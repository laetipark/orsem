"""Source-grounded financial fields, with conservative per-share eligibility."""

import json
import logging
import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Any

from orsem_worker.core import sha256, utcnow

from .common import (
    OFFICIAL,
    checkpoint,
    day,
    insert,
    instant,
    iso,
    named_lock,
    obj,
    read_checkpoint,
)

logger = logging.getLogger(__name__)


def decimal_text(value):
    if not isinstance(value, str):
        return None
    text = value.strip()
    if len(text) > 80 or not re.fullmatch(r"-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", text):
        return None
    whole, _, fraction = text.lstrip("-").replace(",", "").partition(".")
    whole = whole.lstrip("0") or "0"
    fraction = fraction.rstrip("0")
    value = whole + ("." + fraction if fraction else "")
    return "-" + value if text.startswith("-") and value != "0" else value


def list_rows(value):
    rows = obj(value).get("list")
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def receipt_url(row=None):
    receipt = obj(row).get("rcept_no")
    return (
        "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + receipt
        if isinstance(receipt, str) and re.fullmatch(r"\d{14}", receipt)
        else "https://opendart.fss.or.kr/"
    )


def preferred(row):
    return bool(
        re.search(
            r"우선|preferred|preference",
            " ".join(
                str(row.get(k, ""))
                for k in ("account_id", "account_nm", "account_detail", "stock_knd")
            ),
            re.IGNORECASE,
        )
    )


def same_report(row, year, report, statement, required=False):
    return (
        (not required and row.get("bsns_year") is None or str(row.get("bsns_year")) == str(year))
        and (not required and row.get("reprt_code") is None or row.get("reprt_code") == report)
        and row.get("fs_div", statement) == statement
    )


def unique_amount(rows, key):
    values = [decimal_text(r.get(key)) for r in rows]
    return (
        {"row": rows[0], "value": values[0]}
        if rows and None not in values and len(set(values)) == 1
        else None
    )


def report_eps(rows, dividends, year, report, statement):
    if report != "11011" or statement not in ("CFS", "OFS"):
        return {"value": None, "basis": "연간 EPS는 사업보고서 기준", "row": None}
    candidates = [
        r
        for r in rows
        if r.get("account_id")
        in ("ifrs-full_BasicEarningsLossPerShare", "ifrs_BasicEarningsLossPerShare")
        and r.get("sj_div") in ("IS", "CIS")
        and r.get("currency") == "KRW"
        and not preferred(r)
        and same_report(r, year, report, statement)
    ]
    if candidates:
        selected = unique_amount(candidates, "thstrm_amount")
        return {
            "value": selected["value"] if selected else None,
            "row": selected["row"] if selected else candidates[0],
            "basis": "공시된 보통주 기본주당이익 · IFRS 기본 EPS"
            if selected
            else "기본 EPS 중복값 또는 금액 확인 필요",
        }
    fallback = [
        r
        for r in dividends
        if isinstance(r.get("se"), str)
        and re.search(r"주당\s*순이익", r["se"])
        and isinstance(r.get("stock_knd"), str)
        and "보통" in r["stock_knd"]
        and not preferred(r)
        and "희석" not in r["se"]
        and r.get("currency", "KRW") == "KRW"
        and (r.get("currency") == "KRW" or re.search(r"\(원\)\s*$", r["se"]))
        and not re.search(r"천원|백만원|달러|USD|JPY|EUR", r["se"], re.IGNORECASE)
        and not re.search(r"별도|개별" if statement == "CFS" else r"연결", r["se"])
        and same_report(r, year, report, statement)
    ]
    selected = unique_amount(fallback, "thstrm")
    return {
        "value": selected["value"] if selected else None,
        "row": selected["row"] if selected else fallback[0] if fallback else None,
        "basis": "공시된 보통주 주당순이익 · 배당사항"
        if selected
        else "보통주 연간 기본 EPS 공시 확인 필요",
    }


def calendar_date(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"(\d{4})[.-](\d{2})[.-](\d{2})(?:\s*현재)?", value.strip())
    try:
        return date(*map(int, match.groups())).isoformat() if match else None
    except ValueError:
        return None


def financial_date(row, profile, year, report):
    if row.get("thstrm_dt") is not None:
        return calendar_date(row["thstrm_dt"])
    ends = {"11011": "12-31", "11012": "06-30", "11013": "03-31", "11014": "09-30"}
    return (
        f"{year}-{ends[report]}" if obj(profile).get("acc_mt") == "12" and report in ends else None
    )


