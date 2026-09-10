"""Canonical DART tables, source provenance and bounded merged-cell expansion."""

from __future__ import annotations

import re
from typing import Any
from xml.parsers import expat

from .primitives import OpenDartPayloadError, header, whitespace
from .xml_archive import assert_safe_xml, lexical_complexity, literal_entity_copy

LIMITS = {
    "tables": 2000,
    "rows": 100000,
    "sourceCells": 500000,
    "expandedCells": 2000000,
    "sourceTextCharacters": 8 * 1024**2,
    "expandedTextCharacters": 32 * 1024**2,
}


def complexity(message: str) -> None:
    raise OpenDartPayloadError(
        f"XML 표 구조가 안전 처리 한도를 초과했습니다: {message}", "XML_COMPLEXITY_LIMIT"
    )


def budget_add(budget: dict, name: str, value: int) -> None:
    budget[name] = budget.get(name, 0) + value
    if budget[name] > LIMITS[name]:
        complexity(name)


def parse_xml_tree(xml: str) -> dict:
    """Expat validates syntax; DefaultHandler retains source entity spelling."""
    protected_xml, literal_entities, marker = literal_entity_copy(xml)
    marker_pattern = (
        re.compile(re.escape(marker) + r"[0-9a-f]+" + re.escape(marker)) if marker else None
    )

    def restore(value: str) -> str:
        return (
            marker_pattern.sub(lambda match: literal_entities[match[0]], value)
            if marker_pattern
            else value
        )

    stack: list[dict[str, Any]] = []
    roots: list[dict[str, Any]] = []
    parser = expat.ParserCreate()

    def start(tag: str, attributes: dict) -> None:
        node: dict[str, Any] = {
            "tag": tag,
            "attributes": {key: restore(value) for key, value in attributes.items()},
            "children": [],
            "content": [],
        }
        if stack:
            stack[-1]["children"].append(node)
            stack[-1]["content"].append(node)
        else:
            roots.append(node)
        stack.append(node)

    def end(_tag: str) -> None:
        stack.pop()

    def raw(text: str) -> None:
        if not stack:
            return
        content = stack[-1]["content"]
        if content and isinstance(content[-1], str):
            content[-1] += text
        else:
            content.append(text)

    parser.StartElementHandler, parser.EndElementHandler = start, end
    parser.DefaultHandler = raw
    parser.StartCdataSectionHandler = lambda: None
    parser.EndCdataSectionHandler = lambda: None
    parser.CommentHandler = lambda _: None
    parser.XmlDeclHandler = lambda *_: None
    try:
        parser.Parse(protected_xml, True)
    except expat.ExpatError as exc:
        raise OpenDartPayloadError(f"유효하지 않은 XML입니다: {exc}", "INVALID_XML") from exc

    def restore_content(node: dict) -> None:
        node["content"] = [
            restore(item) if isinstance(item, str) else item for item in node["content"]
        ]
        for child in node["children"]:
            restore_content(child)

    if literal_entities:
        for root in roots:
            restore_content(root)
    return {"tag": "", "children": roots, "content": roots, "attributes": {}}


def raw_text(node: dict) -> str:
    result = " ".join(
        item if isinstance(item, str) else raw_text(item) for item in node["content"]
    ).strip()
    if len(result) > 16384:
        complexity("셀 텍스트 16384자 초과")
    return result


def decode_text(raw: str) -> str:
    named = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}

    def replace(match):
        key = match[1]
        if not key.startswith("#"):
            return named.get(key, match[0])
        point = int(key[1:], 0) if key[1].lower() == "x" else int(key[1:])
        return chr(point) if 0 < point <= 0x10FFFF and not 0xD800 <= point <= 0xDFFF else match[0]

    return re.sub(r"&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);", replace, raw, flags=re.IGNORECASE)


def descendants(nodes: list, wanted: set, stop: set | None = None) -> list:
    found = []

    def visit(node):
        tag = node["tag"].upper()
        if tag in wanted:
            found.append(node)
        elif tag not in (stop or set()):
            for child in node["children"]:
                visit(child)

    for node in nodes:
        visit(node)
    return found


def span(attributes: dict, key: str) -> int:
    value = next((v for k, v in attributes.items() if k.upper() == key), "1")
    try:
        number = float(value)
        return int(number) if number.is_integer() and 1 <= number <= 256 else 1
    except ValueError:
        return 1


