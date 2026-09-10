"""Synthetic regression cases carried from the TypeScript market worker contracts."""

import asyncio
import copy
import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from orsem_worker.market import register, start
from orsem_worker.market.common import instant, iso
from orsem_worker.market.fundamentals import (
    decimal_text,
    financial_fields,
    parse_sec_information,
    report_bps,
    sec_facts_url,
)
from orsem_worker.market.indicators import (
    IndicatorRequestError,
    Indicators,
    parse_bithumb_daily,
    parse_bithumb_quotes,
    parse_eia,
    parse_gold_history,
    parse_gold_quote,
    parse_toss_daily,
    parse_toss_fx,
    parse_toss_indicators,
    parse_treasury,
)
from orsem_worker.market.live import quote_from_frame, trade_declaration
from orsem_worker.market.masters import (
    SecTickerIndex,
    alpaca_market,
    parse_alpaca_assets,
    parse_sec_search_cache,
    parse_sec_snapshot,
    plan_etf_master,
    validate_alpaca_size,
    validate_etf_universe,
)
from orsem_worker.market.selection import select_monthly, selection_month, should_refresh
from orsem_worker.market.toss import (
    StockInfo,
    TossClient,
    TossHttpError,
    company_name_patch,
    company_scope,
    decimal,
    normalize_candle,
    plan_view_fetch,
)

NOW = instant("2026-09-06T16:00:00Z")
KR = {
    "companyId": "00000000-0000-4000-8000-000000000001",
    "symbol": "005930",
    "region": "kr",
    "currency": "KRW",
    "priority": "P1",
}
US = {
    **KR,
    "companyId": "00000000-0000-4000-8000-000000000002",
    "symbol": "NVDA",
    "region": "us",
    "currency": "USD",
}


def candle(at="2026-09-04T00:00:00Z", **changes):
    return {
        "timestamp": at,
        "openPrice": "10.00",
        "highPrice": "12",
        "lowPrice": "9",
        "closePrice": "11.50",
        "volume": "100",
        "currency": "KRW",
        "sourceExtra": "preserved",
        **changes,
    }


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("0", "0"),
        ("000.000", "0"),
        ("1.2300000", "1.23"),
        ("12345678901234567890123456789012.123456", "12345678901234567890123456789012.123456"),
    ],
)
def test_toss_decimal_lossless(raw, expected):
    assert decimal(raw) == expected


@pytest.mark.parametrize("raw", ["-1", "1e3", "NaN", "1.0000001", "9" * 33, "1,000", "+1", 1, None])
def test_toss_decimal_rejects_out_of_contract(raw):
    with pytest.raises(ValueError):
        decimal(raw)


def test_candles_exact_values_dates_and_raw():
    raw = candle()
    row = normalize_candle(KR, "1d", raw, NOW)
    assert row["close"] == "11.5" and row["rawPayloadJson"] == raw
    assert row["rightsMode"] == "PRIVATE_DISPLAY_ONLY"
    assert row["provenanceJson"]["adjusted"] is False
    assert row["sessionDate"] == "2026-09-04"
    assert normalize_candle(US, "1d", candle(currency="USD"), NOW)["sessionDate"] == "2026-09-03"
    assert raw["openPrice"] == "10.00"


@pytest.mark.parametrize(
    "changes",
    [
        {"highPrice": "10"},
        {"lowPrice": "12"},
        {"currency": "USD"},
        {"timestamp": "2026-10-01T00:00:00Z"},
        {"timestamp": "2026-09-04T00:00:00"},
    ],
)
def test_candle_rejects_envelope_identity_future(changes):
    with pytest.raises(ValueError):
        normalize_candle(KR, "1m", candle(**changes), NOW)


def test_zero_trade_candle_keeps_reported_close():
    row = normalize_candle(
        KR, "1m", candle(openPrice="0", highPrice="0", lowPrice="0", volume="0"), NOW
    )
    assert row["close"] == "11.5" and row["provenanceJson"]["noTrades"] is True


def test_scope_rejects_unlisted_and_ambiguous_identifiers():
    company = {
        "id": "x",
        "isListed": True,
        "market": "KOSPI",
        "stockCode": "0123A0",
        "ticker": None,
    }
    assert company_scope(company)["symbol"] == "0123A0"
    assert company_scope({**company, "isListed": False}) is None
    assert company_scope({**company, "stockCode": "12345"}) is None
    assert (
        company_scope({"id": "x", "isListed": True, "market": "NYSE", "ticker": "brk.b"})["symbol"]
        == "BRK.B"
    )


