"""Readable disclosure summaries based only on parsed, domain-specific facts."""

from __future__ import annotations

import re

DISCLOSURE_LABELS = {
    "D001": "대량보유 공시",
    "D002": "임원·주요주주 보유",
    "D003": "의결권 위임 권유",
    "D004": "공개매수",
    "D005": "주식 거래계획",
}
BUY_NATURES = {"MARKET_BUY", "BLOCK_BUY", "AFTER_HOURS_BUY", "OFF_MARKET_BUY"}
SELL_NATURES = {"MARKET_SELL", "BLOCK_SELL", "AFTER_HOURS_SELL", "OFF_MARKET_SELL"}


def text(value) -> str:
    return re.sub(r"\s+", " ", value).strip() if isinstance(value, str) else ""


def quantity(value) -> int | None:
    return int(value) if isinstance(value, str) and re.fullmatch(r"[+-]?\d{1,38}", value) else None


def signal(row: dict) -> str | None:
    amount = quantity(row.get("quantity"))
    if amount is None:
        return None
    if row.get("nature") in BUY_NATURES and row.get("direction") == "INCREASE" and amount > 0:
        return "매수신호"
    if row.get("nature") in SELL_NATURES and row.get("direction") == "DECREASE" and amount < 0:
        return "매도신호"
    return None


def transaction_summary(rows: list[dict], planned: bool = False) -> str:
    groups: dict[tuple, dict] = {}
    for index, row in enumerate(rows):
        amount = quantity(row.get("quantity"))
        unit = row.get("quantityUnitRaw")
        unit = unit if unit in ("개", "좌") else "주"
        key = (
            row.get("nature"),
            row.get("direction"),
            text(row.get("methodRaw")),
            text(row.get("securityTypeRaw")),
            unit,
            index if amount is None else None,
        )
        if key in groups and amount is not None:
            groups[key]["amount"] += amount
        else:
            groups[key] = {"amount": amount, "method": key[2], "security": key[3], "unit": unit}
    multiple_securities = len({row["security"] for row in groups.values()}) > 1
    fragments = []
    for row in list(groups.values())[:3]:
        amount = row["amount"]
        formatted = (
            "수량 확인 필요"
            if amount is None
            else f"{'+' if amount > 0 and not planned else ''}{amount:,}{row['unit']}"
        )
        fragments.append(
            " ".join(
                filter(
                    None,
                    (
                        row["security"] if multiple_securities else "",
                        formatted,
                        row["method"] or "방법 확인 필요",
                    ),
                )
            )
        )
    if len(groups) > 3:
        fragments.append(f"외 {len(groups) - 3}종")
    return " · ".join(fragments) or "거래 내역 확인 필요"


def parsed_summary(parsed: dict, company_name: str | None = None) -> str:
    kind = parsed["detailType"]
    company = f"({text(company_name)})" if text(company_name) else ""
    reporter = text(parsed.get("reporterName")) or "보고자 확인 필요"
    identity = " ".join(
        dict.fromkeys(
            filter(
                None,
                (
                    reporter,
                    text(parsed.get("positionRaw")),
                    text(parsed.get("relationshipRaw")),
                ),
            )
        )
    )
    if kind == "D002":
        rows = parsed.get("transactions") or []
        signals = {signal(row) for row in rows}
        label = " ".join(f"[{value}]" for value in ("매수신호", "매도신호") if value in signals)
        return " ".join(
            filter(
                None,
                (
                    label or "[소유변동]",
                    company,
                    identity,
                    transaction_summary(rows),
                ),
            )
        )
    if kind == "D005":
        detail = f"{identity} {transaction_summary(parsed.get('planItems') or [], True)} 예정"
    elif kind == "D001":
        detail = f"{reporter} {text(parsed.get('reportReasonRaw')) or '사유 확인 필요'}"
    elif kind == "D003":
        detail = (
            f"{text(parsed.get('solicitorName')) or '권유자 확인 필요'} "
            f"주주총회 {text(parsed.get('meetingDate')) or '일자 확인 필요'}, "
            f"안건 {len(parsed.get('agendas') or [])}건"
        )
    elif kind == "D004":
        label = "공개매수 결과" if parsed.get("documentKind") == "RESULT" else "공개매수 문서"
        return " ".join(
            filter(
                None,
                (
                    f"[{label}]",
                    company,
                    text(parsed.get("offerorName")) or "공개매수자 확인 필요",
                    text(parsed.get("targetCompanyName")) or "대상회사 확인 필요",
                ),
            )
        )
    else:
        return " ".join(filter(None, ("[공시]", company, reporter)))
    return " ".join(filter(None, (f"[{DISCLOSURE_LABELS[kind]}]", company, detail)))
