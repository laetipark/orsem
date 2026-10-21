"""Native market indicator observations, bounded acquisition and publication."""

from __future__ import annotations

import asyncio
import json
import re
import time
from bisect import bisect_left
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from defusedxml import ElementTree

from orsem_worker.core import utcnow

from .common import camel, date_text, day, http_request, insert, insert_many, instant, iso, obj

CATALOG = json.loads(Path(__file__).with_name("catalog.json").read_text())
DEFINITIONS = {row["id"]: row for row in CATALOG}
ORIGINS = {
    "BITHUMB": "https://api.bithumb.com",
    "TREASURY": "https://home.treasury.gov",
    "GOLD_API": "https://api.gold-api.com",
    "EIA": "https://api.eia.gov",
}
CONNECTORS = {
    "TOSS": "market:toss",
    "BITHUMB": "market:bithumb",
    "TREASURY": "market:treasury",
    "GOLD_API": "market:gold",
    "EIA": "market:eia",
}


def number(value, positive=False):
    raw = str(value)
    if (
        isinstance(value, bool)
        or len(raw) > 38
        or not re.fullmatch(r"-?\d+(?:\.\d+)?", raw)
        or positive
        and Decimal(raw) <= 0
    ):
        raise ValueError("Invalid decimal observation")
    return raw


def provider_time(value, now):
    at = (
        datetime.fromtimestamp(value / 1000, UTC)
        if type(value) is int and value > 0
        else instant(value)
    )
    if at > now + timedelta(minutes=1):
        raise ValueError("Invalid provider time")
    return at


def source_day(value, now):
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
        or date.fromisoformat(value).isoformat() != value
        or value > day(now)
    ):
        raise ValueError("Invalid or future observation date")
    return value


def records(value, maximum):
    if (
        not isinstance(value, list)
        or len(value) > maximum
        or any(not isinstance(r, dict) for r in value)
    ):
        raise ValueError("Invalid observation collection")
    return value


def quote(instrument, value, at, raw):
    return {
        "instrumentId": instrument,
        "kind": "QUOTE",
        "period": "latest",
        "value": value,
        "sourceDate": day(at) if at else None,
        "providerAt": at,
        "raw": raw,
    }


def parse_toss_indicators(payload, now):
    seen = set()
    result = []
    for raw in records(obj(payload).get("result"), 2):
        symbol = raw.get("symbol")
        if symbol not in ("KOSPI", "KOSDAQ") or symbol in seen:
            raise ValueError("Unexpected or duplicate market indicator")
        seen.add(symbol)
        result.append(
            quote(
                symbol.lower(),
                number(raw.get("lastPrice"), True),
                provider_time(raw["timestamp"], now) if raw.get("timestamp") else None,
                raw,
            )
        )
    return result


def toss_etf_definition(instrument):
    definition = DEFINITIONS.get(instrument, {})
    if (
        instrument not in ("sp500", "nasdaq")
        or definition.get("provider") != "TOSS"
        or definition.get("displayKind") != "NATIVE"
        or definition.get("region") != "us"
        or definition.get("currency") != "USD"
        or not isinstance(definition.get("symbol"), str)
        or not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", definition["symbol"])
    ):
        raise ValueError("Invalid Toss ETF instrument")
    return definition


def toss_etf_raw(raw, definition, endpoint):
    return {
        **raw,
        "requestProvenance": {
            "provider": "TOSS",
            "endpoint": endpoint,
            "symbol": definition["symbol"],
            "sessionTimeZone": "America/New_York",
            **({"interval": "1d", "adjusted": False} if endpoint.endswith("/candles") else {}),
        },
    }


