#!/usr/bin/env python3
"""Bound disposable backup/release storage; never touch source data or databases."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import shutil
import stat
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAY = 86400
GIB = 1024**3
# This recovery environment is explicitly retained by PYTHON_WORKER.md.
PROTECTED_BACKUPS = {"python-worker-20260910"}


class RetentionError(Exception):
    pass


@dataclass(frozen=True)
class Snapshot:
    name: str
    size: int
    newest: float
    fingerprint: str
    pinned: bool


def inspect_tree(path: Path) -> Snapshot:
    """Measure allocated bytes without following links, and detect subsequent edits."""
    digest = hashlib.sha256()
    size = 0
    newest = 0.0
    pinned = False
    device = path.lstat().st_dev
    pending = [path]
    while pending:
        current = pending.pop()
        info = current.lstat()
        if info.st_dev != device:
            raise RetentionError("A snapshot contains a separate filesystem; refusing cleanup.")
        relative = str(current.relative_to(path))
        digest.update(
            json.dumps(
                [relative, info.st_dev, info.st_ino, info.st_mode, info.st_size,
                 info.st_mtime_ns, info.st_ctime_ns],
                separators=(",", ":"),
            ).encode()
        )
        size += info.st_blocks * 512
        newest = max(newest, info.st_mtime)
        pinned |= current.name == ".keep"
        if stat.S_ISDIR(info.st_mode):
            pending.extend(sorted(current.iterdir(), reverse=True))
        elif not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            raise RetentionError("A snapshot contains a special file; refusing cleanup.")
    return Snapshot(path.name, size, newest, digest.hexdigest(), pinned)


def validate_data_dir(value: str) -> Path:
    declared = Path(value)
    resolved = declared.resolve(strict=True)
    if (not declared.is_absolute() or not resolved.is_dir() or resolved == Path("/")
            or resolved.is_relative_to(ROOT) or ROOT.is_relative_to(resolved)):
        raise RetentionError("Data directory must be an absolute directory outside the repository.")
    return resolved


def group_directory(data_dir: Path, kind: str) -> Path:
    relative = Path("backups") if kind == "backups" else Path("worker/releases")
    current = data_dir
    for component in relative.parts:
        current /= component
        if current.is_symlink():
            raise RetentionError("Managed storage directories must not be symbolic links.")
        if current.exists() and not current.is_dir():
            raise RetentionError("Managed storage path must be a directory.")
    return current


def scan_group(data_dir: Path, kind: str) -> tuple[list[Snapshot], list[str]]:
    directory = group_directory(data_dir, kind)
    if not directory.exists():
        return [], []
    snapshots, ignored = [], []
    for entry in sorted(directory.iterdir()):
        # Backups are complete top-level sets. Unknown release names stay untouched.
        if (entry.is_symlink() or not entry.is_dir()
                or (kind == "releases" and not re.fullmatch(r"[a-f0-9]{64}", entry.name))):
            ignored.append(entry.name)
            continue
        snapshots.append(inspect_tree(entry))
    return snapshots, ignored


def release_targets(data_dir: Path) -> set[str]:
    """Keep all explicitly linked worker releases, including current and rollback."""
    worker = data_dir / "worker"
    releases = group_directory(data_dir, "releases")
    if not worker.exists():
        return set()
    targets = set()
    for entry in worker.iterdir():
        if not entry.is_symlink():
            continue
        target = entry.resolve(strict=True)
        if target.is_relative_to(releases) and target != releases:
            targets.add(target.relative_to(releases).parts[0])
    # Deleting environments without an identifiable active release is unsafe.
    if releases.exists() and any(releases.iterdir()) and not targets:
        raise RetentionError("No linked worker release was found; refusing release cleanup.")
    return targets


def plan_group(snapshots: list[Snapshot], *, days: int, max_bytes: int, keep: int,
               min_age_days: int, protected: set[str], now: float) -> dict:
    ordered = sorted(snapshots, key=lambda item: (item.newest, item.name), reverse=True)
    protected = protected | {item.name for item in ordered[:keep]}
    protected |= {item.name for item in ordered if item.pinned}
    total = sum(item.size for item in ordered)
    remaining = total
    deletes = []
    # Expiration is unconditional for unprotected snapshots. Capacity pressure
    # may remove younger snapshots, but never those inside the minimum age.
    for item in reversed(ordered):
        age = now - item.newest
        if item.name in protected or age < min_age_days * DAY:
            continue
        expired = age >= days * DAY
        if expired or remaining > max_bytes:
            deletes.append({"name": item.name, "bytes": item.size,
                            "reason": "expired" if expired else "capacity",
                            "fingerprint": item.fingerprint})
            remaining -= item.size
    return {"bytesBefore": total, "bytesAfter": remaining, "limitBytes": max_bytes,
            "overLimit": remaining > max_bytes, "protected": sorted(protected),
            "delete": deletes}


def make_plan(data_dir: Path, options, *, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    plan = {"dataDir": str(data_dir), "groups": {}}
    for kind, days, maximum, protected in (
        ("backups", options.backup_days, options.backup_max_gib,
         PROTECTED_BACKUPS | set(options.protect_backup)),
        ("releases", options.release_days, options.release_max_gib, release_targets(data_dir)),
    ):
        snapshots, ignored = scan_group(data_dir, kind)
        group = plan_group(snapshots, days=days, max_bytes=int(maximum * GIB),
                           keep=options.keep, min_age_days=options.min_age_days,
                           protected=protected, now=now)
        group["ignored"] = ignored
        plan["groups"][kind] = group
    plan["reclaimableBytes"] = sum(
        group["bytesBefore"] - group["bytesAfter"] for group in plan["groups"].values()
    )
    return plan


def apply_plan(data_dir: Path, plan: dict, options) -> int:
    if not shutil.rmtree.avoids_symlink_attacks:
        raise RetentionError("This Python runtime cannot safely remove directory trees.")
    # Validate the complete set before removing the first snapshot. The lock
    # serializes maintainers; changed snapshots and newly pinned targets abort.
    fresh = make_plan(data_dir, options)
    if fresh != plan:
        raise RetentionError("Storage changed during planning; rerun to review a fresh plan.")
    removed = 0
    for kind, group in plan["groups"].items():
        directory = group_directory(data_dir, kind)
        for item in group["delete"]:
            target = directory / item["name"]
            if target.is_symlink() or inspect_tree(target).fingerprint != item["fingerprint"]:
                raise RetentionError("A cleanup target changed; remaining snapshots were preserved.")
            if kind == "releases" and target.name in release_targets(data_dir):
                raise RetentionError("A release became active; remaining snapshots were preserved.")
            shutil.rmtree(target)
            removed += item["bytes"]
            # Emit progress so a later failure never hides a completed deletion.
            print(json.dumps({"deletedGroup": kind, "deletedName": item["name"],
                              "estimatedBytes": item["bytes"]}), flush=True)
    return removed


def positive_number(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("Value must be a finite positive number.")
    return number


def parse_args(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default=os.environ.get("ORSEM_DATA_DIR", "/home/laeti/orsem-data"))
    parser.add_argument("--apply", action="store_true", help="delete the planned expired snapshots")
    parser.add_argument("--backup-days", type=int, default=30)
    parser.add_argument("--backup-max-gib", type=positive_number, default=8)
    parser.add_argument("--release-days", type=int, default=30)
    parser.add_argument("--release-max-gib", type=positive_number, default=1)
    parser.add_argument("--min-age-days", type=int, default=7)
    parser.add_argument("--keep", type=int, default=3)
    parser.add_argument("--protect-backup", action="append", default=[])
    options = parser.parse_args(arguments)
    if (options.keep < 2 or options.min_age_days < 1
            or min(options.backup_days, options.release_days) < options.min_age_days):
        parser.error("Keep at least two snapshots; retention days must be >= minimum age >= 1.")
    for name in options.protect_backup:
        if not name or Path(name).name != name or name in (".", ".."):
            parser.error("Protected backup must be a single directory name.")
    return options


def main(arguments=None):
    options = parse_args(arguments)
    try:
        data_dir = validate_data_dir(options.data_dir)
        if not options.apply:
            plan = make_plan(data_dir, options)
            print(json.dumps({"mode": "dry-run", **plan}, ensure_ascii=False, indent=2))
            return 0
        lock_path = data_dir / ".storage-retention.lock"
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "r+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RetentionError("Storage maintenance is already running.") from None
            plan = make_plan(data_dir, options)
            print(json.dumps({"mode": "apply", **plan}, ensure_ascii=False, indent=2), flush=True)
            removed = apply_plan(data_dir, plan, options)
            usage = shutil.disk_usage(data_dir)
            print(json.dumps({"removedEstimatedBytes": removed, "availableBytes": usage.free,
                              "overLimit": any(g["overLimit"] for g in plan["groups"].values())}))
        return 0
    except (RetentionError, OSError, RuntimeError):
        # Backup files can contain credentials. Never print file contents/errors.
        print("Storage maintenance stopped: check paths, permissions, active links and concurrent changes.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
