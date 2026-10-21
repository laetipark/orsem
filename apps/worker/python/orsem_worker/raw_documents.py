"""Immutable content-addressed raw disclosure storage."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import stat
import time
from pathlib import Path
from uuid import uuid4

from .config import repository_root


class RawDocumentStore:
    def __init__(self, config):
        self.root = Path(config.rawDocumentDir).resolve()
        if not Path(config.rawDocumentDir).is_absolute() or self.root.is_relative_to(
            repository_root()
        ):
            raise ValueError(
                "RAW_DOCUMENT_DIR must be an absolute directory outside the repository."
            )

    async def put(self, data: bytes, *, extension: str = "zip") -> dict:
        return await asyncio.to_thread(self._put, bytes(data), extension)

    def _put(self, data: bytes, extension: str = "zip") -> dict:
        if extension not in ("zip", "json", "xml", "html", "xlsx"):
            raise ValueError("Unsupported raw object extension.")
        digest = hashlib.sha256(data).hexdigest()
        directory = self.root / digest[:2]
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.is_symlink() or not directory.resolve().is_relative_to(self.root):
            raise ValueError("Raw object directory escapes the configured root.")
        candidates = [
            p
            for p in directory.iterdir()
            if re.match(r"\.[a-f0-9]{64}\.tmp-", p.name) and not p.is_symlink()
        ][:32]
        for path in candidates:
            try:
                if path.is_file() and time.time() - path.stat().st_mtime > 86400:
                    path.unlink()
            except FileNotFoundError:
                pass
        target = directory / f"{digest}.{extension}"
        temporary = directory / f".{digest}.tmp-{os.getpid()}-{uuid4()}"
        created = False
        try:
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, target)
                created = True
            except FileExistsError:
                descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, "rb") as stream:
                    metadata = os.fstat(stream.fileno())
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != len(data):
                        raise ValueError("Existing raw object does not match expected byte size.")
                    if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                        raise ValueError("Existing raw object does not match expected SHA-256.")
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)
        return {
            "sha256": digest,
            "byteSize": str(len(data)),
            "objectUri": f"file://{target}",
            "created": created,
        }