def share_count(row, key):
    value = decimal_text(row.get(key))
    return int(value) if value is not None and re.fullmatch(r"\d+", value) else None


def report_bps(raw, rows, year, report):
    def unavailable(reason, row=None):
        return {"value": None, "basis": "BPS 산출 보류 · " + reason, "row": row}

    statement = raw.get("statement")
    if statement not in ("CFS", "OFS"):
        return unavailable("재무제표 연결·별도 구분 확인 필요")
    financial = [
        r
        for r in rows
        if r.get("sj_div") == "BS"
        and r.get("currency") == "KRW"
        and not preferred(r)
        and same_report(r, year, report, statement, True)
    ]
    explicit = [
        r
        for r in financial
        if isinstance(r.get("account_nm"), str)
        and re.fullmatch(
            r"(?:보통주주당순자산(?:가액|가치)?|보통주주당장부가액)",
            re.sub(r"원$", "", re.sub(r"[\s()]", "", r["account_nm"])),
        )
    ]
    if explicit:
        selected = unique_amount(explicit, "thstrm_amount")
        end = (
            financial_date(selected["row"], raw.get("profile"), year, report) if selected else None
        )
        return (
            {**selected, "basis": f"{end} 기말 · 공시된 보통주 주당순자산"}
            if selected and end
            else unavailable("공시 BPS 금액 또는 기준일 확인 필요", explicit[0])
        )
    ids = (
        ("ifrs-full_EquityAttributableToOwnersOfParent", "ifrs_EquityAttributableToOwnersOfParent")
        if statement == "CFS"
        else ("ifrs-full_Equity", "ifrs_Equity")
    )
    equity_rows = [r for r in financial if r.get("account_id") in ids]
    equity = unique_amount(equity_rows, "thstrm_amount")
    if not equity:
        return unavailable(
            "보통주 귀속 자본 금액 확인 필요", equity_rows[0] if equity_rows else None
        )
    row = equity["row"]
    end = financial_date(row, raw.get("profile"), year, report)
    if not end:
        return unavailable("재무제표 기준일 확인 필요", row)
    shares = list_rows(raw.get("shares"))
    if any(not isinstance(r.get("se"), str) or not r["se"].strip() for r in shares):
        return unavailable("주식 발행종류 구분 확인 필요", row)
    classes = [r for r in shares if r["se"].replace(" ", "") not in ("합계", "총계", "계", "비고")]
    common = [
        r for r in classes if re.fullmatch(r"(?:기명식)?보통주(?:식)?", r["se"].replace(" ", ""))
    ]
    if len(common) != 1:
        return unavailable("단일 보통주 발행종류 확인 필요", row)
    share = common[0]
    keys = ("istc_totqy", "tesstk_co", "distb_stock_co")
    issued, treasury, outstanding = (share_count(share, k) for k in keys)
    if (
        None in (issued, treasury, outstanding)
        or outstanding <= 0
        or issued - treasury != outstanding
    ):
        return unavailable("발행주식·자기주식·유통주식 수 불일치", row)
    totals = [r for r in shares if r["se"].replace(" ", "") in ("합계", "총계", "계")]
    values = (issued, treasury, outstanding)
    totals_match = bool(totals) and all(
        all(share_count(r, k) == v for k, v in zip(keys, values)) for r in totals
    )
    for other in classes:
        if other is share:
            continue
        if not all(share_count(other, k) == 0 for k in keys) and not (
            totals_match and all(other.get(k) == "-" for k in keys)
        ):
            return unavailable("우선주 등 다른 발행종류의 자본 배분 확인 필요", row)
    if any(any(share_count(r, k) != v for k, v in zip(keys, values)) for r in totals):
        return unavailable("종류별 주식 수와 합계 불일치", row)
    if (
        not re.fullmatch(r"\d{14}", str(row.get("rcept_no")))
        or not re.fullmatch(r"\d{8}", str(row.get("corp_code")))
        or any(
            calendar_date(r.get("stlm_dt")) != end
            or r.get("rcept_no") != row["rcept_no"]
            or r.get("corp_code") != row["corp_code"]
            for r in classes + totals
        )
    ):
        return unavailable("재무제표와 주식 수의 회사·보고서·기준일 불일치", row)
    with localcontext() as context:
        context.prec = 100
        value = decimal_text(
            format(
                (Decimal(equity["value"]) / Decimal(outstanding)).quantize(
                    Decimal(".000001"), rounding=ROUND_HALF_UP
                ),
                "f",
            )
        )
    return {
        "value": value,
        "row": row,
        "basis": f"{end} 기말 · {'지배기업 소유주지분' if statement == 'CFS' else '자본총계'} / 보통주 유통주식수 {outstanding}주(자기주식 제외) · 동일 보고서 · 소수 6자리 반올림",
    }


