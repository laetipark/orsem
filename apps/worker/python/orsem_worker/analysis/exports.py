"""Streaming XLSX output with exact text values and no executable formulas."""

from __future__ import annotations

import io
import re


def clean(value):
    text = "" if value is None else str(value)
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", "", text)[:32767]


def build_xlsx(sheets: dict[str, list[list[object]]]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.cell import WriteOnlyCell

    if not 1 <= len(sheets) <= 100:
        raise ValueError("Export sheet count exceeded")
    workbook = Workbook(write_only=True)
    total = 0
    names = set()
    for number, (name, rows) in enumerate(sheets.items(), 1):
        name = re.sub(r"[\\/*?:\[\]]", "_", clean(name)).strip("'")[:31] or f"Sheet{number}"
        if name.casefold() in names:
            name = name[:24] + f"_{number}"
        names.add(name.casefold())
        if len(rows) > 100000:
            raise ValueError("Export row count exceeded")
        sheet = workbook.create_sheet(name)
        for row in rows:
            if len(row) > 512:
                raise ValueError("Export column count exceeded")
            cells = []
            for value in row:
                text = clean(value)
                total += len(text)
                if total > 30_000_000:
                    raise ValueError("Export text size exceeded")
                cell = WriteOnlyCell(sheet, value=text)
                cell.data_type = "s"
                cells.append(cell)
            sheet.append(cells)
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()
