"""Exact, source-addressable financial facts. No network or persistence side effects."""

from __future__ import annotations

import re
from collections import defaultdict
from copy import deepcopy
from datetime import date
from decimal import Decimal, InvalidOperation

from ..core import json_text, sha256

VERSION = "analysis-financial-v1"
REPORTS = {"11011": 4, "11013": 1, "11012": 2, "11014": 3}
METRICS = {
    "Revenue": "revenue",
    "RevenueFromContractWithCustomerExcludingAssessedTax": "revenue",
    "Revenues": "revenue",
    "SalesRevenueNet": "revenue",
    "OperatingIncomeLoss": "operatingIncome",
    "ProfitLoss": "netIncome",
    "Assets": "assets",
    "Liabilities": "liabilities",
    "Equity": "equity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest": "equity",
    "CashFlowsFromUsedInOperatingActivities": "operatingCashFlow",
    "NetCashProvidedByUsedInOperatingActivities": "operatingCashFlow",
    "CashFlowsFromUsedInInvestingActivities": "investingCashFlow",
    "NetCashProvidedByUsedInInvestingActivities": "investingCashFlow",
    "CashFlowsFromUsedInFinancingActivities": "financingCashFlow",
    "NetCashProvidedByUsedInFinancingActivities": "financingCashFlow",
}
BALANCE = {"assets", "liabilities", "equity"}


def decimal_value(value):
    if isinstance(value, (bool, float)) or value is None:
        return None
    text = (format(value, "f") if isinstance(value, Decimal) else str(value)).strip()
    if not text or len(text) > 100 or text in ("-", "—", "N/A"):
        return None
    if text.startswith("(") and text.endswith(")"):
        text = "-" + text[1:-1].strip()
    if not re.fullmatch(r"-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", text):
        return None
    try:
        number = Decimal(text.replace(",", ""))
        if not number.is_finite():
            return None
        result = format(number, "f")
        return (result.rstrip("0").rstrip(".") if "." in result else result) if number else "0"
    except InvalidOperation:
        return None


def metric_for(account):
    local = re.split(r"[_:]", account, maxsplit=1)[-1]
    return METRICS.get(local, "account:" + account)


def valid_date(value):
    try:
        return (
            value
            if isinstance(value, str) and date.fromisoformat(value).isoformat() == value
            else None
        )
    except ValueError:
        return None


