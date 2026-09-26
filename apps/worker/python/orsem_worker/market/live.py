"""Lossy live quotes: one Redis lease, bounded frames, no volume aggregation."""

import asyncio
import json
import logging
import random
import time
from datetime import timedelta

from orsem_worker.core import identifier, json_text, utcnow

from .common import PRIVATE, instant, iso, obj
from .toss import RELEASE, WS_URL, TossAccessBlocked, TossAuthCoolingDown, decimal

logger = logging.getLogger(__name__)


def trade_declaration(scopes):
    return [
        {
            "type": "trade:" + region,
            "codes": list(dict.fromkeys(s["symbol"] for s in scopes if s["region"] == region)),
        }
        for region in ("kr", "us")
        if any(s["region"] == region for s in scopes)
    ]


def quote_from_frame(raw, scopes, now):
    if not isinstance(raw, dict) or raw.get("type") != "message":
        return None
    scope = next(
        (s for s in scopes if raw.get("topic") == f"trade:{s['region']}:{s['symbol']}"), None
    )
    data = obj(raw.get("data"))
    if not scope or data.get("currency") != scope["currency"]:
        return None
    try:
        provider = instant(data.get("timestamp"))
        if provider > now + timedelta(minutes=1):
            return None
        price = decimal(data.get("price"), "trade price")
        decimal(data.get("volume"), "trade volume")
        return {
            "companyId": scope["companyId"],
            "symbol": scope["symbol"],
            "source": "TOSS_KR_INTEGRATED" if scope["region"] == "kr" else "TOSS_US",
            "currency": scope["currency"],
            "price": price,
            "providerAt": iso(provider),
            "observedAt": iso(now),
            "rightsMode": PRIVATE,
            "lossy": True,
            "rawPayload": raw,
        }
    except (ValueError, TypeError):
        return None


