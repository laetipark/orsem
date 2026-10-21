"""Synthetic coverage for native US ETF indicators using the shared Toss client."""

import json
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from orsem_worker.market.common import instant, iso
from orsem_worker.market.indicators import (
    DEFINITIONS,
    Indicators,
    parse_toss_etf_daily,
    parse_toss_etf_quote,
)
from orsem_worker.market.toss import TossHttpError

NOW = instant("2026-10-10T02:00:00Z")


def etf_quote(symbol="SPY", **changes):
    return {
        "symbol": symbol,
        "lastPrice": "500.2500",
        "currency": "USD",
        "timestamp": "2026-10-10T01:00:00Z",
        "providerExtra": "preserved",
        **changes,
    }


def etf_candle(at="2026-10-09T00:00:00-04:00", **changes):
    return {
        "timestamp": at,
        "openPrice": "499",
        "highPrice": "502",
        "lowPrice": "498",
        "closePrice": "500.2500",
        "volume": "100",
        "currency": "USD",
        "providerExtra": "preserved",
        **changes,
    }


@pytest.mark.parametrize("instrument,symbol", [("sp500", "SPY"), ("nasdaq", "ONEQ")])
def test_toss_etf_quotes_use_catalog_symbol_and_new_york_session(instrument, symbol):
    raw = etf_quote(symbol)
    row = parse_toss_etf_quote({"result": [raw]}, instrument, NOW)[0]
    assert row["instrumentId"] == instrument
    assert row["value"] == "500.2500"
    assert row["sourceDate"] == "2026-10-09"
    assert iso(row["providerAt"]) == "2026-10-10T01:00:00.000Z"
    assert {key: row["raw"][key] for key in raw} == raw
    assert row["raw"]["requestProvenance"] == {
        "provider": "TOSS",
        "endpoint": "/api/v1/prices",
        "symbol": symbol,
        "sessionTimeZone": "America/New_York",
    }
    assert "referenceValue" not in row


@pytest.mark.parametrize("missing", [True, False])
def test_toss_etf_quote_missing_optional_timestamp_never_invents_a_date(missing):
    raw = etf_quote(timestamp=None)
    if missing:
        raw.pop("timestamp")
    row = parse_toss_etf_quote({"result": [raw]}, "sp500", NOW)[0]
    assert row["providerAt"] is None and row["sourceDate"] is None
    assert parse_toss_etf_quote({"result": []}, "sp500", NOW) == []


@pytest.mark.parametrize(
    "changes",
    [
        {"symbol": "ONEQ"},
        {"symbol": None},
        {"currency": "KRW"},
        {"currency": None},
        {"lastPrice": None},
        {"lastPrice": 500.25},
        {"lastPrice": "0"},
        {"lastPrice": "NaN"},
        {"timestamp": "2026-10-10T02:02:00Z"},
        {"timestamp": "2026-10-09"},
        {"timestamp": ""},
        {"timestamp": 1791597600000},
    ],
)
def test_toss_etf_quote_rejects_mismatched_or_malformed_payloads(changes):
    with pytest.raises(ValueError):
        parse_toss_etf_quote({"result": [etf_quote(**changes)]}, "sp500", NOW)


def test_toss_etf_quote_rejects_duplicate_quotes_and_unsupported_instruments():
    with pytest.raises(ValueError):
        parse_toss_etf_quote({"result": [etf_quote(), etf_quote()]}, "sp500", NOW)
    with pytest.raises(ValueError):
        parse_toss_etf_quote({"result": [etf_quote()]}, "kospi", NOW)


@pytest.mark.parametrize(
    "at,source,utc",
    [
        ("2026-01-02T00:00:00-05:00", "2026-01-02", "2026-01-02T05:00:00.000Z"),
        ("2026-09-04T00:00:00-04:00", "2026-09-04", "2026-09-04T04:00:00.000Z"),
        ("2026-10-10T01:00:00Z", "2026-10-09", "2026-10-10T01:00:00.000Z"),
    ],
)
def test_toss_etf_history_preserves_raw_fields_and_new_york_dates(at, source, utc):
    raw = etf_candle(at)
    rows, cursor = parse_toss_etf_daily(
        {"result": {"candles": [raw], "nextBefore": None}}, "nasdaq", NOW
    )
    assert cursor is None
    assert rows[0]["period"] == source == rows[0]["sourceDate"]
    assert iso(rows[0]["providerAt"]) == utc
    assert {key: rows[0]["raw"][key] for key in raw} == raw
    assert rows[0]["raw"]["requestProvenance"] == {
        "provider": "TOSS",
        "endpoint": "/api/v1/candles",
        "symbol": "ONEQ",
        "sessionTimeZone": "America/New_York",
        "interval": "1d",
        "adjusted": False,
    }