def normalize_dart(
    payload, *, company_id, year, report_code, scope, date_evidence=None, fiscal_month=None
):
    if report_code not in REPORTS or scope not in ("CFS", "OFS") or not 2015 <= year <= 2100:
        raise ValueError("Invalid financial report context")
    rows = payload.get("list", [])
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError("Invalid financial row count")
    facts = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise TypeError("Invalid financial row")
        if (
            str(row.get("bsns_year", year)) != str(year)
            or row.get("reprt_code", report_code) != report_code
            or row.get("fs_div", scope) != scope
        ):
            raise ValueError("Financial report context mismatch")
        receipt = row.get("rcept_no")
        if not isinstance(receipt, str) or not re.fullmatch(r"\d{14}", receipt):
            raise ValueError("Financial receipt is missing")
        account = str(row.get("account_id") or "")[:255]
        statement = row.get("sj_div")
        if not account or statement not in ("BS", "IS", "CIS", "CF", "SCE"):
            continue
        metric = metric_for(account)
        start, end = None, None
        candidates = [
            item.get("thstrm_dt")
            for item in (date_evidence or [])
            if item.get("rcept_no") == receipt
            and item.get("fs_div") == scope
            and item.get("sj_div") == statement
            and item.get("currency", "KRW") == row.get("currency")
        ]
        date_basis = "SOURCE"
        if statement == "CF" and not candidates and row.get("thstrm_nm"):
            candidates = [
                item.get("thstrm_dt")
                for item in (date_evidence or [])
                if item.get("rcept_no") == receipt
                and item.get("fs_div") == scope
                and item.get("sj_div") in ("IS", "CIS")
                and item.get("currency", "KRW") == row.get("currency")
                and item.get("thstrm_nm") == row["thstrm_nm"]
            ]
            date_basis = "SAME_FILING_YTD"
        dates_unique = {item for item in candidates if isinstance(item, str) and item.strip()}
        raw_date = row.get("thstrm_dt") or (
            next(iter(dates_unique)) if len(dates_unique) == 1 else None
        )
        if isinstance(raw_date, str):
            dates = re.findall(r"\d{4}[.-]\d{2}[.-]\d{2}", raw_date)
            parsed = [valid_date(item.replace(".", "-")) for item in dates]
            if parsed and all(parsed):
                start, end = (parsed[0], parsed[-1]) if len(parsed) > 1 else (None, parsed[0])
        instant = statement == "BS"
        if start and end and start > end:
            start, end = None, None
        basis = "INSTANT" if instant else "ANNUAL" if report_code == "11011" else "YTD"
        field = "thstrm_amount" if instant or report_code == "11011" else "thstrm_add_amount"
        if field not in row and (statement == "CF" or report_code == "11013"):
            field = "thstrm_amount"
        pairs = [(basis, field, None if instant else start)]
        if statement in ("IS", "CIS") and report_code != "11011":
            quarter_start = None
            if start and end and date.fromisoformat(start).day == 1:
                q = REPORTS[report_code]
                initial = date.fromisoformat(start)
                month_index = initial.year * 12 + initial.month - 1 + (q - 1) * 3
                quarter_start = f"{month_index // 12}-{month_index % 12 + 1:02}-01"
                duration = (date.fromisoformat(end) - date.fromisoformat(quarter_start)).days + 1
                if not 60 <= duration <= 110:
                    quarter_start = None
            pairs.append(("SINGLE_QUARTER", "thstrm_amount", quarter_start))
        for fact_basis, source_field, fact_start in pairs:
            raw = row.get(source_field)
            value = decimal_value(raw)
            currency = (
                row.get("currency")
                if re.fullmatch(r"[A-Z]{3}", str(row.get("currency", "")))
                else None
            )
            days = (
                (date.fromisoformat(end) - date.fromisoformat(fact_start)).days + 1
                if end and fact_start
                else 0
            )
            duration_valid = instant or (
                330 <= days <= 380
                if fact_basis == "ANNUAL"
                else 60 <= days <= 110
                if fact_basis == "SINGLE_QUARTER" or REPORTS[report_code] == 1
                else 150 <= days <= 220
                if REPORTS[report_code] == 2
                else 240 <= days <= 310
            )
            metadata = {
                "companyId": company_id,
                "filingId": receipt,
                "accountName": row.get("account_nm"),
                "accountDetail": row.get("account_detail"),
                "statement": statement,
                "rawValue": raw,
                "sourceField": source_field,
                "sourceRow": index,
                "sourceRowJson": row,
                "reportYear": year,
                "reportCode": report_code,
                "scope": scope,
                "normalizerVersion": VERSION,
                "dateBasis": date_basis if raw_date else "UNKNOWN",
                "dateEvidence": [
                    item
                    for item in (date_evidence or [])
                    if item.get("rcept_no") == receipt
                    and item.get("fs_div") == scope
                    and item.get("thstrm_dt") == raw_date
                ],
                "sourceUrl": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + receipt,
            }
            facts.append(
                {
                    "metric": metric,
                    "accountId": account,
                    "periodStart": fact_start,
                    "periodEnd": end,
                    "basis": fact_basis,
                    "currency": currency,
                    "unit": currency,
                    "valueText": value,
                    "status": "AVAILABLE"
                    if value is not None
                    and end
                    and currency
                    and duration_valid
                    and (instant or fact_start)
                    else "UNSUPPORTED"
                    if value is not None
                    else "NO_DATA",
                    "factJson": metadata,
                }
            )
    return mark_ambiguities(facts)


def mark_ambiguities(facts):
    grouped = defaultdict(list)
    for fact in facts:
        meta = fact["factJson"]
        key = (
            meta.get("filingId"),
            fact["metric"],
            fact["basis"],
            fact["periodStart"],
            fact["periodEnd"],
            fact["currency"],
            meta.get("scope"),
            meta.get("accountDetail"),
        )
        grouped[key].append(fact)
    for group in grouped.values():
        if len({(f["valueText"], f["accountId"]) for f in group}) > 1:
            for fact in group:
                fact["status"] = "AMBIGUOUS"
    return facts


