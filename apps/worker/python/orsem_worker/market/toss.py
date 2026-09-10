"""Read-only Toss REST client and price ingestion, including shared OAuth and pacing."""

from __future__ import annotations

import asyncio
import json
import random
import re
import time
from collections import Counter
from datetime import timedelta
from decimal import Decimal
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlencode

from orsem_worker.core import identifier, json_text, sha256, utcnow

from .common import (
    GROUP_SQL,
    KR_MARKETS,
    PRIVATE,
    SELECTION_SQL,
    US_MARKETS,
    camel,
    checkpoint,
    date_text,
    day,
    http_request,
    in_params,
    insert,
    insert_many,
    instant,
    iso,
    obj,
    read_checkpoint,
    update,
)

ORIGIN = "https://openapi.tossinvest.com"
WS_URL = "wss://openapi-ws.tossinvest.com/ws/v1"
ENDPOINTS = {
    "/api/v1/" + path
    for path in (
        "candles",
        "prices",
        "stocks",
        "stocks/all",
        "market-indicators/prices",
        "exchange-rate",
        "market-indicators/KOSPI/candles",
        "market-indicators/KOSDAQ/candles",
    )
}
RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0"


class TossHttpError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Toss HTTP {status}")


def decimal(raw, field="number"):
    if not isinstance(raw, str) or not re.fullmatch(r"\d+(?:\.\d+)?", raw) or len(raw) > 40:
        raise ValueError(f"Toss {field} is outside the nonnegative DECIMAL(38,6) contract.")
    whole, _, fraction = raw.partition(".")
    whole = whole.lstrip("0") or "0"
    fraction = fraction.rstrip("0")
    if len(whole) > 32 or len(fraction) > 6:
        raise ValueError(f"Toss {field} is outside the nonnegative DECIMAL(38,6) contract.")
    return whole + ("." + fraction if fraction else "")


def validate_stock(stock):
    if (
        not isinstance(stock, dict)
        or any(
            not isinstance(stock.get(k), str)
            for k in ("symbol", "name", "isinCode", "market", "status")
        )
        or not 1 <= len(stock["symbol"]) <= 32
        or stock.get("currency") not in ("USD", "KRW")
        or stock.get("englishName") is not None
        and not isinstance(stock["englishName"], str)
    ):
        raise ValueError("Toss response did not match the stock contract.")
    return stock