class LiveQuotes:
    def __init__(self, ctx, client, market):
        self.ctx, self.client, self.market = ctx, client, market
        self.owner = identifier()
        self.lease = False
        self.stopped = False
        self.socket = None
        self.scopes = []
        self.signature = ""
        self.rejected = set()
        self.connection_task = None
        self.retry_at = 0
        self.attempt = 0
        self.auth_refreshed = False
        self.subscription_retry_at = 0
        self.subscription_attempt = 0
        self.refresh_lock = asyncio.Lock()
        self.lease_key = f"{ctx.config.redisPrefix}market:toss:ws-leader"

    async def maintain_lease(self):
        if self.stopped:
            return
        try:
            await self.client.ensure_access()
            acquired = await self.ctx.redis.eval(
                "local v=redis.call('GET',KEYS[1]); if not v or v==ARGV[1] then redis.call('SET',KEYS[1],ARGV[1],'PX',30000); return 1 end return 0",
                1,
                self.lease_key,
                self.owner,
            )
            self.lease = int(acquired) == 1
            if not self.lease:
                await self.close_socket()
            elif self.connection_task is None and time.monotonic() >= self.retry_at:
                self.connection_task = asyncio.create_task(self.connect(), name="toss-websocket")
        except TossAccessBlocked:
            self.lease = False
            self.auth_refreshed = False
            await self.close_socket()
        except Exception:  # noqa: BLE001 - preserve independent connector operation
            self.lease = False
            await self.close_socket()
            logger.warning(
                "Toss live quote lease unavailable; REST candles remain independently scheduled."
            )

    async def refresh_scope(self):
        if (
            not self.lease
            or self.stopped
            or self.refresh_lock.locked()
            or time.monotonic() < self.subscription_retry_at
        ):
            return
        async with self.refresh_lock:
            candidates = await self.market.scope()
            previous = {s["companyId"] for s in self.scopes}
            self.scopes = [
                s for s in candidates if f"trade:{s['region']}:{s['symbol']}" not in self.rejected
            ][: self.ctx.config.tossMaxSubscriptions]
            declaration = json_text(trade_declaration(self.scopes))
            if declaration != self.signature and self.socket:
                await self.socket.send(declaration)
                self.signature = declaration
                added = [s for s in self.scopes if s["companyId"] not in previous]
                if added:
                    await self.initial_snapshot(added)

    async def ping(self):
        if self.socket:
            await self.socket.send("PING")

    async def connect(self):
        from websockets.asyncio.client import connect

        token = None
        try:
            await self.refresh_scope()
            if not self.scopes or not self.lease or self.stopped:
                return
            token = await self.client.access_token()
            await self.client.ensure_access()
            async with connect(
                WS_URL,
                additional_headers={"Authorization": f"Bearer {token}"},
                open_timeout=self.ctx.config.httpTimeoutMs / 1000,
                max_size=1_000_000,
                ping_interval=None,
            ) as socket:
                if not self.lease or self.stopped:
                    return
                self.socket = socket
                self.attempt = 0
                self.auth_refreshed = False
                self.signature = json_text(trade_declaration(self.scopes))
                await socket.send(self.signature)
                try:
                    await self.initial_snapshot(self.scopes)
                except TossAccessBlocked:
                    raise
                except Exception:  # noqa: BLE001 - preserve independent connector operation
                    logger.warning(
                        "Toss initial quote snapshot unavailable; live subscription continues."
                    )
                async for frame in socket:
                    await self.receive(frame)
        except asyncio.CancelledError:
            raise
        except TossAccessBlocked:
            self.auth_refreshed = False  # The shared client records the refusal once.
        except Exception as error:  # noqa: BLE001 - record per-source failure at runtime boundary
            response = getattr(error, "response", None)
            status = getattr(response, "status_code", None)
            try:
                await self.client.check_auth_response(
                    status, source="websocket", refreshed=self.auth_refreshed
                )
            except TossAuthCoolingDown:
                self.auth_refreshed = False
                return
            except TossAccessBlocked:
                return
            if status == 401 and token:
                self.auth_refreshed = True
                await self.client.invalidate_token(token)
            logger.warning(
                "Toss live quote connection unavailable; REST candles remain independently scheduled."
            )
        finally:
            self.socket = None
            self.connection_task = None
            self.retry_at = (
                time.monotonic() + min(60, 2 ** min(self.attempt, 6)) + random.random() / 2
            )
            self.attempt += 1

    async def initial_snapshot(self, scopes):
        try:
            prices = await self.client.prices([s["symbol"] for s in scopes])
        except TossAccessBlocked:
            await self.close_socket()
            raise
        for price in prices:
            scope = next(
                (
                    s
                    for s in scopes
                    if s["symbol"] == price["symbol"] and s["currency"] == price["currency"]
                ),
                None,
            )
            if not scope or not price.get("timestamp"):
                continue
            provider = instant(price["timestamp"])
            if provider > utcnow() + timedelta(minutes=1):
                continue
            await self.cache(
                {
                    "companyId": scope["companyId"],
                    "symbol": scope["symbol"],
                    "source": "TOSS_KR" if scope["region"] == "kr" else "TOSS_US",
                    "currency": scope["currency"],
                    "price": decimal(price["lastPrice"]),
                    "providerAt": iso(provider),
                    "observedAt": iso(utcnow()),
                    "rightsMode": PRIVATE,
                    "lossy": True,
                    "rawPayload": {"endpoint": "/api/v1/prices", **price},
                }
            )

    async def receive(self, text):
        if len(text) > 1_000_000 or not self.lease or self.stopped:
            return
        try:
            raw = json.loads(text)
        except (ValueError, TypeError):
            return
        if not isinstance(raw, dict):
            return
        if raw.get("type") == "subscriptions":
            self.subscription_attempt = 0
            rejected = raw.get("rejected", [])
            if isinstance(rejected, list):
                self.rejected.update(
                    r["target"]
                    for r in rejected
                    if isinstance(r, dict)
                    and isinstance(r.get("target"), str)
                    and isinstance(r.get("code"), str)
                )
            return
        if raw.get("type") == "error":
            code = obj(raw.get("error")).get("code")
            if code == "server-shutdown":
                await self.close_socket()
            elif code in ("internal-error", "rate-limit-exceeded"):
                self.signature = ""
                self.subscription_retry_at = time.monotonic() + min(
                    30, 1.1 * 2 ** min(self.subscription_attempt, 5)
                )
                self.subscription_attempt += 1
            return
        quote = quote_from_frame(raw, self.scopes, utcnow())
        if quote:
            await self.cache(quote)

    async def cache(self, quote):
        await self.ctx.redis.eval(
            "local old=redis.call('GET',KEYS[1]); if old then local p=cjson.decode(old); if p.providerAt>ARGV[2] then return 0 end end redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[3]); return 1",
            1,
            f"{self.ctx.config.redisPrefix}market:quote:{quote['companyId']}",
            json_text(quote),
            quote["providerAt"],
            86400,
        )

    async def close_socket(self):
        socket = self.socket
        self.socket = None
        if socket:
            await socket.close()

    async def close(self):
        self.stopped = True
        await self.close_socket()
        if self.connection_task:
            self.connection_task.cancel()
            await asyncio.gather(self.connection_task, return_exceptions=True)
        if self.lease:
            try:
                await self.ctx.redis.eval(RELEASE, 1, self.lease_key, self.owner)
            except Exception:  # noqa: BLE001 - preserve independent connector operation
                logger.warning("Toss lease will expire while Redis is stopping.")
        self.lease = False
