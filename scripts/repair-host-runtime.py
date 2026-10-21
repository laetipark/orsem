#!/usr/bin/env python3
"""Repair this host's stopped Redis, then recover Orsem; never reboot.

No changes occur without --apply. AOF truncation also requires --repair-aof.
--update-ga-kernel updates only the existing, recognized 139 diagnostic pin.
Run offline tests: python3 scripts/repair-host-runtime.test.py
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import socket
import stat
import subprocess
import tempfile
import time

REPOSITORY = Path('/home/laeti/orsem')
NODE = Path('/home/laeti/.nvm/versions/node/v24.14.1/bin/node')
CONFIG = Path('/etc/redis/redis.conf')
DATA = Path('/var/lib/redis')
INCLUDE = Path('/etc/redis/orsem-durability.conf')
SYSCTL = Path('/etc/sysctl.d/99-orsem-redis-overcommit.conf')
PIN = Path('/etc/default/grub.d/99-orsem-ga-diagnostic.cfg')
GRUB = Path('/boot/grub/grub.cfg')
BACKUPS = Path('/var/backups/orsem-host-repair')
CPU_HELPER = Path('/usr/local/sbin/orsem-cpu-isolation')
OLD_KERNEL = '6.8.0-139-generic'
NEW_KERNEL = '6.8.0-142-generic'
FILESYSTEM_UUID = '9c0166b9-16fc-40c0-91b3-eda8d3bb3b60'
SUBMENU = f'gnulinux-advanced-{FILESYSTEM_UUID}'
OLD_ENTRY = f'gnulinux-{OLD_KERNEL}-advanced-{FILESYSTEM_UUID}'
NEW_ENTRY = f'gnulinux-{NEW_KERNEL}-advanced-{FILESYSTEM_UUID}'
OLD_PIN = ('# Diagnostic GA boot selection; installed HWE kernels and mitigations retained.\n'
           '# Exact version for diagnosis; review after GA security kernel updates.\n'
           f'GRUB_DEFAULT="{SUBMENU}>{OLD_ENTRY}"\n')
NEW_PIN = OLD_PIN.replace(OLD_KERNEL, NEW_KERNEL)
DURABILITY = ('# Managed by Orsem host repair v1\n'
              'appendfsync always\n'
              'no-appendfsync-on-rewrite no\n')
OVERCOMMIT = '# Managed by Orsem host repair v1\nvm.overcommit_memory = 1\n'


class RepairError(RuntimeError):
    pass


def trusted_metadata(path: Path, info, *, root_owned=False) -> bool:
    """Known service/user trees may be writable by their owning primary group."""
    identities = {(0, 0)}
    if path == CONFIG.parent or CONFIG.parent in path.parents or path == DATA or DATA in path.parents:
        account = pwd.getpwnam('redis')
        identities.add((account.pw_uid, account.pw_gid))
    elif not root_owned and (path == Path('/home/laeti') or Path('/home/laeti') in path.parents):
        account = pwd.getpwnam('laeti')
        identities.add((account.pw_uid, account.pw_gid))
    if info.st_mode & 0o002 or info.st_uid not in {uid for uid, _ in identities}:
        return False
    # /etc/redis is intentionally redis:redis 2770; repository/nvm are laeti:laeti 775.
    return not (info.st_mode & 0o020) or (info.st_uid, info.st_gid) in identities


def guarded_path(path: Path, *, directory=False, root_owned=False) -> os.stat_result:
    """Reject links and unexpected owners; allow only known host account groups."""
    path = path.absolute()
    for parent in reversed(path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or not trusted_metadata(parent, info, root_owned=root_owned):
            raise RepairError('Unsafe parent directory; manual review required.')
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or (not directory and info.st_nlink != 1):
        raise RepairError('A managed path is a link or unexpected file type.')
    if not trusted_metadata(path, info, root_owned=root_owned):
        raise RepairError('A managed path has unexpected ownership or permissions.')
    return info


def inspect_tree(root: Path) -> int:
    """Back up only ordinary directories/files, never follow data/config links."""
    guarded_path(root, directory=True)
    size = 0
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            info = (Path(directory) / name).lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise RepairError('Redis tree contains a linked directory; manual review required.')
        for name in files:
            info = (Path(directory) / name).lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise RepairError('Redis tree contains a link or special file; manual review required.')
            size += info.st_size
    return size


def parse_config(text: str, managed_text: str | None = None, *, validate_layout=True) -> dict[str, list[str]]:
    """Only our known include is supported; unknown includes may override paths/auth."""
    settings: dict[str, list[str]] = {}
    for line in text.splitlines():
        try:
            words = shlex.split(line, comments=True)
        except ValueError:
            raise RepairError('Redis configuration syntax needs manual review.') from None
        if not words:
            continue
        directive, *values = words
        directive = directive.lower()
        if directive == 'include':
            if values != [str(INCLUDE)] or managed_text != DURABILITY:
                raise RepairError('Unexpected Redis include; manual review required.')
            settings.update(parse_config(managed_text, validate_layout=False))
        else:
            settings[directive] = values
    if not validate_layout:
        return settings
    expected = {'dir': [str(DATA)], 'appenddirname': ['appendonlydir'],
                'appendfilename': ['appendonly.aof'], 'appendonly': ['yes'], 'port': ['6379']}
    defaults = {'appenddirname': ['appendonlydir'], 'appendfilename': ['appendonly.aof'], 'port': ['6379']}
    for key, value in expected.items():
        if settings.get(key, defaults.get(key)) != value:
            raise RepairError(f'Unexpected Redis {key}; this repair supports only the known local layout.')
    if settings.get('cluster-enabled', ['no']) != ['no'] or 'replicaof' in settings:
        raise RepairError('Cluster/replica Redis needs a separate recovery procedure.')
    if settings.get('tls-port', ['0']) != ['0'] or settings.get('loadmodule'):
        raise RepairError('Custom TLS/module Redis needs manual review.')
    if 'aclfile' in settings:
        values = settings['aclfile']
        if len(values) != 1 or not Path(values[0]).is_absolute() or Path(values[0]).parent != CONFIG.parent:
            raise RepairError('Redis ACL file must be inside the backed-up configuration directory.')
    return settings


def manifest_files(directory: Path) -> tuple[Path, Path]:
    guarded_path(directory, directory=True)
    manifests = list(directory.glob('*.manifest'))
    if len(manifests) != 1 or manifests[0].name != 'appendonly.aof.manifest':
        raise RepairError('Expected exactly one known Redis AOF manifest.')
    manifest = manifests[0]
    guarded_path(manifest)
    base: list[Path] = []
    seen: set[str] = set()
    incremental_sequences: list[int] = []
    for line in manifest.read_text().splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'file (appendonly\.aof\.(\d+)\.(base\.(?:rdb|aof)|incr\.aof)) seq (\d+) type ([bi])', line)
        if not match:
            raise RepairError('Unexpected AOF manifest entry; manual recovery required.')
        name, sequence, kind, declared_sequence, file_type = match.groups()
        if name in seen or sequence != declared_sequence or (file_type == 'b') != kind.startswith('base.'):
            raise RepairError('Inconsistent AOF manifest entry.')
        seen.add(name)
        member = directory / name
        guarded_path(member)
        if file_type == 'b':
            base.append(member)
        else:
            incremental_sequences.append(int(sequence))
    if len(base) != 1 or not incremental_sequences or incremental_sequences != sorted(set(incremental_sequences)):
        raise RepairError('AOF manifest base/increment sequence needs manual review.')
    return manifest, base[0]


def durable_config(original: str) -> str:
    include_line = f'include {INCLUDE}'
    lines = [line for line in original.splitlines() if line.strip() != include_line]
    return '\n'.join(lines).rstrip() + '\n\n' + include_line + '\n'


def atomic_write(path: Path, data: bytes, mode: int, uid: int, gid: int) -> None:
    guarded_path(path.parent, directory=True, root_owned=True)
    if path.exists() or path.is_symlink():
        guarded_path(path, root_owned=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Commands:
    def __init__(self):
        self.backup: Path | None = None

    def run(self, args, *, input=None, timeout=120, check=True, label='command', cwd=None):
        try:
            result = subprocess.run(args, input=input, text=True, capture_output=True,
                                    timeout=timeout, cwd=cwd, env={
                                        'PATH': '/usr/sbin:/usr/bin:/sbin:/bin',
                                        'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})
        except (OSError, subprocess.TimeoutExpired):
            raise RepairError(f'{label} could not complete; inspect the private backup logs.') from None
        if self.backup:
            # Raw checker output could contain Redis record fragments. Keep it root-only.
            log = self.backup / f'{label}.log'
            with log.open('a') as stream:
                os.chmod(log, 0o600)
                stream.write(result.stdout + result.stderr)
        if check and result.returncode:
            raise RepairError(f'{label} failed (exit {result.returncode}); inspect the private backup logs.')
        return result


def require_stopped(commands: Commands) -> None:
    state = commands.run(['systemctl', 'show', 'redis-server.service', '-p', 'ActiveState', '--value'], label='redis-state').stdout.strip()
    if state not in {'inactive', 'failed'}:
        raise RepairError('Redis must already be inactive/failed. Healthy or starting Redis is never stopped by this script.')
    try:
        with socket.create_connection(('127.0.0.1', 6379), timeout=1):
            raise RepairError('Port 6379 is already accepting connections; refusing offline AOF repair.')
    except (ConnectionRefusedError, socket.timeout):
        pass


def require_unit(commands: Commands) -> None:
    command = commands.run(['systemctl', 'show', 'redis-server.service', '-p', 'ExecStart', '--value'], label='redis-exec').stdout
    expected = 'argv[]=/usr/bin/redis-server /etc/redis/redis.conf --supervised systemd --daemonize no ;'
    if expected not in command or command.count('argv[]=') != 1:
        raise RepairError('Redis service command differs from the known configuration.')


def check_pin(text: str) -> None:
    if text not in {OLD_PIN, NEW_PIN}:
        raise RepairError('Diagnostic GRUB pin changed; refusing to overwrite it.')


def verify_menu(text: str) -> None:
    for kind, entry in [('submenu', SUBMENU), ('menuentry', NEW_ENTRY)]:
        pattern = rf'^\s*{kind}\s+[^\n]*\s[\'\"]{re.escape(entry)}[\'\"]\s*\{{\s*$'
        if not re.search(pattern, text, re.MULTILINE):
            raise RepairError('Installed GA kernel is absent from the generated GRUB menu.')


def kernel_preflight() -> tuple[bytes, os.stat_result, bytes, os.stat_result]:
    pin_info = guarded_path(PIN, root_owned=True)
    check_pin(PIN.read_text())
    guarded_path(Path('/boot') / f'vmlinuz-{NEW_KERNEL}', root_owned=True)
    guarded_path(Path('/boot') / f'initrd.img-{NEW_KERNEL}', root_owned=True)
    guarded_path(Path('/usr/lib/modules') / NEW_KERNEL, directory=True)
    grub_info = guarded_path(GRUB, root_owned=True)
    verify_menu(GRUB.read_text())
    return PIN.read_bytes(), pin_info, GRUB.read_bytes(), grub_info


def update_kernel(commands: Commands, snapshot) -> None:
    before, info, grub_before, grub_info = snapshot
    if before == NEW_PIN.encode():
        print('GA kernel diagnostic pin already selects 6.8.0-142.')
        return
    # Do not source or replace unrelated GRUB settings, including CPU/mitigation settings.
    if PIN.read_bytes() != before or GRUB.read_bytes() != grub_before:
        raise RepairError('GRUB configuration changed during repair; refusing kernel update.')
    atomic_write(PIN, NEW_PIN.encode(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
    try:
        commands.run(['update-grub'], timeout=180, label='update-grub')
        verify_menu(GRUB.read_text())
        if f'set default="{SUBMENU}>{NEW_ENTRY}"' not in GRUB.read_text():
            raise RepairError('Generated GRUB default does not select the requested GA kernel.')
    except BaseException:
        atomic_write(PIN, before, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        atomic_write(GRUB, grub_before, stat.S_IMODE(grub_info.st_mode), grub_info.st_uid, grub_info.st_gid)
        raise
    print('Next boot selects installed GA kernel 6.8.0-142. No reboot was performed.')


def create_backup(commands: Commands, total_size: int, extra: list[Path]) -> Path:
    guarded_path(BACKUPS.parent, directory=True, root_owned=True)
    if not BACKUPS.exists():
        BACKUPS.mkdir(mode=0o700)
    guarded_path(BACKUPS, directory=True, root_owned=True)
    if stat.S_IMODE(BACKUPS.stat().st_mode) != 0o700:
        raise RepairError('Backup parent must have private permissions 0700.')
    if shutil.disk_usage(BACKUPS).free < total_size * 1.1 + 64 * 1024 * 1024:
        raise RepairError('Not enough free space for the full Redis backup; no repair performed.')
    backup = Path(tempfile.mkdtemp(prefix='repair-', dir=BACKUPS))
    commands.backup = backup
    archive = backup / 'before.tar'
    members = [CONFIG.parent, DATA] + extra
    commands.run(['tar', '--numeric-owner', '-cpf', str(archive), '-C', '/'] +
                 [str(path).lstrip('/') for path in members], timeout=1800, label='backup')
    os.chmod(archive, 0o600)
    with archive.open('rb') as stream:
        os.fsync(stream.fileno())
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    (backup / 'before.tar.sha256').write_text(digest + '  before.tar\n')
    print(f'Full private backup: {backup}')
    return backup


def repair_aof(commands: Commands, manifest: Path, base: Path, allow_fix: bool) -> None:
    checker = 'redis-check-rdb' if base.suffix == '.rdb' else 'redis-check-aof'
    if commands.run([checker, str(base)], timeout=900, check=False, label='base-check').returncode:
        raise RepairError('The base snapshot is damaged. No AOF truncation attempted; manual recovery required.')
    check = commands.run(['redis-check-aof', str(manifest)], timeout=900, check=False, label='aof-check-before')
    if check.returncode:
        if not allow_fix:
            raise RepairError('AOF is damaged. Review backup; rerun with --repair-aof to authorize truncating damaged records.')
        print('WARNING: AOF repair may discard damaged records and records after them, including sessions/queued jobs.')
        print(f'Unmodified data/config archive is in {commands.backup}.')
        commands.run(['redis-check-aof', '--fix', str(manifest)], input='y\n', timeout=900, label='aof-fix')
    commands.run(['redis-check-aof', str(manifest)], timeout=900, label='aof-check-after')
    print('Redis base snapshot and AOF validation passed.')


def app_command(*args: str) -> list[str]:
    return ['runuser', '-u', 'laeti', '--', 'env', 'HOME=/home/laeti',
            f'PATH={NODE.parent}:/usr/local/bin:/usr/bin:/bin', str(NODE), *args]


def healthy_redis(commands: Commands) -> bool:
    # Use the same environment merge as start-at-boot; neither credentials nor raw INFO leave this process.
    code = """import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {checkRedisHealth} from './scripts/check-redis-health.mjs';