class TossClient:
    def __init__(self, ctx):
        self.ctx = ctx
        self.config = ctx.config
        self.token_key = (
            f"{self.config.redisPrefix}market:toss:oauth:"
            + sha256(f"{self.config.tossClientId or ''}:{self.config.tossClientSecret or ''}")[:24]
        )
        self.token_lock = asyncio.Lock()
        self.closed = False

    @property
    def enabled(self):
        return self.config.marketDataProvider == "toss" and bool(
            self.config.tossClientId and self.config.tossClientSecret
        )

    async def cached_token(self):
        cached = obj(await self.ctx.redis.get(self.token_key))
        return (
            cached.get("token")
            if isinstance(cached.get("token"), str)
            and isinstance(cached.get("expiresAt"), (int, float))
            and cached["expiresAt"] > time.time() * 1000 + 60_000
            else None
        )

    async def access_token(self):
        if not self.enabled:
            raise RuntimeError("Toss credentials are not configured or the provider is disabled.")
        async with self.token_lock:
            key, owner = self.token_key + ":lock", identifier()
            deadline = time.monotonic() + self.config.httpTimeoutMs / 500 + 30
            while not self.closed and time.monotonic() < deadline:
                cached = await self.cached_token()
                if cached:
                    return cached
                if not await self.ctx.redis.set(
                    key, owner, px=self.config.httpTimeoutMs + 15000, nx=True
                ):
                    await asyncio.sleep(0.15)
                    continue
                try:
                    cached = await self.cached_token()
                    if cached:
                        return cached
                    status, _, body = await http_request(
                        self.ctx,
                        "POST",
                        ORIGIN + "/oauth2/token",
                        data={
                            "grant_type": "client_credentials",
                            "client_id": self.config.tossClientId,
                            "client_secret": self.config.tossClientSecret,
                        },
                        headers={"Accept": "application/json"},
                    )
                    if not 200 <= status < 300:
                        raise TossHttpError(status)
                    token = json.loads(body)
                    if (
                        not isinstance(token.get("access_token"), str)
                        or not token["access_token"]
                        or token.get("token_type") != "Bearer"
                        or type(token.get("expires_in")) is not int
                        or token["expires_in"] <= 0
                    ):
                        raise ValueError("Toss token response did not match contract.")
                    await self.ctx.redis.set(
                        self.token_key,
                        json_text(
                            {
                                "token": token["access_token"],
                                "expiresAt": time.time() * 1000 + token["expires_in"] * 1000,
                            }
                        ),
                        px=token["expires_in"] * 1000,
                    )
                    return token["access_token"]
                finally:
                    await self.ctx.redis.eval(RELEASE, 1, key, owner)
            raise RuntimeError("Timed out waiting for the shared Toss token.")

    async def invalidate_token(self, token):
        await self.ctx.redis.eval(
            "local v=redis.call('GET',KEYS[1]); if v and cjson.decode(v).token==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
            1,
            self.token_key,
            token,
        )

    async def pace(self, endpoint):
        group = (
            "stock-all"
            if endpoint.endswith("/stocks/all")
            else "stock"
            if endpoint.endswith("/stocks")
            else ("indicator-chart" if endpoint.endswith("/candles") else "indicator")
            if "/market-indicators/" in endpoint
            else "info"
            if endpoint.endswith("/exchange-rate")
            else "chart"
            if endpoint.endswith("/candles")
            else "data"
        )
        while not self.closed:
            wait = await self.ctx.redis.eval(
                "local now=tonumber(ARGV[1]); local next=tonumber(redis.call('GET',KEYS[1]) or '0'); if next>now then return next-now end redis.call('SET',KEYS[1],now+tonumber(ARGV[2]),'PX',2000); return 0",
                1,
                f"{self.config.redisPrefix}market:toss:pace:{group}",
                int(time.time() * 1000),
                1000 if group == "stock-all" else 300,
            )
            if float(wait) <= 0:
                return
            await asyncio.sleep(min(float(wait) / 1000, 1))
        raise RuntimeError("Toss client is stopping.")

    async def get(self, endpoint, params):
        if endpoint not in ENDPOINTS:
            raise ValueError("Unsupported Toss market-data endpoint.")
        refreshed = False
        for attempt in range(4):
            token = await self.access_token()
            await self.pace(endpoint)
            status, headers, body = await http_request(
                self.ctx,
                "GET",
                ORIGIN + endpoint,
                params=params,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
            if 200 <= status < 300:
                try:
                    return json.loads(body)
                except ValueError:
                    raise ValueError("Toss returned invalid JSON.") from None
            if status == 401 and not refreshed:
                refreshed = True
                await self.invalidate_token(token)
                continue
            if (status == 429 or status >= 500) and attempt < 3:
                retry = headers.get("retry-after")
                try:
                    wait = (
                        float(retry)
                        if retry and re.fullmatch(r"\d+(?:\.\d+)?", retry)
                        else parsedate_to_datetime(retry).timestamp() - time.time()
                    )
                    wait = max(1, wait)
                except (TypeError, ValueError):
                    wait = 2**attempt + random.random() / 2
                if wait > 60:
                    raise TossHttpError(status)
                await asyncio.sleep(wait)
                continue
            raise TossHttpError(status)
        raise RuntimeError("Toss request retry limit reached.")

    async def candle_page(self, symbol, interval, before=None):
        if interval not in ("1d", "1m"):
            raise ValueError("Invalid candle interval")
        payload = obj(
            await self.get(
                "/api/v1/candles",
                {
                    "symbol": symbol,
                    "interval": interval,
                    "count": "200",
                    "adjusted": "false",
                    **({"before": before} if before else {}),
                },
            )
        ).get("result")
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("candles"), list)
            or len(payload["candles"]) > 200
        ):
            raise ValueError("Invalid Toss candle page")
        if payload.get("nextBefore"):
            instant(payload["nextBefore"])
        return payload

    async def stocks(self, symbols):
        if not symbols:
            return []
        if len(symbols) > 200:
            raise ValueError("Toss stock lookup supports at most 200 symbols.")
        rows = obj(await self.get("/api/v1/stocks", {"symbols": ",".join(symbols)})).get("result")
        if not isinstance(rows, list) or len(rows) > 200:
            raise ValueError("Invalid stock response")
        return [validate_stock(row) for row in rows]

    async def stocks_all(self, market, status="ACTIVE", security_type=None):
        if (
            market not in ("KOSPI", "KOSDAQ", "NYSE", "NASDAQ", "AMEX", "KR_ETC", "US_ETC")
            or status not in ("ACTIVE", "DELISTED")
            or security_type not in (None, "ETF")
        ):
            raise ValueError("Invalid stock universe filter")
        rows = obj(
            await self.get(
                "/api/v1/stocks/all",
                {
                    "market": market,
                    "status": status,
                    **({"securityType": security_type} if security_type else {}),
                },
            )
        ).get("result")
        if not isinstance(rows, list) or len(rows) > 20000:
            raise ValueError("Invalid stock universe response")
        for row in rows:
            if (
                not isinstance(row, dict)
                or any(
                    not isinstance(row.get(k), str)
                    for k in ("symbol", "name", "securityType", "isinCode")
                )
                or not 1 <= len(row["symbol"]) <= 32
                or type(row.get("isCommonShare")) is not bool
            ):
                raise ValueError("Invalid listed stock contract")
        return rows

    async def prices(self, symbols):
        if not symbols:
            return []
        if len(symbols) > 200:
            raise ValueError("Toss price lookup supports at most 200 symbols.")
        rows = obj(await self.get("/api/v1/prices", {"symbols": ",".join(symbols)})).get("result")
        if not isinstance(rows, list) or len(rows) > 200:
            raise ValueError("Invalid price response")
        for row in rows:
            if (
                not isinstance(row, dict)
                or not isinstance(row.get("symbol"), str)
                or row.get("currency") not in ("USD", "KRW")
            ):
                raise ValueError("Invalid price contract")
            decimal(row.get("lastPrice"))
            if row.get("timestamp") is not None:
                instant(row["timestamp"])
        return rows

    async def close(self):
        self.closed = True