@pytest.mark.parametrize(
    "changes",
    [
        {"symbol": "ONEQ"},
        {"currency": "KRW"},
        {"currency": None},
        {"closePrice": "0"},
        {"closePrice": None},
        {"closePrice": 500.25},
        {"timestamp": None},
        {"timestamp": 1791597600000},
        {"timestamp": "2026-10-11T00:00:00-04:00"},
    ],
)
def test_toss_etf_history_rejects_malformed_or_wrong_currency_rows(changes):
    with pytest.raises(ValueError):
        parse_toss_etf_daily({"result": {"candles": [etf_candle(**changes)]}}, "sp500", NOW)


def test_toss_etf_history_rejects_wrong_page_identity_and_cursor():
    for page in [
        {"symbol": "ONEQ", "candles": [etf_candle()]},
        {"candles": [etf_candle()], "nextBefore": "invalid"},
        {"candles": [etf_candle()], "nextBefore": False},
        {"candles": [etf_candle()] * 201},
    ]:
        with pytest.raises(ValueError):
            parse_toss_etf_daily({"result": page}, "sp500", NOW)


@pytest.mark.asyncio
async def test_toss_etf_history_uses_shared_client_and_bounded_pagination():
    get = AsyncMock(
        side_effect=[
            {
                "result": {
                    "candles": [etf_candle(f"2026-10-0{9 - i}T00:00:00-04:00")],
                    "nextBefore": f"2026-10-0{9 - i}T04:00:00Z",
                }
            }
            for i in range(4)
        ]
    )
    service = Indicators(SimpleNamespace(), SimpleNamespace(enabled=True, get=get))
    rows = await service.collect("TOSS", ["sp500"], "daily", NOW)
    assert len(rows) == 3 and get.await_count == 3
    for index, call in enumerate(get.call_args_list):
        assert call.args == (
            "/api/v1/candles",
            {
                "symbol": "SPY",
                "interval": "1d",
                "count": "200",
                "adjusted": "false",
                **({"before": f"2026-10-0{10 - index}T04:00:00Z"} if index else {}),
            },
        )


@pytest.mark.asyncio
async def test_toss_etf_history_stops_at_370_days_and_rejects_stuck_cursor():
    oldest = iso(NOW - timedelta(days=371))
    get = AsyncMock(
        return_value={
            "result": {
                "candles": [etf_candle(), etf_candle(oldest)],
                "nextBefore": oldest,
            }
        }
    )
    service = Indicators(SimpleNamespace(), SimpleNamespace(enabled=True, get=get))
    rows = await service.collect("TOSS", ["nasdaq"], "daily", NOW)
    assert len(rows) == 1 and rows[0]["sourceDate"] == "2026-10-09"
    assert get.await_count == 1
    get.reset_mock()
    get.return_value = {"result": {"candles": [etf_candle()], "nextBefore": "2026-10-09T04:00:00Z"}}
    with pytest.raises(ValueError, match="no progress"):
        await service.collect("TOSS", ["nasdaq"], "daily", NOW)
    assert get.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["http", "missing", "currency"])