def canonicalize_tables(xml: str, entry_name: str, budget: dict | None = None) -> dict:
    budget = budget if budget is not None else {}
    assert_safe_xml(xml, entry_name)
    lexical_complexity(xml, budget)
    tree = parse_xml_tree(xml)
    document = next((node for node in tree["children"] if node["tag"].upper() == "DOCUMENT"), None)

    def document_text(name):
        values = [
            node for node in (document or {}).get("children", []) if node["tag"].upper() == name
        ]
        return (whitespace(decode_text(raw_text(values[0]))) or None) if len(values) == 1 else None

    context = {
        "sourceEntryName": entry_name,
        "documentName": document_text("DOCUMENT-NAME"),
        "companyName": document_text("COMPANY-NAME"),
    }
    tables, source_index = [], 0

    def visit(node: dict, path: list):
        nonlocal source_index
        next_path = path + ([node["tag"]] if node["tag"] else [])
        if node["tag"].upper() == "TABLE":
            index = source_index
            source_index += 1
            budget_add(budget, "tables", 1)
            source_rows = []
            for row_index, row_node in enumerate(descendants(node["children"], {"TR"}, {"TABLE"})):
                cells = []
                for column, cell in enumerate(
                    descendants(row_node["children"], {"TD", "TH", "TE", "TU"}, {"TR", "TABLE"})
                ):
                    raw = raw_text(cell)
                    text = whitespace(decode_text(raw))
                    attributes = cell["attributes"]
                    attribute_length = sum(len(k) + len(v) for k, v in attributes.items())
                    if attribute_length > 16384:
                        complexity("셀 속성 16384자 초과")
                    budget_add(budget, "sourceTextCharacters", len(text) + attribute_length)
                    cells.append(
                        {
                            "tag": cell["tag"].upper(),
                            "sourceRowIndex": row_index,
                            "sourceColumnIndex": column,
                            "text": text,
                            "rawText": raw,
                            "attributes": attributes,
                            "rowSpan": span(attributes, "ROWSPAN"),
                            "colSpan": span(attributes, "COLSPAN"),
                        }
                    )
                source_rows.append(cells)
            budget_add(budget, "rows", len(source_rows))
            budget_add(budget, "sourceCells", sum(map(len, source_rows)))
            if source_rows:
                grid: list[dict[int, dict[str, Any]]] = []
                carry: dict[int, tuple[dict[str, Any], int]] = {}
                width = 0
                for source_row in source_rows:
                    row = {}
                    for column, (cell, remaining) in sorted(carry.items()):
                        row[column] = cell
                        if remaining <= 1:
                            del carry[column]
                        else:
                            carry[column] = (cell, remaining - 1)
                    column = 0
                    for cell in source_row:
                        while column in row:
                            column += 1
                        if column + cell["colSpan"] > 4096:
                            complexity("표 열 4096개 초과")
                        for offset in range(cell["colSpan"]):
                            target = column + offset
                            if target in row:
                                raise OpenDartPayloadError(
                                    "겹치는 표 병합 셀을 안전하게 정렬할 수 없습니다.",
                                    "INVALID_TABLE_SPAN",
                                )
                            row[target] = cell
                            if cell["rowSpan"] > 1:
                                carry[target] = (cell, cell["rowSpan"] - 1)
                        column += cell["colSpan"]
                    width = max(width, max(row, default=-1) + 1)
                    if (
                        budget.get("expandedCells", 0) + width * (len(grid) + 1)
                        > LIMITS["expandedCells"]
                    ):
                        complexity("확장 셀 2000000개 초과")
                    budget_add(
                        budget,
                        "expandedTextCharacters",
                        sum(len(cell["text"]) for cell in row.values()),
                    )
                    grid.append(row)
                budget_add(budget, "expandedCells", width * len(grid))
                expanded_grid = [[row.get(column) for column in range(width)] for row in grid]
                captions = descendants(
                    node["children"], {"CAPTION", "TITLE", "TU"}, {"TR", "TABLE"}
                )
                caption = next(
                    (whitespace(raw_text(item)) for item in captions if whitespace(raw_text(item))),
                    None,
                )
                tables.append(
                    {
                        "index": index,
                        "sourceEntryName": entry_name,
                        "path": next_path,
                        "caption": caption,
                        "rows": [
                            [cell["text"] if cell else "" for cell in row] for row in expanded_grid
                        ],
                        "grid": expanded_grid,
                        "sourceRows": source_rows,
                    }
                )
        for child in node["children"]:
            visit(child, next_path)

    visit(tree, [])
    return {"tables": tables, "documentContext": context, "warnings": []}


