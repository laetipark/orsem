"""D003 proxy solicitation and D004 tender-offer facts, kept outside trading events."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from .extractors import currency
from .primitives import (
    date_only,
    header,
    multiply,
    parse_decimal,
    parse_integer,
    unit_price,
    warning,
    whitespace,
)
from .tables import body_tables, has_value, locate_header, provenance, summary_provenance


def label_key(value: str) -> str:
    return re.sub(r"^[□■]", "", re.sub(r"^(?:[가-힣]|\d+)\.", "", header(value)))


def find_field(tables: list, labels: list) -> dict | None:
    for label in map(label_key, labels):
        for table in tables:
            for row, values in enumerate(table["rows"]):
                for column, text in enumerate(values):
                    if label_key(text) != label:
                        continue
                    cell = table["grid"][row][column]
                    if not cell or cell["sourceRowIndex"] != row:
                        continue
                    next_column = column + 1
                    while next_column < len(values) and table["grid"][row][next_column] is cell:
                        next_column += 1
                    value = whitespace(values[next_column]) if next_column < len(values) else ""
                    if has_value(value) and value != text:
                        return {
                            "value": value,
                            "provenance": provenance(table, row, next_column, [text]),
                        }
    return None


def find_coded_field(tables: list, codes: list) -> dict | None:
    for code in codes:
        for table in tables:
            for row, cells in enumerate(table["grid"]):
                column = next(
                    (
                        index
                        for index, cell in enumerate(cells)
                        if cell
                        and cell["attributes"].get("ACODE") == code
                        and cell["sourceRowIndex"] == row
                    ),
                    -1,
                )
                if column >= 0:
                    value = whitespace(table["rows"][row][column])
                    if has_value(value):
                        return {
                            "value": value,
                            "provenance": provenance(table, row, column, [code]),
                        }
    return None


def find_column_field(tables: list, labels: list) -> dict | None:
    for table in tables:
        found = locate_header(table, {"value": labels}, ["value"])
        if not found:
            continue
        column = found["columns"]["value"]
        for row in range(found["headerEndRow"] + 1, len(table["rows"])):
            value = table["rows"][row][column]
            if has_value(value):
                return {"value": value, "provenance": provenance(table, row, column, labels)}
    return None


def document_provenance(context: dict, tag: str, value: str) -> dict:
    return {
        "sourcePath": ["DOCUMENT", tag],
        "sourceEntryName": context["sourceEntryName"],
        "tableIndex": -1,
        "rowIndex": -1,
        "columnIndex": -1,
        "sourceRowIndex": -1,
        "sourceColumnIndex": -1,
        "headerPath": [tag],
        "rawText": value,
    }


def date_tokens(raw: str) -> list:
    return [
        value
        for match in re.finditer(
            r"(\d{4})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})\s*일?", raw
        )
        if (value := date_only(f"{match[1]}-{match[2]}-{match[3]}"))
    ]


def single_date(value: dict | None, field: str, warnings: list) -> str | None:
    if value:
        dates = date_tokens(value["value"])
        if len(dates) == 1:
            return dates[0]
        warnings.append(
            warning(
                "INVALID_DATE",
                "하나의 유효한 날짜를 확인할 수 없습니다.",
                field,
                tableIndex=value["provenance"]["tableIndex"],
                rowIndex=value["provenance"]["rowIndex"],
            )
        )
    return None


def required_fields(fields: dict, warnings: list) -> None:
    warnings.extend(
        warning("MISSING_DISCLOSURE_FIELD", "공시 핵심 항목이 없거나 확정할 수 없습니다.", key)
        for key, value in fields.items()
        if value is None or value == ""
    )


def meeting_instant(date: str | None, raw: str | None) -> dict:
    empty = {"meetingTimeRaw": None, "meetingAt": None}
    if not date or not raw:
        return empty
    raw = re.sub(r"\d{4}\s*(?:년|[./-])\s*\d{1,2}\s*(?:월|[./-])\s*\d{1,2}\s*일?", "", raw, count=1)
    match = re.search(r"(오전|오후)?\s*(\d{1,2})\s*(?:시(?:\s*(\d{1,2})\s*분)?|:(\d{2}))", raw)
    if not match:
        return empty
    hour, minute = int(match[2]), int(match[3] or match[4] or 0)
    if hour > 23 or minute > 59 or match[1] and not 1 <= hour <= 12:
        return {**empty, "meetingTimeRaw": match[0].strip()}
    if match[1]:
        hour = hour % 12 + (12 if match[1] == "오후" else 0)
    instant = datetime.fromisoformat(f"{date}T{hour:02d}:{minute:02d}:00+09:00").astimezone(UTC)
    return {
        "meetingTimeRaw": match[0].strip(),
        "meetingAt": instant.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }


def extract_d003(tables: list, context: dict) -> dict:
    tables, warnings = body_tables(tables), []
    summaries = [
        t
        for t in tables
        if any("권유자" in value for row in t["rows"] for value in row)
        and any(
            re.search(r"권유취지|권유시작일|권유 시작일", value)
            for row in t["rows"]
            for value in row
        )
    ]
    summary = summaries[0] if summaries else None
    if len(summaries) > 1:
        warnings.append(
            warning("AMBIGUOUS_DISCLOSURE_SUMMARY", "의결권 권유 요약표가 여러 개입니다.")
        )
    selected = [summary] if summary else []
    located = {
        "solicitorName": find_coded_field(selected, ["REC_NM"]) or find_field(selected, ["권유자"]),
        "relationshipRaw": find_coded_field(selected, ["REC_COP_RL"])
        or find_field(selected, ["회사와의 관계"]),
        "purposeRaw": find_coded_field(selected, ["REC_PPS"]) or find_field(selected, ["권유취지"]),
        "meetingDate": find_field(selected, ["주주총회일"]),
        "meetingDateTime": find_field(
            [
                t
                for t in tables
                if any(re.fullmatch(r"장\s*소", value) for row in t["rows"] for value in row)
            ],
            ["일시"],
        ),
        "meetingLocation": find_field(tables, ["장소"]),
        "solicitationStartDate": find_column_field(
            [
                t
                for t in tables
                if any(
                    "권유종료일" in re.sub(r"\s", "", value) for row in t["rows"] for value in row
                )
            ],
            ["권유시작일"],
        )
        or find_field(selected, ["권유시작일"]),
        "solicitationEndDate": find_column_field(tables, ["권유종료일"]),
        "electronicVoting": find_field(selected, ["전자/서면투표여부"]),
    }

    def value(key: str):
        item = located[key]
        return item["value"] if item else None

    summary_date = single_date(located["meetingDate"], "meetingDate", warnings)
    detail_dates = date_tokens(value("meetingDateTime") or "")
    meeting_date = detail_dates[0] if len(detail_dates) == 1 else summary_date
    if summary_date and meeting_date != summary_date:
        warnings.append(
            warning(
                "DISCLOSURE_DATE_CONFLICT",
                "총회 요약 날짜와 상세 일시가 일치하지 않습니다.",
                "meetingDate",
            )
        )
    timing = meeting_instant(meeting_date, value("meetingDateTime"))
    if timing["meetingTimeRaw"] and not timing["meetingAt"]:
        warnings.append(
            warning("INVALID_MEETING_TIME", "총회 시각이 유효하지 않습니다.", "meetingAt")
        )
    start = single_date(located["solicitationStartDate"], "solicitationStartDate", warnings)
    end = single_date(located["solicitationEndDate"], "solicitationEndDate", warnings)
    if start and end and start > end:
        warnings.append(
            warning(
                "INVALID_DATE_RANGE", "권유 시작일이 종료일보다 늦습니다.", "solicitationEndDate"
            )
        )
    vote = re.sub(r"\s", "", value("electronicVoting") or "")
    voting = (
        True
        if vote == "전자투표가능"
        else False
        if vote in ("해당사항없음", "전자투표불가", "전자투표불가능")
        else None
    )
    agendas: list[dict[str, Any]] = []
    if summary:
        agenda_start = next(
            (
                index
                for index, row in enumerate(summary["rows"])
                if any("주주총회목적사항" in re.sub(r"\s", "", text) for text in row)
            ),
            -1,
        )
        if agenda_start >= 0:
            for row in range(agenda_start + 1, len(summary["rows"])):
                source_row = summary["rows"][row]
                title = re.sub(r"^[□■]\s*", "", " ".join(dict.fromkeys(source_row))).strip()
                if title and re.match(r"\s*[□■]", source_row[0] if source_row else ""):
                    agendas.append(
                        {
                            "ordinal": len(agendas) + 1,
                            "title": title,
                            "provenance": {
                                "title": provenance(summary, row, 0, ["주주총회 목적사항"])
                            },
                        }
                    )
    if not agendas:
        warnings.append(
            warning("MISSING_AGENDAS", "주주총회 안건을 확인할 수 없습니다.", "agendas")
        )
    result = {
        "solicitorName": value("solicitorName"),
        "targetCompanyName": context.get("companyName"),
        "relationshipRaw": value("relationshipRaw"),
        "meetingDate": meeting_date,
        **timing,
        "meetingLocation": value("meetingLocation"),
        "solicitationStartDate": start,
        "solicitationEndDate": end,
        "purposeRaw": value("purposeRaw"),
        "electronicVoting": voting,
        "agendas": agendas,
    }
    required_fields(
        {
            key: result[key]
            for key in (
                "solicitorName",
                "targetCompanyName",
                "meetingDate",
                "solicitationStartDate",
                "solicitationEndDate",
            )
        },
        warnings,
    )
    source = summary_provenance(located)
    if result["targetCompanyName"]:
        source["targetCompanyName"] = document_provenance(
            context, "COMPANY-NAME", result["targetCompanyName"]
        )
    return {
        **result,
        "confidence": 0.5 if warnings else 0.95,
        "provenance": source,
        "warnings": warnings,
        "score": 100 + len(agendas) if summary else 0,
    }


def summary_field(table: dict | None, label: str, parent: str | None = None) -> dict | None:
    if table:
        for row, values in enumerate(table["rows"]):
            if (
                not any(header(v) == header(label) for v in values)
                or parent
                and not re.search(parent, " ".join(map(header, values)))
            ):
                continue
            column = len(values) - 1
            while column >= 0 and not values[column].strip():
                column -= 1
            if column < 0:
                continue
            value = values[column].strip()
            if value and header(value) != header(label):
                return {
                    "value": value,
                    "provenance": provenance(table, row, column, list(dict.fromkeys(values[:-1]))),
                }
    return None


def quantities(value: dict | None, field: str, warnings: list) -> dict:
    if not value:
        return {"min": None, "max": None}
    raw = re.sub(r"\s", "", value["value"])
    minimum, maximum = (
        re.search(r"최소[:：]?([\d,]+)주", raw),
        re.search(r"최대[:：]?([\d,]+)주", raw),
    )
    one = re.fullmatch(r"([\d,]+)주(?:\([^)]*%\))?", raw)
    lower = parse_integer(minimum[1] if minimum else one[1] if one else "", field)["value"]
    upper = parse_integer(maximum[1] if maximum else one[1] if one else "", field)["value"]
    if lower is None or upper is None or int(lower) > int(upper):
        warnings.append(
            warning(
                "INVALID_TENDER_QUANTITY_RANGE",
                "공개매수 수량 범위를 확정할 수 없습니다.",
                field,
                tableIndex=value["provenance"]["tableIndex"],
                rowIndex=value["provenance"]["rowIndex"],
            )
        )
    return {"min": lower, "max": upper}


def header_column(table: dict, label: str) -> int:
    return next(
        (
            i
            for i, value in enumerate(table["rows"][0] if table["rows"] else [])
            if header(value) == header(label)
        ),
        -1,
    )


def exact_result_table(tables: list, labels: list) -> dict | None:
    found = [table for table in tables if all(header_column(table, label) >= 0 for label in labels)]
    return found[0] if len(found) == 1 else None


def extract_d004_result(tables: list, context: dict) -> dict:
    warnings = []
    terms = exact_result_table(tables, ["주식등의 종류", "매수가격", "매수예정수량", "결제수단"])
    results = exact_result_table(
        tables, ["주식등의 종류", "예정주식 수", "응모주식 수", "매수주식 수"]
    )
    cover = next(
        (table for table in tables if any(tag.upper() == "COVER" for tag in table["path"])), None
    )
    offeror = summary_field(cover, "보고자")
    name_match = re.search(r"성\s*명\s*[:：]\s*(.+)$", offeror["value"] if offeror else "")
    offeror_name = name_match[1].strip() if name_match else None
    target = context.get("companyName")
    securities = []
    if terms and results and len(terms["rows"]) == 2 and len(results["rows"]) == 2:
        terms_type = terms["rows"][1][header_column(terms, "주식등의 종류")].strip()
        results_type_column = header_column(results, "주식등의 종류")
        results_type = results["rows"][1][results_type_column].strip()
        if terms_type and terms_type == results_type:
            price_column = header_column(terms, "매수가격")
            price = unit_price(re.sub(r"^주당\s*", "", terms["rows"][1][price_column]))
            if price["warning"]:
                warnings.append({**price["warning"], "tableIndex": terms["index"], "rowIndex": 1})

            def source_integer(table: dict, label: str):
                column = header_column(table, label)
                parsed = parse_integer(table["rows"][1][column] if column >= 0 else "", label)
                if parsed["warning"]:
                    warnings.append(
                        {**parsed["warning"], "tableIndex": table["index"], "rowIndex": 1}
                    )
                return parsed["value"]

            maximum = source_integer(terms, "매수예정수량")
            offered, acquired = (
                source_integer(results, "응모주식 수"),
                source_integer(results, "매수주식 수"),
            )
            amount = (
                multiply(acquired, price["value"])
                if acquired is not None and price["value"] is not None
                else None
            )
            if acquired is not None and price["value"] is not None and amount is None:
                warnings.append(
                    warning(
                        "NUMERIC_OUT_OF_RANGE",
                        "실제 공개매수 금액을 안전한 범위에서 계산할 수 없습니다.",
                        "actualAmount",
                        tableIndex=results["index"],
                        rowIndex=1,
                    )
                )
            source = {
                "securityTypeRaw": provenance(results, 1, results_type_column, ["주식등의 종류"]),
                "unitPrice": provenance(terms, 1, price_column, ["매수가격"]),
            }
            for field, table, label in (
                ("maxQuantity", terms, "매수예정수량"),
                ("offeredQuantity", results, "응모주식 수"),
                ("acquiredQuantity", results, "매수주식 수"),
            ):
                source[field] = provenance(table, 1, header_column(table, label), [label])
            securities.append(
                {
                    "rowIndex": 1,
                    "securityTypeRaw": results_type,
                    "unitPrice": price["value"],
                    "currency": currency(price["unitRaw"]),
                    "minQuantity": None,
                    "maxQuantity": maximum,
                    "heldQuantity": None,
                    "expectedHoldingsMin": None,
                    "expectedHoldingsMax": None,
                    "offeredQuantity": offered,
                    "acquiredQuantity": acquired,
                    "actualAmount": amount,
                    "provenance": source,
                }
            )
    if not securities:
        warnings.append(
            warning(
                "UNVERIFIED_TENDER_RESULT_TEMPLATE",
                "검증된 공개매수 결과표 구조와 일치하지 않아 실제 수량을 추출하지 않았습니다.",
                "securities",
            )
        )
    required_fields({"offerorName": offeror_name, "targetCompanyName": target}, warnings)
    source = {"offerorName": offeror["provenance"]} if offeror else {}
    if target:
        source["targetCompanyName"] = document_provenance(context, "COMPANY-NAME", target)
    if context.get("documentName"):
        source["documentKind"] = document_provenance(
            context, "DOCUMENT-NAME", context["documentName"]
        )
    return {
        "documentKind": "RESULT",
        "offerorName": offeror_name,
        "targetCompanyName": target,
        "purposeRaw": None,
        "conditionsRaw": None,
        "subscriptionStartDate": None,
        "subscriptionEndDate": None,
        "settlementDate": None,
        "securities": securities,
        "confidence": 0.5 if warnings else 0.95,
        "provenance": source,
        "warnings": warnings,
        "score": 100 + len(securities) if terms and results else 0,
    }


def extract_d004(tables: list, context: dict) -> dict:
    tables, warnings = body_tables(tables), []
    title = re.sub(r"\s", "", context.get("documentName") or "")
    kind = (
        "RESULT"
        if "공개매수결과보고서" in title
        else "EXPLANATION"
        if "공개매수설명서" in title
        else "REPORT"
        if "공개매수신고서" in title
        else "OTHER"
    )
    if kind == "RESULT":
        return extract_d004_result(tables, context)
    summaries = [
        t
        for t in tables
        if all(
            label in [header(value) for row in t["rows"] for value in row]
            for label in ("공개매수대상회사명", "공개매수목적", "공개매수기간")
        )
    ]
    summary = summaries[0] if len(summaries) == 1 else None
    if len(summaries) > 1:
        warnings.append(
            warning(
                "AMBIGUOUS_DISCLOSURE_SUMMARY",
                "공개매수 요약표가 여러 개여서 하나를 선택하지 않았습니다.",
            )
        )
    if kind == "OTHER":
        warnings.append(
            warning(
                "UNRECOGNIZED_TENDER_DOCUMENT_KIND",
                "공개매수 문서 단계를 확정할 수 없습니다.",
                "documentKind",
            )
        )
    labels = {
        "offerorName": "공개매수자",
        "targetCompanyName": "공개매수 대상회사명",
        "purposeRaw": "공개매수 목적",
        "conditionsRaw": "공개매수조건",
        "subscriptionPeriod": "공개매수기간",
        "securityTypeRaw": "주식등의 종류",
        "quantityRange": "매수 예정 수량(비율)",
        "unitPrice": "매수 가격",
    }
    located = {key: summary_field(summary, label) for key, label in labels.items()}
    located["heldQuantity"] = summary_field(summary, "보유 수량", "신고서제출일현재")
    located["expectedHoldings"] = summary_field(summary, "보유 수량", "공개매수후")

    def value(key: str):
        item = located[key]
        return item["value"] if item else None

    raw_offeror = value("offerorName") or ""
    named = re.search(r"성명\s*[:：]\s*([^□■]+)", raw_offeror)
    offeror = (
        named[1].strip()
        if named
        else raw_offeror
        if raw_offeror and not re.search(r"[□■:：]", raw_offeror)
        else None
    )
    period = value("subscriptionPeriod") or ""
    dates = date_tokens(re.sub(r"\([^)]*결제일[^)]*\)", "", period))
    start, end = dates if len(dates) == 2 else (None, None)
    settlement = re.search(r"결제일\s*[:：]?\s*([^)]*)", period)
    settlement_dates = date_tokens(settlement[1] if settlement else "")
    settlement_date = settlement_dates[0] if len(settlement_dates) == 1 else None
    if start and end and start > end or settlement_date and end and settlement_date < end:
        warnings.append(
            warning(
                "INVALID_DATE_RANGE",
                "공개매수 기간 또는 결제일 순서를 확인해야 합니다.",
                "subscriptionEndDate",
            )
        )
    securities = []
    security = located["securityTypeRaw"]
    if summary and security:
        bounds, expected = (
            quantities(located["quantityRange"], "quantityRange", warnings),
            quantities(located["expectedHoldings"], "expectedHoldings", warnings),
        )
        price = parse_decimal(re.sub(r"^주당\s*", "", value("unitPrice") or ""), "unitPrice")
        held = parse_integer(value("heldQuantity") or "", "heldQuantity")
        warnings.extend(item["warning"] for item in (price, held) if item["warning"])
        price_value = (
            price["value"]
            if price["value"] is not None and not price["value"].startswith("-")
            else None
        )
        source = summary_provenance(located)
        for location, fields in (
            ("quantityRange", ("minQuantity", "maxQuantity")),
            ("expectedHoldings", ("expectedHoldingsMin", "expectedHoldingsMax")),
        ):
            location_value = located[location]
            if location_value:
                source.update({field: location_value["provenance"] for field in fields})
        securities.append(
            {
                "rowIndex": security["provenance"]["rowIndex"],
                "securityTypeRaw": value("securityTypeRaw"),
                "unitPrice": price_value,
                "currency": currency(price["unitRaw"]),
                "minQuantity": bounds["min"],
                "maxQuantity": bounds["max"],
                "heldQuantity": held["value"],
                "expectedHoldingsMin": expected["min"],
                "expectedHoldingsMax": expected["max"],
                "offeredQuantity": None,
                "acquiredQuantity": None,
                "actualAmount": None,
                "provenance": source,
            }
        )
        required_fields(
            {"unitPrice": price_value, "minQuantity": bounds["min"], "maxQuantity": bounds["max"]},
            warnings,
        )
    result = {
        "documentKind": kind,
        "offerorName": offeror,
        "targetCompanyName": value("targetCompanyName"),
        "purposeRaw": value("purposeRaw"),
        "conditionsRaw": value("conditionsRaw"),
        "subscriptionStartDate": start,
        "subscriptionEndDate": end,
        "settlementDate": settlement_date,
        "securities": securities,
    }
    required_fields(
        {
            key: result[key]
            for key in (
                "offerorName",
                "targetCompanyName",
                "subscriptionStartDate",
                "subscriptionEndDate",
            )
        },
        warnings,
    )
    if not securities:
        warnings.append(
            warning(
                "MISSING_TENDER_SECURITIES",
                "검증된 공개매수 대상 증권 행이 없습니다.",
                "securities",
            )
        )
    source = summary_provenance(located)
    if context.get("documentName"):
        source["documentKind"] = document_provenance(
            context, "DOCUMENT-NAME", context["documentName"]
        )
    if located["subscriptionPeriod"]:
        source.update(
            {
                field: located["subscriptionPeriod"]["provenance"]
                for field in ("subscriptionStartDate", "subscriptionEndDate", "settlementDate")
            }
        )
    return {
        **result,
        "confidence": 0.5 if warnings else 0.95,
        "provenance": source,
        "warnings": warnings,
        "score": 100 + len(securities) if summary else 0,
    }
