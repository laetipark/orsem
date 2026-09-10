"""Market storage helpers. Values are bound; identifiers are internal constants only."""

from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from itertools import islice
from typing import Any
from zoneinfo import ZoneInfo

from orsem_worker.core import db_time, identifier, json_text, utcnow

KR_MARKETS = ("KRX", "KOSPI", "KOSDAQ", "KONEX")
US_MARKETS = ("NASDAQ", "NYSE", "AMEX")
PRIVATE = "PRIVATE_DISPLAY_ONLY"
OFFICIAL = "OFFICIAL_PUBLIC_DATA"
GROUP_SQL = """SELECT DISTINCT gi.company_id AS companyId FROM watchlist_group_items gi
JOIN watchlist_groups g ON g.id=gi.group_id LEFT JOIN watchlist_rooms r ON r.id=g.room_id
WHERE (g.room_id IS NULL OR r.id IS NOT NULL) AND (
EXISTS (SELECT 1 FROM admins a WHERE COALESCE(r.owner_key,g.owner_key)=CONCAT('ADMIN:',a.id) AND a.is_active=1)
OR EXISTS (SELECT 1 FROM members m WHERE COALESCE(r.owner_key,g.owner_key)=CONCAT('MEMBER:',m.id) AND m.role='VIEWER' AND m.status='APPROVED'))"""
SELECTION_SQL = """SELECT DISTINCT m.company_id AS companyId FROM market_cap_memberships m
JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id
JOIN companies c ON c.id=m.company_id WHERE c.is_listed=1"""


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def instant(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value
    ):
        raise ValueError("Invalid provider instant")
    return datetime.fromisoformat(value).astimezone(UTC)


def day(value: datetime, zone: str = "Asia/Seoul") -> str:
    return instant(value).astimezone(ZoneInfo(zone)).date().isoformat()


def obj(value: Any) -> dict:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return {}
    return value if isinstance(value, dict) else {}


def date_text(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, date) else value


def camel(row: dict | None) -> dict:
    if row is None:
        return {}
    return {re.sub(r"_([a-z])", lambda m: m[1].upper(), k): v for k, v in row.items()}


def snake(key: str) -> str:
    return re.sub(r"[A-Z]", lambda m: "_" + m[0].lower(), key)


def in_params(values, prefix="p"):
    params = {f"{prefix}{i}": v for i, v in enumerate(values)}
    return ",".join(":" + k for k in params) or "NULL", params


def _insert_values(row, entity):
    values = {
        snake(k): (
            json_text(v)
            if isinstance(v, (dict, list))
            else db_time(v)
            if isinstance(v, datetime)
            else v
        )
        for k, v in row.items()
    }
    if entity:
        values.setdefault("id", identifier())
    return values


async def insert(db, table: str, row: dict, update: list[str] | None = None, entity=True):
    values = _insert_values(row, entity)
    assert all(re.fullmatch(r"[a-z_]+", key) for key in [table, *values])
    columns = ",".join("`" + k + "`" for k in values)
    sql = f"INSERT INTO `{table}` ({columns}) VALUES ({','.join(':' + k for k in values)})"
    if update is not None:
        updates = [snake(k) for k in update]
        sql += " ON DUPLICATE KEY UPDATE " + ",".join(f"`{k}`=VALUES(`{k}`)" for k in updates)
    await db.execute(sql, values)
    return values.get("id")


