"""Domain-separated D001 holdings, D002 transactions and D005 planned trades."""

from __future__ import annotations

import re
from typing import Any

from .primitives import (
    AMOUNT_NATURES,
    classify_method,
    date_only,
    direction,
    header,
    multiply,
    parse_decimal,
    parse_integer,
    scale,
    unit_price,
    warning,
    whitespace,
)
from .tables import (
    body_tables,
    cell_at,
    empty_warning,
    find_label,
    find_summary,
    has_value,
    header_scale,
    is_data_row,
    locate_header,
    required_warnings,
    row_provenance,
    summary_provenance,
)

HEADERS = {
    "D001": {
        "eventDate": ["변동일", "변동일자", "계약체결일", "거래일"],
        "securityType": ["주식등의종류", "증권의종류", "특정증권등의종류"],
        "method": ["변동방법", "취득/처분방법", "취득처분방법", "보고사유"],
        "quantity": ["변동수량", "증감수량", "취득/처분수량", "변동내역>증감"],
    },
    "D002": {
        "eventDate": ["소유상황변동일", "변동일자", "변동일", "거래일"],
        "securityType": [
            "특정증권등의종류",
            "특정증권등 종류",
            "증권의종류",
            "주식등의종류",
            "증권종류",
        ],
        "method": ["취득/처분방법", "취득처분방법", "변동사유", "거래종류", "보고사유"],
        "quantity": ["취득/처분수량", "취득처분수량", "변동수량", "증감수량", "소유주식수>증감"],
        "unitPrice": [
            "취득/처분단가",
            "취득처분단가",
            "주당거래단가",
            "거래단가",
            "주당단가",
            "단가",
        ],
        "sharesAfter": ["변동후수량", "거래후보유수량", "소유수량", "잔고", "소유주식수>변동후"],
    },
    "D005": {
        "startDate": ["거래개시일", "거래시작일", "예정시작일", "시작일"],
        "endDate": ["거래종료일", "거래종료예정일", "예정종료일", "종료일"],
        "dateRange": ["거래예정기간", "거래기간", "예정기간"],
        "securityType": ["특정증권등의종류", "증권의종류", "주식등의종류"],
        "method": ["거래방법", "취득/처분방법", "취득처분방법", "거래구분"],
        "quantity": ["거래예정수량", "예정수량", "거래수량", "특정증권등의수", "수량"],
        "plannedUnitPrice": ["취득/처분단가", "취득처분단가"],
        "plannedAmount": ["거래금액"],
        "priceMin": ["최저가격", "최저단가", "가격하한"],
        "priceMax": ["최고가격", "최고단가", "가격상한"],
    },
}


def currency(unit: str | None) -> str | None:
    return (
        "KRW"
        if unit and re.fullmatch(r"억원|백만원|천원|원|krw", unit, re.IGNORECASE)
        else "USD"
        if unit and re.fullmatch(r"달러|usd", unit, re.IGNORECASE)
        else None
    )


def split_date_range(raw: str) -> tuple[str | None, str | None]:
    normalized = whitespace(raw)
    explicit = re.fullmatch(
        r"\s*(\d{4}[./-]?\d{1,2}[./-]?\d{1,2})\s*(?:~|∼|～|부터|-)\s*(\d{4}[./-]?\d{1,2}[./-]?\d{1,2})\s*",
        normalized,
    )
    if explicit:
        return date_only(explicit[1]), date_only(explicit[2])
    parts = re.split(r"\s*(?:~|∼|～|부터|\s+-\s+)\s*", normalized)
    return (date_only(parts[0]), date_only(parts[1])) if len(parts) >= 2 else (date_only(raw), None)


def scaled_fields(
    table: dict, found: dict, raw: dict, fields: list, warnings: list
) -> tuple[dict, dict, dict]:
    parsed, values, units = {}, {}, {}
    for field in fields:
        kind = "SHARES" if field in ("quantity", "sharesAfter") else "MONEY"
        units[field] = header_scale(table, found["headerEndRow"], found["columns"].get(field), kind)
        parsed[field] = (
            parse_integer(raw.get(field, ""), field)
            if kind == "SHARES"
            else unit_price(raw.get(field, ""))
            if field == "unitPrice"
            else parse_decimal(raw.get(field, ""), field)
        )
        numeric = parsed[field]
        values[field] = (
            numeric["value"]
            if numeric["unitRaw"]
            else scale(numeric["value"], units[field]["multiplier"])
        )
        if numeric["warning"]:
            warnings.append(numeric["warning"])
        if (
            numeric["value"] is not None
            and not numeric["unitRaw"]
            and units[field]["multiplier"] > 1
            and values[field] is None
        ):
            warnings.append(
                warning(
                    "NUMERIC_OUT_OF_RANGE",
                    f"헤더 단위를 적용한 {field} 값이 DECIMAL(38,6) 범위를 초과했습니다.",
                    field,
                )
            )
    return parsed, values, units


