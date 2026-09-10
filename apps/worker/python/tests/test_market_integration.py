"""Opt-in tests against the disposable migrated MySQL database, never production."""

import asyncio
import copy
import os
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from orsem_worker.core import Database, identifier, utcnow
from orsem_worker.market.common import in_params, insert, instant, iso, obj, read_checkpoint, update
from orsem_worker.market.indicators import Indicators
from orsem_worker.market.masters import AlpacaMaster, EtfMaster, SecCikMaster
from orsem_worker.market.toss import MarketData, StockInfo

URL = os.environ.get("ORSEM_MARKET_TEST_DB", "")
pytestmark = pytest.mark.skipif(
    not URL, reason="Set ORSEM_MARKET_TEST_DB to disposable migrated MySQL"
)


@pytest_asyncio.fixture
async def context():
    if "/orsem_test?" not in URL:
        raise RuntimeError("Integration tests require the disposable orsem_test database")
    db = Database.from_url(URL)
    cfg = SimpleNamespace(
        redisPrefix="market-test:",
        tossMaxSubscriptions=100,
        tossClientId="fixture-id",
        tossClientSecret="fixture-secret",
        alpacaApiKey="fixture-key",
        alpacaApiSecret="fixture-secret",
        goldApiKey=None,
        eiaApiKey=None,
        secUserAgent="OrsemTest test@example.com",
        httpTimeoutMs=1000,
    )
    ctx = SimpleNamespace(
        config=cfg, db=db, redis=SimpleNamespace(zadd=AsyncMock(), expire=AsyncMock()), services={}
    )
    yield ctx
    await db.close()


@pytest.mark.asyncio
async def test_ingestion_atomic_checkpoint_and_no_duplicate_bars(context):
    ctx = context
    company = identifier()
    symbol = "T" + company[:7].replace("-", "").upper()
    now = utcnow()
    await insert(
        ctx.db,
        "companies",
        {
            "id": company,
            "market": "NASDAQ",
            "ticker": symbol,
            "nameKo": "Synthetic",
            "nameEn": "Synthetic",
            "isListed": True,
        },
    )
    stock = {
        "symbol": symbol,
        "market": "NASDAQ",
        "status": "ACTIVE",
        "currency": "USD",
        "name": "합성 테스트",
        "englishName": "Synthetic",
        "isinCode": "US1234567890",
    }
    raw = {
        "timestamp": iso(now - timedelta(days=1)),
        "openPrice": "10",
        "highPrice": "12",
        "lowPrice": "9",
        "closePrice": "11",
        "volume": "100",
        "currency": "USD",
    }
    client = SimpleNamespace(
        enabled=True,
        stocks=AsyncMock(return_value=[stock]),
        candle_page=AsyncMock(return_value={"candles": [raw], "nextBefore": None}),
    )
    service = MarketData(ctx, client, StockInfo(ctx, client))
    payload = {"companyIds": [company], "interval": "1d", "reason": "VIEW"}
    first = await service.ingest(payload)
    second = await service.ingest(payload)
    assert first["itemsCreated"] == 1 and second["itemsCreated"] == 0
    count = await ctx.db.fetch_one(
        "SELECT COUNT(*) total FROM price_bars WHERE company_id=:id", {"id": company}
    )
    assert count["total"] == 1
    cp = await read_checkpoint(ctx.db, "TOSS", "PRICE_BARS:1d:" + company)
    history = obj(cp["metadataJson"])["viewHistory"]
    assert history["maximumBars"] == 400 and history["symbol"] == symbol
    initial_checkpoint = iso(instant(cp["lastSuccessAt"]))
    client.candle_page = AsyncMock(side_effect=ValueError("synthetic fetch failure"))
    with pytest.raises(RuntimeError, match="synthetic fetch failure"):
        await service.ingest(payload)
    cp = await read_checkpoint(ctx.db, "TOSS", "PRICE_BARS:1d:" + company)
    assert iso(instant(cp["lastSuccessAt"])) == initial_checkpoint
    stored = await ctx.db.fetch_one(
        "SELECT name_ko,name_en FROM companies WHERE id=:id", {"id": company}
    )
    assert stored["name_ko"] == "합성 테스트" and stored["name_en"] == "Synthetic"


@pytest.mark.asyncio
async def test_indicator_corrections_first_observed_and_previous_reference(context):
    service = Indicators(context, SimpleNamespace(enabled=False))
    await service.catalog()
    now = utcnow()
    dates = ["1901-01-01", "1901-01-02"]
    rows = [
        {
            "instrumentId": "us2y",
            "kind": "DAILY",
            "period": day,
            "sourceDate": day,
            "providerAt": None,
            "value": str(3 + i),
            "raw": {"syntheticTest": True},
        }
        for i, day in enumerate(dates)
    ]
    assert await service.save_observations("TREASURY", rows, now) == 3
    current = await context.db.fetch_one(
        "SELECT * FROM market_observations WHERE instrument_id='us2y' AND kind='DAILY' AND period='1901-01-02'"
    )
    assert str(current["reference_value"]) == "3.0000000000"
    first = current["first_observed_at"]
    changed = copy.deepcopy(rows)
    changed[1]["value"] = "4.25"
    await service.save_observations("TREASURY", changed, now + timedelta(seconds=1))
    revised = await context.db.fetch_one(
        "SELECT * FROM market_observations WHERE instrument_id='us2y' AND kind='DAILY' AND period='1901-01-02'"
    )
    assert revised["first_observed_at"] == first and str(revised["value"]) == "4.2500000000"
    with pytest.raises(ValueError, match="Unexpected instrument source"):
        await service.save_observations("TOSS", rows, now)