def header_key(text: str) -> str:
    return re.sub(r"[*※]+\d*$", "", header(text))


def header_path(table: dict, start: int, end: int, column: int) -> list:
    result, previous = [], None
    for row in range(start, end + 1):
        cell = (
            table["grid"][row][column]
            if row < len(table["grid"]) and column < len(table["grid"][row])
            else None
        )
        source = (cell["sourceRowIndex"], cell["sourceColumnIndex"]) if cell else None
        text = (
            table["rows"][row][column]
            if row < len(table["rows"]) and column < len(table["rows"][row])
            else ""
        )
        if text and (source is None or source != previous):
            result.append(text)
        previous = source
    return result


def exact_leaf(key: str, name: str) -> bool:
    return key.startswith(name) and bool(
        re.fullmatch(r"(?:주식수|백만주|천주|주|%)?[0-9]*", key[len(name) :])
    )


def matches_header(path: list, alias: str) -> bool:
    parts, keys = [header_key(p) for p in alias.split(">")], [header_key(p) for p in path]
    if len(parts) > 1:
        index = 0
        for key in keys:
            if index < len(parts) and (
                exact_leaf(key, parts[index])
                if index == len(parts) - 1
                else key.startswith(parts[index])
            ):
                index += 1
        return index == len(parts)
    return any(
        exact_leaf(key, parts[0]) if parts[0] == "수량" else key.startswith(parts[0])
        for key in keys
    )


def locate_header(table: dict, aliases: dict, required: list) -> dict | None:
    best: dict[str, Any] | None = None
    for start in range(min(12, len(table["rows"]))):
        for end in range(start, min(start + 6, len(table["rows"]))):
            cells = table["sourceRows"][end]
            if any(cell["tag"] in ("TU", "TE") for cell in cells):
                break
            if end > start and not any(cell["tag"] == "TH" for cell in cells):
                break
            columns = {}
            for field, names in aliases.items():
                for name in names:
                    candidates = []
                    for column in range(len(table["rows"][end])):
                        path = header_path(table, start, end, column)
                        leaf = re.sub(r"\s", "", path[-1]) if path else ""
                        if field in ("quantity", "sharesAfter") and re.search(
                            r"금액|가격|단가|비율|%|[([{](?:억원|백만원|천원|원)[)\]}]", leaf
                        ):
                            continue
                        if matches_header(path, name):
                            candidates.append(column)
                    if len(candidates) == 1:
                        columns[field] = candidates[0]
                        break
            if not all(field in columns for field in required):
                continue
            if (
                not best
                or len(columns) > best["matchedFields"]
                or (
                    len(columns) == best["matchedFields"]
                    and start == best["headerStartRow"]
                    and end > best["headerEndRow"]
                    and any(cell["tag"] == "TH" for cell in cells)
                )
            ):
                best = {
                    "headerStartRow": start,
                    "headerEndRow": end,
                    "columns": columns,
                    "matchedFields": len(columns),
                }
        if best:
            break
    return best


def cell_at(row: list, columns: dict, field: str) -> str:
    column = columns.get(field)
    return whitespace(row[column]) if column is not None and column < len(row) else ""


def has_value(value: str) -> bool:
    return bool(value) and not bool(re.fullmatch(r"[-―—–\s]+", value))


def is_data_row(row: list) -> bool:
    first = header(next((v for v in row if has_value(v)), ""))
    return bool(first) and first not in ("합계", "총계", "소계", "계")


def provenance(table: dict, row: int, column: int, path: list | None = None) -> dict:
    cell = (
        table["grid"][row][column]
        if row < len(table["grid"]) and column < len(table["grid"][row])
        else None
    )
    return {
        "sourcePath": table["path"],
        "sourceEntryName": table["sourceEntryName"],
        "tableIndex": table["index"],
        "rowIndex": row,
        "columnIndex": column,
        "sourceRowIndex": cell["sourceRowIndex"] if cell else row,
        "sourceColumnIndex": cell["sourceColumnIndex"] if cell else column,
        "headerPath": path or [],
        "rawText": cell["rawText"] if cell else table["rows"][row][column],
    }


def row_provenance(table: dict, found: dict, row: int) -> dict:
    names = {
        "method": "methodRaw",
        "securityType": "securityTypeRaw",
        "startDate": "plannedStartDate",
        "endDate": "plannedEndDate",
    }
    return {
        names.get(field, field): provenance(
            table,
            row,
            column,
            header_path(table, found["headerStartRow"], found["headerEndRow"], column),
        )
        for field, column in found["columns"].items()
    }


