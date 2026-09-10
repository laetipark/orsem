#!/usr/bin/env python3
"""Verify a source snapshot without replacing files used by running services."""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    with tempfile.TemporaryDirectory(prefix="orsem-check-") as temporary:
        target = Path(temporary)
        tracked = (
            subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
            .decode()
            .split("\0")
        )
        added = (
            subprocess.check_output(
                ["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=ROOT
            )
            .decode()
            .split("\0")
        )
        for name in set(tracked + added):
            source = ROOT / name
            if (
                not name
                or not source.is_file()
                or source.name == ".env"
                or (source.name.startswith(".env.") and source.name != ".env.example")
            ):
                continue
            output = target / name
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, output)
        modules = target / "node_modules"
        modules.mkdir()
        for source in (ROOT / "node_modules").iterdir():
            if source.name != "@orsem":
                (modules / source.name).symlink_to(
                    source, target_is_directory=source.is_dir()
                )
        namespace = modules / "@orsem"
        namespace.mkdir()
        for parent in ("apps", "packages"):
            for package in (target / parent).iterdir():
                if (package / "package.json").is_file():
                    (namespace / package.name).symlink_to(
                        package, target_is_directory=True
                    )
        # No environment-file loading and no live service URLs in the check process.
        environment = {
            key: value
            for key, value in os.environ.items()
            if key not in ("DATABASE_URL", "REDIS_URL", "ORSEM_REPO_ROOT")
        }
        environment["NODE_ENV"] = "test"
        for command in (["npm", "run", "check"], ["npm", "run", "build"]):
            subprocess.run(command, cwd=target, env=environment, check=True)


if __name__ == "__main__":
    main()
