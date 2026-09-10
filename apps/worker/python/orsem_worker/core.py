"""Shared infrastructure. Importing this module never connects to external services."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

logger = logging.getLogger("orsem.worker")


def utcnow() -> datetime:
    value = datetime.now(UTC)
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def db_time(value: datetime | None = None) -> datetime:
    value = value or utcnow()
    if value.tzinfo is not None:
        value = value.astimezone(UTC).replace(tzinfo=None)
    # Existing DATETIME(3) leases and JavaScript Dates use exact milliseconds.
    return value.replace(microsecond=(value.microsecond // 1000) * 1000)


def as_instant(value: datetime | str) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return as_instant(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def json_text(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), allow_nan=False, default=_json_default
    )


def decode_json(value: Any, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, (str, bytes, bytearray)):
        try:
            return json.loads(value)
        except (ValueError, UnicodeDecodeError):
            return default
    return value


def identifier() -> str:
    return str(uuid4())


def sha256(value: bytes | str) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


class Database:
    """Parameterized SQL on a shared async engine, with explicit transaction ownership."""

    def __init__(self, engine: Any, connection: Any = None):
        self.engine = engine
        self._connection = connection

    @classmethod
    def from_url(cls, url: str) -> Database:
        from sqlalchemy.ext.asyncio import create_async_engine

        if not url.startswith("mysql://"):
            raise ValueError("DATABASE_URL must use mysql://.")
        engine = create_async_engine(
            "mysql+asyncmy://" + url[len("mysql://") :],
            pool_pre_ping=True,
            pool_size=10,
            max_overflow=5,
            pool_recycle=1800,
            connect_args={"charset": "utf8mb4", "init_command": "SET time_zone = '+00:00'"},
            echo=False,
            hide_parameters=True,
        )
        return cls(engine)

    @staticmethod
    def _statement(sql: str, params: Mapping[str, Any] | None) -> tuple[Any, dict[str, Any]]:
        from sqlalchemy import bindparam, text

        statement = text(sql)
        values = dict(params or {})
        for key, value in values.items():
            if isinstance(value, (list, tuple, set)):
                statement = statement.bindparams(bindparam(key, expanding=True))
                values[key] = list(value)
            elif isinstance(value, datetime):
                values[key] = db_time(value)
        return statement, values

    async def fetch_all(
        self, sql: str, params: Mapping[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        statement, values = self._statement(sql, params)
        if self._connection is not None:
            result = await self._connection.execute(statement, values)
            return [dict(row) for row in result.mappings().all()]
        async with self.engine.connect() as connection:
            result = await connection.execute(statement, values)
            return [dict(row) for row in result.mappings().all()]

    async def fetch_one(
        self, sql: str, params: Mapping[str, Any] | None = None
    ) -> dict[str, Any] | None:
        rows = await self.fetch_all(sql, params)
        return rows[0] if rows else None

    async def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        statement, values = self._statement(sql, params)
        if self._connection is not None:
            result = await self._connection.execute(statement, values)
            return int(result.rowcount)
        async with self.engine.begin() as connection:
            result = await connection.execute(statement, values)
            return int(result.rowcount)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[Database]:
        if self._connection is not None:
            async with self._connection.begin_nested():
                yield self
        else:
            async with self.engine.begin() as connection:
                yield Database(self.engine, connection)

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[Database]:
        """Pin one session, including session-scoped advisory locks."""
        if self._connection is not None:
            yield self
        else:
            async with self.engine.connect() as connection:
                yield Database(self.engine, connection)
                await connection.commit()

    async def close(self) -> None:
        await self.engine.dispose()


Handler = Callable[[dict[str, Any]], Awaitable[Any]]


class RuntimeContext:
    def __init__(self, config: Any, db: Database, redis: Any, http: Any):
        self.config = config
        self.db = db
        self.redis = redis
        self.http = http
        self.services: dict[str, Any] = {}
        self.queues: dict[str, Any] = {}
        self.tasks: set[asyncio.Task[Any]] = set()
        self._close_hooks: list[Callable[[], Awaitable[Any]]] = []
        self.stopping = asyncio.Event()

    async def enqueue(
        self,
        queue_name: str,
        job_name: str,
        payload: dict[str, Any],
        options: dict[str, Any] | None = None,
    ) -> Any:
        return await self.queues[queue_name].add(job_name, payload, options or {})

    def on_close(self, callback: Callable[[], Awaitable[Any]]) -> None:
        self._close_hooks.append(callback)

    def periodic(
        self,
        name: str,
        seconds: float,
        callback: Callable[[], Awaitable[Any]],
        immediately: bool = True,
    ) -> asyncio.Task[Any]:
        async def run() -> None:
            if not immediately:
                try:
                    await asyncio.wait_for(self.stopping.wait(), seconds)
                    return
                except TimeoutError:
                    pass
            while not self.stopping.is_set():
                try:
                    await callback()
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - isolate jobs and redact provider credentials
                    # Provider errors may contain credentials in request URLs.
                    logger.error("Periodic task %s failed (%s)", name, type(error).__name__)
                try:
                    await asyncio.wait_for(self.stopping.wait(), seconds)
                except TimeoutError:
                    pass

        task = asyncio.create_task(run(), name=name)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def stop_periodics(self) -> None:
        """Stop producers while keeping services and shared I/O open for active jobs."""
        self.stopping.set()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self) -> None:
        await self.stop_periodics()
        errors: list[BaseException] = []
        for hook in reversed(self._close_hooks):
            try:
                await hook()
            except Exception as error:  # noqa: BLE001 - finish independent resource cleanup
                logger.error("Worker close hook failed (%s)", type(error).__name__)
                errors.append(error)
        closers = []
        for queue in self.queues.values():
            closers.append(queue.close())
        closers.extend((self.http.aclose(), self.redis.aclose(), self.db.close()))
        for result in await asyncio.gather(*closers, return_exceptions=True):
            if isinstance(result, BaseException):
                logger.error("Worker resource close failed (%s)", type(result).__name__)
                errors.append(result)
        if errors:
            raise RuntimeError("Worker resources did not all close.") from None