try { const env={...process.env,...parseEnv(await readFile('.env','utf8'))};
const result=await checkRedisHealth(env); process.exitCode=result.state==='OK'?0:1;
} catch { process.exitCode=1; }"""
    return commands.run(app_command('--input-type=module', '-e', code), cwd=REPOSITORY,
                        check=False, timeout=15, label='redis-authenticated-health').returncode == 0


def apply(args, commands: Commands) -> None:
    require_stopped(commands)
    require_unit(commands)
    config_info = guarded_path(CONFIG, root_owned=True)
    original = CONFIG.read_text()
    managed = None
    if INCLUDE.exists() or INCLUDE.is_symlink():
        guarded_path(INCLUDE, root_owned=True)
        managed = INCLUDE.read_text()
        if managed != DURABILITY:
            raise RepairError('Existing durability include is not managed by this script.')
    parse_config(original, managed)
    if SYSCTL.exists() or SYSCTL.is_symlink():
        guarded_path(SYSCTL, root_owned=True)
        if SYSCTL.read_text() != OVERCOMMIT:
            raise RepairError('Existing overcommit file is not managed by this script.')
    total = inspect_tree(CONFIG.parent) + inspect_tree(DATA)
    manifest, base = manifest_files(DATA / 'appendonlydir')
    for program in ('systemctl', 'redis-check-aof', 'redis-check-rdb', 'tar', 'sysctl', 'runuser', 'flock'):
        if not shutil.which(program):
            raise RepairError(f'Required host program missing: {program}')
    guarded_path(NODE)
    guarded_path(REPOSITORY / 'scripts/start-at-boot.mjs')
    if commands.run(app_command('--version'), label='node-version').stdout.strip().split('.')[0] != 'v24':
        raise RepairError('The selected Node runtime must be version 24.')
    snapshot = kernel_preflight() if args.update_ga_kernel else None
    extras = ([PIN, GRUB] if snapshot else []) + ([SYSCTL] if SYSCTL.exists() else [])
    create_backup(commands, total, extras)
    require_stopped(commands)
    if CONFIG.read_text() != original:
        raise RepairError('Redis configuration changed during backup; refusing repair.')
    repair_aof(commands, manifest, base, args.repair_aof)
    atomic_write(INCLUDE, DURABILITY.encode(), 0o640, 0, pwd.getpwnam('redis').pw_gid)
    atomic_write(CONFIG, durable_config(original).encode(), stat.S_IMODE(config_info.st_mode),
                 config_info.st_uid, config_info.st_gid)
    atomic_write(SYSCTL, OVERCOMMIT.encode(), 0o644, 0, 0)
    commands.run(['sysctl', '-w', 'vm.overcommit_memory=1'], label='redis-overcommit')
    print('Redis durable writes and memory overcommit configured. Authentication settings preserved.')
    unresolved = []
    if snapshot:
        try:
            update_kernel(commands, snapshot)
        except RepairError:
            unresolved.append('GA kernel pin update failed and was rolled back; see private logs.')
    if CPU_HELPER.exists():
        guarded_path(CPU_HELPER, root_owned=True)
        # Original helper validates hardware, ownership and hashes, with its own rollback.
        if commands.run([str(CPU_HELPER), '--apply'], timeout=100, check=False, label='cpu-isolation').returncode:
            unresolved.append('Existing CPU isolation still fails. Its helper/unit were left intact.')
        else:
            print('Existing CPU isolation successfully reapplied.')
    commands.run(['systemctl', 'reset-failed', 'redis-server.service'], label='redis-reset-failed')
    commands.run(['systemctl', 'start', 'redis-server.service'], timeout=180, label='redis-start')
    for attempt in range(15):
        if healthy_redis(commands):
            break
        time.sleep(2)
    else:
        raise RepairError('Redis authenticated persistence health failed; app startup was not attempted.')
    print('Redis authenticated persistence health passed.')
    startup = app_command('scripts/start-at-boot.mjs')
    node_index = startup.index(str(NODE))
    startup[node_index:node_index] = ['flock', '-w', '240', '/home/laeti/orsem-data/orsem-boot.lock']
    commands.run(startup, cwd=REPOSITORY, timeout=600, label='orsem-start')
    print('Orsem startup completed. No reboot or panic-policy change was performed.')
    for message in unresolved:
        print('UNRESOLVED: ' + message)
    if unresolved:
        raise RepairError('Redis/app recovery completed, but host diagnosis remains unresolved as listed above.')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='perform backed-up repair (requires root)')
    parser.add_argument('--repair-aof', action='store_true', help='authorize damaged AOF record truncation after full backup')
    parser.add_argument('--update-ga-kernel', action='store_true', help='update recognized 139 diagnostic pin to installed 142; never reboot')
    args = parser.parse_args()
    if not args.apply:
        print('No changes made. Use sudo python3 scripts/repair-host-runtime.py --apply --repair-aof --update-ga-kernel')
        return 0
    if os.geteuid() != 0:
        print('ERROR: --apply requires root. Run the command with sudo in your own terminal.')
        return 1
    os.umask(0o077)
    try:
        guarded_path(Path('/run'), directory=True, root_owned=True)
        lock_fd = os.open('/run/orsem-host-repair.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(lock_fd, 'w') as lock:
            info = os.fstat(lock.fileno())
            if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise RepairError('Unsafe repair lock file.')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            apply(args, Commands())
        return 0
    except (RepairError, OSError, ValueError):
        # OSError/ValueError may contain sensitive content; only our safe messages are public.
        import sys
        exc = sys.exception()
        print('ERROR: ' + (str(exc) if isinstance(exc, RepairError) else 'Host repair stopped; inspect private backup logs.'))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