def header_scale(table: dict, end: int, column: int | None, kind: str) -> dict:
    if column is None:
        return {"multiplier": 1, "unitRaw": None}
    raw = " ".join(row[column] if column < len(row) else "" for row in table["rows"][: end + 1])
    units = (
        [("백만주", 1000000), ("천주", 1000)]
        if kind == "SHARES"
        else [("억원", 100000000), ("백만원", 1000000), ("천원", 1000)]
    )
    for unit, multiplier in units:
        if unit in raw:
            return {"unitRaw": unit, "multiplier": multiplier}
    return {
        "multiplier": 1,
        "unitRaw": "원" if kind == "MONEY" and re.search(r"\(\s*원\s*\)", raw) else None,
    }


LABEL_ONLY_VALUES = {
    "보유비율",
    "보유주식등의수",
    "임원등기여부",
    "직위명",
    "한글",
    "한자영문",
    "주요주주",
}


def find_label(tables: list, labels: list) -> dict | None:
    for candidate in map(header_key, labels):
        for table in tables:
            for row_index, row in enumerate(table["rows"]):
                if any(re.search(r"업무상연락처|담당자", header_key(text)) for text in row):
                    continue
                for column in range(len(row) - 1):
                    if header_key(row[column]) != candidate:
                        continue
                    label = table["grid"][row_index][column]
                    if not label or label["sourceRowIndex"] != row_index:
                        continue
                    next_column = column + 1
                    while next_column < len(row) and table["grid"][row_index][next_column] is label:
                        next_column += 1
                    if next_column >= len(row):
                        continue
                    value_cell, value = (
                        table["grid"][row_index][next_column],
                        whitespace(row[next_column]),
                    )
                    if (
                        not value_cell
                        or value_cell["tag"] == "TH"
                        or not has_value(value)
                        or header_key(value) in LABEL_ONLY_VALUES
                        or header_key(value) == candidate
                    ):
                        continue
                    return {
                        "value": value,
                        "provenance": provenance(table, row_index, next_column, [row[column]]),
                    }
    return None


def find_summary(tables: list, aliases: list, row_labels: list) -> dict | None:
    for table in tables:
        for row_index, row in enumerate(table["rows"]):
            if not any(header_key(text) in row_labels for text in row):
                continue
            for column, value in enumerate(row):
                path = header_path(table, max(0, row_index - 4), row_index - 1, column)
                if not any(matches_header(path, alias) for alias in aliases):
                    continue
                cell = table["grid"][row_index][column]
                if (
                    cell
                    and cell["sourceRowIndex"] == row_index
                    and cell["tag"] != "TH"
                    and has_value(value)
                ):
                    return {
                        "value": value,
                        "provenance": provenance(table, row_index, column, path),
                    }
    return None


def summary_provenance(located: dict) -> dict:
    return {field: cell["provenance"] for field, cell in located.items() if cell}


def body_tables(tables: list) -> list:
    return [
        table for table in tables if not any(tag.upper() == "CORRECTION" for tag in table["path"])
    ]


def empty_warning(tables: list, headers: int, rows: int) -> dict:
    code = (
        "TABLE_NOT_FOUND"
        if not tables
        else "REQUIRED_HEADER_NOT_FOUND"
        if not headers
        else "NO_DATA_ROWS"
        if not rows
        else "ROWS_FOUND_BUT_INVALID"
    )
    return {
        "code": code,
        "message": {
            "TABLE_NOT_FOUND": "추출할 표가 없습니다.",
            "REQUIRED_HEADER_NOT_FOUND": "필수 거래 표 헤더를 찾지 못했습니다.",
            "NO_DATA_ROWS": "거래 표에 실제 데이터 행이 없습니다.",
            "ROWS_FOUND_BUT_INVALID": "데이터 행은 있으나 유효한 필수 거래값을 추출하지 못했습니다.",
        }[code],
    }


def required_warnings(quantity: str | None, method: str, table: int, row: int) -> list:
    result = []
    if quantity is None:
        result.append(
            {
                "code": "MISSING_REQUIRED_QUANTITY",
                "message": "필수 변동 수량이 없거나 유효한 숫자가 아닙니다.",
                "field": "quantity",
                "tableIndex": table,
                "rowIndex": row,
            }
        )
    if not has_value(method):
        result.append(
            {
                "code": "MISSING_REQUIRED_METHOD",
                "message": "필수 변동 방법이 없습니다.",
                "field": "methodRaw",
                "tableIndex": table,
                "rowIndex": row,
            }
        )
    return result