def test_view_history_only_complete_view_requests_can_hydrate():
    payload = {"interval": "1d", "reason": "VIEW"}
    plan, policy, hydrated = plan_view_fetch(KR, payload, None, NOW)
    assert plan["maxPages"] == 3 and policy["maximumBars"] == 400 and hydrated is None
    metadata = {
        "viewHistory": {
            **policy,
            "hydratedAt": iso(NOW - timedelta(days=5)),
            "refreshedAt": iso(NOW - timedelta(days=1)),
        }
    }
    assert plan_view_fetch(KR, payload, metadata, NOW)[0]["maxPages"] == 1
    assert plan_view_fetch(KR, {**payload, "reason": "SCHEDULED"}, metadata, NOW)[1] is None
    assert plan_view_fetch(KR, {**payload, "maxPages": 1}, metadata, NOW)[1] is None
    assert plan_view_fetch(KR, {**payload, "before": iso(NOW)}, metadata, NOW)[1] is None
    assert plan_view_fetch(KR, payload, metadata, NOW + timedelta(days=180))[0]["maxPages"] == 3
    assert plan_view_fetch({**KR, "symbol": "000660"}, payload, metadata, NOW)[0]["maxPages"] == 3


def test_trade_frame_only_matches_declared_identity_and_never_sums_volume():
    raw = {
        "type": "message",
        "topic": "trade:kr:005930",
        "data": {"price": "1.20", "volume": "99", "timestamp": iso(NOW), "currency": "KRW"},
    }
    quote = quote_from_frame(raw, [KR, US], NOW)
    assert (
        quote["price"] == "1.2"
        and quote["source"] == "TOSS_KR_INTEGRATED"
        and quote["lossy"] is True
    )
    assert "volume" not in quote and quote["rawPayload"] == raw
    assert quote_from_frame(raw, [US], NOW) is None
    raw["data"]["timestamp"] = iso(NOW + timedelta(minutes=2))
    assert quote_from_frame(raw, [KR], NOW) is None
    assert trade_declaration([KR, KR, US]) == [
        {"type": "trade:kr", "codes": ["005930"]},
        {"type": "trade:us", "codes": ["NVDA"]},
    ]


def test_stock_names_preserve_manual_korean_and_existing_english():
    company = {
        "id": "x",
        "isListed": True,
        "ticker": "AAPL",
        "market": "NASDAQ",
        "nameKo": "Apple",
        "nameEn": "Original",
    }
    stock = {
        "symbol": "AAPL",
        "market": "NASDAQ",
        "currency": "USD",
        "name": "애플",
        "englishName": "Apple Inc",
    }
    assert company_name_patch(company, stock, None) == {"nameKo": "애플"}
    assert company_name_patch({**company, "nameKo": "직접 이름"}, stock, None) == {}
    assert company_name_patch(
        {**company, "nameKo": "직접 이름"}, stock, {"appliedNameKo": "직접 이름"}
    ) == {"nameKo": "애플"}
    assert company_name_patch(company, {**stock, "market": "NYSE"}, None) == {}


@pytest.mark.asyncio
async def test_stock_404_splits_only_missing_symbol():
    async def lookup(symbols):
        if "BAD" in symbols:
            raise TossHttpError(404)
        return [{"symbol": s} for s in symbols]

    service = StockInfo(None, SimpleNamespace(stocks=lookup))
    assert await service.available(["A", "BAD", "C"]) == [{"symbol": "A"}, {"symbol": "C"}]