def company_scope(company, priority=None):
    if not company.get("isListed"):
        return None
    code, ticker = company.get("stockCode"), (company.get("ticker") or "").strip().upper()
    region = (
        "kr"
        if company["market"] in KR_MARKETS and code and re.fullmatch(r"[0-9A-Z]{6}", code)
        else "us"
        if company["market"] in US_MARKETS and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", ticker)
        else None
    )
    return (
        {
            "companyId": company["id"],
            "symbol": code if region == "kr" else ticker,
            "region": region,
            "currency": "KRW" if region == "kr" else "USD",
            "priority": priority,
        }
        if region
        else None
    )


def normalize_candle(scope, interval, raw, observed_at):
    if not isinstance(raw, dict) or raw.get("currency") != scope["currency"]:
        raise ValueError("Toss currency mismatch.")
    at = instant(raw.get("timestamp"))
    if at > observed_at + timedelta(minutes=1):
        raise ValueError("Toss candle starts in the future.")
    values = {
        key: decimal(raw.get(field), key)
        for key, field in [
            ("open", "openPrice"),
            ("high", "highPrice"),
            ("low", "lowPrice"),
            ("close", "closePrice"),
            ("volume", "volume"),
        ]
    }
    o, h, l, c, v = (Decimal(values[k]) for k in ("open", "high", "low", "close", "volume"))
    no_trades = o == h == l == v == 0
    if not no_trades and (h < max(o, l, c) or l > min(o, c)):
        raise ValueError("Toss returned an invalid OHLC envelope.")
    return {
        "companyId": scope["companyId"],
        "interval": interval,
        "barAt": at,
        "sessionDate": day(at, "Asia/Seoul" if scope["region"] == "kr" else "America/New_York"),
        **values,
        "currency": raw["currency"],
        "source": "TOSS_KR" if scope["region"] == "kr" else "TOSS_US",
        "rightsMode": PRIVATE,
        "rawPayloadJson": dict(raw),
        "observedAt": observed_at,
        "provenanceJson": {
            "provider": "TOSS",
            "endpoint": "/api/v1/candles",
            "symbol": scope["symbol"],
            "interval": interval,
            "adjusted": False,
            "adjustment": "RAW",
            "providerTimestamp": raw["timestamp"],
            "exchangeCoverage": "PROVIDER_UNSPECIFIED",
            "observedAt": iso(observed_at),
            "noTrades": no_trades,
            "complete": at + timedelta(minutes=1) <= observed_at if interval == "1m" else None,
        },
    }