async def insert_many(db, table, rows, update=None, *, chunk_size=200, entity=True):
    """Bounded multi-row equivalent of insert; caller owns the transaction."""
    if type(chunk_size) is not int or not 1 <= chunk_size <= 500:
        raise ValueError("Invalid insert batch size")
    iterator = iter(rows)
    written = 0
    while batch := list(islice(iterator, chunk_size)):
        values = [_insert_values(row, entity) for row in batch]
        names = list(values[0])
        updates = [snake(key) for key in update] if update is not None else []
        if (
            not all(re.fullmatch(r"[a-z_]+", key) for key in [table, *names, *updates])
            or any(set(row) != set(names) for row in values)
            or any(key not in names for key in updates)
        ):
            raise ValueError("Inconsistent insert batch fields")
        columns = ",".join(f"`{name}`" for name in names)
        params = {f"b{i}_{name}": row[name] for i, row in enumerate(values) for name in names}
        arguments = ",".join(
            "(" + ",".join(f":b{i}_{name}" for name in names) + ")" for i in range(len(values))
        )
        sql = f"INSERT INTO `{table}` ({columns}) VALUES {arguments}"
        if update is not None:
            sql += " ON DUPLICATE KEY UPDATE " + ",".join(
                f"`{key}`=VALUES(`{key}`)" for key in updates
            )
        await db.execute(sql, params)
        written += len(batch)
    return written


async def update(db, table: str, row_id: str, patch: dict):
    if not patch:
        return
    values = {
        snake(k): (
            json_text(v)
            if isinstance(v, (dict, list))
            else db_time(v)
            if isinstance(v, datetime)
            else v
        )
        for k, v in patch.items()
    }
    sql = f"UPDATE `{table}` SET " + ",".join(f"`{k}`=:{k}" for k in values) + " WHERE id=:row_id"
    await db.execute(sql, {**values, "row_id": row_id})


async def checkpoint(db, connector, stream, metadata, at=None, date=None):
    at = at or utcnow()
    await insert(
        db,
        "source_checkpoints",
        {
            "connector": connector,
            "stream": stream,
            "checkpointCursor": None,
            "lastSuccessAt": at,
            "lastSuccessDate": date,
            "metadataJson": metadata,
        },
        ["checkpointCursor", "lastSuccessAt", "lastSuccessDate", "metadataJson"],
    )


async def read_checkpoint(db, connector, stream, lock=False):
    return camel(
        await db.fetch_one(
            "SELECT * FROM source_checkpoints WHERE connector=:connector AND stream=:stream"
            + (" FOR UPDATE" if lock else ""),
            {"connector": connector, "stream": stream},
        )
    )


@asynccontextmanager
async def named_lock(ctx, name: str, timeout=0):
    from orsem_worker.core import Database

    # The advisory lock outlives the write transaction on the same session.
    # Releasing before COMMIT allows a contender to observe the old checkpoint
    # and begin duplicate collection while the first writer still holds row locks.
    async with ctx.db.engine.connect() as connection:
        tx = Database(ctx.db.engine, connection)
        acquired = False
        try:
            row = await tx.fetch_one(
                "SELECT GET_LOCK(:name,:timeout) acquired", {"name": name, "timeout": timeout}
            )
            acquired = int((row or {}).get("acquired") or 0) == 1
            # GET_LOCK starts SQLAlchemy's implicit transaction. End it before
            # beginning the body transaction; COMMIT preserves session locks.
            await connection.commit()
            if acquired:
                async with connection.begin():
                    yield tx
            else:
                yield None
        finally:
            if acquired:
                try:
                    await tx.fetch_one("SELECT RELEASE_LOCK(:name) released", {"name": name})
                    await connection.commit()
                except BaseException:
                    # A pooled session must never retain an advisory lock after
                    # failed cleanup, including cancellation or connection loss.
                    await connection.invalidate()
                    raise


async def bounded_response(response, limit=4_000_000) -> bytes:
    length = 0
    chunks = []
    async for chunk in response.aiter_bytes():
        length += len(chunk)
        if length > limit:
            await response.aclose()
            raise ValueError("Provider response exceeded the size limit")
        chunks.append(chunk)
    return b"".join(chunks)


async def http_request(ctx, method, url, *, limit=4_000_000, **kwargs):
    kwargs.setdefault("timeout", ctx.config.httpTimeoutMs / 1000)
    kwargs["follow_redirects"] = False
    async with ctx.http.stream(method, url, **kwargs) as response:
        body = await bounded_response(response, limit)
        return response.status_code, response.headers, body
