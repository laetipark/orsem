"""Monthly issuer-aware capitalization selection; exact scaled integer arithmetic."""

import logging
import re
from collections import defaultdict
from datetime import timedelta
from typing import Any

from orsem_worker.core import identifier, utcnow

from .common import PRIVATE, camel, day, insert, instant, iso, named_lock

logger = logging.getLogger(__name__)
MARKETS = {"kr": ("KOSPI", "KOSDAQ", "KR_ETC"), "us": ("NASDAQ", "NYSE", "AMEX")}
METHOD = "월간 조회 시점 · 발행주식수 × 제공자 최종 거래가 · 상장 보통주 기준"
SCALE = 10**12


def selection_month(now):
    return day(now)[:7]


def should_refresh(state, now):
    if state.get("selectionMonth") == selection_month(now):
        return False
    last = state.get("last_attempt_at", state.get("lastAttemptAt"))
    return not last or (now - instant(last)).total_seconds() >= 6 * 3600


def eligible_listings(listings):
    return [
        r
        for r in listings
        if r.get("isCommonShare") is True
        and r.get("securityType") == "STOCK"
        and not re.search(
            r"우선주|채권|워런트|\b(?:preferred|pfd|warrants?|notes?|nts|bonds?)\b",
            r.get("name", ""),
            re.IGNORECASE,
        )
    ]


def unique_symbols(rows):
    result = {r["symbol"]: r for r in rows}
    if len(result) != len(rows):
        raise ValueError("전체 종목 응답 중복")
    return result


