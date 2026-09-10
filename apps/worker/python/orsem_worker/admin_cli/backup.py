"""Read-only production snapshots and hash-verified isolated restores."""

from __future__ import annotations

import json
import stat
from pathlib import Path

from dotenv import dotenv_values

from orsem_worker.core import json_text, sha256, utcnow

from .common import (
    AdminError,
    connect,
    encode,
    identifier,
    prepare_output,
    read_private,
    write_private,
)

RELATED_TABLES = json.loads(Path(__file__).with_name("backup_contract.json").read_text())


def ordered(rows, keys):
    return sorted(rows, key=lambda row: json_text([row[k] for k in keys]))


def normalized(value):
    """Match native JSON columns and stable SQL scalar encodings before hash comparison."""
    from datetime import date, datetime
    from decimal import Decimal

    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S") + (
            "." + f"{value.microsecond:06}"[:3] if value.microsecond else ""
        )
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    if isinstance(value, (bytes, bytearray)):
        return {"type": "Buffer", "data": list(value)}
    return value


async def table_rows(connection, name, columns):
    rows = await connection.query(
        "SELECT " + ",".join(map(identifier, columns)) + " FROM " + identifier(name)
    )
    fields = await connection.query("SHOW FULL COLUMNS FROM " + identifier(name))
    json_columns = {field["Field"] for field in fields if field["Type"].lower() == "json"}
    for row in rows:
        for key in json_columns:
            if isinstance(row.get(key), str):
                row[key] = json.loads(row[key])
    return normalized(rows)


async def backup(connection, output_directory):
    output = prepare_output(output_directory, empty=True)
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
    try:
        await connection.query("SELECT id FROM parse_runs LIMIT 1")
        clock = (await connection.query("SELECT UTC_TIMESTAMP(3) AS snapshot_utc"))[0]
        available = await connection.query(
            "SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
        )
        schemas = {}
        tables = {}
        for record in available:
            name = record["name"]
            schemas[name] = (await connection.query("SHOW CREATE TABLE " + identifier(name)))[0][
                "Create Table"
            ]
            if name not in RELATED_TABLES:
                continue
            fields = await connection.query("SHOW FULL COLUMNS FROM " + identifier(name))
            columns = [
                f["Field"]
                for f in fields
                if "GENERATED" not in f["Extra"]
                or not any(marker in f["Extra"] for marker in ("VIRTUAL", "STORED"))
            ]
            keys = await connection.query(
                "SHOW KEYS FROM " + identifier(name) + " WHERE Key_name='PRIMARY'"
            )
            primary = [
                key["Column_name"] for key in sorted(keys, key=lambda key: key["Seq_in_index"])
            ]
            if not primary:
                raise AdminError("BACKUP_REQUIRES_PRIMARY_KEY")
            rows = ordered(await table_rows(connection, name, columns), primary)
            tables[name] = {
                "columns": columns,
                "primaryKeys": primary,
                "count": len(rows),
                **write_private(output, name + ".json", rows, exclusive=True),
            }
        await connection.commit()
        schema_file = write_private(output, "schemas.json", schemas, exclusive=True)
        manifest = {
            "version": 1,
            "snapshotUtc": normalized(clock["snapshot_utc"]),
            "tables": tables,
            "schema": schema_file,
            "absentRelatedTables": [name for name in RELATED_TABLES if name not in tables],
            "note": "Related table data plus complete DDL. Other table data is not included. Original documents remain in external immutable storage.",
        }
        manifest_file = write_private(output, "manifest.json", manifest, exclusive=True)
        write_private(
            output,
            "backup-complete.json",
            {"manifestSha256": manifest_file["sha256"], "completedAt": utcnow().isoformat()},
            exclusive=True,
        )
        return {
            "output": str(output),
            "tables": len(tables),
            "rows": sum(t["count"] for t in tables.values()),
            "manifestSha256": manifest_file["sha256"],
        }
    except BaseException:
        await connection.rollback()
        raise


