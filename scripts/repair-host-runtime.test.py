#!/usr/bin/env python3
"""Offline repair safety tests: only temporary files and mocked host commands."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('repair_host', Path(__file__).with_name('repair-host-runtime.py'))
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class FakeCommands:
    def __init__(self, codes):
        self.codes = iter(codes)
        self.calls = []
        self.backup = Path('/private/backup')

    def run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        code = next(self.codes)
        if code and kwargs.get('check', True):
            raise repair.RepairError('fake checked command failed')
        return subprocess.CompletedProcess(args, code, '', '')


class RepairTests(unittest.TestCase):
    def config(self):
        return '# existing settings\ndir /var/lib/redis\nappendonly yes\nrequirepass "not-a-real-secret"\nappendfsync everysec\n'

    def test_known_deployment_permissions_are_allowed(self):
        account = lambda name: SimpleNamespace(pw_uid=126 if name == 'redis' else 1000, pw_gid=128 if name == 'redis' else 1000)
        with patch.object(repair.pwd, 'getpwnam', side_effect=account):
            redis_dir = SimpleNamespace(st_uid=126, st_gid=128, st_mode=0o42770)
            self.assertTrue(repair.trusted_metadata(Path('/etc/redis'), redis_dir, root_owned=True))
            redis_file = SimpleNamespace(st_uid=126, st_gid=128, st_mode=0o100640)
            self.assertTrue(repair.trusted_metadata(repair.CONFIG, redis_file, root_owned=True))
            app_dir = SimpleNamespace(st_uid=1000, st_gid=1000, st_mode=0o40775)
            self.assertTrue(repair.trusted_metadata(Path('/home/laeti/.nvm'), app_dir))
            self.assertFalse(repair.trusted_metadata(Path('/home/laeti/.nvm'), app_dir, root_owned=True))
            self.assertFalse(repair.trusted_metadata(Path('/etc/sysctl.d'), app_dir, root_owned=True))
            unsafe = SimpleNamespace(st_uid=126, st_gid=128, st_mode=0o42777)
            self.assertFalse(repair.trusted_metadata(Path('/etc/redis'), unsafe, root_owned=True))
            wrong_group = SimpleNamespace(st_uid=126, st_gid=999, st_mode=0o42770)
            self.assertFalse(repair.trusted_metadata(Path('/etc/redis'), wrong_group, root_owned=True))

    def test_known_layout_and_defaults(self):
        values = repair.parse_config(self.config())
        self.assertEqual(values['requirepass'], ['not-a-real-secret'])

    def test_reject_unknown_or_path_overriding_include(self):
        with self.assertRaises(repair.RepairError):
            repair.parse_config(self.config() + 'include /etc/redis/custom.conf\n')
        with self.assertRaises(repair.RepairError):
            repair.parse_config(self.config() + 'dir /elsewhere\n')

    def test_managed_include_has_final_precedence_and_preserves_auth(self):
        original = self.config()
        result = repair.durable_config(original)
        values = repair.parse_config(result, repair.DURABILITY)
        self.assertEqual(values['appendfsync'], ['always'])
        self.assertEqual(values['no-appendfsync-on-rewrite'], ['no'])
        self.assertIn('requirepass "not-a-real-secret"', result)
        self.assertEqual(result, repair.durable_config(result))
        self.assertEqual(result.count(f'include {repair.INCLUDE}'), 1)

    def test_reject_replication_and_external_acl(self):
        for directive in ['replicaof localhost 1234', 'cluster-enabled yes', 'aclfile /somewhere/users.acl']:
            with self.subTest(directive=directive), self.assertRaises(repair.RepairError):
                repair.parse_config(self.config() + directive + '\n')

    def test_manifest_rejects_traversal_and_duplicate_base(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(repair, 'guarded_path'):
            directory = Path(temporary)
            manifest = directory / 'appendonly.aof.manifest'
            manifest.write_text('file ../../outside seq 1 type b\n')
            with self.assertRaises(repair.RepairError):
                repair.manifest_files(directory)
            manifest.write_text('file appendonly.aof.1.base.rdb seq 1 type b\n'
                                'file appendonly.aof.2.base.rdb seq 2 type b\n'
                                'file appendonly.aof.2.incr.aof seq 2 type i\n')
            with self.assertRaises(repair.RepairError):
                repair.manifest_files(directory)

    def test_manifest_accepts_exact_known_members(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(repair, 'guarded_path'):
            directory = Path(temporary)
            manifest = directory / 'appendonly.aof.manifest'
            manifest.write_text('file appendonly.aof.415.base.rdb seq 415 type b\n'
                                'file appendonly.aof.415.incr.aof seq 415 type i\n')
            found, base = repair.manifest_files(directory)
            self.assertEqual(found, manifest)
            self.assertEqual(base.name, 'appendonly.aof.415.base.rdb')
            (directory / 'other.manifest').write_text('')
            with self.assertRaises(repair.RepairError):
                repair.manifest_files(directory)

    def test_tree_rejects_link_without_following(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(repair, 'guarded_path'):
            directory = Path(temporary)
            (directory / 'data').write_text('x')
            (directory / 'link').symlink_to(directory / 'data')
            with self.assertRaises(repair.RepairError):
                repair.inspect_tree(directory)

    def test_damaged_base_never_attempts_fix(self):
        commands = FakeCommands([1])
        with self.assertRaises(repair.RepairError):
            repair.repair_aof(commands, Path('/manifest'), Path('/base.rdb'), True)
        self.assertEqual(len(commands.calls), 1)

    def test_explicit_flag_required_for_aof_truncation(self):
        commands = FakeCommands([0, 1])
        with self.assertRaises(repair.RepairError):
            repair.repair_aof(commands, Path('/manifest'), Path('/base.rdb'), False)
        self.assertFalse(any('--fix' in call[0] for call in commands.calls))

    def test_fix_is_followed_by_successful_full_validation(self):
        commands = FakeCommands([0, 1, 0, 0])
        repair.repair_aof(commands, Path('/manifest'), Path('/base.rdb'), True)
        self.assertEqual(commands.calls[2][0], ['redis-check-aof', '--fix', '/manifest'])
        self.assertEqual(commands.calls[2][1]['input'], 'y\n')
        self.assertEqual(commands.calls[3][0], ['redis-check-aof', '/manifest'])

    def test_failed_post_fix_validation_stops(self):
        commands = FakeCommands([0, 1, 0, 1])
        with self.assertRaises(repair.RepairError):
            repair.repair_aof(commands, Path('/manifest'), Path('/base.rdb'), True)

    def test_healthy_aof_is_not_rewritten(self):
        commands = FakeCommands([0, 0, 0])
        repair.repair_aof(commands, Path('/manifest'), Path('/base.rdb'), True)
        self.assertFalse(any('--fix' in call[0] for call in commands.calls))

    def test_active_redis_is_never_stopped(self):
        class Active:
            def run(self, args, **kwargs):
                self.args = args
                return subprocess.CompletedProcess(args, 0, 'active\n', '')
        commands = Active()
        with self.assertRaises(repair.RepairError):
            repair.require_stopped(commands)
        self.assertNotIn('stop', commands.args)

    def test_pin_preserves_unrelated_content_by_refusing_it(self):
        repair.check_pin(repair.OLD_PIN)
        repair.check_pin(repair.NEW_PIN)
        with self.assertRaises(repair.RepairError):
            repair.check_pin(repair.OLD_PIN + 'GRUB_CMDLINE_LINUX="isolcpus=5,11"\n')

    def test_menu_requires_exact_142_and_submenu(self):
        menu = f"submenu 'Advanced options' $menuentry_id_option '{repair.SUBMENU}' {{\n"
        menu += f"menuentry 'Ubuntu 142' --class ubuntu $menuentry_id_option '{repair.NEW_ENTRY}' {{\n"
        repair.verify_menu(menu)
        with self.assertRaises(repair.RepairError):
            repair.verify_menu(menu.replace(repair.NEW_ENTRY, repair.OLD_ENTRY))

    def test_update_failure_restores_pin_and_grub_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            pin, grub = Path(temporary) / 'pin', Path(temporary) / 'grub'
            pin.write_text(repair.OLD_PIN)
            grub.write_text('original grub')
            snapshot = (pin.read_bytes(), pin.stat(), grub.read_bytes(), grub.stat())
            def write(path, data, *args):
                path.write_bytes(data)
            with patch.object(repair, 'PIN', pin), patch.object(repair, 'GRUB', grub), patch.object(repair, 'atomic_write', write):
                with self.assertRaises(repair.RepairError):
                    repair.update_kernel(FakeCommands([1]), snapshot)
            self.assertEqual(pin.read_text(), repair.OLD_PIN)
            self.assertEqual(grub.read_text(), 'original grub')

    def test_non_apply_makes_no_mutation(self):
        with patch('sys.argv', ['repair']), patch.object(repair, 'apply') as apply, patch.object(repair.os, 'open') as open_file:
            self.assertEqual(repair.main(), 0)
            apply.assert_not_called()
            open_file.assert_not_called()

    def test_apply_requires_root(self):
        with patch('sys.argv', ['repair', '--apply']), patch.object(repair.os, 'geteuid', return_value=1000), patch.object(repair, 'apply') as apply:
            self.assertEqual(repair.main(), 1)
            apply.assert_not_called()

    def test_startup_is_always_unprivileged(self):
        command = repair.app_command('scripts/start-at-boot.mjs')
        self.assertEqual(command[:4], ['runuser', '-u', 'laeti', '--'])


if __name__ == '__main__':
    unittest.main()
