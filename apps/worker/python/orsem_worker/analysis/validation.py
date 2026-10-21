"""Reproducible checks over immutable public financial facts, using exact decimals."""

from __future__ import annotations

import copy
import re
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation, localcontext
from uuid import NAMESPACE_URL, uuid5

VERSION = "analysis-validation-v1"
_DECIMAL = re.compile(r"^-?\d+(?:\.\d+)?$")
_BALANCE = ("assets", "liabilities", "equity")


def number(value):
    if not isinstance(value, str) or len(value) > 255 or not _DECIMAL.fullmatch(value):
        return None
    try:
        result = Decimal(value)
        return result if result.is_finite() else None
    except InvalidOperation:
        return None


def rendered(value):
    if value == 0:
        return "0"
    value = format(value, "f")
    return value.rstrip("0").rstrip(".") if "." in value else value


def parsed_date(value):
    try:
        return date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def context_key(fact):
    return tuple(
        fact.get(k)
        for k in (
            "companyId",
            "reportId",
            "scope",
            "basis",
            "periodStart",
            "periodEnd",
            "currency",
            "unit",
        )
    )


def valid_context(fact):
    end = parsed_date(fact.get("periodEnd"))
    start = parsed_date(fact.get("periodStart"))
    return (
        fact.get("scope") in ("CFS", "OFS")
        and bool(fact.get("currency"))
        and bool(fact.get("unit"))
        and end is not None
        and (fact.get("basis") == "INSTANT" or (start is not None and start <= end))
    )


def finding(rule, facts, status, message, formula="", tolerance=None):
    ids = [str(f.get("id", "")) for f in facts]
    return {
        "id": str(uuid5(NAMESPACE_URL, VERSION + rule + ":".join(sorted(ids)))),
        "rule": rule,
        "ruleVersion": VERSION,
        "status": status,
        "message": message,
        "formula": formula,
        "factIds": ids,
        "values": [str(f.get("value")) for f in facts if f.get("value") is not None],
        "tolerance": tolerance,
    }


def half_rounding_unit(fact):
    # XBRL decimals describes precision in normalized units, not printed scale.
    precision = fact.get("precision")
    if precision == "INF":
        return Decimal(0)
    if not isinstance(precision, str) or not re.fullmatch(r"-?\d{1,2}", precision):
        return None
    decimals = int(precision)
    if not -18 <= decimals <= 18:
        return None
    return Decimal(1).scaleb(-decimals) / 2


def total_equity(fact):
    tag = re.split(r"[:_]", str(fact.get("accountId") or ""), maxsplit=1)[-1]
    return (
        tag
        not in (
            "StockholdersEquity",
            "EquityAttributableToOwnersOfParent",
            "EquityAttributableToOwnersOfTheParent",
        )
        and "OwnersOfParent" not in tag
    )


