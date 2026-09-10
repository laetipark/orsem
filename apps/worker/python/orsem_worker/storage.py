"""Explicit existing-schema adapter; never creates or synchronizes schema.

schema.json records the deployed TypeORM column contract. Only names from this
allowlist can be interpolated into SQL; values are always bound parameters.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from .core import db_time, decode_json, identifier, json_text

SCHEMA = json.loads(Path(__file__).with_name("schema.json").read_text())


def column(table: str, field: str) -> str:
    return SCHEMA[table][field]["name"]


def model(table: str, row: dict | None) -> dict | None:
    if row is None:
        return None
    result = {}
    for property_name, spec in SCHEMA[table].items():
        name = spec["name"]
        if name not in row:
            continue
        value = row[name]
        if spec.get("type") == "json":
            value = decode_json(value)
        elif spec.get("type") in ("boolean", "bool") and value is not None:
            value = bool(value)
        elif spec.get("type") == "date" and isinstance(value, date):
            value = value.isoformat()
        elif isinstance(value, Decimal):
            value = format(value, "f")
        result[property_name] = value
    return result


async def select(
    db, table: str, where: str = "1=1", params: dict | None = None, suffix: str = ""
) -> list:
    if table not in SCHEMA:
        raise ValueError("Unknown disclosure table")
    return [
        model(table, row)
        for row in await db.fetch_all(f"SELECT * FROM `{table}` WHERE {where} {suffix}", params)
    ]


async def one(
    db,
    table: str,
    where: str = "1=1",
    params: dict | None = None,
    lock: bool = False,
    order: str = "",
) -> dict | None:
    rows = await select(
        db,
        table,
        where,
        params,
        (f"ORDER BY {order} " if order else "") + "LIMIT 1" + (" FOR UPDATE" if lock else ""),
    )
    return rows[0] if rows else None


def bindings(table: str, values: dict) -> dict:
    result = {}
    for key, value in values.items():
        spec = SCHEMA[table][key]
        result[key] = (
            json_text(value)
            if spec.get("type") == "json" and value is not None
            else db_time(value)
            if isinstance(value, datetime)
            else value
        )
    return result


async def insert(db, table: str, values: dict, ignore: bool = False) -> dict:
    item = ({"id": identifier()} if "id" in SCHEMA[table] else {}) | values
    now = db_time()
    for key in ("createdAt", "updatedAt"):
        if key in SCHEMA[table] and key not in item:
            item[key] = now
    fields = ",".join(f"`{column(table, key)}`" for key in item)
    arguments = ",".join(":" + key for key in item)
    await db.execute(
        f"INSERT {'IGNORE ' if ignore else ''}INTO `{table}` ({fields}) VALUES ({arguments})",
        bindings(table, item),
    )
    return item


async def update(db, table: str, values: dict, where: str, params: dict | None = None) -> int:
    fields = {key: value for key, value in values.items() if key not in ("id", "createdAt")}
    if "updatedAt" in SCHEMA[table]:
        fields["updatedAt"] = db_time()
    arguments = bindings(table, fields)
    arguments = {"set_" + key: value for key, value in arguments.items()}
    return await db.execute(
        f"UPDATE `{table}` SET "
        + ",".join(f"`{column(table, key)}`=:set_{key}" for key in fields)
        + f" WHERE {where}",
        {**arguments, **(params or {})},
    )


async def save(db, table: str, item: dict) -> dict:
    if item.get("id"):
        await update(db, table, item, "id=:save_id", {"save_id": item["id"]})
        return item
    return await insert(db, table, item)