def read_verified_backup(directory):
    root = Path(directory).resolve()

    def read(name):
        if Path(name).name != name:
            raise AdminError("INVALID_BACKUP_PATH")
        return read_private(root / name)

    data = read("manifest.json")
    complete = json.loads(read("backup-complete.json"))
    if sha256(data) != complete["manifestSha256"]:
        raise AdminError("BACKUP_MANIFEST_HASH_MISMATCH")
    manifest = json.loads(data)
    if manifest.get("version") != 1:
        raise AdminError("BACKUP_VERSION_UNSUPPORTED")

    def verified(entry):
        content = read(entry["file"])
        if len(content) != entry["bytes"] or sha256(content) != entry["sha256"]:
            raise AdminError("BACKUP_FILE_HASH_MISMATCH")
        return json.loads(content)

    schemas = verified(manifest["schema"])
    tables = {}
    for name, entry in manifest["tables"].items():
        identifier(name)
        tables[name] = verified(entry)
        if len(tables[name]) != entry["count"]:
            raise AdminError("BACKUP_ROW_COUNT_MISMATCH")
    return {
        "manifest": manifest,
        "schemas": schemas,
        "tables": tables,
        "manifestSha256": sha256(data),
    }


async def restore_check(options):
    import re

    socket = Path(options.socket_path).resolve()
    if not socket.is_relative_to("/tmp") or not stat.S_ISSOCK(socket.stat().st_mode):
        raise AdminError("ISOLATED_TMP_SOCKET_REQUIRED")
    if not re.fullmatch(r"orsem_[a-z0-9_]+_test", options.database):
        raise AdminError("ISOLATED_TEST_DATABASE_REQUIRED")
    saved = read_verified_backup(options.backup_dir)
    output = prepare_output(options.output_dir, empty=True)
    connection = await connect("mysql://root@localhost/", str(socket), database=False)
    try:
        await connection.query(
            "CREATE DATABASE "
            + identifier(options.database)
            + " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )
        await connection.query("USE " + identifier(options.database))
        await connection.query("SET FOREIGN_KEY_CHECKS=0")
        for name, definition in saved["schemas"].items():
            # Verified hashes detect corruption; do not execute arbitrary statements masquerading as DDL.
            if not definition.startswith("CREATE TABLE " + identifier(name) + " "):
                raise AdminError("INVALID_BACKUP_DDL")
            await connection.query(definition)
        for name, rows in saved["tables"].items():
            columns = saved["manifest"]["tables"][name]["columns"]
            for row in rows:
                values = {
                    key: bytes(row[key]["data"])
                    if isinstance(row[key], dict) and row[key].get("type") == "Buffer"
                    else row[key]
                    for key in columns
                }
                await connection.insert(name, values)
        await connection.commit()
        await connection.query("SET FOREIGN_KEY_CHECKS=1")
        for name, rows in saved["tables"].items():
            entry = saved["manifest"]["tables"][name]
            restored = ordered(
                await table_rows(connection, name, entry["columns"]), entry["primaryKeys"]
            )
            if sha256(encode(restored)) != sha256(encode(rows)):
                raise AdminError("RESTORED_DATA_MISMATCH")
        proof = {
            "manifestSha256": saved["manifestSha256"],
            "verifiedAt": utcnow().isoformat(),
            "database": options.database,
            "socketPath": str(socket),
            "tablesVerified": list(saved["tables"]),
            "dataMatches": True,
        }
        write_private(output, "restore-proof.json", proof, exclusive=True)
        return proof
    finally:
        await connection.close()


async def run_backup(options):
    if options.mode == "restore-check":
        return await restore_check(options)
    values = dotenv_values(options.env_file, interpolate=False)
    url = values.get("DATABASE_URL")
    if not url:
        raise AdminError("MYSQL_URL_REQUIRED")
    connection = await connect(url)
    try:
        return await backup(connection, options.output_dir)
    finally:
        await connection.close()