async def test_one_unavailable_etf_does_not_block_other_toss_indicators(failure):
    async def get(endpoint, params):
        if endpoint == "/api/v1/market-indicators/prices":
            return {
                "result": [{"symbol": symbol, "lastPrice": "100"} for symbol in ("KOSPI", "KOSDAQ")]
            }
        if endpoint == "/api/v1/exchange-rate":
            return {
                "result": {
                    "baseCurrency": "USD",
                    "quoteCurrency": "KRW",
                    "rate": "1400",
                    "validFrom": "2026-10-09T14:00:00Z",
                }
            }
        if params["symbols"] == "SPY":
            if failure == "http":
                raise TossHttpError(404)
            return {"result": [] if failure == "missing" else [etf_quote(currency="KRW")]}
        assert endpoint == "/api/v1/prices" and params["symbols"] == "ONEQ"
        return {"result": [etf_quote("ONEQ")]}

    service = Indicators(
        SimpleNamespace(), SimpleNamespace(enabled=True, get=AsyncMock(side_effect=get))
    )
    service.catalog = AsyncMock()
    tasks = [task for task in service.tasks("quotes") if task[0] == "TOSS"]
    service.tasks = lambda mode: tasks
    service.save_observations = AsyncMock(side_effect=lambda source, rows, now: len(rows))
    service.record_health = AsyncMock()
    result = await service.refresh("quotes")
    assert result["saved"] == 5
    assert result["sources"] == [
        {"source": "TOSS", "statuses": ["HEALTHY", "HEALTHY", "DEGRADED", "HEALTHY"]}
    ]
    health = service.record_health.call_args.args[2]
    assert [r["instrumentIds"] for r in health if r["status"] == "DEGRADED"] == [["sp500"]]


def test_etf_tasks_respect_missing_toss_credentials():
    service = Indicators(
        SimpleNamespace(config=SimpleNamespace(goldApiKey=None, eiaApiKey=None)),
        SimpleNamespace(enabled=False),
    )
    for mode in ("quotes", "daily"):
        tasks = service.tasks(mode)
        assert ("TOSS", ["sp500"], False) in tasks
        assert ("TOSS", ["nasdaq"], False) in tasks
        assert (
            ("BITHUMB", ["btc", "eth"], True) in tasks
            if mode == "quotes"
            else ("BITHUMB", ["btc"], True) in tasks
        )


@pytest.mark.asyncio
async def test_etf_save_uses_prior_session_and_preserves_first_observation():
    @asynccontextmanager
    async def transaction():
        yield db

    first = NOW - timedelta(hours=1)
    db = SimpleNamespace(
        transaction=transaction,
        fetch_all=AsyncMock(
            side_effect=[
                [
                    {
                        "instrument_id": "sp500",
                        "kind": "QUOTE",
                        "period": "latest",
                        "source_date": "2026-10-09",
                        "provider_at": NOW - timedelta(hours=2),
                        "first_observed_at": first,
                        "value": "500",
                    }
                ],
                [{"instrument_id": "sp500", "source_date": "2026-10-08", "value": "490"}],
            ]
        ),
        execute=AsyncMock(),
    )
    service = Indicators(SimpleNamespace(db=db), SimpleNamespace(enabled=True))
    rows = parse_toss_etf_quote({"result": [etf_quote()]}, "sp500", NOW)
    assert await service.save_observations("TOSS", rows, NOW) == 1
    params = db.execute.call_args.args[1]
    assert params["b0_source_date"] == "2026-10-09"
    assert params["b0_reference_date"] == "2026-10-08"
    assert params["b0_reference_value"] == "490"
    assert params["b0_first_observed_at"] == first.replace(tzinfo=None)
    assert params["b0_source"] == "TOSS"
    assert params["b0_rights_mode"] == "PRIVATE_DISPLAY_ONLY"
    assert params["b0_source_url"] == DEFINITIONS["sp500"]["sourceUrl"]
    assert json.loads(params["b0_raw_metadata_json"])["requestProvenance"]["symbol"] == "SPY"


@pytest.mark.asyncio
async def test_etf_reference_does_not_mix_other_provider_index_values():
    current = [
        {
            "instrumentId": "sp500",
            "kind": "DAILY",
            "sourceDate": "2026-10-08",
            "value": "6000",
            "source": "FRED",
        }
    ]
    db = SimpleNamespace(
        fetch_all=AsyncMock(
            return_value=[
                {
                    "instrument_id": "sp500",
                    "source_date": "2026-10-07",
                    "value": "490",
                    "source": "TOSS",
                }
            ]
        )
    )
    service = Indicators(SimpleNamespace(db=db), SimpleNamespace(enabled=True))
    rows = parse_toss_etf_quote({"result": [etf_quote()]}, "sp500", NOW)
    references = await service.read_daily_references(db, rows, current)
    assert references["sp500"][0] == ["2026-10-07"]
    assert references["sp500"][1]["2026-10-07"]["value"] == "490"
    query = db.fetch_all.call_args.args[0]
    assert "AND source='TOSS'" in query and "AND prior.source='TOSS'" in query