def financial_fields(raw, year, report, observed_at):
    rows = list_rows(raw.get("financials"))
    dividends = list_rows(raw.get("dividends"))
    period = (
        f"{year}년 "
        + {"11011": "연간", "11012": "반기", "11013": "1분기", "11014": "3분기"}[report]
        + (" · 연결" if raw.get("statement") == "CFS" else " · 별도")
    )
    result = []

    def field(key, label, value, unit, basis, row=None):
        result.append(
            {
                "key": key,
                "label": label,
                "value": value,
                "unit": unit,
                "basis": basis,
                "source": "OpenDART",
                "sourceUrl": receipt_url(row),
                "observedAt": observed_at,
            }
        )

    for key, label, ids in [
        ("revenue", "매출액", ("ifrs-full_Revenue", "ifrs_Revenue")),
        ("operatingProfit", "영업이익", ("dart_OperatingIncomeLoss",)),
        ("netIncome", "당기순이익", ("ifrs-full_ProfitLoss", "ifrs_ProfitLoss")),
        ("assets", "자산", ("ifrs-full_Assets", "ifrs_Assets")),
        ("liabilities", "부채", ("ifrs-full_Liabilities", "ifrs_Liabilities")),
        ("equity", "자본", ("ifrs-full_Equity", "ifrs_Equity")),
    ]:
        row: dict[str, Any] = next((r for r in rows if r.get("account_id") in ids), {})
        flow = key in ("revenue", "operatingProfit", "netIncome")
        cumulative = flow and report != "11011"
        field(
            key,
            label,
            decimal_text(row.get("thstrm_add_amount" if cumulative else "thstrm_amount")),
            row.get("currency") if isinstance(row.get("currency"), str) else None,
            period + (" · 누적" if cumulative else "" if flow else " · 기말"),
            row,
        )
    for key, values in [
        ("eps", report_eps(rows, dividends, year, report, raw.get("statement"))),
        ("bps", report_bps(raw, rows, year, report)),
    ]:
        field(
            key,
            key.upper(),
            values["value"],
            "KRW",
            period + " · " + values["basis"],
            values.get("row"),
        )
    dividend: dict[str, Any] = next(
        (
            r
            for r in dividends
            if isinstance(r.get("se"), str)
            and re.search(r"주당\s*현금배당금", r["se"])
            and isinstance(r.get("stock_knd"), str)
            and "보통" in r["stock_knd"]
        ),
        {},
    )
    field(
        "dividend", "주당 현금배당", decimal_text(dividend.get("thstrm")), "KRW", period, dividend
    )
    for key, label, source in [
        ("ceo", "대표자", "ceo_nm"),
        ("industry", "업종 코드", "induty_code"),
        ("established", "설립일", "est_dt"),
        ("fiscalMonth", "결산월", "acc_mt"),
    ]:
        value = obj(raw.get("profile")).get(source)
        field(key, label, value if isinstance(value, str) else None, None, "기업개요 조회 시점")
    return result


def sec_facts_url(cik):
    if not isinstance(cik, str) or not re.fullmatch(r"\d{1,10}", cik) or int(cik) <= 0:
        raise ValueError("Invalid SEC CIK.")
    return f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik.zfill(10)}.json"


def valid_date(value):
    try:
        return (
            isinstance(value, str)
            and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value))
            and date.fromisoformat(value).isoformat() == value
        )
    except ValueError:
        return False


