"""Native market worker entrypoints. Registration has no ingestion side effects."""

from uuid import UUID

from .common import instant
from .fundamentals import Fundamentals
from .indicators import Indicators
from .live import LiveQuotes
from .masters import AlpacaMaster, EtfMaster, SecCikMaster
from .selection import Selection
from .toss import MarketData, StockInfo, TossClient


def validate_ids(payload, maximum=100):
    ids = payload.get("companyIds")
    if ids is not None:
        if not isinstance(ids, list) or not 1 <= len(ids) <= maximum:
            raise ValueError("Invalid company scope")
        for value in ids:
            if not isinstance(value, str):
                raise ValueError("Invalid company UUID")  # noqa: TRY004 - invalid job contract
            UUID(value)


async def register(ctx):
    toss = TossClient(ctx)
    stocks = StockInfo(ctx, toss)
    market = MarketData(ctx, toss, stocks)
    indicators = Indicators(ctx, toss)
    etfs = EtfMaster(ctx, toss)
    alpaca = AlpacaMaster(ctx)
    sec = SecCikMaster(ctx)
    fundamentals = Fundamentals(ctx)
    selection = Selection(ctx, toss, market)
    live = LiveQuotes(ctx, toss, market)
    ctx.services.update(
        {
            "toss": toss,
            "market_data": market,
            "stock_info": stocks,
            "market_indicators": indicators,
            "korean_etf_master": etfs,
            "alpaca_assets": alpaca,
            "sec_cik": sec,
            "company_information": fundamentals,
            "market_selection": selection,
            "toss_live": live,
        }
    )
    for service in (toss, fundamentals, selection, etfs, live):
        ctx.on_close(service.close)

    async def candles(payload):
        validate_ids(payload)
        if payload.get("interval") not in ("1d", "1m") or payload.get("reason") not in (
            None,
            "SCHEDULED",
            "MANUAL",
            "VIEW",
        ):
            raise ValueError("Invalid Toss candle job")
        for key, maximum in [("lookbackDays", 366), ("maxPages", 6)]:
            if key in payload and (
                type(payload[key]) is not int or not 1 <= payload[key] <= maximum
            ):
                raise ValueError("Invalid Toss candle range")
        if payload.get("before") is not None:
            instant(payload["before"])
        return await market.ingest(payload)

    async def sync_stocks(payload):
        validate_ids(payload)
        if set(payload) - {"companyIds", "reason"} or payload.get("reason", "MANUAL") not in (
            "MANUAL",
            "SCHEDULED",
        ):
            raise ValueError("Invalid Toss stock information job")
        return await market.sync_stocks(payload.get("companyIds"))

    async def sync_alpaca(payload):
        if set(payload) != {"reason"} or payload["reason"] not in ("SCHEDULED", "MANUAL"):
            raise ValueError("Invalid Alpaca asset synchronization job")
        return await alpaca.sync()

    async def sync_cik(payload):
        validate_ids(payload, 10000)
        return await sec.sync(payload)

    async def quotes(_payload):
        return await indicators.refresh("quotes")

    async def history(_payload):
        return await indicators.refresh("history")

    return {
        "ingest-toss-candles": candles,
        "sync-toss-stocks": sync_stocks,
        "sync-alpaca-assets": sync_alpaca,
        "sync-sec-cik": sync_cik,
        "refresh-market-indicator-quotes": quotes,
        "refresh-market-indicator-history": history,
    }


async def start(ctx):
    services = ctx.services
    await services["market_indicators"].catalog()
    if ctx.config.nodeEnv == "test":
        return
    ctx.periodic("monthly-market-selection", 300, services["market_selection"].refresh)
    if ctx.config.secUserAgent:
        ctx.periodic("sec-company-information", 900, services["company_information"].refresh_sec)
    dart = services.get("opendart")
    if dart and dart.enabled:
        ctx.periodic(
            "opendart-company-information", 900, services["company_information"].refresh_kr
        )
    if services["toss"].enabled:
        ctx.periodic("toss-korean-etf-master", 3600, services["korean_etf_master"].sync)
        ctx.periodic("toss-live-lease", 10, services["toss_live"].maintain_lease)
        ctx.periodic("toss-live-scope", 15, services["toss_live"].refresh_scope, immediately=False)
        ctx.periodic("toss-live-ping", 60, services["toss_live"].ping, immediately=False)