def parse_toss_etf_quote(payload, instrument, now):
    definition = toss_etf_definition(instrument)
    rows = records(obj(payload).get("result"), 1)
    if not rows:
        return []
    raw = rows[0]
    if (
        raw.get("symbol") != definition["symbol"]
        or raw.get("currency") != "USD"
        or not isinstance(raw.get("lastPrice"), str)
        or raw.get("timestamp") is not None
        and not isinstance(raw["timestamp"], str)
    ):
        raise ValueError("Invalid Toss ETF quote")
    at = provider_time(raw["timestamp"], now) if raw.get("timestamp") is not None else None
    row = quote(
        instrument,
        number(raw.get("lastPrice"), True),
        at,
        toss_etf_raw(raw, definition, "/api/v1/prices"),
    )
    row["sourceDate"] = day(at, "America/New_York") if at else None
    return [row]


def parse_toss_etf_daily(payload, instrument, now):
    definition = toss_etf_definition(instrument)
    page = obj(obj(payload).get("result"))
    if "symbol" in page and page["symbol"] != definition["symbol"]:
        raise ValueError("Unexpected Toss ETF symbol")
    rows = []
    for raw in records(page.get("candles"), 200):
        # Candle responses identify the requested symbol through the request, not a required field.
        if (
            raw.get("currency") != "USD"
            or "symbol" in raw
            and raw["symbol"] != definition["symbol"]
            or not isinstance(raw.get("closePrice"), str)
            or not isinstance(raw.get("timestamp"), str)
        ):
            raise ValueError("Invalid Toss ETF candle")
        at = provider_time(raw.get("timestamp"), now)
        source = day(at, "America/New_York")
        rows.append(
            {
                "instrumentId": instrument,
                "kind": "DAILY",
                "period": source,
                "sourceDate": source,
                "providerAt": at,
                "value": number(raw.get("closePrice"), True),
                "raw": toss_etf_raw(raw, definition, "/api/v1/candles"),
            }
        )
    cursor = page.get("nextBefore")
    if cursor is not None:
        instant(cursor)
    return rows, cursor


def parse_toss_fx(payload, now):
    raw = obj(obj(payload).get("result"))
    if raw.get("baseCurrency") != "USD" or raw.get("quoteCurrency") != "KRW":
        raise ValueError("Unexpected FX direction")
    row = quote(
        "usd-krw", number(raw.get("rate"), True), provider_time(raw.get("validFrom"), now), raw
    )
    return [
        row,
        {
            **row,
            "kind": "DAILY",
            "period": row["sourceDate"],
            "raw": {**raw, "aggregation": "OBSERVED_LAST"},
        },
    ]


def parse_toss_daily(payload, instrument, now):
    page = obj(obj(payload).get("result"))
    rows = []
    if instrument not in ("kospi", "kosdaq"):
        raise ValueError("Invalid Toss indicator")
    for raw in records(page.get("candles"), 200):
        at = provider_time(raw.get("timestamp"), now)
        source = day(at)
        rows.append(
            {
                "instrumentId": instrument,
                "kind": "DAILY",
                "period": source,
                "sourceDate": source,
                "providerAt": at,
                "value": number(raw.get("closePrice"), True),
                "raw": raw,
            }
        )
    if page.get("nextBefore"):
        instant(page["nextBefore"])
    return rows, page.get("nextBefore")


def bithumb_trade_time(raw, now):
    def from_fields(d, t, offset):
        if (
            not isinstance(d, str)
            or not re.fullmatch(r"\d{8}", d)
            or not isinstance(t, str)
            or not re.fullmatch(r"\d{6}", t)
        ):
            raise ValueError("Invalid Bithumb calendar time")
        return provider_time(f"{d[:4]}-{d[4:6]}-{d[6:]}T{t[:2]}:{t[2:4]}:{t[4:]}{offset}", now)

    utc = (
        from_fields(raw.get("trade_date"), raw.get("trade_time"), "Z")
        if raw.get("trade_date") is not None or raw.get("trade_time") is not None
        else None
    )
    kst = (
        from_fields(raw.get("trade_date_kst"), raw.get("trade_time_kst"), "+09:00")
        if raw.get("trade_date_kst") is not None or raw.get("trade_time_kst") is not None
        else None
    )
    if utc and kst and utc != kst:
        raise ValueError("Inconsistent Bithumb trade times")
    return (
        (utc, "trade_date/trade_time (UTC)")
        if utc
        else (kst, "trade_date_kst/trade_time_kst (KST)")
        if kst
        else (provider_time(raw.get("trade_timestamp"), now), "trade_timestamp")
    )