def plan_view_fetch(scope, payload, metadata, now):
    full = 3 if payload["interval"] == "1d" else 6
    if (
        payload.get("reason") != "VIEW"
        or payload.get("before")
        or payload.get("maxPages", full) < full
    ):
        return dict(payload), None, None
    policy = {
        "version": 1,
        "source": "TOSS_KR" if scope["region"] == "kr" else "TOSS_US",
        "symbol": scope["symbol"],
        "interval": payload["interval"],
        "adjusted": False,
        "lookbackDays": payload.get("lookbackDays", 366 if payload["interval"] == "1d" else 7),
        "maximumBars": 400 if payload["interval"] == "1d" else 1000,
    }
    history = obj(obj(metadata).get("viewHistory"))
    try:
        hydrated, refreshed = (
            instant(history.get("hydratedAt")),
            instant(history.get("refreshedAt")),
        )
        elapsed = (now - refreshed).total_seconds()
        if (
            all(history.get(k) == v for k, v in policy.items())
            and hydrated <= refreshed
            and 0 <= elapsed < 180 * (86400 if payload["interval"] == "1d" else 60)
        ):
            return {**payload, "maxPages": 1}, policy, history["hydratedAt"]
    except (ValueError, TypeError):
        pass
    return {**payload, "maxPages": payload.get("maxPages", full)}, policy, None


def matches_company(company, stock):
    if not company.get("isListed"):
        return False
    if company["market"] in US_MARKETS:
        return (
            company.get("ticker") == stock["symbol"]
            and company["market"] == stock["market"]
            and stock["currency"] == "USD"
        )
    return (
        company.get("stockCode") == stock["symbol"]
        and company["market"] in KR_MARKETS
        and stock["market"] in ("KOSPI", "KOSDAQ", "KR_ETC")
        and stock["currency"] == "KRW"
    )


def display_name(value):
    return re.sub(r"[\x00-\x1f\x7f-\x9f]", "", value or "").strip()[:255] or None


def company_name_patch(company, stock, previous):
    if company["market"] not in US_MARKETS or not matches_company(company, stock):
        return {}
    patch = {}
    name = display_name(stock["name"])
    korean = r"[가-힣ㄱ-ㅎㅏ-ㅣ]"
    if (
        name
        and re.search(korean, name)
        and (
            not re.search(korean, company["nameKo"])
            or obj(previous).get("appliedNameKo") == company["nameKo"]
        )
        and name != company["nameKo"]
    ):
        patch["nameKo"] = name
    if not (company.get("nameEn") or "").strip() and display_name(stock.get("englishName")):
        patch["nameEn"] = display_name(stock["englishName"])
    return patch