def parse_sec_information(payload, cik, observed_at, per_share_eligible):
    url = sec_facts_url(cik)
    raw = obj(payload)
    if str(raw.get("cik")).zfill(10) != cik.zfill(10):
        raise ValueError("SEC Company Facts issuer mismatch.")
    today = instant(observed_at).date().isoformat()
    facts = obj(raw.get("facts"))

    def read(taxonomy, tag, unit):
        values = obj(obj(obj(facts.get(taxonomy)).get(tag)).get("units")).get(unit)
        if not isinstance(values, list):
            return []
        result = []
        for value in values:
            row = obj(value)
            if (
                type(row.get("val")) not in (int, float)
                or not Decimal(str(row["val"])).is_finite()
                or abs(row["val"]) > 9007199254740991
                or not valid_date(row.get("end"))
                or not valid_date(row.get("filed"))
                or row["end"] > row["filed"]
                or row["filed"] > today
                or "start" in row
                and (not valid_date(row["start"]) or row["start"] > row["end"])
                or not isinstance(row.get("accn"), str)
                or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", row["accn"])
                or row.get("form") not in ("10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A")
                or any(k in row for k in ("dimensions", "segment", "axis"))
            ):
                continue
            result.append(
                {
                    k: row[k]
                    for k in ("val", "start", "end", "filed", "accn", "form", "fp")
                    if k in row
                }
                | {"taxonomy": taxonomy, "tag": tag, "unit": unit}
            )
        return result

    def candidates(tags, unit):
        return [
            r
            for qualified in tags
            for r in read(qualified.split(":")[0], qualified.split(":")[1], unit)
        ]

    def latest(values):
        ordered = sorted(values, key=lambda r: (r["end"], r["filed"]), reverse=True)
        if not ordered:
            return None
        first = ordered[0]
        peers = [r for r in ordered if r["end"] == first["end"] and r["filed"] == first["filed"]]
        return (
            first
            if len({(r.get("start", ""), Decimal(str(r["val"]))) for r in peers}) == 1
            else None
        )

    def annual(row):
        days = (
            (date.fromisoformat(row["end"]) - date.fromisoformat(row["start"])).days + 1
            if row.get("start")
            else 0
        )
        return (
            row["form"] in ("10-K", "10-K/A", "20-F", "20-F/A")
            and row.get("fp") == "FY"
            and 330 <= days <= 380
        )

    tags = {
        "assets": ["us-gaap:Assets", "ifrs-full:Assets"],
        "liabilities": ["us-gaap:Liabilities", "ifrs-full:Liabilities"],
        "equity": ["us-gaap:StockholdersEquity", "ifrs-full:EquityAttributableToOwnersOfParent"],
        "commonEquity": ["us-gaap:CommonStockholdersEquity"],
    }
    balance = latest(
        [r for r in candidates(tags["assets"], "USD") if not r.get("start")]
    ) or latest([r for r in candidates(tags["equity"], "USD") if not r.get("start")])
    eps = latest(
        [
            r
            for r in candidates(
                ["us-gaap:EarningsPerShareBasic", "ifrs-full:BasicEarningsLossPerShare"],
                "USD/shares",
            )
            if annual(r)
        ]
    )
    anchor = (
        eps
        if not balance or eps and (eps["end"], eps["filed"]) > (balance["end"], balance["filed"])
        else balance
    )
    if not anchor:
        raise ValueError("No supported SEC financial period is available.")

    def same_balance(tags, unit):
        return (
            latest(
                [
                    r
                    for r in candidates(tags, unit)
                    if not r.get("start")
                    and r["end"] == balance["end"]
                    and r["accn"] == balance["accn"]
                    and r["filed"] == balance["filed"]
                ]
            )
            if balance
            else None
        )

    def report_url(fact):
        return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{fact['accn'].replace('-', '')}/{fact['accn']}-index.html"

    fields = []
    unspecified = object()

    def push(key, label, fact, unit, reason, value=unspecified, sources=None):
        if value is unspecified:
            value = fact["val"] if fact else None
        text = decimal_text(format(Decimal(str(value)), "f")) if value is not None else None
        basis = (
            (f"{fact['start']}~" if fact and fact.get("start") else "")
            + f"{fact['end']} {'연간' if fact.get('start') else '기말'} · {fact['form']} · {fact['filed']} 공시 · {reason}"
            if fact
            else reason
        )
        fields.append(
            {
                "key": key,
                "label": label,
                "value": text,
                "unit": unit,
                "basis": basis,
                "source": "SEC",
                "sourceUrl": report_url(fact) if fact else url,
                "observedAt": observed_at,
                "periodStart": fact.get("start") if fact else None,
                "periodEnd": fact["end"] if fact else None,
                "filingDate": fact["filed"] if fact else None,
                "accessionNumber": fact["accn"] if fact else None,
                "sourceTags": [
                    r["taxonomy"] + ":" + r["tag"]
                    for r in (sources if sources is not None else [fact] if fact else [])
                ],
            }
        )

    equity = same_balance(tags["equity"], "USD")
    push("assets", "자산", same_balance(tags["assets"], "USD"), "USD", "기업 전체 공시")
    push("liabilities", "부채", same_balance(tags["liabilities"], "USD"), "USD", "기업 전체 공시")
    push("equity", "지배기업 귀속자본", equity, "USD", "비지배지분 제외")
    splits = [
        r
        for taxonomy, values in facts.items()
        for tag in obj(values)
        if re.search(r"StockSplit.*Ratio|StockSplitConversionRatio", tag)
        for r in read(taxonomy, tag, "pure")
    ]
    split_since = lambda r: bool(r and any(s["val"] != 1 and s["end"] > r["end"] for s in splits))
    usable = eps if per_share_eligible and not split_since(eps) else None
    push(
        "eps",
        "EPS",
        usable,
        "USD",
        "공시된 기본 주당순이익"
        if usable
        else "검증된 연간 보통주 EPS·주식 종류·분할 기준 확인 대기",
    )
    common = same_balance(tags["commonEquity"], "USD")
    sources = [common] if common else []
    preferred_shares = same_balance(["us-gaap:PreferredStockSharesOutstanding"], "shares")
    if not common and equity and preferred_shares and preferred_shares["val"] == 0:
        common = equity
        sources = [equity, preferred_shares]
    shares = same_balance(["us-gaap:CommonStockSharesOutstanding"], "shares")
    safe_common = common if per_share_eligible and not split_since(common) else None
    safe_shares = (
        shares
        if per_share_eligible
        and not split_since(shares)
        and shares
        and shares["val"] > 0
        and Decimal(str(shares["val"])) % 1 == 0
        else None
    )
    push(
        "commonEquity",
        "보통주 귀속자본",
        safe_common,
        "USD",
        "보통주 기준 확인" if safe_common else "보통주 귀속자본·주식 종류 확인 대기",
        sources=sources if safe_common else [],
    )
    push("commonShares", "기말 유통 보통주 수", safe_shares, "주", "동일 공시·동일 기말 기준")
    with localcontext() as context:
        context.prec = 60
        bps = (
            (Decimal(str(safe_common["val"])) / Decimal(str(safe_shares["val"]))).quantize(
                Decimal(".00000001"), rounding=ROUND_HALF_UP
            )
            if safe_common and safe_shares
            else None
        )
    push(
        "bps",
        "BPS",
        safe_common if bps is not None else None,
        "USD",
        "보통주 귀속자본 ÷ 동일 기말 유통 보통주 수"
        if bps is not None
        else "동일 공시·동일 기준일 보통주 BPS 확인 대기",
        bps,
        [*sources, safe_shares] if bps is not None else [],
    )
    return {
        "fields": fields,
        "basisDate": anchor["end"],
        "reportYear": int(anchor["end"][:4]),
        "reportCode": anchor["form"],
        "sourceUrl": report_url(anchor),
    }