def parse_bithumb_quotes(payload, now):
    seen = set()
    result = []
    for raw in records(payload, 2):
        market = raw.get("market")
        if market not in ("KRW-BTC", "KRW-ETH") or market in seen:
            raise ValueError("Unexpected or duplicate Bithumb market")
        seen.add(market)
        at, field = bithumb_trade_time(raw, now)
        row = quote(
            "btc" if market == "KRW-BTC" else "eth",
            number(raw.get("trade_price"), True),
            at,
            {**raw, "normalizedTimeField": field},
        )
        row.update(
            {
                "referenceValue": number(raw.get("prev_closing_price"), True),
                "referenceLabel": "빗썸 전일 종가(KST) 대비",
                "referenceDate": (
                    date.fromisoformat(row["sourceDate"]) - timedelta(days=1)
                ).isoformat(),
            }
        )
        result.append(row)
    return result


def parse_bithumb_daily(payload, instrument, now):
    result = []
    rows = records(payload, 200)
    if instrument not in ("btc", "eth"):
        raise ValueError("Invalid Bithumb instrument")
    for raw in rows:
        if raw.get("market") != ("KRW-BTC" if instrument == "btc" else "KRW-ETH"):
            raise ValueError("Unexpected Bithumb market")
        kst = raw.get("candle_date_time_kst")
        if not isinstance(kst, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", kst
        ):
            raise ValueError("Invalid Bithumb candle period")
        at = provider_time(kst + "+09:00", now)
        source = source_day(kst[:10], now)
        result.append(
            {
                "instrumentId": instrument,
                "kind": "DAILY",
                "period": source,
                "sourceDate": source,
                "providerAt": at,
                "value": number(raw.get("trade_price"), True),
                "raw": raw,
            }
        )
    return result, min((r["candle_date_time_kst"] for r in rows), default=None)


def parse_treasury(payload, now):
    if re.search(r"<!DOCTYPE|<!ENTITY", payload, re.IGNORECASE):
        raise ValueError("Invalid Treasury XML")
    root = ElementTree.fromstring(payload)
    local = lambda tag: tag.rsplit("}", 1)[-1]
    if local(root.tag) != "feed":
        raise ValueError("Invalid Treasury feed")
    result = []
    for entry in root:
        if local(entry.tag) != "entry":
            continue
        props = next((n for n in entry.iter() if local(n.tag) == "properties"), None)
        if props is None:
            raise ValueError("Invalid Treasury entry")
        raw = {
            local(n.tag): (
                {"#text": n.text, **{"@_" + local(k): v for k, v in n.attrib.items()}}
                if n.attrib
                else n.text or ""
            )
            for n in props
        }
        date_value = raw.get("NEW_DATE")
        date_value = obj(date_value).get("#text") if isinstance(date_value, dict) else date_value
        source = source_day(str(date_value)[:10], now)
        for instrument, field in [("us2y", "BC_2YEAR"), ("us10y", "BC_10YEAR")]:
            value = raw.get(field)
            value = obj(value).get("#text") if isinstance(value, dict) else value
            if value in (None, ""):
                continue
            result.append(
                {
                    "instrumentId": instrument,
                    "kind": "DAILY",
                    "period": source,
                    "sourceDate": source,
                    "providerAt": None,
                    "value": number(value),
                    "raw": raw,
                }
            )
    return result


def parse_gold_quote(payload, instrument, now):
    raw = obj(payload)
    if (
        instrument not in ("gold", "silver")
        or raw.get("symbol") != ("XAU" if instrument == "gold" else "XAG")
        or raw.get("currency", "USD") != "USD"
    ):
        raise ValueError("Unexpected metal unit")
    row = quote(
        instrument, number(raw.get("price"), True), provider_time(raw.get("updatedAt"), now), raw
    )
    row["sourceDate"] = row["providerAt"].date().isoformat()
    return [row]


