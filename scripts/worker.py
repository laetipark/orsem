#!/usr/bin/env python3
"""npm workspace convenience commands; the worker itself runs directly in Python."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "apps/worker/python"


def main():
    executable = os.environ.get("ORSEM_WORKER_PYTHON")
    if not executable:
        candidates = (ROOT / ".venv/bin/python", PROJECT / ".venv/bin/python")
        executable = str(
            next((path for path in candidates if path.is_file()), Path(sys.executable))
        )
    command = sys.argv[1] if len(sys.argv) > 1 else "start"
    options = sys.argv[2:]
    commands = {
        "start": ["-m", "orsem_worker"],
        "test": ["-m", "pytest", "-q"],
        "lint": ["-m", "ruff", "check", "--config", "pyproject.toml", "."],
        "typecheck": ["-m", "mypy", "--config-file", "pyproject.toml", "orsem_worker"],
        "build": [
            "-m",
            "build",
            "--wheel",
            "--no-isolation",
            "--outdir",
            str(PROJECT / "dist"),
        ],
        "cli": ["-m", "orsem_worker.cli"],
    }
    if command not in commands:
        raise SystemExit("Usage: python3 scripts/worker.py " + "|".join(commands))
    environment = {
        **os.environ,
        "ORSEM_REPO_ROOT": str(ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(PROJECT)
        + (
            os.pathsep + os.environ["PYTHONPATH"]
            if os.environ.get("PYTHONPATH")
            else ""
        ),
    }
    raise SystemExit(
        subprocess.call(
            [executable, *commands[command], *options], cwd=PROJECT, env=environment
        )
    )


if __name__ == "__main__":
    main()