def test_indicator_sources_keep_correct_times_and_reference():
    result = parse_toss_indicators(
        {"result": [{"symbol": "KOSPI", "lastPrice": "123.4", "timestamp": None}]}, NOW
    )
    assert result[0]["providerAt"] is None and result[0]["sourceDate"] is None
    fx = parse_toss_fx(
        {
            "result": {
                "baseCurrency": "USD",
                "quoteCurrency": "KRW",
                "rate": "1400",
                "validFrom": "2026-09-06T16:00:00Z",
            }
        },
        NOW,
    )
    assert fx[1]["period"] == "2026-09-07" and fx[1]["raw"]["aggregation"] == "OBSERVED_LAST"
    raw = {
        "market": "KRW-BTC",
        "trade_price": 100,
        "prev_closing_price": 90,
        "trade_date": "20260906",
        "trade_time": "150000",
        "trade_date_kst": "20260907",
        "trade_time_kst": "000000",
        "trade_timestamp": 1,
    }
    quote = parse_bithumb_quotes([raw], NOW)[0]
    assert iso(quote["providerAt"]) == "2026-09-06T15:00:00.000Z"
    assert quote["referenceDate"] == "2026-09-06" and quote["referenceValue"] == "90"
    assert quote["raw"]["trade_timestamp"] == 1
    with pytest.raises(ValueError, match="Inconsistent"):
        parse_bithumb_quotes([{**raw, "trade_time_kst": "000001"}], NOW)


def test_indicator_history_does_not_invent_provider_instants():
    gold = parse_gold_history([{"day": "2026-09-04 00:00:00", "avg_price": "2000"}], "gold", NOW)[0]
    assert (
        gold["providerAt"] is None
        and gold["period"] == "2026-09-04"
        and gold["raw"]["aggregation"] == "DAILY_AVERAGE"
    )
    oil = parse_eia(
        {
            "response": {
                "data": [
                    {
                        "period": "2026-09-04",
                        "value": "-37.63",
                        "series": "RWTC",
                        "value-units": "$/BBL",
                    }
                ]
            }
        },
        NOW,
    )[0]
    assert oil["value"] == "-37.63" and oil["providerAt"] is None
    assert parse_eia({"response": {"data": [{"value": None}]}}, NOW) == []
    metal = parse_gold_quote(
        {"symbol": "XAU", "price": 2000, "updatedAt": "2026-09-06T16:00:00Z"}, "gold", NOW
    )[0]
    assert metal["sourceDate"] == "2026-09-06"


def test_treasury_xml_missing_values_remain_missing():
    xml = """<feed xmlns:d="urn:d" xmlns:m="urn:m"><entry><content><m:properties><d:NEW_DATE>2026-09-04T00:00:00</d:NEW_DATE><d:BC_2YEAR m:null="true"/><d:BC_10YEAR>4.2</d:BC_10YEAR></m:properties></content></entry></feed>"""
    rows = parse_treasury(xml, NOW)
    assert len(rows) == 1 and rows[0]["instrumentId"] == "us10y" and rows[0]["providerAt"] is None
    with pytest.raises(ValueError):
        parse_treasury(
            '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed>&x;</feed>', NOW
        )


@pytest.mark.asyncio
async def test_treasury_preserves_deployed_user_agent_only_for_its_own_requests():
    requests = []

    def respond(request):
        requests.append(request)
        assert set(request.extensions["timeout"].values()) == {15.0}
        if request.url.host == "home.treasury.gov":
            assert request.headers["user-agent"] == "node"
            assert request.headers["accept"] == "application/xml"
            assert dict(request.url.params) == {
                "data": "daily_treasury_yield_curve",
                "field_tdr_date_value": "2025",
            }
            return httpx.Response(200, text="<feed/>")
        assert request.headers["user-agent"].startswith("python-httpx/")
        assert request.headers["accept"] == "application/json"
        return httpx.Response(200, json=[])

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False) as client:
        indicators = Indicators(
            SimpleNamespace(http=client, config=SimpleNamespace(httpTimeoutMs=15000)), None
        )
        assert (
            await indicators.request(
                "TREASURY",
                "/resource-center/data-chart-center/interest-rates/pages/xml",
                {"data": "daily_treasury_yield_curve", "field_tdr_date_value": "2025"},
                xml=True,
            )
            == "<feed/>"
        )
        assert await indicators.request("BITHUMB", "/v1/ticker") == []
    assert len(requests) == 2