@pytest.mark.asyncio
async def test_cik_conflict_never_overwrites_existing_identity(context):
    ctx = context
    company = identifier()
    ticker = "C" + company[:7].upper()
    await insert(
        ctx.db,
        "companies",
        {
            "id": company,
            "market": "NASDAQ",
            "ticker": ticker,
            "cik": "0000000012",
            "nameKo": "Synthetic CIK",
            "isListed": True,
        },
    )
    cache = {
        "formatVersion": 1,
        "provenanceUrl": "https://www.sec.gov/files/company_tickers_exchange.json",
        "method": "SEARCH_CACHE_EXTRACT",
        "extractedAt": iso(utcnow()),
        "sourceLastModified": None,
        "cacheAge": "UNKNOWN",
        "coverage": "SELECTED_ROWS_ONLY",
        "liveIssuerValidation": "NOT_COMPLETED",
        "fields": ["cik", "name", "ticker", "exchange"],
        "data": [[13, "Synthetic CIK", ticker, "NASDAQ"]],
    }
    result = await SecCikMaster(ctx).sync({"companyIds": [company]}, cache=cache)
    assert result["conflicts"] == 1 and result["linked"] == 0
    stored = await ctx.db.fetch_one("SELECT cik FROM companies WHERE id=:id", {"id": company})
    assert stored["cik"] == "0000000012"
    cp = await read_checkpoint(ctx.db, "SEC_EDGAR", "CIK_MAPPING:" + company)
    assert obj(cp["metadataJson"])["candidateCik"] == "0000000013"


@pytest.mark.asyncio
async def test_etf_master_dry_run_creates_nothing(context):
    symbol = "Z" + identifier().replace("-", "")[:5].upper()
    stock = {
        "symbol": symbol,
        "name": "합성 ETF",
        "isinCode": "KR1234567890",
        "securityType": "ETF",
        "isCommonShare": False,
    }

    async def stocks_all(market, status, security_type):
        return [stock] if market == "KOSPI" and status == "ACTIVE" else []

    service = EtfMaster(context, SimpleNamespace(enabled=True, stocks_all=stocks_all))
    result = await service.sync({"force": True, "dryRun": True})
    assert result["status"] == "DRY_RUN" and result["created"] == 1
    assert (
        await context.db.fetch_one(
            "SELECT id FROM companies WHERE stock_code=:code", {"code": symbol}
        )
        is None
    )


@pytest.mark.asyncio
async def test_alpaca_stable_asset_id_does_not_remap_reused_ticker(context):
    ctx = context
    provider = identifier()
    symbol = "A" + provider[:7].upper()
    asset = {
        "providerAssetId": provider,
        "assetClass": "us_equity",
        "exchange": "NASDAQ",
        "symbol": symbol,
        "name": "Synthetic Asset",
        "status": "active",
        "tradable": True,
        "marginable": True,
        "shortable": False,
        "easyToBorrow": False,
        "fractionable": True,
        "maintenanceMarginRequirement": None,
        "attributes": [],
        "raw": {"id": provider},
    }
    service = AlpacaMaster(ctx)
    service.fetch = AsyncMock(
        return_value=(
            [asset],
            "https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",
        )
    )
    first = await service.sync()
    assert first["eligibleAssets"] == 1
    stored = await ctx.db.fetch_one(
        "SELECT company_id FROM alpaca_assets WHERE provider_asset_id=:id", {"id": provider}
    )
    company = stored["company_id"]
    changed = {**asset, "symbol": symbol + "X"}
    service.fetch = AsyncMock(
        return_value=(
            [changed],
            "https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",
        )
    )
    second = await service.sync()
    assert second["eligibleAssets"] == 0 and second["ambiguousSymbols"] == 1
    old = await ctx.db.fetch_one(
        "SELECT ticker,is_listed FROM companies WHERE id=:id", {"id": company}
    )
    assert old["ticker"] == symbol and old["is_listed"] == 0