def extract_trading(tables: list, detail_type: str, _context: dict | None = None) -> dict:
    tables = body_tables(tables)
    warnings, transactions = [], []
    headers_found = rows_found = 0
    empty_table_present = False
    for table in tables:
        found = locate_header(table, HEADERS[detail_type], ["method", "quantity"])
        if (
            not found
            or detail_type == "D005"
            and not (
                ("startDate" in found["columns"] and "endDate" in found["columns"])
                or "dateRange" in found["columns"]
            )
        ):
            continue
        headers_found += 1
        data_rows = table["rows"][found["headerEndRow"] + 1 :]
        if all(
            not has_value(cell_at(row, found["columns"], "method"))
            and not has_value(cell_at(row, found["columns"], "quantity"))
            for row in data_rows
        ):
            empty_table_present = True
        fields = (
            ["quantity"]
            if detail_type == "D001"
            else ["quantity", "unitPrice", "sharesAfter"]
            if detail_type == "D002"
            else ["quantity", "priceMin", "priceMax", "plannedUnitPrice", "plannedAmount"]
        )
        for row_index in range(found["headerEndRow"] + 1, len(table["rows"])):
            row = table["rows"][row_index]
            if not is_data_row(row):
                continue
            raw = {field: cell_at(row, found["columns"], field) for field in HEADERS[detail_type]}
            method, security = raw["method"], raw["securityType"]
            if not has_value(method) and not has_value(raw["quantity"]):
                continue
            rows_found += 1
            scalar_warnings: list[dict[str, Any]] = []
            parsed, values, units = scaled_fields(table, found, raw, fields, scalar_warnings)
            row_warnings = (
                required_warnings(values["quantity"], method, table["index"], row_index)
                + scalar_warnings
            )
            item = {
                "rowIndex": row_index,
                "provenance": row_provenance(table, found, row_index),
                "securityTypeRaw": security,
                "methodRaw": method,
                **values,
            }
            classification = classify_method(method, values["quantity"], detail_type == "D005")
            if detail_type == "D001":
                item["direction"] = direction(values["quantity"])
            else:
                item.update(
                    {"nature": classification["nature"], "direction": classification["direction"]}
                )
                row_warnings.extend(classification["warnings"])
            if detail_type in ("D001", "D002"):
                item["eventDate"] = date_only(raw["eventDate"])
                if raw["eventDate"] and not item["eventDate"]:
                    row_warnings.append(
                        warning(
                            "INVALID_DATE",
                            f"날짜를 안전하게 해석할 수 없습니다: {raw['eventDate']}",
                            "eventDate",
                        )
                    )
            if detail_type == "D002":
                can_calculate = (
                    values["quantity"] is not None
                    and values["unitPrice"] is not None
                    and classification["nature"] in AMOUNT_NATURES
                    and bool(re.search(r"보통주|우선주|주식", header(security)))
                )
                amount = (
                    multiply(values["quantity"].removeprefix("-"), values["unitPrice"])
                    if can_calculate
                    else None
                )
                if can_calculate and amount is None:
                    row_warnings.append(
                        warning(
                            "NUMERIC_OUT_OF_RANGE",
                            "계산 거래금액이 DECIMAL(38,6) 범위를 초과했습니다.",
                            "amount",
                        )
                    )
                item.update(
                    {
                        "quantityUnitRaw": parsed["quantity"]["unitRaw"]
                        or units["quantity"]["unitRaw"],
                        "amount": amount,
                        "amountSource": "CALCULATED" if amount is not None else None,
                        "currency": currency(parsed["unitPrice"]["unitRaw"])
                        or ("KRW" if units["unitPrice"]["unitRaw"] else None),
                    }
                )
            if detail_type == "D005":
                range_start, range_end = split_date_range(raw["dateRange"])
                item["plannedStartDate"] = date_only(raw["startDate"]) or range_start
                item["plannedEndDate"] = date_only(raw["endDate"]) or range_end
                for field, raw_field, korean in (
                    ("plannedStartDate", "startDate", "시작일"),
                    ("plannedEndDate", "endDate", "종료일"),
                ):
                    if (raw[raw_field] or raw["dateRange"]) and not item[field]:
                        row_warnings.append(
                            warning(
                                "INVALID_DATE",
                                f"거래계획 {korean}을 안전하게 해석할 수 없습니다.",
                                field,
                            )
                        )
                item["currency"] = (
                    "KRW"
                    if currency(parsed["plannedUnitPrice"]["unitRaw"]) == "KRW"
                    or units["plannedUnitPrice"]["unitRaw"]
                    else None
                )
            if (
                values["quantity"] is None
                or not has_value(method)
                or detail_type == "D005"
                and (not item["plannedStartDate"] or not item["plannedEndDate"])
            ):
                confidence = 0.0
            elif detail_type == "D001":
                confidence = 0.5 if row_warnings else 1
            else:
                confidence = (
                    min(classification["confidence"], 0.75)
                    if row_warnings
                    else classification["confidence"]
                )
            item["confidence"] = confidence
            item["warnings"] = [
                {**value, "tableIndex": table["index"], "rowIndex": row_index}
                for value in row_warnings
            ]
            warnings.extend(item["warnings"])
            transactions.append(item)
    if detail_type == "D001":
        located = {
            "reportTypeRaw": find_label(tables, ["보고구분", "보고유형"]),
            "reporterName": find_label(tables, ["대표보고자", "보고자", "성명"]),
            "reportReasonRaw": find_label(tables, ["보고사유", "변동사유"]),
            "sharesAfter": find_summary(
                tables, ["보유주식등의수", "주식등>주식등의수"], ["이번보고서"]
            )
            or find_label(tables, ["보유주식등의수", "보유수량"]),
            "sharesChange": find_summary(tables, ["주식등>주식등의수"], ["증감"])
            or find_label(tables, ["보유주식등의증감", "보유수량증감"]),
            "ownershipRateAfter": find_summary(tables, ["보유비율", "주식등>비율"], ["이번보고서"])
            or find_label(tables, ["보유비율", "보유비율합계"]),
            "ownershipRateChange": find_summary(tables, ["주식등>비율"], ["증감"])
            or find_label(tables, ["보유비율증감", "증감비율"]),
        }
        result = {field: value["value"] if value else None for field, value in located.items()}
        for field in ("sharesAfter", "sharesChange", "ownershipRateAfter", "ownershipRateChange"):
            cell = located[field]
            if cell:
                parsed = (
                    parse_integer(cell["value"], field)
                    if field.startswith("shares")
                    else parse_decimal(cell["value"], field)
                )
                result[field] = parsed["value"]
                if parsed["warning"]:
                    warnings.append(
                        {
                            **parsed["warning"],
                            "tableIndex": cell["provenance"]["tableIndex"],
                            "rowIndex": cell["provenance"]["rowIndex"],
                        }
                    )
        reason = re.sub(r"\s", "", result["reportReasonRaw"] or "")
        result["reportReasonKind"] = (
            "CONTRACT_CHANGE"
            if re.search(
                r"(?:계약|담보|질권|대출|차입금).*(?:체결|변경|변동|해지|연장|종료|상환|신규|설정|갱신)|(?:체결|해지|상환).*(?:계약|담보|대출)|양수도.*계약",
                reason,
            )
            else "REPORTING_STATUS_CHANGE"
            if re.search(
                r"(?:보고자|특별관계자|특수관계인|임원).*(?:변경|변동|추가|제외|해소|선임|퇴임)|신규보고",
                reason,
            )
            else "HOLDINGS_CHANGE"
            if re.search(
                r"보유(?:주식|주식등|수량).*(?:변동|변경)|(?:추가취득|처분|이익소각|장내매수|장내매도|장외매수|장외매도)",
                reason,
            )
            else "UNKNOWN"
        )
        result["nonTradingReport"] = (
            not transactions
            and not rows_found
            and empty_table_present
            and result["reporterName"] is not None
            and result["sharesAfter"] is not None
            and result["ownershipRateAfter"] is not None
            and result["sharesChange"] == "0"
            and result["ownershipRateChange"] == "0"
            and result["reportReasonKind"] in ("CONTRACT_CHANGE", "REPORTING_STATUS_CHANGE")
            and not warnings
        )
        populated = sum(bool(v) for v in result.values())
        result["changes"] = transactions
    else:
        located = {
            "reporterName": find_label(tables, ["보고자", "보고자성명", "성명"]),
            "relationshipRaw": find_label(
                tables, ["임원(등기여부)", "주요주주", "발행회사와의관계", "발행회사관계", "관계"]
            ),
            "positionRaw": find_label(tables, ["직위명", "임원직위", "직위"]),
        }
        result = {field: cell["value"] if cell else None for field, cell in located.items()}
        populated = sum(bool(v) for v in result.values())
        result["transactions" if detail_type == "D002" else "planItems"] = transactions
    valid_rows = [row for row in transactions if row["confidence"] > 0]
    nontrading = result.get("nonTradingReport", False)
    if not valid_rows and not nontrading:
        warnings.append(empty_warning(tables, headers_found, rows_found))
    result.update(
        {
            "provenance": summary_provenance(located),
            "confidence": 0.95
            if nontrading
            else min(row["confidence"] for row in transactions)
            if valid_rows
            else 0,
            "warnings": warnings,
            "score": len(transactions) * 100 + populated * 5,
        }
    )
    return result