@pytest.mark.asyncio
async def test_treasury_compatibility_header_preserves_redirect_rejection_and_cooldown():
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(302, headers={"Location": "https://unrelated.invalid/"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False) as client:
        indicators = Indicators(
            SimpleNamespace(http=client, config=SimpleNamespace(httpTimeoutMs=15000)), None
        )
        for _ in range(2):
            with pytest.raises(IndicatorRequestError) as failure:
                await indicators.request(
                    "TREASURY",
                    "/resource-center/data-chart-center/interest-rates/pages/xml",
                    xml=True,
                )
            assert failure.value.http_status == 302
    assert len(calls) == 1
    assert calls[0].url.host == "home.treasury.gov"


@pytest.mark.parametrize(
    "parser,payload,args",
    [
        (
            parse_toss_indicators,
            {
                "result": [
                    {"symbol": "KOSPI", "lastPrice": "1"},
                    {"symbol": "KOSPI", "lastPrice": "2"},
                ]
            },
            (),
        ),
        (parse_toss_fx, {"result": {"baseCurrency": "KRW", "quoteCurrency": "USD"}}, ()),
        (parse_gold_quote, {"symbol": "XAG", "price": 1, "updatedAt": iso(NOW)}, ("gold",)),
        (parse_eia, {"response": {"data": [{"period": "2026-10-01", "value": "1"}]}}, ()),
        (
            parse_eia,
            {"response": {"data": [{"period": "2026-09-04", "value": "1", "series": "OTHER"}]}},
            (),
        ),
        (
            parse_bithumb_daily,
            [
                {
                    "market": "KRW-ETH",
                    "candle_date_time_kst": "2026-09-04T00:00:00",
                    "trade_price": 1,
                }
            ],
            ("btc",),
        ),
        (
            parse_toss_daily,
            {"result": {"candles": [{"timestamp": "2026-10-01T00:00:00Z", "closePrice": "1"}]}},
            ("kospi",),
        ),
    ],
)
def test_indicator_validation_failures(parser, payload, args):
    with pytest.raises(ValueError):
        parser(payload, *args, NOW)


def monthly_input(region="us"):
    listings = [
        {
            "name": f"Company {i}",
            "symbol": f"S{i}" if region == "us" else str(i).zfill(6),
            "isinCode": ("US" if region == "us" else "KR") + str(i).zfill(6) + "1000",
            "securityType": "STOCK",
            "isCommonShare": True,
            "requestedMarket": "NASDAQ" if region == "us" else "KOSPI",
        }
        for i in range(25)
    ]
    companies = [
        {
            "id": f"company-{i}",
            "stockCode": r["symbol"] if region == "kr" else None,
            "ticker": r["symbol"],
            "corpCode": str(i + 1).zfill(8) if region == "kr" else None,
            "cik": None,
            "market": "KRX" if region == "kr" else "NASDAQ",
        }
        for i, r in enumerate(listings)
    ]
    stocks = [
        {
            **r,
            "market": r["requestedMarket"],
            "status": "ACTIVE",
            "currency": "USD" if region == "us" else "KRW",
            "sharesOutstanding": "10000000000000000",
        }
        for r in listings
    ]
    prices = [
        {
            "symbol": r["symbol"],
            "lastPrice": f"{100 - i}.1234",
            "currency": "USD" if region == "us" else "KRW",
            "timestamp": "2026-09-04T20:00:00Z",
        }
        for i, r in enumerate(listings)
    ]
    return {
        "region": region,
        "listings": listings,
        "stocks": stocks,
        "prices": prices,
        "companies": companies,
        "observed_at": NOW,
    }


@pytest.mark.parametrize("region", ["kr", "us"])
def test_monthly_large_share_counts_lossless(region):
    result = select_monthly(**monthly_input(region))
    assert (
        len(result["leaders"]) == 20 and result["leaders"][0]["marketCap"] == "1001234000000000000"
    )
    assert result["leaders"][0]["companyId"] == "company-0"


def test_selection_month_and_retry_are_kst():
    assert selection_month(instant("2026-09-30T14:59:59Z")) == "2026-09"
    assert selection_month(instant("2026-09-30T15:00:00Z")) == "2026-10"
    assert not should_refresh({"selectionMonth": "2026-09"}, NOW)
    assert not should_refresh({"last_attempt_at": NOW - timedelta(hours=5)}, NOW)
    assert should_refresh({"last_attempt_at": NOW - timedelta(hours=6)}, NOW)


def test_issuer_classes_aggregate_and_ambiguous_cik_fails():
    data = monthly_input()
    data["listings"][1]["isinCode"] = data["stocks"][1]["isinCode"] = "US0000002000"
    result = select_monthly(**data)
    assert result["leaders"][0]["marketCap"] == "1992468000000000000"
    assert [r["symbol"] for r in result["leaders"][0]["components"]] == ["S0", "S1"]
    data["companies"][0]["cik"] = "12"
    data["companies"][1]["cik"] = "13"
    with pytest.raises(ValueError, match="충돌"):
        select_monthly(**data)


@pytest.mark.parametrize(
    "mutation",
    [
        "missing_stock",
        "missing_price",
        "unknown_type",
        "market",
        "currency",
        "future",
        "shares",
        "top_unpriced",
    ],
)
def test_monthly_fail_closed(mutation):
    data = monthly_input()
    if mutation == "missing_stock":
        data["stocks"].pop()
    elif mutation == "missing_price":
        data["prices"].pop()
    elif mutation == "unknown_type":
        data["listings"][0]["securityType"] = "UNKNOWN"
    elif mutation == "market":
        data["stocks"][0]["market"] = "NYSE"
    elif mutation == "currency":
        data["prices"][0]["currency"] = "KRW"
    elif mutation == "future":
        data["prices"][0]["timestamp"] = "2026-10-01T00:00:00Z"
    elif mutation == "shares":
        data["stocks"][0]["sharesOutstanding"] = "0"
    else:
        data["prices"][0]["timestamp"] = None
    with pytest.raises(ValueError):
        select_monthly(**data)


def test_small_unpriced_exclusion_cannot_hide_top_issuer():
    data = monthly_input()
    data["prices"][24]["timestamp"] = None
    result = select_monthly(**data)
    assert result["excluded"][0]["reason"] == "NO_PRICE_TIME"
    assert int(result["quality"]["excludedMaximumMarketCap"]) < int(
        result["quality"]["cutoffMarketCap"]
    )


def etf_stock(**overrides):
    return {
        "symbol": "123456",
        "isinCode": "KR1234567890",
        "name": "테스트 ETF",
        "securityType": "ETF",
        "isCommonShare": False,
        **overrides,
    }


def test_etf_missing_rows_are_never_delisting_evidence():
    company = {
        "id": "a",
        "stockCode": "123456",
        "market": "KOSPI",
        "corpCode": None,
        "cik": None,
        "ticker": None,
        "nameKo": "테스트 ETF",
        "nameEn": None,
        "isListed": True,
    }
    identity = {
        "companyId": "a",
        "symbol": "123456",
        "isinCode": "KR1234567890",
        "market": "KOSPI",
        "managedCompany": True,
        "appliedNameKo": "테스트 ETF",
    }
    missing = plan_etf_master([], [company], [identity])
    assert missing["actions"] == [] and missing["missingRetained"] == 1
    confirmed = plan_etf_master(
        [{"market": "KOSPI", "status": "DELISTED", "rows": [etf_stock()]}], [company], [identity]
    )
    assert confirmed["actions"][0]["patch"] == {"isListed": False}
    preserved = plan_etf_master(
        [{"market": "KOSPI", "status": "ACTIVE", "rows": [etf_stock(name="새 ETF")]}],
        [{**company, "nameKo": "직접 이름"}],
        [identity],
    )
    assert preserved["actions"][0]["patch"] == {"isListed": True}
    conflict = plan_etf_master(
        [{"market": "KOSPI", "status": "ACTIVE", "rows": [etf_stock()]}],
        [{**company, "corpCode": "12345678"}],
        [identity],
    )
    assert conflict["actions"] == [] and conflict["conflicts"] == 1


def test_etf_validates_full_snapshot_before_actions():
    rows = [{"market": "KOSPI", "status": "ACTIVE", "rows": [etf_stock()]}]
    assert validate_etf_universe(rows)["active"] == 1
    with pytest.raises(ValueError):
        validate_etf_universe(rows, 100)
    with pytest.raises(ValueError):
        validate_etf_universe(rows + rows)
    with pytest.raises(ValueError):
        validate_etf_universe(
            [{"market": "KOSPI", "status": "ACTIVE", "rows": [etf_stock(), etf_stock()]}]
        )


def test_alpaca_bounds_and_symbol_classes():
    validate_alpaca_size(100, 80)
    with pytest.raises(ValueError):
        validate_alpaca_size(100, 79)
    with pytest.raises(ValueError):
        validate_alpaca_size(0, 0)
    eligible = {
        "assetClass": "us_equity",
        "status": "active",
        "tradable": True,
        "symbol": "BRK.B",
        "exchange": "NYSE",
    }
    assert alpaca_market(eligible) == "NYSE"
    assert alpaca_market({**eligible, "exchange": "OTC"}) is None
    assert alpaca_market({**eligible, "tradable": False}) is None


def test_alpaca_raw_provider_id_not_rfc_version_restricted():
    raw = {
        "id": "00000000-0000-0000-0000-000000000001",
        "class": "us_equity",
        "exchange": "NYSE",
        "symbol": "A",
        "name": "A",
        "status": "active",
        **{
            k: True
            for k in ("tradable", "marginable", "shortable", "easy_to_borrow", "fractionable")
        },
        "extra": "raw",
    }
    parsed = parse_alpaca_assets([raw])
    assert parsed[0]["raw"] == raw and parsed[0]["providerAssetId"] == raw["id"]
    with pytest.raises(ValueError):
        parse_alpaca_assets([raw, raw])


def test_sec_ticker_exact_and_separator_alias_preserve_classes():
    snapshot = parse_sec_snapshot(
        json.dumps(
            {
                "fields": ["cik", "name", "ticker", "exchange"],
                "data": [[12, "Issuer", "BRK-B", "NYSE"], [13, "Other", "ABC", "NASDAQ"]],
            }
        )
    )
    index = SecTickerIndex(snapshot["rows"])
    company = {"isListed": True, "market": "NYSE", "ticker": "BRK.B"}
    assert index.match(company)["cik"] == "0000000012"
    assert index.match(company)["rule"] == "DOT_HYPHEN_TICKER_EXCHANGE"
    assert index.match({**company, "ticker": "BRK"})["status"] == "UNMATCHED"
    assert index.match({**company, "market": "NASDAQ"})["status"] == "UNMATCHED"
    conflict = SecTickerIndex(
        snapshot["rows"] + [{"cik": "0000000099", "ticker": "BRK-B", "exchange": "NYSE"}]
    )
    assert conflict.match(company)["status"] == "AMBIGUOUS"


def test_sec_search_cache_requires_explicit_partial_provenance():
    cache = {
        "formatVersion": 1,
        "provenanceUrl": "https://www.sec.gov/files/company_tickers_exchange.json",
        "method": "SEARCH_CACHE_EXTRACT",
        "extractedAt": iso(NOW),
        "sourceLastModified": None,
        "cacheAge": "UNKNOWN",
        "coverage": "SELECTED_ROWS_ONLY",
        "liveIssuerValidation": "NOT_COMPLETED",
        "fields": ["cik", "name", "ticker", "exchange"],
        "data": [[12, "Issuer", "A", "NASDAQ"]],
    }
    snapshot = parse_sec_search_cache(cache)
    assert snapshot["acquisition"]["sha256Basis"] == "EXTRACTED_JSON"
    with pytest.raises(ValueError):
        parse_sec_search_cache({**cache, "coverage": "FULL"})


def sec_input():
    def fact(value, **more):
        return {
            "val": value,
            "end": "2025-12-31",
            "filed": "2026-02-15",
            "accn": "0000123456-26-000001",
            "form": "10-K",
            "fp": "FY",
            **more,
        }

    return {
        "cik": 123456,
        "facts": {
            "us-gaap": {
                key: {"units": {unit: [fact(value, **more)]}}
                for key, unit, value, more in [
                    ("Assets", "USD", 1200, {}),
                    ("Liabilities", "USD", 400, {}),
                    ("StockholdersEquity", "USD", 800, {}),
                    ("CommonStockholdersEquity", "USD", 750, {}),
                    ("CommonStockSharesOutstanding", "shares", 100, {}),
                    ("EarningsPerShareBasic", "USD/shares", 5, {"start": "2025-01-01"}),
                ]
            }
        },
    }


def sec_fields(data, eligible=True):
    return {
        r["key"]: r for r in parse_sec_information(data, "0000123456", iso(NOW), eligible)["fields"]
    }


def test_sec_same_period_eps_bps_provenance():
    raw = sec_input()
    original = copy.deepcopy(raw)
    fields = sec_fields(raw)
    assert fields["eps"]["value"] == "5" and fields["eps"]["periodStart"] == "2025-01-01"
    assert fields["bps"]["value"] == "7.5"
    assert fields["bps"]["sourceTags"] == [
        "us-gaap:CommonStockholdersEquity",
        "us-gaap:CommonStockSharesOutstanding",
    ]
    assert raw == original
    assert sec_facts_url("123456").endswith("CIK0000123456.json")


@pytest.mark.parametrize(
    "change",
    [
        {"start": "2025-10-01"},
        {"form": "10-Q"},
        {"fp": "Q4"},
        {"dimensions": {}},
        {"filed": "2027-01-01"},
        {"end": "2025-02-30"},
        {"val": float("nan")},
    ],
)
def test_sec_unsafe_eps_withheld(change):
    raw = sec_input()
    raw["facts"]["us-gaap"]["EarningsPerShareBasic"]["units"]["USD/shares"][0].update(change)
    assert sec_fields(raw)["eps"]["value"] is None


def test_sec_conflicting_recent_eps_no_stale_fallback():
    raw = sec_input()
    rows = raw["facts"]["us-gaap"]["EarningsPerShareBasic"]["units"]["USD/shares"]
    rows.append({**rows[0], "val": 6})
    assert sec_fields(raw)["eps"]["value"] is None
    assert sec_fields(sec_input(), False)["bps"]["value"] is None
    raw = sec_input()
    raw["facts"]["us-gaap"]["CommonStockSharesOutstanding"]["units"]["shares"][0]["accn"] = (
        "0000123456-26-000002"
    )
    assert sec_fields(raw)["bps"]["value"] is None


def test_sec_stock_split_suppresses_stale_per_share_facts():
    raw = sec_input()
    row = copy.deepcopy(raw["facts"]["us-gaap"]["Assets"]["units"]["USD"][0])
    row.update({"val": 2, "end": "2026-04-01", "filed": "2026-05-01"})
    raw["facts"]["us-gaap"]["StockSplitConversionRatio"] = {"units": {"pure": [row]}}
    assert sec_fields(raw)["eps"]["value"] is None and sec_fields(raw)["bps"]["value"] is None
    assert sec_fields(raw)["assets"]["value"] == "1200"


def kr_financial_input():
    equity = {
        "account_id": "ifrs-full_EquityAttributableToOwnersOfParent",
        "sj_div": "BS",
        "currency": "KRW",
        "bsns_year": "2025",
        "reprt_code": "11011",
        "fs_div": "CFS",
        "thstrm_amount": "1,000",
        "rcept_no": "20260301000001",
        "corp_code": "12345678",
    }
    share = {
        "se": "보통주",
        "istc_totqy": "110",
        "tesstk_co": "10",
        "distb_stock_co": "100",
        "stlm_dt": "2025.12.31",
        "rcept_no": equity["rcept_no"],
        "corp_code": equity["corp_code"],
    }
    return {
        "profile": {"acc_mt": "12"},
        "statement": "CFS",
        "financials": {"list": [equity]},
        "dividends": {"list": []},
        "shares": {"list": [share, {**share, "se": "합계"}]},
    }


def test_kr_bps_same_company_receipt_date_and_share_counts():
    raw = kr_financial_input()
    values = report_bps(raw, raw["financials"]["list"], 2025, "11011")
    assert values["value"] == "10" and "자기주식 제외" in values["basis"]
    raw["shares"]["list"][0]["rcept_no"] = "20260301000002"
    assert report_bps(raw, raw["financials"]["list"], 2025, "11011")["value"] is None
    raw = kr_financial_input()
    raw["shares"]["list"][0]["distb_stock_co"] = "99"
    assert report_bps(raw, raw["financials"]["list"], 2025, "11011")["value"] is None


def test_kr_bps_preferred_capital_never_guessed():
    raw = kr_financial_input()
    raw["shares"]["list"].append(
        {
            **raw["shares"]["list"][0],
            "se": "우선주",
            "istc_totqy": "1",
            "tesstk_co": "0",
            "distb_stock_co": "1",
        }
    )
    assert report_bps(raw, raw["financials"]["list"], 2025, "11011")["value"] is None


def test_kr_financial_period_flows_and_exact_decimal():
    raw = kr_financial_input()
    raw["financials"]["list"].append(
        {
            "account_id": "ifrs-full_Revenue",
            "thstrm_amount": "100",
            "thstrm_add_amount": "250",
            "currency": "KRW",
        }
    )
    fields = {r["key"]: r for r in financial_fields(raw, 2025, "11012", iso(NOW))}
    assert fields["revenue"]["value"] == "250" and "누적" in fields["revenue"]["basis"]
    assert fields["eps"]["value"] is None
    assert decimal_text("-000,123.4500") == "-123.45"
    assert decimal_text("1,23") is None


class MemoryRedis:
    def __init__(self):
        self.values = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, **options):
        if options.get("nx") and key in self.values:
            return None
        self.values[key] = value
        return True

    async def eval(self, script, count, key, *args):
        if "next-now" in script:
            return 0
        old = self.values.get(key)
        if ".token==ARGV[1]" in script:
            if old and json.loads(old)["token"] == args[0]:
                self.values.pop(key, None)
                return 1
        elif old == args[0]:
            self.values.pop(key, None)
            return 1
        return 0