def scaled_price(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{1,18}(?:\.\d{1,12})?", value):
        raise ValueError("시세 숫자 검증 실패")
    whole, _, fraction = value.partition(".")
    return int(whole) * SCALE + int(fraction.ljust(12, "0"))


def select_monthly(region, listings, stocks, prices, companies, observed_at):
    markets = MARKETS[region]
    currency = "KRW" if region == "kr" else "USD"
    unique_symbols(listings)
    if not 20 <= len(listings) <= 30000:
        raise ValueError("전체 종목 수 검증 실패")
    known = {
        "STOCK",
        "FOREIGN_STOCK",
        "DEPOSITARY_RECEIPT",
        "INFRASTRUCTURE_FUND",
        "REIT",
        "ETF",
        "FOREIGN_ETF",
        "ETN",
        "STOCK_WARRANTS",
    }
    for listing in listings:
        if (
            listing.get("requestedMarket") not in markets
            or listing.get("securityType") not in known
            or not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}[0-9]", listing.get("isinCode", ""))
        ):
            raise ValueError("전체 종목 유형 또는 시장 검증 실패")
    eligible = eligible_listings(listings)
    stock_map = unique_symbols(stocks)
    price_map = unique_symbols(prices)
    if (
        len(stock_map) != len(eligible)
        or len(price_map) != len(eligible)
        or len({r["isinCode"] for r in eligible}) != len(eligible)
    ):
        raise ValueError("전체 주식 또는 시세 응답 누락")
    by_symbol = defaultdict(list)
    for company in companies:
        if company["market"] not in (
            ("KRX", "KOSPI", "KOSDAQ", "KONEX", "KR_ETC") if region == "kr" else markets
        ):
            continue
        symbol = company.get("stockCode" if region == "kr" else "ticker")
        if symbol:
            by_symbol[symbol].append(company)
    cik_by_cusip: dict[str, str] = {}
    for listing in eligible:
        owners = by_symbol[listing["symbol"]]
        cik = owners[0].get("cik") if len(owners) == 1 else None
        if region == "us" and cik and re.match(r"US|CA", listing["isinCode"]):
            cusip = listing["isinCode"][2:8]
            normalized = cik.zfill(10)
            if cusip in cik_by_cusip and cik_by_cusip[cusip] != normalized:
                raise ValueError("발행자 식별 정보 충돌")
            cik_by_cusip[cusip] = normalized
    groups = defaultdict(list)
    excluded = []
    for listing in eligible:
        stock = stock_map.get(listing["symbol"])
        price = price_map.get(listing["symbol"])
        if (
            not stock
            or not price
            or stock.get("isinCode") != listing["isinCode"]
            or stock.get("market") != listing["requestedMarket"]
            or stock.get("securityType") != "STOCK"
            or stock.get("isCommonShare") is not True
            or stock.get("status") != "ACTIVE"
            or stock.get("currency") != currency
            or price.get("currency") != currency
            or not isinstance(stock.get("sharesOutstanding"), str)
            or not re.fullmatch(r"\d{1,30}", stock["sharesOutstanding"])
        ):
            raise ValueError("주식·시세 식별 또는 발행주식수 검증 실패")
        shares = int(stock["sharesOutstanding"])
        cap = shares * scaled_price(price["lastPrice"])
        if not shares or not cap:
            raise ValueError("발행주식수 또는 가격 미제공 · 시총 상한 확인 불가")
        if cap >= 10**30 * SCALE:
            raise ValueError("시가총액 범위 초과")
        owners = by_symbol[listing["symbol"]]
        company = owners[0] if len(owners) == 1 else None
        if region == "kr":
            issuer = (
                "DART:" + company["corpCode"]
                if company and company.get("corpCode")
                else "ISIN:" + listing["isinCode"]
            )
        else:
            cusip = listing["isinCode"][2:8] if re.match(r"US|CA", listing["isinCode"]) else None
            cik = (
                cik_by_cusip.get(cusip)
                if cusip
                else (company.get("cik") or "").zfill(10)
                if company and company.get("cik")
                else None
            )
            issuer = (
                "SEC:" + cik
                if cik
                else "CUSIP6:" + cusip
                if cusip
                else "ISIN:" + listing["isinCode"]
            )
        try:
            at = instant(price.get("timestamp"))
        except (ValueError, TypeError):
            at = None
        if at and at > observed_at + timedelta(minutes=5):
            raise ValueError("미래 가격 시각 검증 실패")
        if not at or observed_at - at > timedelta(days=14):
            excluded.append(
                {
                    "symbol": listing["symbol"],
                    "issuer": issuer,
                    "marketCapScaled": str(cap),
                    "reason": "NO_PRICE_TIME" if not at else "STALE_PRICE",
                }
            )
            continue
        groups[issuer].append(
            {
                "symbol": listing["symbol"],
                "company": company,
                "cap": cap,
                "priceAt": price["timestamp"],
            }
        )
    ranked = []
    for issuer, members in groups.items():
        members.sort(key=lambda m: (-m["cap"], m["symbol"]))
        ranked.append({"issuer": issuer, "members": members, "cap": sum(m["cap"] for m in members)})
    ranked.sort(key=lambda g: (-g["cap"], g["issuer"]))
    if len(ranked) < 20:
        raise ValueError("검증된 기업 20개 미충족")
    unverified: dict[str, int] = defaultdict(int)
    for row in excluded:
        unverified[row["issuer"]] += int(row["marketCapScaled"])
    verified = {g["issuer"]: g["cap"] for g in ranked}
    if any(
        cap + verified.get(issuer, 0) >= ranked[19]["cap"] for issuer, cap in unverified.items()
    ):
        raise ValueError("확인 불가 종목의 시총이 선정 경계 이상")
    leaders = []
    for index, group in enumerate(ranked[:20]):
        rep = group["members"][0]
        if not rep["company"] or region == "kr" and not rep["company"].get("corpCode"):
            raise ValueError("상위 기업 식별 확인 대기")
        leaders.append(
            {
                "companyId": rep["company"]["id"],
                "stockCode": rep["symbol"],
                "marketCap": str(group["cap"] // SCALE),
                "rank": index + 1,
                "issuer": group["issuer"],
                "components": [
                    {
                        "companyId": m["company"]["id"] if m["company"] else None,
                        "symbol": m["symbol"],
                        "priceAt": m["priceAt"],
                        "marketCapScaled": str(m["cap"]),
                        "scale": 12,
                    }
                    for m in group["members"]
                ],
            }
        )
    if len({r["companyId"] for r in leaders}) != 20:
        raise ValueError("대표 기업 중복")
    return {
        "leaders": leaders,
        "currency": currency,
        "eligibleCount": len(eligible),
        "classificationExcluded": [
            {k: r[k] for k in ("symbol", "name", "securityType", "isCommonShare")}
            for r in listings
            if r not in eligible
        ],
        "excluded": excluded,
        "issuerCount": len(ranked),
        "reviewCandidates": [
            {
                "issuer": g["issuer"],
                "marketCap": str(g["cap"] // SCALE),
                "symbols": [m["symbol"] for m in g["members"]],
            }
            for g in ranked[:40]
        ],
        "quality": {
            "excludedMaximumMarketCap": str(
                max((int(r["marketCapScaled"]) for r in excluded), default=0) // SCALE
            ),
            "cutoffMarketCap": str(ranked[19]["cap"] // SCALE),
            "unknownShareCount": 0,
            "pricedIssuerCount": len(ranked),
        },
    }


def validate_fsc_rows(rows, basis, total):
    if not total or len(rows) != total or len({r.get("isinCd") for r in rows}) != total:
        raise ValueError("전체 시세 자료 검증 실패")
    for row in rows:
        if (
            row.get("basDt") != basis
            or not re.fullmatch(r"[0-9A-Z]{6}", row.get("srtnCd", ""))
            or not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}[0-9]", row.get("isinCd", ""))
            or not re.fullmatch(r"\d{1,30}", row.get("mrktTotAmt", ""))
            or not re.fullmatch(r"\d+", row.get("clpr", ""))
            or not re.fullmatch(r"\d+", row.get("lstgStCnt", ""))
            or int(row["clpr"]) * int(row["lstgStCnt"]) != int(row["mrktTotAmt"])
        ):
            raise ValueError("시세 기준일 또는 시가총액 검증 실패")


class Selection:
    def __init__(self, ctx, toss, market):
        self.ctx, self.toss, self.market = ctx, toss, market
        self.stopped = False

    async def collect(self, region, now=None):
        now = now or utcnow()
        if not self.toss.enabled:
            raise ValueError("공식 시세 연결 설정 대기")
        listings: list[dict[str, Any]] = []
        for market in MARKETS[region]:
            rows = await self.toss.stocks_all(market)
            if len(rows) < 100 and market != "KR_ETC":
                raise ValueError("전체 시장 응답 누락")
            listings.extend({**r, "requestedMarket": market} for r in rows)
        eligible = eligible_listings(listings)
        stocks = []
        prices = []
        for offset in range(0, len(eligible), 200):
            if self.stopped:
                raise RuntimeError("수집 중지")
            symbols = [r["symbol"] for r in eligible[offset : offset + 200]]
            stocks.extend(await self.toss.stocks(symbols))
            prices.extend(await self.toss.prices(symbols))
        companies = [
            camel(r)
            for r in await self.ctx.db.fetch_all(
                "SELECT id,stock_code,ticker,corp_code,cik,market FROM companies WHERE is_listed=1"
            )
        ]
        observed = utcnow()
        selected = select_monthly(region, listings, stocks, prices, companies, observed)
        if selection_month(now) != selection_month(observed):
            raise ValueError("수집 중 기준 월 변경")
        basis = max(
            day(instant(c["priceAt"]), "Asia/Seoul" if region == "kr" else "America/New_York")
            for r in selected["leaders"]
            for c in r["components"]
        )
        raw = {
            "version": 2,
            "selectionMonth": selection_month(now),
            "refreshCadence": "MONTHLY",
            "sourceName": "토스증권 Open API",
            "method": METHOD,
            "providerScope": "토스 제공 국내 상장 보통주 · ETF·우선주 제외"
            if region == "kr"
            else "토스 제공 미국 거래소 상장 보통주 · ETF·우선주·ADR 제외",
            "issuerMethod": "국내 DART 법인번호 · 미국 CIK 또는 US/CA ISIN의 CUSIP 발행자 코드 · 그 외 ISIN 단위",
            "issuerLimitations": "CIK 없는 다른 CUSIP 발행자 코드 및 외국 ISIN은 동일 기업 여부를 확정하지 않음",
            "issuerMethodSource": "https://www.cusip.com/pdf/Processes%20-%20CUSIP_Template_2019.pdf",
            "currency": selected["currency"],
            "observedAt": iso(observed),
            "sourceUrl": "https://openapi.tossinvest.com/",
            "rightsMode": PRIVATE,
            "documentationUrl": "https://openapi.tossinvest.com/openapi-docs/latest/openapi.json",
            "markets": list(MARKETS[region]),
            "listings": listings,
            "stocks": stocks,
            "prices": prices,
            **selected,
        }
        return {
            "region": region,
            "observedAt": observed,
            "basisDate": basis,
            **selected,
            "sourceCount": len(listings),
            "raw": raw,
        }

    async def refresh(self):
        if self.stopped or self.ctx.config.nodeEnv == "test":
            return
        for region in ("kr", "us"):
            try:
                await self.run_region(region)
            except Exception:  # noqa: BLE001 - preserve independent connector operation
                logger.warning(
                    "Monthly market selection validation pending; previous snapshot retained (%s).",
                    region,
                )
                await self.ctx.db.execute(
                    "UPDATE market_selection_state SET status='VALIDATION_PENDING',reason='월간 자료 검증 대기 · 마지막 정상 목록 유지' WHERE region=:region",
                    {"region": region},
                )

    async def run_region(self, region):
        added = []
        async with named_lock(self.ctx, "orsem-market-selection-" + region) as tx:
            if tx is None:
                return
            state = (
                await tx.fetch_one(
                    "SELECT st.*,s.source_count sourceCount,JSON_UNQUOTE(JSON_EXTRACT(s.raw_json,'$.selectionMonth')) selectionMonth FROM market_selection_state st LEFT JOIN market_cap_snapshots s ON s.id=st.active_snapshot_id WHERE st.region=:region",
                    {"region": region},
                )
                or {}
            )
            now = utcnow()
            if not should_refresh(state, now):
                return
            if not self.toss.enabled:
                await insert(
                    tx,
                    "market_selection_state",
                    {
                        "region": region,
                        "status": "UNCONFIGURED",
                        "reason": "월간 시총 목록 · 공식 시세 연결 설정 대기",
                    },
                    ["status", "reason"],
                    False,
                )
                return
            # Attempt state must survive failed validation; use the independent DB handle.
            await insert(
                self.ctx.db,
                "market_selection_state",
                {"region": region, "status": "COLLECTING", "lastAttemptAt": now, "reason": None},
                ["status", "lastAttemptAt", "reason"],
                False,
            )
            result = await self.collect(region, now)
            if state.get("sourceCount") and result["sourceCount"] < int(state["sourceCount"]) * 0.8:
                raise ValueError("전체 종목 수 급감 · 이전 목록 유지")
            old = (
                await tx.fetch_all(
                    "SELECT company_id companyId FROM market_cap_memberships WHERE snapshot_id=:id",
                    {"id": state["active_snapshot_id"]},
                )
                if state.get("active_snapshot_id")
                else []
            )
            added = [
                r["companyId"]
                for r in result["leaders"]
                if r["companyId"] not in {r["companyId"] for r in old}
            ]
            snapshot_id = identifier()
            await insert(
                tx,
                "market_cap_snapshots",
                {
                    "id": snapshot_id,
                    "region": region,
                    "basisDate": result["basisDate"],
                    "observedAt": result["observedAt"],
                    "sourceUrl": "https://openapi.tossinvest.com/",
                    "rightsMode": PRIVATE,
                    "sourceCount": result["sourceCount"],
                    "rawJson": result["raw"],
                },
            )
            for leader in result["leaders"]:
                await insert(
                    tx,
                    "market_cap_memberships",
                    {
                        "snapshotId": snapshot_id,
                        "companyId": leader["companyId"],
                        "rankNo": leader["rank"],
                        "stockCode": leader["stockCode"],
                        "marketCap": leader["marketCap"],
                    },
                    entity=False,
                )
            await tx.execute(
                "UPDATE market_selection_state SET status='AVAILABLE',active_snapshot_id=:id,last_success_at=:observed,reason=NULL WHERE region=:region",
                {
                    "id": snapshot_id,
                    "observed": result["observedAt"].replace(tzinfo=None),
                    "region": region,
                },
            )
        if added:
            try:
                await self.market.ingest(
                    {
                        "interval": "1d",
                        "companyIds": added,
                        "reason": "SCHEDULED",
                        "lookbackDays": 366,
                        "maxPages": 6,
                    }
                )
            except Exception:  # noqa: BLE001 - preserve independent connector operation
                logger.warning(
                    "New market leader history hydration failed; normal candle retries remain active."
                )

    async def fetch_date(self, basis):
        from defusedxml import ElementTree

        from .common import http_request

        if not self.ctx.config.fscApiKey:
            return []
        rows = []
        total = None
        for page in range(1, 51):
            status, _, body = await http_request(
                self.ctx,
                "GET",
                "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo",
                limit=16000000,
                timeout=30,
                params={
                    "serviceKey": self.ctx.config.fscApiKey,
                    "basDt": basis,
                    "numOfRows": "2000",
                    "pageNo": str(page),
                    "resultType": "xml",
                },
            )
            if status != 200 or re.search(rb"<!DOCTYPE|<!ENTITY", body, re.IGNORECASE):
                raise ValueError("시세 응답 검증 실패")
            root = ElementTree.fromstring(body)
            if root.findtext("header/resultCode") not in ("00", "0000", "0"):
                raise ValueError("공식 시세 응답 오류")
            count = int(root.findtext("body/totalCount", "-1"))
            if (
                not 0 <= count <= 100000
                or int(root.findtext("body/pageNo", "0")) != page
                or total is not None
                and total != count
            ):
                raise ValueError("시세 페이지 검증 실패")
            total = count
            if not count and page == 1:
                return []
            items = [
                {n.tag: n.text or "" for n in item} for item in root.findall("body/items/item")
            ]
            if not items:
                raise ValueError("시세 페이지 누락")
            rows.extend(items)
            if len(rows) >= count:
                validate_fsc_rows(rows, basis, count)
                return rows
        raise ValueError("시세 페이지 한도 초과")

    async def close(self):
        self.stopped = True
