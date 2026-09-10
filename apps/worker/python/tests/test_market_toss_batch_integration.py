"""Toss batch writes against disposable MySQL, with provider calls replaced."""

import copy
import os
import re
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from orsem_worker.core import Database, identifier, utcnow
from orsem_worker.market.common import insert, iso, obj, read_checkpoint
from orsem_worker.market.toss import MarketData, normalize_candle

URL = os.environ.get("ORSEM_MARKET_TEST_DB", "")
pytestmark = pytest.mark.skipif(not URL, reason="Requires disposable migrated MySQL")


@pytest_asyncio.fixture
async def database():
    if "/orsem_test?" not in URL or "unix_socket=/tmp/" not in URL:
        raise RuntimeError("Requires the disposable orsem_test Unix-socket database")
    db = Database.from_url(URL)
    yield db
    await db.close()


async def prepare(db, count):
    company = identifier()
    symbol = "T" + company[:7].upper()
    await insert(
        db,
        "companies",
        {"id": company, "market": "NASDAQ", "ticker": symbol, "nameKo": "합성", "isListed": True},
    )
    scope = {
        "companyId": company,
        "symbol": symbol,
        "region": "us",
        "currency": "USD",
        "priority": "P1",
    }
    stock = {"symbol": symbol, "market": "NASDAQ", "currency": "USD", "name": "합성"}
    ctx = SimpleNamespace(db=db, config=SimpleNamespace(tossClientId=None, tossClientSecret=None))
    stocks = SimpleNamespace(lookup=AsyncMock(return_value={symbol: stock}))
    service = MarketData(ctx, SimpleNamespace(enabled=True), stocks)
    service.scope = AsyncMock(return_value=[scope])
    service.health = AsyncMock()
    now = utcnow()
    bars = [
        normalize_candle(
            scope,
            "1m",
            {
                "timestamp": iso(now - timedelta(minutes=count - index + 1)),
                "openPrice": "10.123456",
                "highPrice": "12",
                "lowPrice": "9",
                "closePrice": "11.123456",
                "volume": "9007199254740993",
                "currency": "USD",
                "syntheticSequence": index,
            },
            now,
        )
        for index in range(count)
    ]
    service.fetch_candles = AsyncMock(return_value=bars)
    return service, {"companyIds": [company], "interval": "1m", "reason": "VIEW"}, bars, stock


@pytest.mark.asyncio
async def test_toss_405_bars_use_200_row_batches_and_preserve_existing_identity(
    database, monkeypatch
):
    service, payload, bars, stock = await prepare(database, 405)
    calls = []
    original = Database.execute

    async def record(db, sql, params=None):
        if sql.startswith("INSERT INTO `price_bars`"):
            calls.append(sum(bool(re.fullmatch(r"b\d+_id", key)) for key in params))
            assert "`id`=" not in sql.split("ON DUPLICATE KEY UPDATE")[1]
        return await original(db, sql, params)

    monkeypatch.setattr(Database, "execute", record)
    first = await service.ingest(payload)
    assert first["itemsCreated"] == first["rows"] == 405
    assert calls == [200, 200, 5]
    before = await database.fetch_all(
        "SELECT * FROM price_bars WHERE company_id=:company ORDER BY bar_at",
        {"company": payload["companyIds"][0]},
    )
    assert len(before) == 405
    assert str(before[0]["close"]) == "11.123456"
    assert str(before[0]["volume"]) == "9007199254740993.000000"
    assert obj(before[0]["raw_payload_json"])["volume"] == "9007199254740993"
    assert obj(before[0]["provenance_json"])["stock"] == stock
    assert before[0]["rights_mode"] == "PRIVATE_DISPLAY_ONLY"
    revised = copy.deepcopy(bars)
    revised[0]["close"] = "11.765432"
    revised[0]["rawPayloadJson"]["closePrice"] = "11.765432"
    revised[0]["observedAt"] += timedelta(seconds=1)
    revised[0]["provenanceJson"]["observedAt"] = iso(revised[0]["observedAt"])
    service.fetch_candles = AsyncMock(return_value=revised)
    calls.clear()
    second = await service.ingest(payload)
    assert second["itemsCreated"] == 0 and second["rows"] == 405
    assert calls == [200, 200, 5]
    after = await database.fetch_all(
        "SELECT * FROM price_bars WHERE company_id=:company ORDER BY bar_at",
        {"company": payload["companyIds"][0]},
    )
    assert [row["id"] for row in after] == [row["id"] for row in before]
    assert after[0]["bar_at"] == before[0]["bar_at"]
    assert after[0]["source"] == "TOSS_US" and after[0]["interval"] == "1m"
    assert str(after[0]["close"]) == "11.765432"
    assert obj(after[0]["raw_payload_json"])["closePrice"] == "11.765432"
    assert after[0]["observed_at"] > before[0]["observed_at"]
    checkpoint = await read_checkpoint(
        database, "TOSS", "PRICE_BARS:1m:" + payload["companyIds"][0]
    )
    assert obj(checkpoint["metadataJson"])["rows"] == 405


@pytest.mark.asyncio
async def test_toss_later_batch_failure_rolls_back_earlier_rows_and_checkpoint(
    database, monkeypatch
):
    service, payload, bars, _ = await prepare(database, 201)
    service.fetch_candles = AsyncMock(return_value=bars[:1])
    await service.ingest(payload)
    company = payload["companyIds"][0]
    before = await database.fetch_all(
        "SELECT * FROM price_bars WHERE company_id=:id", {"id": company}
    )
    checkpoint = await read_checkpoint(database, "TOSS", "PRICE_BARS:1m:" + company)
    revised = copy.deepcopy(bars)
    revised[0]["close"] = "11.5"
    revised[0]["rawPayloadJson"]["closePrice"] = "11.5"
    service.fetch_candles = AsyncMock(return_value=revised)
    original = Database.execute
    calls = 0

    async def fail_second(db, sql, params=None):
        nonlocal calls
        if sql.startswith("INSERT INTO `price_bars`"):
            calls += 1
            if calls == 2:
                raise RuntimeError("synthetic second batch failure")
        return await original(db, sql, params)

    monkeypatch.setattr(Database, "execute", fail_second)
    with pytest.raises(RuntimeError, match="synthetic second batch failure"):
        await service.ingest(payload)
    assert calls == 2
    assert (
        await database.fetch_all("SELECT * FROM price_bars WHERE company_id=:id", {"id": company})
        == before
    )
    assert await read_checkpoint(database, "TOSS", "PRICE_BARS:1m:" + company) == checkpoint