def validate_facts(facts: list[dict]) -> list[dict]:
    findings = []
    groups = defaultdict(list)
    for fact in facts:
        groups[context_key(fact)].append(fact)
        if fact.get("status") != "AVAILABLE" or number(fact.get("value")) is None:
            findings.append(
                finding(
                    "FACT_AVAILABILITY",
                    [fact],
                    "UNAVAILABLE",
                    "자료가 없거나 추출·계정 대응을 확인해야 합니다.",
                )
            )
        elif not valid_context(fact):
            findings.append(
                finding(
                    "FACT_CONTEXT",
                    [fact],
                    "UNAVAILABLE",
                    "회계기간·연결 범위·통화·단위를 확인할 수 없습니다.",
                )
            )
    for group in groups.values():
        by_metric = defaultdict(list)
        for fact in group:
            by_metric[fact.get("metric")].append(fact)
        for same in by_metric.values():
            if len(same) > 1:
                findings.append(
                    finding(
                        "DUPLICATE_METRIC",
                        same,
                        "REVIEW",
                        "같은 조건에 계정이 여러 개 있어 합산하거나 하나를 자동 선택하지 않습니다.",
                    )
                )
        relevant = [f for f in group if f.get("metric") in _BALANCE]
        if not relevant:
            continue
        complete = all(len(by_metric[m]) == 1 for m in _BALANCE)
        usable = complete and all(
            f.get("status") == "AVAILABLE"
            and valid_context(f)
            and number(f.get("value")) is not None
            for f in relevant
        )
        usable = usable and all(f.get("basis") == "INSTANT" for f in relevant)
        usable = usable and all(total_equity(f) for f in by_metric["equity"])
        if not usable:
            findings.append(
                finding(
                    "BALANCE_SHEET_EQUATION",
                    relevant,
                    "UNAVAILABLE",
                    "동일 제출본의 자산·부채·총자본을 정확히 확보해야 검사할 수 있습니다.",
                    "자산 = 부채 + 총자본",
                )
            )
            continue
        ordered = [by_metric[m][0] for m in _BALANCE]
        with localcontext() as ctx:
            ctx.prec = 300
            values = [number(f["value"]) for f in ordered]
            difference = values[0] - values[1] - values[2]
            units = [half_rounding_unit(f) for f in ordered]
            tolerance = sum(units, Decimal(0)) if all(u is not None for u in units) else None
            status = (
                "PASS"
                if difference == 0
                else "ROUNDING"
                if tolerance is not None and abs(difference) <= tolerance
                else "REVIEW"
            )
            message = (
                "합계가 일치합니다."
                if status == "PASS"
                else "원문 표시 정밀도의 반올림 범위 안에 있습니다."
                if status == "ROUNDING"
                else "합계 차이를 원문에서 확인해야 합니다."
            )
            findings.append(
                finding(
                    "BALANCE_SHEET_EQUATION",
                    ordered,
                    status,
                    message,
                    f"{ordered[0]['value']} - {ordered[1]['value']} - {ordered[2]['value']} = {rendered(difference)}",
                    rendered(tolerance) if tolerance is not None else None,
                )
            )
    return findings


def comparable(current, previous):
    if not valid_context(current) or not valid_context(previous):
        return False
    for key in (
        "companyId",
        "metric",
        "accountDetail",
        "scope",
        "basis",
        "currency",
        "unit",
        "reportCode",
    ):
        if current.get(key) != previous.get(key):
            return False
    if current.get("mappingVersion") != previous.get("mappingVersion"):
        return False
    if not current.get("mappingVersion") and current.get("accountId") != previous.get("accountId"):
        return False
    current_end, previous_end = (
        parsed_date(current["periodEnd"]),
        parsed_date(previous["periodEnd"]),
    )
    if not 358 <= (current_end - previous_end).days <= 373:
        return False
    if current.get("basis") != "INSTANT":
        current_start, previous_start = (
            parsed_date(current["periodStart"]),
            parsed_date(previous["periodStart"]),
        )
        if not 358 <= (current_start - previous_start).days <= 373:
            return False
        if abs((current_end - current_start).days - (previous_end - previous_start).days) > 7:
            return False
    return True


def compare_facts(facts: list[dict]) -> list[dict]:
    result = copy.deepcopy(facts)
    # Only selected immutable facts are compared. Multiple prior versions are ambiguous.
    for current in result:
        current.pop("comparison", None)
        if current.get("status") != "AVAILABLE" or number(current.get("value")) is None:
            continue
        previous = [
            f
            for f in facts
            if f.get("status") == "AVAILABLE"
            and number(f.get("value")) is not None
            and comparable(current, f)
        ]
        if len(previous) != 1:
            continue
        prior = previous[0]
        with localcontext() as ctx:
            ctx.prec = 300
            value, prior_value = number(current["value"]), number(prior["value"])
            difference = value - prior_value
            percent = (
                (difference / prior_value * 100).quantize(Decimal("0.000001"))
                if prior_value > 0
                else None
            )
            profit_metric = current.get("metric") in ("netIncome", "operatingIncome")
            transition = (
                "PROFIT"
                if profit_metric and value > 0 and prior_value < 0
                else "LOSS"
                if profit_metric and value < 0 and prior_value > 0
                else None
            )
            current["comparison"] = {
                "previousFactId": prior["id"],
                "difference": rendered(difference),
                "percent": rendered(percent) if percent is not None else None,
                "transition": transition,
            }
    return result