def normalize_sec(payload, *, cik, company_id, years, filing_contexts=None):
    if str(payload.get("cik", "")).zfill(10) != cik.zfill(10):
        raise ValueError("SEC issuer mismatch")
    facts = []
    for taxonomy in ("us-gaap", "ifrs-full"):
        for account, definition in payload.get("facts", {}).get(taxonomy, {}).items():
            if not isinstance(definition, dict):
                continue
            metric = METRICS.get(account)
            if metric is None:
                continue
            for unit, values in definition.get("units", {}).items():
                if not re.fullmatch(r"[A-Z]{3}", unit) or not isinstance(values, list):
                    continue
                for index, row in enumerate(values):
                    end, start, filed = (
                        valid_date(row.get("end")),
                        valid_date(row.get("start")),
                        valid_date(row.get("filed")),
                    )
                    accession = row.get("accn")
                    if (
                        not end
                        or not filed
                        or end > filed
                        or row.get("form")
                        not in ("10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A")
                    ):
                        continue
                    if (
                        not isinstance(accession, str)
                        or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession)
                        or any(k in row for k in ("dimensions", "segment", "axis"))
                    ):
                        continue
                    if start and start > end:
                        continue
                    context = (filing_contexts or {}).get(accession, {})
                    # fy/fp describe the filing, including comparative facts. They
                    # identify this fact's period only at the original report end.
                    if context.get("reportDate") != end or context.get("form") != row.get("form"):
                        continue
                    year = row.get("fy")
                    fp = row.get("fp")
                    code = {"FY": "11011", "Q1": "11013", "Q2": "11012", "Q3": "11014"}.get(fp)
                    if type(year) is not int or year not in years or code is None:
                        continue
                    days = (
                        (date.fromisoformat(end) - date.fromisoformat(start)).days + 1
                        if start
                        else 0
                    )
                    basis = (
                        "INSTANT"
                        if not start
                        else "ANNUAL"
                        if fp == "FY"
                        else "SINGLE_QUARTER"
                        if 60 <= days <= 110
                        else "YTD"
                    )
                    duration_valid = (
                        metric in BALANCE
                        if not start
                        else (
                            330 <= days <= 380
                            if fp == "FY"
                            else 60 <= days <= 110
                            or {"Q2": 150 <= days <= 220, "Q3": 240 <= days <= 310}.get(fp, False)
                        )
                    )
                    value = decimal_value(row.get("val"))
                    scope = "CFS" if context.get("consolidated") is True else "UNKNOWN"
                    facts.append(
                        {
                            "metric": metric,
                            "accountId": taxonomy + ":" + account,
                            "periodStart": start,
                            "periodEnd": end,
                            "basis": basis,
                            "currency": unit,
                            "unit": unit,
                            "valueText": value,
                            "status": "NO_DATA"
                            if value is None
                            else "AVAILABLE"
                            if duration_valid and scope == "CFS"
                            else "AMBIGUOUS",
                            "factJson": {
                                "companyId": company_id,
                                "filingId": accession,
                                "scope": scope,
                                "form": row.get("form"),
                                "publicationDate": filed,
                                "reportYear": year,
                                "reportCode": code,
                                "filingContext": context,
                                "durationValid": duration_valid,
                                "accountName": definition.get("label"),
                                "sourceRow": index,
                                "sourceField": "val",
                                "sourceRowJson": row,
                                "rawValue": str(row.get("val")),
                                "normalizerVersion": VERSION,
                                "dateBasis": "SOURCE",
                                "sourceUrl": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{accession}-index.html",
                            },
                        }
                    )
    if len(facts) > 50000:
        raise ValueError("SEC financial fact limit exceeded")
    # The first quarter is both the official YTD and single-quarter period;
    # retain both requested views without arithmetic or inventing a Q4 value.
    for fact in list(facts):
        if fact["factJson"]["reportCode"] == "11013" and fact["basis"] == "SINGLE_QUARTER":
            cumulative = deepcopy(fact)
            cumulative["basis"] = "YTD"
            facts.append(cumulative)
    return mark_ambiguities(facts)


def fact_identity(fact):
    return sha256(json_text({k: v for k, v in fact.items() if k != "id"}))