REQUESTED = """(EXISTS (SELECT 1 FROM source_checkpoints request WHERE request.connector='COMPANY_INFORMATION' AND request.stream=c.id)
OR EXISTS (SELECT 1 FROM watchlist_group_items i WHERE i.company_id=c.id)
OR EXISTS (SELECT 1 FROM market_cap_memberships m JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id WHERE m.company_id=c.id))"""


class Fundamentals:
    def __init__(self, ctx):
        self.ctx = ctx
        self.stopped = False

    async def sec_cooling(self):
        state = await read_checkpoint(self.ctx.db, "SEC", "ACCESS_COOLDOWN")
        retry = obj(state.get("metadataJson")).get("retryAt")
        return bool(retry and instant(retry) > utcnow())

    async def refresh_sec(self):
        if self.stopped or not self.ctx.config.secUserAgent or await self.sec_cooling():
            return
        async with named_lock(self.ctx, "orsem-sec-company-information") as tx:
            if tx is None:
                return
            companies = await tx.fetch_all(
                """SELECT c.id,c.cik,
            (SELECT COUNT(*) FROM companies sibling WHERE sibling.cik=c.cik AND sibling.is_listed=1 AND sibling.market IN ('NASDAQ','NYSE','AMEX','OTC')) listedClasses,
            stock.metadata_json stockMetadata FROM companies c
            LEFT JOIN (SELECT company_id,MAX(observed_at) collected FROM company_information_snapshots WHERE source='SEC' GROUP BY company_id) latest ON latest.company_id=c.id
            LEFT JOIN source_checkpoints failure ON failure.connector='SEC_COMPANY_INFORMATION_FAILURE' AND failure.stream=c.id
            LEFT JOIN source_checkpoints stock ON stock.connector='TOSS' AND stock.stream=CONCAT('STOCK_INFO:',c.id)
            WHERE c.cik IS NOT NULL AND c.is_listed=1 AND c.market IN ('NASDAQ','NYSE','AMEX','OTC')
            AND (failure.last_success_at IS NULL OR failure.last_success_at < UTC_TIMESTAMP() - INTERVAL 1 DAY)
            AND (latest.collected IS NULL OR latest.collected < UTC_TIMESTAMP() - INTERVAL 7 DAY)
            AND """
                + REQUESTED
                + " ORDER BY latest.collected,c.id LIMIT 4"
            )
            for company in companies:
                if self.stopped or await self.sec_cooling():
                    break
                try:
                    url = sec_facts_url(company["cik"])
                    response = await self.ctx.services["sec_http"].request(
                        url,
                        headers={
                            "Accept": "application/json",
                            "User-Agent": self.ctx.config.secUserAgent,
                        },
                        timeout_ms=self.ctx.config.httpTimeoutMs,
                        max_bytes=20 * 1024 * 1024,
                    )
                    if not response.is_success:
                        raise RuntimeError(f"SEC Company Facts HTTP {response.status_code}")
                    if len(response.content) > 20 * 1024 * 1024:
                        raise ValueError("SEC Company Facts response exceeds 20 MiB.")
                    raw = json.loads(response.content)
                    now = utcnow()
                    metadata = obj(company["stockMetadata"])
                    stock = obj(metadata.get("rawPayload"))
                    eligible = (
                        int(company["listedClasses"]) == 1
                        and stock.get("isCommonShare") is True
                        and stock.get("securityType") == "STOCK"
                        and stock.get("currency") == "USD"
                    )
                    result = parse_sec_information(raw, company["cik"], iso(now), eligible)
                    if self.stopped:
                        break
                    await insert(
                        tx,
                        "company_information_snapshots",
                        {
                            "companyId": company["id"],
                            "source": "SEC",
                            "reportYear": result["reportYear"],
                            "reportCode": result["reportCode"],
                            "basisDate": result["basisDate"],
                            "observedAt": now,
                            "sourceUrl": result["sourceUrl"],
                            "rightsMode": OFFICIAL,
                            "fieldsJson": result["fields"],
                            "rawJson": {
                                "companyFacts": raw,
                                "provenanceUrl": url,
                                "observedAt": iso(now),
                                "sha256": sha256(response.content),
                                "sourceLastModified": response.headers.get("last-modified"),
                                "perShareEligibility": {
                                    "eligible": eligible,
                                    "listedClasses": int(company["listedClasses"]),
                                    "stockMetadata": metadata,
                                },
                            },
                        },
                    )
                except Exception as error:  # noqa: BLE001 - record per-source failure at runtime boundary
                    if self.stopped:
                        break
                    cooldown = type(error).__name__ == "SecAccessCooldownError"
                    policy = type(error).__name__ == "SecAccessPolicyError"
                    metadata = {
                        "state": "ACCESS_WAITING" if cooldown else "RETRY_PENDING",
                        "nextAttemptAfterHours": 24,
                        "reason": "검증된 SEC 재무 자료 수집 대기",
                    }
                    if cooldown:
                        retry = getattr(error, "retryAt", None)
                        status = getattr(error, "providerStatus", None)
                        metadata.update(
                            {
                                "reason": f"SEC {status} 접근 대기",
                                "retryAt": iso(retry) if retry else None,
                                "providerStatus": status,
                            }
                        )
                    await checkpoint(
                        self.ctx.db, "SEC_COMPANY_INFORMATION_FAILURE", company["id"], metadata
                    )
                    if cooldown or policy:
                        break

    async def refresh_kr(self):
        dart = self.ctx.services.get("opendart")
        if self.stopped or dart is None or not dart.enabled:
            return
        # OpenDart client owns persisted daily API pause and request pacing.
        async with named_lock(self.ctx, "orsem-company-information") as tx:
            if tx is None:
                return
            companies = await tx.fetch_all(
                """SELECT c.id,c.corp_code corpCode FROM companies c
            LEFT JOIN company_information_snapshots latest ON latest.id=(SELECT id FROM company_information_snapshots WHERE company_id=c.id AND source='OPENDART' ORDER BY observed_at DESC,id DESC LIMIT 1)
            LEFT JOIN source_checkpoints failure ON failure.connector='COMPANY_INFORMATION_FAILURE' AND failure.stream=c.id
            WHERE (failure.last_success_at IS NULL OR failure.last_success_at < UTC_TIMESTAMP() - INTERVAL 1 DAY)
            AND c.corp_code IS NOT NULL AND c.is_listed=1
            AND (latest.observed_at IS NULL OR latest.observed_at < UTC_TIMESTAMP() - INTERVAL 7 DAY OR COALESCE(JSON_EXTRACT(latest.raw_json,'$.normalizationVersion'),0)<2)
            AND """
                + REQUESTED
                + " ORDER BY latest.observed_at,c.id LIMIT 4"
            )
            now = utcnow()
            local_date = date.fromisoformat(day(now))
            year, month = local_date.year, local_date.month
            for company in companies:
                if self.stopped:
                    break
                try:
                    annual_year = year - 1 if month >= 4 else year - 2
                    raw = await dart.company_information(company["corpCode"], annual_year, "11011")
                    annual = financial_fields(raw, annual_year, "11011", iso(now))
                    quarter = (
                        "11014"
                        if month >= 11
                        else "11012"
                        if month >= 8
                        else "11013"
                        if month >= 5
                        else None
                    )
                    recent = (
                        await dart.company_information(company["corpCode"], year, quarter)
                        if quarter
                        else None
                    )
                    recent_fields = (
                        financial_fields(recent, year, quarter, iso(now))
                        if recent and recent.get("financials") and quarter
                        else []
                    )
                    fields = (
                        [r for r in recent_fields if r["key"] not in ("eps", "dividend")]
                        + [r for r in annual if r["key"] in ("eps", "dividend")]
                        if recent_fields
                        else annual
                    )
                    if not any(
                        raw.get(k) for k in ("profile", "financials", "dividends")
                    ) and not obj(recent).get("financials"):
                        raise ValueError("Company report unavailable")
                    previous = await tx.fetch_one(
                        "SELECT fields_json fields FROM company_information_snapshots WHERE company_id=:id ORDER BY observed_at DESC LIMIT 1",
                        {"id": company["id"]},
                    )
                    stored = previous.get("fields") if previous else []
                    if isinstance(stored, str):
                        stored = json.loads(stored)
                    if isinstance(stored, list):
                        fields = [
                            next(
                                (
                                    older
                                    for older in stored
                                    if older.get("key") == f["key"]
                                    and older.get("value") is not None
                                ),
                                f,
                            )
                            if f["value"] is None and f["key"] not in ("eps", "bps")
                            else f
                            for f in fields
                        ]
                    has_recent = bool(obj(recent).get("financials"))
                    await insert(
                        tx,
                        "company_information_snapshots",
                        {
                            "companyId": company["id"],
                            "source": "OPENDART",
                            "reportYear": year if has_recent else annual_year,
                            "reportCode": quarter if has_recent else "11011",
                            "basisDate": None,
                            "observedAt": now,
                            "sourceUrl": "https://opendart.fss.or.kr/",
                            "rightsMode": OFFICIAL,
                            "fieldsJson": fields,
                            "rawJson": {"normalizationVersion": 2, "annual": raw, "recent": recent},
                        },
                    )
                except Exception as error:  # noqa: BLE001 - record per-source failure at runtime boundary
                    if (
                        getattr(error, "status", None) == "020"
                        or type(error).__name__ == "OpenDartCooldownError"
                    ):
                        break
                    await checkpoint(
                        self.ctx.db,
                        "COMPANY_INFORMATION_FAILURE",
                        company["id"],
                        {"state": "RETRY_PENDING", "nextAttemptAfterHours": 24},
                    )
                    logger.warning(
                        "OpenDART company information validation pending (%s).",
                        type(error).__name__,
                    )

    async def close(self):
        self.stopped = True