@pytest.mark.asyncio
async def test_oauth_singleflight_and_401_refresh_without_redirects():
    calls = []
    token_count = 0

    async def http(request):
        nonlocal token_count
        calls.append(request)
        if request.url.path == "/oauth2/token":
            token_count += 1
            return httpx.Response(
                200,
                json={
                    "access_token": f"token{token_count}",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
            )
        if request.headers["authorization"] == "Bearer token1":
            return httpx.Response(401)
        return httpx.Response(200, json={"result": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(http)) as http_client:
        config = SimpleNamespace(
            redisPrefix="test:",
            tossClientId="client",
            tossClientSecret="secret",
            marketDataProvider="toss",
            httpTimeoutMs=1000,
        )
        client = TossClient(SimpleNamespace(config=config, redis=MemoryRedis(), http=http_client))
        assert await asyncio.gather(*[client.access_token() for _ in range(5)]) == ["token1"] * 5
        assert await client.get("/api/v1/stocks", {"symbols": "A"}) == {"result": []}
        assert token_count == 2
        with pytest.raises(ValueError):
            await client.get("/api/v1/orders", {})
        assert all(r.url.host == "openapi.tossinvest.com" for r in calls)


@pytest.mark.asyncio
async def test_registration_is_side_effect_free_and_validates_before_disabled_connector():
    cfg = SimpleNamespace(
        redisPrefix="test:",
        tossClientId=None,
        tossClientSecret=None,
        marketDataProvider="toss",
        httpTimeoutMs=1000,
    )
    db = SimpleNamespace(execute=AsyncMock(), fetch_one=AsyncMock(), fetch_all=AsyncMock())
    ctx = SimpleNamespace(
        config=cfg, db=db, redis=MemoryRedis(), http=None, services={}, on_close=lambda hook: None
    )
    handlers = await register(ctx)
    db.execute.assert_not_called()
    db.fetch_one.assert_not_called()
    assert "company_logos" not in ctx.services
    assert len(handlers) == 6
    assert await handlers["ingest-toss-candles"]({"interval": "1d"}) == {
        "disabled": True,
        "connector": "TOSS",
    }
    with pytest.raises(ValueError):
        await handlers["ingest-toss-candles"]({"interval": "1d", "maxPages": 7})
    with pytest.raises(ValueError):
        await handlers["sync-toss-stocks"]({"reason": "VIEW"})
    with pytest.raises(ValueError):
        await handlers["sync-alpaca-assets"]({"reason": "MANUAL", "extra": 1})


@pytest.mark.asyncio
async def test_market_start_does_not_schedule_external_logo_downloads():
    catalog = AsyncMock()
    selection = AsyncMock()
    periodic = Mock()
    ctx = SimpleNamespace(
        config=SimpleNamespace(nodeEnv="production", secUserAgent=None),
        services={
            "market_indicators": SimpleNamespace(catalog=catalog),
            "market_selection": SimpleNamespace(refresh=selection),
            "toss": SimpleNamespace(enabled=False),
        },
        periodic=periodic,
    )
    await start(ctx)
    catalog.assert_awaited_once()
    periodic.assert_called_once_with("monthly-market-selection", 300, selection)
