"""Private external artifacts and explicit native MySQL sessions for admin commands."""

from __future__ import annotations

import json
import os
import re
import stat
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4

from orsem_worker.config import repository_root
from orsem_worker.core import json_text, sha256


class AdminError(Exception):
    def __init__(self, code, details=None):
        self.code, self.details = code, details or {}
        super().__init__(code)


def prepare_output(directory, *, empty=False):
    directory = Path(directory).absolute()
    physical = directory.resolve()
    if physical.is_relative_to(repository_root().resolve()):
        raise AdminError("OUTPUT_MUST_BE_OUTSIDE_REPOSITORY")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not directory.is_dir():
        raise AdminError("OUTPUT_DIRECTORY_REQUIRED")
    if empty and any(directory.iterdir()):
        raise AdminError("OUTPUT_DIRECTORY_MUST_BE_EMPTY")
    return directory.resolve()


def encode(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        indent=2,
        allow_nan=False,
        default=lambda v: (
            str(v)
            if isinstance(v, Decimal)
            else v.isoformat()
            if isinstance(v, (datetime, date))
            else list(v)
            if isinstance(v, (bytes, bytearray))
            else (_ for _ in ()).throw(TypeError("UNSUPPORTED_JSON_VALUE"))
        ),
    ).encode()


def write_private(directory, filename, value, *, exclusive=False, atomic=False):
    if Path(filename).name != filename:
        raise AdminError("INVALID_OUTPUT_NAME")
    content = (
        value.encode()
        if isinstance(value, str)
        else value
        if isinstance(value, bytes)
        else encode(value)
    )
    target = Path(directory) / filename
    temporary = Path(directory) / (f".{filename}.{uuid4()}.tmp") if atomic else target
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_NOFOLLOW
        | (os.O_EXCL if exclusive or atomic else os.O_TRUNC)
    )
    fd = os.open(temporary, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(content)
            output.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    if atomic:
        os.replace(temporary, target)
    return {"file": filename, "bytes": len(content), "sha256": sha256(content)}


def read_private(path):
    path = Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_mode & 0o077:
        raise AdminError("PRIVATE_REGULAR_FILE_REQUIRED")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise AdminError("FILE_CHANGED_DURING_READ")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return stream.read()
    finally:
        os.close(fd)


def read_source(document, expected):
    uri = urlsplit(document.get("object_uri", ""))
    if uri.scheme != "file" or uri.netloc not in ("", "localhost") or uri.query or uri.fragment:
        raise AdminError("LOCAL_DOCUMENT_REQUIRED")
    path = Path(unquote(uri.path)).resolve()
    if path.is_relative_to(repository_root().resolve()):
        raise AdminError("RAW_SOURCE_MUST_BE_EXTERNAL")
    from orsem_worker.disclosures.xml_archive import ARCHIVE_LIMITS

    if not path.is_file() or path.stat().st_size > ARCHIVE_LIMITS["maxArchiveBytes"]:
        raise AdminError("SOURCE_SIZE_LIMIT")
    data = path.read_bytes()
    if (
        sha256(data) != expected
        or document.get("sha256") != expected
        or len(data) != int(document["byte_size"])
    ):
        raise AdminError("SOURCE_SHA_MISMATCH")
    return path, data


def json_value(value, default=None):
    if value is None:
        return default
    return json.loads(value) if isinstance(value, (str, bytes)) else value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_]+", value):
        raise AdminError("INVALID_IDENTIFIER")
    return "`" + value + "`"


def csv(rows, columns):
    def cell(value, opaque=False):
        text = (
            ""
            if value is None
            else json_text(value)
            if isinstance(value, (dict, list, bool))
            else str(value)
        )
        if text and (opaque or re.match(r"^[\s\ufeff]*[=+@-]|^[\t\r\n]", text)):
            text = "'" + text
        return '"' + text.replace('"', '""') + '"'

    columns = [{"key": c, "label": c} if isinstance(c, str) else c for c in columns]
    return (
        "\ufeff"
        + "\r\n".join(
            [
                ",".join(cell(c["label"]) for c in columns),
                *(
                    ",".join(cell(row.get(c["key"]), c.get("opaque", False)) for c in columns)
                    for row in rows
                ),
            ]
        )
        + "\r\n"
    )


class Connection:
    def __init__(self, raw):
        self.raw = raw

    async def query(self, sql, values=None):
        import asyncmy.cursors

        async with self.raw.cursor(asyncmy.cursors.DictCursor) as cursor:
            await cursor.execute(sql, values)
            return list(await cursor.fetchall())

    async def begin(self):
        await self.raw.begin()

    async def commit(self):
        await self.raw.commit()

    async def rollback(self):
        await self.raw.rollback()

    async def close(self):
        await self.raw.ensure_closed()

    async def insert(self, table, values):
        prepared = {
            k: json_text(v) if isinstance(v, (dict, list)) else v for k, v in values.items()
        }
        await self.query(
            "INSERT INTO "
            + identifier(table)
            + " ("
            + ",".join(map(identifier, prepared))
            + ") VALUES ("
            + ",".join("%s" for _ in prepared)
            + ")",
            tuple(prepared.values()),
        )

    async def update(self, table, values, where, params):
        prepared = {
            k: json_text(v) if isinstance(v, (dict, list)) else v for k, v in values.items()
        }
        await self.query(
            "UPDATE "
            + identifier(table)
            + " SET "
            + ",".join(identifier(k) + "=%s" for k in prepared)
            + " WHERE "
            + where,
            (*prepared.values(), *params),
        )


async def connect(url, socket_path=None, *, database=True):
    import asyncmy

    parsed = urlsplit(url)
    if parsed.scheme != "mysql" or database and not parsed.path.lstrip("/"):
        raise AdminError("MYSQL_DATABASE_URL_REQUIRED")
    socket_path = socket_path or parse_qs(parsed.query).get("unix_socket", [None])[0]
    options = {
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "charset": "utf8mb4",
        "connect_timeout": 10,
        "autocommit": False,
    }
    if database:
        options["db"] = unquote(parsed.path.lstrip("/"))
    if socket_path:
        options["unix_socket"] = socket_path
    raw = await asyncmy.connect(**options)
    connection = Connection(raw)
    await connection.query("SET SESSION time_zone='+00:00'")
    return connection
