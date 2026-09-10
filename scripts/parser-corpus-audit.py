#!/usr/bin/env python3
"""Native parser-corpus-audit entry point; use the worker Python environment."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps/worker/python"))
from orsem_worker.admin_cli import run
from orsem_worker.admin_cli.common import AdminError
from orsem_worker.core import json_text

if __name__ == "__main__":
    try:
        print(json_text(asyncio.run(run("parser-corpus-audit", sys.argv[1:]))))
    except Exception as error:  # noqa: BLE001 - CLI boundary redacts URLs, credentials, and raw parser data.
        print(
            json_text(
                {"error": error.code if isinstance(error, AdminError) else "ADMIN_COMMAND_FAILED"}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