def parse_gold_history(payload, instrument, now):
    result = []
    for raw in records(payload, 400):
        source = source_day(re.sub(r" 00:00:00$", "", str(raw.get("day"))), now)
        result.append(
            {
                "instrumentId": instrument,
                "kind": "DAILY",
                "period": source,
                "sourceDate": source,
                "providerAt": None,
                "value": number(raw.get("avg_price"), True),
                "raw": {**raw, "aggregation": "DAILY_AVERAGE"},
            }
        )
    return result


def parse_eia(payload, now):
    result = []
    for raw in records(obj(obj(payload).get("response")).get("data"), 5000):
        if raw.get("value") in (None, ""):
            continue
        source = source_day(raw.get("period"), now)
        if raw.get("series", "RWTC") not in ("RWTC", "PET.RWTC.D") or raw.get(
            "value-units", "$/BBL"
        ) not in ("Dollars per Barrel", "$/BBL", "Dollars per barrel"):
            raise ValueError("Unexpected EIA series or unit")
        result.append(
            {
                "instrumentId": "wti",
                "kind": "DAILY",
                "period": source,
                "sourceDate": source,
                "providerAt": None,
                "value": number(raw["value"]),
                "raw": raw,
            }
        )
    return result


class IndicatorRequestError(RuntimeError):
    def __init__(self, source, status, retry_at):
        self.source, self.http_status, self.retry_at = source, status, retry_at
        super().__init__(
            f"{source} HTTP {status}" if status else f"{source} 응답을 확인할 수 없습니다."
        )


def retry_delay(header, now, failures):
    try:
        seconds = (
            float(header)
            if header and re.fullmatch(r"\d+(?:\.\d+)?", header)
            else parsedate_to_datetime(header).timestamp() - now
        )
        return max(1, seconds)
    except (ValueError, TypeError):
        return min(900, 60 * 2 ** max(0, failures - 1))