class StockInfo:
    def __init__(self, ctx, client):
        self.ctx, self.client = ctx, client

    async def available(self, symbols):
        try:
            return await self.client.stocks(symbols)
        except TossHttpError as error:
            if error.status != 404:
                raise
            if len(symbols) == 1:
                return []
            middle = (len(symbols) + 1) // 2
            return await self.available(symbols[:middle]) + await self.available(symbols[middle:])

    async def persist(self, scope, stock, now, cached=False):
        async with self.ctx.db.transaction() as tx:
            company = camel(
                await tx.fetch_one(
                    "SELECT * FROM companies WHERE id=:id FOR UPDATE", {"id": scope["companyId"]}
                )
            )
            if not company or not matches_company(company, stock):
                return False
            old = await read_checkpoint(tx, "TOSS", "STOCK_INFO:" + company["id"], True)
            metadata = obj(old.get("metadataJson"))
            old_stock = obj(metadata.get("rawPayload"))
            if old_stock and old_stock.get("isinCode") != stock["isinCode"]:
                return False
            patch = company_name_patch(company, stock, metadata)
            await update(tx, "companies", company["id"], patch)
            if cached:
                if patch:
                    await update(
                        tx,
                        "source_checkpoints",
                        old["id"],
                        {
                            "metadataJson": {
                                **metadata,
                                "originalCompanyNames": metadata.get(
                                    "originalCompanyNames",
                                    {"nameKo": company["nameKo"], "nameEn": company.get("nameEn")},
                                ),
                                "appliedNameKo": patch.get("nameKo", metadata.get("appliedNameKo")),
                            }
                        },
                    )
                return True
            await checkpoint(
                tx,
                "TOSS",
                "STOCK_INFO:" + company["id"],
                {
                    "version": 1,
                    "companyId": company["id"],
                    "symbol": stock["symbol"],
                    "source": "TOSS",
                    "rightsMode": PRIVATE,
                    "provenanceUrl": ORIGIN
                    + "/api/v1/stocks?"
                    + urlencode({"symbols": stock["symbol"]}),
                    "rawPayload": stock,
                    "firstObservedAt": metadata.get("firstObservedAt", iso(now)),
                    "observedAt": iso(now),
                    "originalCompanyNames": metadata.get(
                        "originalCompanyNames",
                        {"nameKo": company["nameKo"], "nameEn": company.get("nameEn")},
                    ),
                    "appliedNameKo": patch.get("nameKo", metadata.get("appliedNameKo")),
                },
                now,
                day(now),
            )
            return True

    async def lookup(self, scopes):
        if not self.client.enabled or not scopes:
            return {}
        if len(scopes) > 100 or len({s["symbol"] for s in scopes}) != len(scopes):
            raise ValueError("Toss stock information scope is oversized or ambiguous.")
        now, result, missing = utcnow(), {}, []
        for scope in scopes:
            company = camel(
                await self.ctx.db.fetch_one(
                    "SELECT * FROM companies WHERE id=:id AND is_listed=1",
                    {"id": scope["companyId"]},
                )
            )
            if not company:
                continue
            old = await read_checkpoint(self.ctx.db, "TOSS", "STOCK_INFO:" + company["id"])
            stock = obj(obj(old.get("metadataJson")).get("rawPayload"))
            try:
                validate_stock(stock)
                age = (now - instant(old.get("lastSuccessAt"))).total_seconds()
                valid = (
                    stock["symbol"] == scope["symbol"]
                    and stock["status"] == "ACTIVE"
                    and matches_company(company, stock)
                    and 0 <= age < 86400
                )
            except (ValueError, TypeError):
                valid = False
            if valid and await self.persist(scope, stock, now, True):
                result[scope["symbol"]] = stock
            else:
                missing.append(scope)
        response = await self.available([s["symbol"] for s in missing]) if missing else []
        requested = {s["symbol"]: s for s in missing}
        if len({s["symbol"] for s in response}) != len(response) or any(
            s["symbol"] not in requested for s in response
        ):
            raise ValueError("Toss stock lookup returned an unrequested or duplicate symbol.")
        for stock in response:
            if stock["status"] == "ACTIVE" and await self.persist(
                requested[stock["symbol"]], stock, now
            ):
                result[stock["symbol"]] = stock
        return result