@pytest.mark.asyncio
async def test_alpaca_batches_are_atomic_and_concurrent_sync_keeps_stable_ids(context, monkeypatch):
    ctx = context
    tag = identifier().replace("-", "")[:6].upper()
    assets = [
        {
            "providerAssetId": identifier(),
            "assetClass": "us_equity",
            "exchange": "NASDAQ",
            "symbol": f"B{tag}{i:03}",
            "name": "Synthetic batch asset",
            "status": "active",
            "tradable": True,
            "marginable": True,
            "shortable": False,
            "easyToBorrow": False,
            "fractionable": True,
            "maintenanceMarginRequirement": None,
            "attributes": [],
            "raw": {"syntheticBatch": tag, "sequence": i},
        }
        for i in range(501)
    ]
    providers = [asset["providerAssetId"] for asset in assets]
    symbols = [asset["symbol"] for asset in assets]
    marks, provider_params = in_params(providers)
    symbol_marks, symbol_params = in_params(symbols)
    before_assets = await ctx.db.fetch_all("SELECT provider_asset_id,is_current FROM alpaca_assets")
    before_companies = await ctx.db.fetch_all(
        "SELECT DISTINCT c.id,c.is_listed FROM companies c JOIN alpaca_assets a ON a.company_id=c.id WHERE a.is_current=1"
    )
    before_checkpoint = await read_checkpoint(ctx.db, "ALPACA", "ASSET_MASTER")
    original_execute = Database.execute
    writes = []
    fail_second_asset_batch = True

    async def recording_execute(db, sql, params=None):
        if sql.startswith("INSERT INTO `alpaca_assets`"):
            writes.append(
                ("assets", len([key for key in params if key.endswith("_provider_asset_id")]))
            )
            if fail_second_asset_batch and len(writes) == 2:
                raise RuntimeError("Synthetic second asset batch failure")
        return await original_execute(db, sql, params)

    monkeypatch.setattr(Database, "execute", recording_execute)
    service = AlpacaMaster(ctx)
    service.fetch = AsyncMock(return_value=(assets, "https://paper-api.alpaca.markets/v2/assets"))
    try:
        with pytest.raises(RuntimeError, match="Synthetic second asset batch failure"):
            await service.sync()
        assert writes == [("assets", 250), ("assets", 250)]
        assert not await ctx.db.fetch_all(
            f"SELECT id FROM alpaca_assets WHERE provider_asset_id IN ({marks})", provider_params
        )
        assert not await ctx.db.fetch_all(
            f"SELECT id FROM companies WHERE ticker IN ({symbol_marks})", symbol_params
        )
        assert await read_checkpoint(ctx.db, "ALPACA", "ASSET_MASTER") == before_checkpoint
        assert (
            await ctx.db.fetch_all("SELECT provider_asset_id,is_current FROM alpaca_assets")
            == before_assets
        )

        fail_second_asset_batch = False
        writes.clear()
        first = await service.sync()
        assert first["companiesCreated"] == first["assetsCreated"] == 501
        assert writes == [("assets", 250), ("assets", 250), ("assets", 1)]
        first_rows = await ctx.db.fetch_all(
            f"SELECT id,provider_asset_id,company_id,first_observed_at FROM alpaca_assets WHERE provider_asset_id IN ({marks}) ORDER BY provider_asset_id",
            provider_params,
        )
        assert len(first_rows) == len({row["company_id"] for row in first_rows}) == 501
        second = AlpacaMaster(ctx)
        second.fetch = AsyncMock(
            return_value=(assets, "https://paper-api.alpaca.markets/v2/assets")
        )
        concurrent = await asyncio.gather(service.sync(), second.sync())
        assert all(
            result["companiesCreated"] == result["assetsCreated"] == 0 for result in concurrent
        )
        after_rows = await ctx.db.fetch_all(
            f"SELECT id,provider_asset_id,company_id,first_observed_at FROM alpaca_assets WHERE provider_asset_id IN ({marks}) ORDER BY provider_asset_id",
            provider_params,
        )
        assert after_rows == first_rows
        counts = await ctx.db.fetch_one(
            f"SELECT COUNT(*) total,COUNT(DISTINCT provider_asset_id) distinct_ids FROM alpaca_assets WHERE provider_asset_id IN ({marks})",
            provider_params,
        )
        assert counts["total"] == counts["distinct_ids"] == 501
    finally:
        monkeypatch.setattr(Database, "execute", original_execute)
        await ctx.db.execute(
            f"DELETE FROM alpaca_assets WHERE provider_asset_id IN ({marks})", provider_params
        )
        await ctx.db.execute(
            f"DELETE FROM companies WHERE ticker IN ({symbol_marks})", symbol_params
        )
        for row in before_assets:
            await ctx.db.execute(
                "UPDATE alpaca_assets SET is_current=:is_current WHERE provider_asset_id=:provider_asset_id",
                row,
            )
        for row in before_companies:
            await ctx.db.execute("UPDATE companies SET is_listed=:is_listed WHERE id=:id", row)
        if before_checkpoint:
            await update(
                ctx.db,
                "source_checkpoints",
                before_checkpoint["id"],
                {
                    key: before_checkpoint[key]
                    for key in (
                        "lastSuccessDate",
                        "lastSuccessAt",
                        "checkpointCursor",
                        "metadataJson",
                    )
                },
            )
        else:
            await ctx.db.execute(
                "DELETE FROM source_checkpoints WHERE connector='ALPACA' AND stream='ASSET_MASTER'"
            )