class Indicators:
    def __init__(self, ctx, toss):
        self.ctx, self.toss = ctx, toss
        self.cooldown = {}
        self.last_request = {}
        self.catalog_ready = False

    async def catalog(self):
        if not self.catalog_ready:
            for definition in CATALOG:
                await insert(
                    self.ctx.db,
                    "market_instruments",
                    {"id": definition["id"], "definitionJson": definition},
                    ["definitionJson"],
                    entity=False,
                )
            self.catalog_ready = True

    async def request(self, source, path, params=None, xml=False):
        key = "GOLD_API_HISTORY" if source == "GOLD_API" and path == "/history" else source
        state = self.cooldown.get(key, {})
        now = time.time()
        if state.get("until", 0) > now:
            raise IndicatorRequestError(
                source, state.get("status"), datetime.fromtimestamp(state["until"], UTC)
            )
        wait = self.last_request.get(source, 0) + 1.2 - now
        if wait > 0:
            await asyncio.sleep(wait)
        url = urljoin(ORIGINS[source], path)
        if (
            urlsplit(url).netloc != urlsplit(ORIGINS[source]).netloc
            or urlsplit(url).scheme != "https"
        ):
            raise ValueError("Invalid market-data origin")
        params = dict(params or {})
        headers = {"Accept": "application/xml" if xml else "application/json"}
        if source == "TREASURY":
            # Preserve the deployed fetch UA: Treasury times out for httpx's default UA.
            headers["User-Agent"] = "node"
        if source == "GOLD_API" and path == "/history" and self.ctx.config.goldApiKey:
            headers["x-api-key"] = self.ctx.config.goldApiKey
        if source == "EIA" and self.ctx.config.eiaApiKey:
            params["api_key"] = self.ctx.config.eiaApiKey
        self.last_request[source] = time.time()
        try:
            status, response_headers, body = await http_request(
                self.ctx, "GET", url, headers=headers, params=params
            )
            if not 200 <= status < 300:
                failures = state.get("failures", 0) + 1
                until = time.time() + retry_delay(
                    response_headers.get("retry-after"), time.time(), failures
                )
                self.cooldown[key] = {"until": until, "failures": failures, "status": status}
                raise IndicatorRequestError(source, status, datetime.fromtimestamp(until, UTC))
            parsed = body.decode("utf8") if xml else json.loads(body)
            self.cooldown.pop(key, None)
            return parsed
        except IndicatorRequestError:
            raise
        except Exception:  # noqa: BLE001 - preserve independent connector operation
            failures = state.get("failures", 0) + 1
            until = time.time() + retry_delay(None, time.time(), failures)
            self.cooldown[key] = {"until": until, "failures": failures, "status": None}
            raise IndicatorRequestError(source, None, datetime.fromtimestamp(until, UTC)) from None

    def tasks(self, mode):
        if mode == "quotes":
            return [
                ("TOSS", ["kospi", "kosdaq"], self.toss.enabled),
                ("TOSS", ["usd-krw"], self.toss.enabled),
                ("TOSS", ["sp500"], self.toss.enabled),
                ("TOSS", ["nasdaq"], self.toss.enabled),
                ("BITHUMB", ["btc", "eth"], True),
                ("GOLD_API", ["gold"], True),
                ("GOLD_API", ["silver"], True),
            ]
        return (
            [("TOSS", [i], self.toss.enabled) for i in ("kospi", "kosdaq", "sp500", "nasdaq")]
            + [("BITHUMB", [i], True) for i in ("btc", "eth")]
            + [("TREASURY", ["us2y", "us10y"], True)]
            + [("GOLD_API", [i], bool(self.ctx.config.goldApiKey)) for i in ("gold", "silver")]
            + [("EIA", ["wti"], bool(self.ctx.config.eiaApiKey))]
        )

    async def collect(self, source, ids, mode, now):
        instrument = ids[0]
        start = now - timedelta(days=370)
        history_start = (
            day(start, "America/New_York")
            if instrument in ("sp500", "nasdaq")
            else start.date().isoformat()
        )
        if mode == "quotes":
            if source == "TOSS" and instrument == "kospi":
                return parse_toss_indicators(
                    await self.toss.get(
                        "/api/v1/market-indicators/prices", {"symbols": "KOSPI,KOSDAQ"}
                    ),
                    now,
                )
            if source == "TOSS" and instrument in ("sp500", "nasdaq"):
                definition = toss_etf_definition(instrument)
                return parse_toss_etf_quote(
                    await self.toss.get("/api/v1/prices", {"symbols": definition["symbol"]}),
                    instrument,
                    now,
                )
            if source == "TOSS":
                return parse_toss_fx(
                    await self.toss.get(
                        "/api/v1/exchange-rate", {"baseCurrency": "USD", "quoteCurrency": "KRW"}
                    ),
                    now,
                )
            if source == "BITHUMB":
                return parse_bithumb_quotes(
                    await self.request("BITHUMB", "/v1/ticker", {"markets": "KRW-BTC,KRW-ETH"}), now
                )
            return parse_gold_quote(
                await self.request(
                    "GOLD_API", "/price/" + ("XAU" if instrument == "gold" else "XAG")
                ),
                instrument,
                now,
            )
        if source in ("TOSS", "BITHUMB"):
            rows = []
            before = None
            for _ in range(3 if source == "TOSS" else 2):
                if source == "TOSS":
                    etf = instrument in ("sp500", "nasdaq")
                    definition = toss_etf_definition(instrument) if etf else None
                    parser = parse_toss_etf_daily if etf else parse_toss_daily
                    part, cursor = parser(
                        await self.toss.get(
                            "/api/v1/candles"
                            if etf
                            else f"/api/v1/market-indicators/{instrument.upper()}/candles",
                            {
                                "interval": "1d",
                                "count": "200",
                                **(
                                    {"symbol": definition["symbol"], "adjusted": "false"}
                                    if definition
                                    else {}
                                ),
                                **({"before": before} if before else {}),
                            },
                        ),
                        instrument,
                        now,
                    )
                else:
                    part, cursor = parse_bithumb_daily(
                        await self.request(
                            "BITHUMB",
                            "/v1/candles/days",
                            {
                                "market": "KRW-BTC" if instrument == "btc" else "KRW-ETH",
                                "count": "200",
                                **({"to": before} if before else {}),
                            },
                        ),
                        instrument,
                        now,
                    )
                rows.extend(part)
                if (
                    not cursor
                    or not part
                    or source == "BITHUMB"
                    and len(part) < 200
                    or source == "TOSS"
                    and any(r["sourceDate"] < history_start for r in part)
                ):
                    break
                if before and (
                    instant(cursor) >= instant(before) if source == "TOSS" else cursor >= before
                ):
                    raise ValueError("Indicator history pagination made no progress")
                before = cursor
            return [r for r in rows if r["sourceDate"] >= history_start]
        if source == "TREASURY":
            rows = []
            for year in range(start.year, now.year + 1):
                rows.extend(
                    parse_treasury(
                        await self.request(
                            "TREASURY",
                            "/resource-center/data-chart-center/interest-rates/pages/xml",
                            {
                                "data": "daily_treasury_yield_curve",
                                "field_tdr_date_value": str(year),
                            },
                            True,
                        ),
                        now,
                    )
                )
            return [r for r in rows if r["sourceDate"] >= start.date().isoformat()]
        if source == "GOLD_API":
            return parse_gold_history(
                await self.request(
                    "GOLD_API",
                    "/history",
                    {
                        "symbol": "XAU" if instrument == "gold" else "XAG",
                        "startTimestamp": str(int(start.timestamp())),
                        "endTimestamp": str(int(now.timestamp())),
                        "groupBy": "day",
                        "aggregation": "avg",
                        "orderBy": "asc",
                    },
                ),
                instrument,
                now,
            )
        return parse_eia(
            await self.request(
                "EIA",
                "/v2/seriesid/PET.RWTC.D",
                {
                    "start": start.date().isoformat(),
                    "end": now.date().isoformat(),
                    "length": "400",
                    "sort[0][column]": "period",
                    "sort[0][direction]": "desc",
                },
            ),
            now,
        )

    async def read_current_observations(self, tx, rows):
        current: list[dict[str, Any]] = []
        for offset in range(0, len(rows), 200):
            clauses, params = [], {}
            for i, row in enumerate(rows[offset : offset + 200]):
                clauses.append(
                    f"(instrument_id=:instrument{i} AND kind=:kind{i} AND period=:period{i})"
                )
                params.update(
                    {
                        f"instrument{i}": row["instrumentId"],
                        f"kind{i}": row["kind"],
                        f"period{i}": row["period"],
                    }
                )
            current.extend(
                camel(row)
                for row in await tx.fetch_all(
                    "SELECT instrument_id,kind,period,value,source_date,provider_at,first_observed_at,source FROM market_observations WHERE "
                    + " OR ".join(clauses)
                    + " FOR UPDATE",
                    params,
                )
            )
        return current

    async def read_daily_references(self, tx, rows, existing):
        targets = list(
            dict.fromkeys(
                (row["instrumentId"], row["sourceDate"])
                for row in rows
                if row["sourceDate"]
                and (row.get("referenceValue") is None or row.get("referenceDate") is None)
            )
        )
        daily: dict[str, dict[str, dict[str, Any]]] = {}

        def add(row):
            if row["instrumentId"] in ("sp500", "nasdaq") and row.get("source", "TOSS") != "TOSS":
                return
            source_date = date_text(row.get("sourceDate"))
            if source_date is not None:
                daily.setdefault(row["instrumentId"], {})[source_date] = row

        for offset in range(0, len(targets), 200):
            clauses, params = [], {}
            for i, (instrument, before) in enumerate(targets[offset : offset + 200]):
                etf = instrument in ("sp500", "nasdaq")
                clauses.append(
                    f"(instrument_id=:instrument{i} AND kind='DAILY' "
                    + ("AND source='TOSS' " if etf else "")
                    + "AND source_date="
                    f"(SELECT MAX(prior.source_date) FROM market_observations prior "
                    f"WHERE prior.instrument_id=:instrument{i} AND prior.kind='DAILY' "
                    + ("AND prior.source='TOSS' " if etf else "")
                    + f"AND prior.source_date<:before{i}))"
                )
                params.update({f"instrument{i}": instrument, f"before{i}": before})
            for row in await tx.fetch_all(
                "SELECT instrument_id,source_date,value,source FROM market_observations WHERE "
                + " OR ".join(clauses),
                params,
            ):
                add(camel(row))
        for row in [*existing, *rows]:
            if row["kind"] == "DAILY":
                add(row)
        return {instrument: (sorted(dates), dates) for instrument, dates in daily.items()}

    async def save_observations(self, source, rows, now):
        key = lambda r: (r["instrumentId"], r["kind"], r["period"])
        pending: dict[tuple[str, str, str], dict[str, Any]] = {}
        promoted = {}
        for row in rows:
            definition = DEFINITIONS.get(row["instrumentId"])
            if (
                not definition
                or definition["provider"] != source
                or definition["displayKind"] != "NATIVE"
            ):
                raise ValueError("Unexpected instrument source")
            old = pending.get(key(row))
            if (
                not old
                or not old["providerAt"]
                or not row["providerAt"]
                or old["providerAt"] <= row["providerAt"]
            ):
                pending[key(row)] = row
        if source in ("TREASURY", "EIA"):
            latest: dict[str, dict[str, Any]] = {}
            for row in pending.values():
                if row["kind"] == "DAILY" and (
                    row["instrumentId"] not in latest
                    or latest[row["instrumentId"]]["period"] < row["period"]
                ):
                    latest[row["instrumentId"]] = row
            for instrument, row in latest.items():
                k = (instrument, "QUOTE", "latest")
                pending[k] = {**row, "kind": "QUOTE", "period": "latest"}
                promoted[k] = key(row)
        async with self.ctx.db.transaction() as tx:
            existing = await self.read_current_observations(tx, list(pending.values()))
            current = {key(row): row for row in existing}
            for k, row in list(pending.items()):
                old = current.get(k, {})
                if old and (
                    (
                        old.get("providerAt")
                        and row["providerAt"]
                        and instant(old["providerAt"]) > row["providerAt"]
                    )
                    or (
                        old.get("sourceDate")
                        and row["sourceDate"]
                        and date_text(old["sourceDate"]) > row["sourceDate"]
                    )
                ):
                    pending.pop(k)
            for k, daily_key in promoted.items():
                if daily_key not in pending:
                    pending.pop(k, None)
            references = await self.read_daily_references(tx, list(pending.values()), existing)
            writes = []
            for k, row in pending.items():
                definition = DEFINITIONS[row["instrumentId"]]
                old = current.get(k, {})
                reference = {}
                if row["sourceDate"] and (
                    row.get("referenceValue") is None or row.get("referenceDate") is None
                ):
                    dates, by_date = references.get(k[0], ([], {}))
                    index = bisect_left(dates, date_text(row["sourceDate"])) - 1
                    if index >= 0:
                        reference = by_date[dates[index]]
                label = (
                    "이전 일평균 대비"
                    if definition["historyKind"] == "daily_average"
                    else "이전 일별 관측값 대비"
                    if definition["historyKind"] == "observed"
                    else "이전 발표값 대비"
                    if definition["category"] == "BOND"
                    else "전일 종가 대비"
                )
                write = {
                    k: v
                    for k, v in row.items()
                    if k not in ("raw", "referenceValue", "referenceDate", "referenceLabel")
                }
                write.update(
                    {
                        "firstObservedAt": old.get("firstObservedAt", now),
                        "lastObservedAt": now,
                        "source": source,
                        "sourceUrl": definition["sourceUrl"],
                        "rightsMode": definition["rightsMode"],
                        "referenceValue": row.get("referenceValue")
                        if row.get("referenceValue") is not None
                        else reference.get("value"),
                        "referenceDate": row.get("referenceDate") or reference.get("sourceDate"),
                        "referenceLabel": row.get("referenceLabel") or label,
                        "rawMetadataJson": row["raw"],
                    }
                )
                writes.append(write)
            if writes:
                await insert_many(
                    tx,
                    "market_observations",
                    writes,
                    [k for k in writes[0] if k != "firstObservedAt"],
                )
        return len(pending)

    async def record_health(self, source, mode, results, now):
        connector = CONNECTORS[source]
        old = camel(
            await self.ctx.db.fetch_one(
                "SELECT * FROM connector_health WHERE connector=:connector",
                {"connector": connector},
            )
        )
        component = "quote" if mode == "quotes" else "history"
        statuses = [r["status"] for r in results]
        status = (
            "UNCONFIGURED"
            if all(s == "UNCONFIGURED" for s in statuses)
            else "HEALTHY"
            if all(s == "HEALTHY" for s in statuses)
            else "DEGRADED"
        )
        metadata = {
            **obj(old.get("metadataJson")),
            "provider": source,
            component + "Status": status,
            component + "CheckedAt": iso(now),
            component + "UnavailableInstruments": [
                i for r in results if r["status"] != "HEALTHY" for i in r["instrumentIds"]
            ],
            component + "RetryAt": max(
                (r["retryAt"] for r in results if r.get("retryAt")), default=None
            ),
            component + "HttpStatus": next(
                (r["httpStatus"] for r in results if r.get("httpStatus")), None
            ),
        }
        statuses = [metadata[k] for k in ("quoteStatus", "historyStatus") if k in metadata]
        overall = (
            "DISABLED"
            if all(s == "UNCONFIGURED" for s in statuses)
            else "HEALTHY"
            if all(s == "HEALTHY" for s in statuses)
            else "DEGRADED"
        )
        message = (
            None
            if overall == "HEALTHY"
            else f"{source} {'이력' if component == 'history' else '시세'} 연결 설정이 필요합니다."
            if status == "UNCONFIGURED"
            else f"{source} 일부 데이터가 지연되었거나 연결 설정이 필요합니다. 마지막 수신 값을 유지합니다."
            if overall == "DEGRADED"
            else f"{source} 연결 설정이 필요합니다."
        )
        write = {
            "connector": connector,
            "status": overall,
            "message": message,
            "checkedAt": now,
            "lastSuccessAt": now if status == "HEALTHY" else old.get("lastSuccessAt"),
            "lastFailureAt": now if status == "DEGRADED" else old.get("lastFailureAt"),
            "metadataJson": metadata,
        }
        await insert(self.ctx.db, "connector_health", write, list(write))

    async def refresh(self, mode):
        await self.catalog()
        now = utcnow()
        results: dict[str, list[dict[str, Any]]] = {}
        saved = 0
        for source, ids, configured in self.tasks(mode):
            result = {"status": "UNCONFIGURED", "instrumentIds": ids}
            if configured:
                try:
                    rows = await self.collect(source, ids, mode, now)
                    if any(r["instrumentId"] not in ids for r in rows):
                        raise ValueError("Unexpected instrument")
                    missing = [i for i in ids if not any(r["instrumentId"] == i for r in rows)]
                    if rows:
                        saved += await self.save_observations(source, rows, now)
                    result = {
                        "status": "DEGRADED" if missing else "HEALTHY",
                        "instrumentIds": missing or ids,
                    }
                except Exception as error:  # noqa: BLE001 - record per-source failure at runtime boundary
                    result = {"status": "DEGRADED", "instrumentIds": ids}
                    if isinstance(error, IndicatorRequestError):
                        result.update(
                            {"retryAt": iso(error.retry_at), "httpStatus": error.http_status}
                        )
            results.setdefault(source, []).append(result)
        for source, items in results.items():
            await self.record_health(source, mode, items, now)
        return {
            "mode": mode,
            "saved": saved,
            "sources": [
                {"source": source, "statuses": [i["status"] for i in items]}
                for source, items in results.items()
            ],
        }