class MarketData:
    def __init__(self, ctx, client, stocks):
        self.ctx, self.client, self.stocks = ctx, client, stocks

    async def scope(self, company_ids=None):
        watches = [
            camel(r)
            for r in await self.ctx.db.fetch_all(
                "SELECT company_id,priority FROM watchlist_items WHERE priority IN ('P1','P2')"
            )
        ]
        priorities = {r["companyId"]: r["priority"] for r in watches}
        grouped = (
            await self.ctx.db.fetch_all(GROUP_SQL + " ORDER BY companyId")
            if company_ids is None
            else []
        )
        automatic = await self.ctx.db.fetch_all(SELECTION_SQL) if company_ids is None else []
        requested = (
            list(company_ids)
            if company_ids is not None
            else [r["companyId"] for r in watches + grouped]
        )
        if self.client.enabled:
            redis, key, now = (
                self.ctx.redis,
                f"{self.ctx.config.redisPrefix}market:toss:active",
                int(time.time() * 1000),
            )
            if company_ids:
                await redis.zadd(key, {v: now for v in company_ids})
                await redis.expire(key, 600)
            elif company_ids is None:
                await redis.zremrangebyscore(key, "-inf", now - 300000)
                requested = (
                    list(await redis.zrevrangebyscore(key, "+inf", now - 300000, start=0, num=100))
                    + requested
                )
        ids = list(dict.fromkeys([r["companyId"] for r in automatic] + requested))[
            : self.ctx.config.tossMaxSubscriptions
        ]
        marks, params = in_params(ids)
        companies = (
            [
                camel(r)
                for r in await self.ctx.db.fetch_all(
                    f"SELECT * FROM companies WHERE id IN ({marks}) AND is_listed=1", params
                )
            ]
            if ids
            else []
        )
        scopes = [
            s for c in companies if (s := company_scope(c, priorities.get(c["id"]))) is not None
        ]
        counts = Counter((s["region"], s["symbol"]) for s in scopes)
        return sorted(
            [s for s in scopes if counts[(s["region"], s["symbol"])] == 1],
            key=lambda s: ids.index(s["companyId"]),
        )

    async def sync_stocks(self, company_ids=None):
        if not self.client.enabled:
            return {"disabled": True, "connector": "TOSS"}
        if company_ids is not None and len(company_ids) > 100:
            raise ValueError("Toss stock information scope exceeds 100 companies.")
        if company_ids is None:
            watches = await self.ctx.db.fetch_all(
                "SELECT company_id companyId FROM watchlist_items ORDER BY priority ASC,created_at DESC LIMIT 100"
            )
            recent = await self.ctx.db.fetch_all(
                "SELECT stream FROM source_checkpoints WHERE connector='TOSS' AND stream LIKE 'PRICE_BARS:%' ORDER BY last_success_at DESC LIMIT 200"
            )
            selected = await self.ctx.db.fetch_all(SELECTION_SQL)
            grouped = await self.ctx.db.fetch_all(GROUP_SQL + " ORDER BY companyId")
            company_ids = list(
                dict.fromkeys(
                    [r["companyId"] for r in selected + watches + grouped]
                    + [
                        r["stream"].split(":")[-1]
                        for r in recent
                        if re.fullmatch(r"[0-9a-f-]{36}", r["stream"].split(":")[-1], re.IGNORECASE)
                    ]
                )
            )[:100]
        ids = list(dict.fromkeys(company_ids))
        marks, params = in_params(ids)
        companies = (
            [
                camel(r)
                for r in await self.ctx.db.fetch_all(
                    f"SELECT * FROM companies WHERE id IN ({marks}) AND is_listed=1", params
                )
            ]
            if ids
            else []
        )
        scopes = [s for c in companies if (s := company_scope(c)) is not None]
        counts = Counter(s["symbol"] for s in scopes)
        scopes = sorted(
            [s for s in scopes if counts[s["symbol"]] == 1], key=lambda s: ids.index(s["companyId"])
        )
        stocks = await self.stocks.lookup(scopes)
        return {
            "connector": "TOSS",
            "stream": "STOCK_INFO",
            "companiesRequested": len(scopes),
            "companiesAvailable": len(stocks),
            "unavailableSymbols": [s["symbol"] for s in scopes if s["symbol"] not in stocks],
            "withoutKoreanNames": [
                s["symbol"]
                for s in scopes
                if s["region"] == "us"
                and s["symbol"] in stocks
                and not re.search(r"[가-힣ㄱ-ㅎㅏ-ㅣ]", stocks[s["symbol"]]["name"])
            ],
            "excludedCompanyIds": [i for i in ids if not any(s["companyId"] == i for s in scopes)],
        }

    async def fetch_candles(self, scope, payload):
        now = utcnow()
        interval = payload["interval"]
        maximum = 400 if interval == "1d" else 1000
        pages = payload.get("maxPages", 3 if interval == "1d" else 6)
        cutoff = now - timedelta(days=payload.get("lookbackDays", 366 if interval == "1d" else 7))
        rows: dict[Any, dict[str, Any]] = {}
        before = payload.get("before")
        cursors = set()
        for page in range(pages):
            response = await self.client.candle_page(scope["symbol"], interval, before)
            oldest = None
            added = 0
            for raw in response["candles"]:
                row = normalize_candle(scope, interval, raw, now)
                at = row["barAt"]
                if before and at > instant(before):
                    raise ValueError("Toss candle exceeds the requested inclusive cursor.")
                oldest = min(oldest, at) if oldest else at
                if at < cutoff or at in rows or len(rows) >= maximum:
                    continue
                rows[at] = row
                added += 1
            cursor = response.get("nextBefore")
            if (
                not cursor
                or not response["candles"]
                or oldest is not None
                and oldest < cutoff
                or len(rows) >= maximum
            ):
                break
            if (
                cursor in cursors
                or before
                and instant(cursor) >= instant(before)
                or page > 0
                and not added
            ):
                raise ValueError("Toss candle pagination made no progress.")
            cursors.add(cursor)
            before = cursor
        return [rows[key] for key in sorted(rows)]

    def safe_error(self, error):
        message = str(error)
        for secret in (self.ctx.config.tossClientId, self.ctx.config.tossClientSecret):
            if secret:
                message = message.replace(secret, "[REDACTED]")
        return message[:2000]

    async def health(self, status, message, metadata):
        old = camel(
            await self.ctx.db.fetch_one("SELECT * FROM connector_health WHERE connector='toss'")
        )
        now = utcnow()
        row = {
            "connector": "toss",
            "status": status,
            "message": message,
            "checkedAt": now,
            "lastSuccessAt": now if status == "HEALTHY" else old.get("lastSuccessAt"),
            "lastFailureAt": now if status == "FAILED" else old.get("lastFailureAt"),
            "metadataJson": {
                **obj(old.get("metadataJson")),
                **metadata,
                "healthSource": "TOSS_INGESTION",
                "rightsMode": PRIVATE,
                "provider": "TOSS",
            },
        }
        await insert(self.ctx.db, "connector_health", row, list(row))

    async def ingest(self, payload):
        if not self.client.enabled:
            return {"disabled": True, "connector": "TOSS"}
        run = await insert(
            self.ctx.db,
            "ingestion_runs",
            {
                "connector": "TOSS",
                "stream": "PRICE_BARS:" + payload["interval"],
                "status": "PROCESSING",
                "itemsSeen": "0",
                "itemsCreated": "0",
                "startedAt": utcnow(),
                "finishedAt": None,
                "errorMessage": None,
            },
        )
        saved = created = succeeded = 0
        failures = []
        try:
            scopes = await self.scope(payload.get("companyIds"))
            stocks = await self.stocks.lookup(scopes)
            for scope in scopes:
                if scope["symbol"] not in stocks:
                    failures.append(
                        scope["symbol"] + ": unavailable or inconsistent stock identity"
                    )
                    continue
                try:
                    stream = f"PRICE_BARS:{payload['interval']}:{scope['companyId']}"
                    old = (
                        await read_checkpoint(self.ctx.db, "TOSS", stream)
                        if payload.get("reason") == "VIEW"
                        else {}
                    )
                    plan, policy, hydrated = plan_view_fetch(
                        scope, payload, obj(old.get("metadataJson")), utcnow()
                    )
                    bars = await self.fetch_candles(scope, plan)
                    if not bars:
                        failures.append(scope["symbol"] + ": no bars in the requested range")
                        continue
                    async with self.ctx.db.transaction() as tx:
                        marks, params = in_params([b["barAt"].replace(tzinfo=None) for b in bars])
                        existing = await tx.fetch_all(
                            f"SELECT bar_at FROM price_bars WHERE company_id=:company AND source=:source AND `interval`=:interval AND bar_at IN ({marks})",
                            {
                                **params,
                                "company": scope["companyId"],
                                "source": bars[0]["source"],
                                "interval": payload["interval"],
                            },
                        )
                        for bar in bars:
                            bar["provenanceJson"]["stock"] = stocks[scope["symbol"]]
                        await insert_many(
                            tx,
                            "price_bars",
                            bars,
                            [
                                "open",
                                "high",
                                "low",
                                "close",
                                "volume",
                                "currency",
                                "rightsMode",
                                "sessionDate",
                                "rawPayloadJson",
                                "provenanceJson",
                                "observedAt",
                            ],
                            chunk_size=200,
                        )
                        current = await read_checkpoint(tx, "TOSS", stream, True)
                        latest = bars[-1]
                        completed = utcnow()
                        advance = not current.get("lastSuccessDate") or latest[
                            "sessionDate"
                        ] >= date_text(current["lastSuccessDate"])
                        metadata = obj(current.get("metadataJson"))
                        if advance:
                            metadata.update(
                                {
                                    "companyId": scope["companyId"],
                                    "symbol": scope["symbol"],
                                    "source": latest["source"],
                                    "interval": payload["interval"],
                                    "adjusted": False,
                                    "rows": len(bars),
                                    "latestBarAt": iso(latest["barAt"]),
                                }
                            )
                        if policy:
                            metadata["viewHistory"] = {
                                **policy,
                                "hydratedAt": hydrated or iso(completed),
                                "refreshedAt": iso(completed),
                            }
                        await checkpoint(
                            tx,
                            "TOSS",
                            stream,
                            metadata,
                            completed,
                            latest["sessionDate"] if advance else current["lastSuccessDate"],
                        )
                    saved += len(bars)
                    created += len(bars) - len(existing)
                    succeeded += 1
                except Exception as error:  # noqa: BLE001 - record per-source failure at runtime boundary
                    failures.append(scope["symbol"] + ": " + self.safe_error(error))
            if failures and not succeeded:
                raise RuntimeError("; ".join(failures[:5]))
            await update(
                self.ctx.db,
                "ingestion_runs",
                run,
                {
                    "status": "COMPLETED",
                    "itemsSeen": str(saved),
                    "itemsCreated": str(created),
                    "finishedAt": utcnow(),
                    "errorMessage": "; ".join(failures[:5]) or None,
                },
            )
            await self.health(
                "DEGRADED" if failures or not saved else "HEALTHY",
                "; ".join(failures[:3])
                or ("No eligible watchlist or active-page companies." if not saved else None),
                {
                    "interval": payload["interval"],
                    "rows": saved,
                    "companiesSucceeded": succeeded,
                    "companiesFailed": len(failures),
                },
            )
            return {
                "connector": "TOSS",
                "interval": payload["interval"],
                "rows": saved,
                "itemsCreated": created,
                "companiesSucceeded": succeeded,
                "companiesFailed": len(failures),
            }
        except Exception as error:  # noqa: BLE001 - record per-source failure at runtime boundary
            message = self.safe_error(error)
            await update(
                self.ctx.db,
                "ingestion_runs",
                run,
                {"status": "FAILED", "finishedAt": utcnow(), "errorMessage": message},
            )
            await self.health("FAILED", message, {"interval": payload["interval"]})
            raise RuntimeError(message) from None
