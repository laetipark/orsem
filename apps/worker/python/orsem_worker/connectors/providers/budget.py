"""Transactional rolling request budgets shared by news APIs."""

from __future__ import annotations

import re
from datetime import UTC, datetime

from orsem_worker.core import utcnow

from ..common import Checkpoints, ConnectorRequestError, instant, iso


class NewsApiBudget:
    def __init__(self, ctx):
        self.ctx, self.store = ctx, Checkpoints(ctx.db)

    async def reserve(self, provider, daily, per_minute=None, now=None):
        now = now or utcnow()
        stamp = int(now.timestamp() * 1000)
        if (
            not isinstance(daily, int)
            or not 1 <= daily <= 1000
            or (per_minute is not None and (not isinstance(per_minute, int) or per_minute < 1))
        ):
            raise ValueError("Invalid news request budget.")
        async with self.ctx.db.transaction() as tx:
            metadata = await self.store.locked(tx, provider, "NEWS_API_BUDGET")
            reservations = metadata.get("reservations", [])
            if (
                not isinstance(reservations, list)
                or len(reservations) > 10000
                or any(not isinstance(v, (int, float)) or v < 0 for v in reservations)
            ):
                raise ValueError("Stored news budget invalid.")
            reservations = sorted(v for v in reservations if v > stamp - 86400000)
            retry = instant(metadata.get("retryAt"))
            recent = [v for v in reservations if v > stamp - 60000]
            blocked = [retry] if retry and retry > now else []
            if len(reservations) >= daily:
                blocked.append(
                    datetime.fromtimestamp((reservations[-daily] + 86400000) / 1000, UTC)
                )
            if per_minute and len(recent) >= per_minute:
                blocked.append(datetime.fromtimestamp((recent[-per_minute] + 60000) / 1000, UTC))
            if blocked:
                raise ConnectorRequestError(
                    provider, "news-budget", 429, retry_at=max(blocked), request_attempted=False
                )
            reservations.append(stamp)
            next_run = (
                datetime.fromtimestamp((reservations[-daily] + 86400000) / 1000, UTC)
                if len(reservations) >= daily
                else now
            )
            updated = {
                **metadata,
                "version": 1,
                "reservations": reservations,
                "retryAt": None,
                "lastError": None,
                "dailyRequestBudget": daily,
                "rollingRequestBudget": daily,
                "rollingRequestCount": len(reservations),
                "requestBudgetWindow": "ROLLING_24_HOURS",
            }
            await self.store.write(tx, provider, "NEWS_API_BUDGET", updated)
            await tx.execute(
                "INSERT INTO api_usage_counters (id,connector,usage_date,request_count,last_request_at,created_at,updated_at) VALUES (UUID(),:connector,:day,1,:now,:now,:now) ON DUPLICATE KEY UPDATE request_count=request_count+1,last_request_at=:now,updated_at=:now",
                {"connector": provider, "day": now.date(), "now": now},
            )
            return {**updated, "nextRunAt": iso(next_run)}

    async def defer(self, provider, retry_at, reason):
        if not re.fullmatch(r"[A-Z_0-9]{1,64}", reason):
            raise ValueError("Unsafe budget reason.")
        async with self.ctx.db.transaction() as tx:
            metadata = await self.store.locked(tx, provider, "NEWS_API_BUDGET")
            previous = instant(metadata.get("retryAt"))
            await self.store.write(
                tx,
                provider,
                "NEWS_API_BUDGET",
                {
                    **metadata,
                    "retryAt": iso(max(previous, retry_at) if previous else retry_at),
                    "lastError": reason,
                },
            )
