"""Bounded source table extraction and confirmed, auditable document differences."""

from __future__ import annotations

import re
from collections import defaultdict
from decimal import Decimal, localcontext
from uuid import NAMESPACE_URL, uuid5

from lxml import etree

from ..core import sha256
from ..disclosures.tables import canonicalize_tables
from ..disclosures.xml_archive import normalize_xml, read_archive
from .facts import decimal_value, valid_date
from .validation import finding, number, rendered

VERSION = "analysis-tables-v1"


def local_name(element):
    return str(element.tag).rsplit("}", 1)[-1].rsplit(":", 1)[-1].lower()


def element_text(element):
    return " ".join(" ".join(element.itertext()).split())


def inline_contexts(root):
    contexts, units = {}, {}
    for node in root.iter():
        name = local_name(node)
        if name == "context" and node.get("id"):
            values = {local_name(n): element_text(n) for n in node.iter()}
            contexts[node.get("id")] = {
                "entityId": values.get("identifier"),
                "periodStart": valid_date(values.get("startdate")),
                "periodEnd": valid_date(values.get("enddate") or values.get("instant")),
                "dimensions": any(
                    local_name(n) in ("explicitmember", "typedmember", "segment", "scenario")
                    for n in node.iter()
                ),
            }
        elif name == "unit" and node.get("id"):
            measures = [
                element_text(n).rsplit(":", 1)[-1]
                for n in node.iter()
                if local_name(n) == "measure"
            ]
            if len(measures) == 1 and re.fullmatch(r"[A-Z]{3}", measures[0]):
                units[node.get("id")] = measures[0]
    return contexts, units


def inline_fact(node, contexts, units):
    attrs = {str(k).lower(): v for k, v in node.attrib.items()}
    context = contexts.get(attrs.get("contextref"))
    currency = units.get(attrs.get("unitref"))
    tag = attrs.get("name", "")
    if not context or not currency or not tag or attrs.get("continuedat"):
        return None
    raw = element_text(node)
    transform = attrs.get("format", "").rsplit(":", 1)[-1].lower()
    if transform not in (
        "",
        "num-dot-decimal",
        "numdotdecimal",
        "numcommadecimal",
        "num-comma-decimal",
    ):
        return None
    value = decimal_value(
        raw.replace(".", "").replace(",", ".")
        if transform in ("numcommadecimal", "num-comma-decimal")
        else raw
    )
    if value is None or not re.fullmatch(r"-?\d{1,2}", attrs.get("scale", "0")):
        return None
    scale = int(attrs.get("scale", "0"))
    if not -18 <= scale <= 18 or attrs.get("sign", "") not in ("", "-"):
        return None
    with localcontext() as ctx:
        ctx.prec = 150
        result = Decimal(value) * (Decimal(10) ** scale)
        if attrs.get("sign") == "-":
            result = -result
    return {
        **context,
        "accountId": tag,
        "currency": currency,
        "value": rendered(result),
        "rawValue": raw,
        "scale": scale,
        "precision": attrs.get("decimals"),
    }


def safe_html(content):
    # HTML5 doctype is harmless. Entity declarations and external subsets are not accepted.
    if re.search(rb"<!\s*ENTITY\b|<!\s*DOCTYPE[^>]*(?:SYSTEM|PUBLIC|\[)", content, re.IGNORECASE):
        raise ValueError("Unsafe HTML declaration")
    root = etree.fromstring(
        content, etree.HTMLParser(no_network=True, remove_comments=True, huge_tree=False)
    )
    if root is None:
        raise ValueError("Invalid HTML")
    nodes = list(root.iter())
    if len(nodes) > 200000:
        raise ValueError("HTML node limit exceeded")
    for node in nodes:
        if len(list(node.iterancestors())) > 128:
            raise ValueError("HTML depth limit exceeded")
    contexts, units = inline_contexts(root)
    heading = None
    distance = 0
    for node in nodes:
        distance += 1
        name = local_name(node)
        if name in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "b", "strong") and not any(
            local_name(c) == "table" for c in node.iterdescendants()
        ):
            text = element_text(node)
            if 5 <= len(text) <= 300:
                if re.search(
                    r"(?:consolidated|separate|parent.company).*?(?:balance.sheet|statement|financial.position)|(?:연결|별도).*재무",
                    text,
                    re.IGNORECASE,
                ):
                    heading, distance = text, 0
                elif name.startswith("h"):
                    heading = None
        if (
            name == "table"
            and heading
            and distance < 100
            and not any(local_name(c) == "caption" for c in node)
        ):
            caption = etree.Element("caption")
            caption.text = heading
            node.insert(0, caption)
    inline = {}
    for index, cell in enumerate(root.iter()):
        if local_name(cell) not in ("td", "th"):
            continue
        key = str(index)
        cell.set("data-analysis-cell", key)
        candidates = [
            inline_fact(n, contexts, units) for n in cell.iter() if local_name(n) == "nonfraction"
        ]
        candidates = [c for c in candidates if c is not None]
        if len(candidates) == 1:
            inline[key] = candidates[0]
    for node in reversed(nodes):
        name = local_name(node)
        if name in (
            "script",
            "style",
            "iframe",
            "object",
            "embed",
            "svg",
            "math",
            "header",
            "resources",
            "hidden",
            "context",
            "unit",
            "link",
            "meta",
        ):
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)
            continue
        node.tag = name
        attrs = {
            k: v
            for k, v in node.attrib.items()
            if k.lower() in ("rowspan", "colspan", "data-analysis-cell")
        }
        node.attrib.clear()
        node.attrib.update(attrs)
    return etree.tostring(root, encoding="unicode", method="xml"), inline


def narrative_notes(xml, document_key):
    root = etree.fromstring(
        xml.encode(),
        etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False),
    )
    notes: list[dict] = []
    heading = "본문"
    paragraphs: list[str] = []
    serial = 0

    def flush():
        nonlocal paragraphs, serial
        if paragraphs:
            text = "\n".join(paragraphs)
            # Bound snippets without silently treating a truncated section as a complete note.
            for start in range(0, len(text), 30000):
                notes.append(
                    {
                        "key": f"{document_key}:text:{serial}",
                        "title": heading,
                        "text": text[start : start + 30000],
                        "tableIds": [],
                    }
                )
                serial += 1
            paragraphs = []

    for node in root.iter():
        if any(local_name(p) == "table" for p in node.iterancestors()):
            continue
        name = local_name(node)
        if name in ("title", "h1", "h2", "h3", "h4", "h5", "h6"):
            flush()
            heading = element_text(node)[:500] or "본문"
        elif name in ("p", "div") and not any(
            local_name(c) in ("p", "div", "table") for c in node.iterdescendants()
        ):
            text = element_text(node)
            if text:
                paragraphs.append(text)
    flush()
    return notes[:2000]


def extract_document_tables(content: bytes, *, media_type="application/zip", max_tables=300):
    if len(content) > 50 * 1024**2:
        raise ValueError("Document size exceeded")
    inline = {}
    if media_type in ("text/html", "application/xhtml+xml"):
        xml, inline = safe_html(content)
        candidates = [{"xml": xml, "entryName": "document.html", "sha256": sha256(content)}]
    elif media_type == "application/zip":
        candidates = read_archive(content)["xmlCandidates"]
    elif media_type in ("application/xml", "text/xml"):
        xml = content.decode("utf-8-sig", errors="strict")
        candidates = [{"xml": xml, "entryName": "document.xml", "sha256": sha256(content)}]
    else:
        raise ValueError("Unsupported document media type")
    tables: list[dict] = []
    notes: list[dict] = []
    audits: list[dict] = []
    inline_facts: list[dict] = []
    budget: dict[str, int] = {}
    for candidate in candidates:
        if media_type in ("text/html", "application/xhtml+xml"):
            normalized = {
                "xml": candidate["xml"],
                "audit": {"source": "HTML_SAFE_TEXT", "sha256": sha256(content)},
            }
        else:
            normalized = normalize_xml(
                candidate["xml"], candidate["entryName"], candidate["sha256"]
            )
        audits.append(normalized["audit"])
        canonical = canonicalize_tables(normalized["xml"], candidate["entryName"], budget)
        document_key = sha256(content)[:24] + ":" + sha256(candidate["entryName"])[:12]
        notes.extend(narrative_notes(normalized["xml"], document_key))
        for table in canonical["tables"]:
            if len(tables) >= max_tables:
                raise ValueError("Document table count exceeded")
            identity = document_key + ":" + str(table["index"])
            title = table["caption"] or " / ".join(table["rows"][0])[:300] or "표"
            section = " / ".join(table["path"])
            # Scope evidence must be inside this table, not an unrelated page heading.
            scope_text = " ".join(" ".join(row) for row in table["rows"][:8]) + " " + title
            consolidated = bool(re.search(r"\bconsolidated\b|연결", scope_text, re.IGNORECASE))
            separate = bool(
                re.search(r"\bseparate\b|\bparent.company.only\b|별도", scope_text, re.IGNORECASE)
            )
            cells = []
            for ri, row in enumerate(table["grid"]):
                for ci, cell in enumerate(row):
                    if not cell or cell["sourceRowIndex"] != ri or (ci > 0 and row[ci - 1] is cell):
                        continue
                    item = {
                        "row": ri,
                        "column": ci,
                        "text": cell["text"],
                        "rowSpan": cell["rowSpan"],
                        "colSpan": cell["colSpan"],
                        "value": decimal_value(cell["text"]),
                        "isHeader": cell["tag"] == "TH",
                    }
                    contextual = inline.get(cell["attributes"].get("data-analysis-cell"))
                    if contextual:
                        contextual = {
                            **contextual,
                            "consolidated": consolidated and not separate,
                            "scope": "CFS"
                            if consolidated and not separate
                            else "OFS"
                            if separate and not consolidated
                            else "UNKNOWN",
                        }
                        item["sourceFact"] = contextual
                        inline_facts.append(
                            {**contextual, "tableId": identity, "row": ri, "column": ci}
                        )
                    cells.append(item)
            tables.append(
                {
                    "id": identity,
                    "title": title,
                    "section": section,
                    "cells": cells,
                    "rowCount": len(table["rows"]),
                    "columnCount": max(map(len, table["rows"]), default=0),
                    "sourceEntryName": candidate["entryName"],
                    "sourceRows": table["sourceRows"],
                }
            )
            notes.append(
                {
                    "key": identity,
                    "title": title,
                    "text": "\n".join("\t".join(row) for row in table["rows"]),
                    "tableIds": [identity],
                }
            )
    if len(notes) > 2000:
        raise ValueError("Document note count exceeded")
    return {
        "tables": tables,
        "notes": notes,
        "inlineFacts": inline_facts,
        "normalizationAudits": audits,
        "parserVersion": VERSION,
    }


def link_document_facts(tables, facts):
    """Attach only a unique, same-context Inline XBRL fact; never match by number alone."""
    validations = []
    for table in tables:
        for cell in table["cells"]:
            cell.pop("factId", None)
            source = cell.get("sourceFact")
            if not source or source.get("dimensions") or source.get("scope") == "UNKNOWN":
                continue
            candidates = [
                f
                for f in facts
                if f.get("status") == "AVAILABLE"
                and all(
                    f.get(k) == source.get(k)
                    for k in ("accountId", "periodStart", "periodEnd", "currency", "scope")
                )
            ]
            if len(candidates) != 1:
                continue
            fact = candidates[0]
            cell["factId"] = fact["id"]
            left, right = number(fact.get("value")), number(source.get("value"))
            status = (
                "UNAVAILABLE"
                if left is None or right is None
                else "PASS"
                if left == right
                else "REVIEW"
            )
            result = finding(
                "SOURCE_TABLE_MATCH",
                [fact],
                status,
                "동일 계정·기간·통화·연결 범위의 원문 값을 대조했습니다.",
                f"{fact.get('value')} = {source.get('value')}",
                "0",
            )
            result["id"] = str(
                uuid5(
                    NAMESPACE_URL, result["id"] + table["id"] + f":{cell['row']}:{cell['column']}"
                )
            )
            result["tableId"], result["row"], result["column"] = (
                table["id"],
                cell["row"],
                cell["column"],
            )
            validations.append(result)
    return validations


def difference(kind, label, before, after, **extra):
    result = {"kind": kind, "label": label, "before": before, "after": after, **extra}
    left, right = decimal_value(before), decimal_value(after)
    if left is not None and right is not None:
        with localcontext() as context:
            context.prec = 300
            delta = Decimal(right) - Decimal(left)
            result.update(
                difference=format(delta, "f"),
                percent=format(delta / abs(Decimal(left)) * 100, ".6f")
                if Decimal(left) > 0
                else None,
            )
    return result


def diff_document_tables(before, after, *, confirmed):
    if not confirmed:
        return {
            "status": "WAITING",
            "differences": [difference("REVIEW", "정정 관계 확인 필요", None, None)],
        }
    groups = []
    for document in (before, after):
        found = defaultdict(list)
        for table in document.get("tables", []):
            found[(table["title"], table.get("section", ""))].append(table)
        groups.append(found)
    differences = []
    for key in sorted(set(groups[0]) | set(groups[1])):
        left, right = groups[0].get(key, []), groups[1].get(key, [])
        if len(left) > 1 or len(right) > 1:
            differences.append(difference("REVIEW", key[0] + " · 중복 표 대응 검토", None, None))
            continue
        if not left or not right:
            table = (left or right)[0]
            differences.append(
                difference(
                    "REMOVED" if left else "ADDED",
                    table["title"],
                    table["title"] if left else None,
                    table["title"] if right else None,
                    **{"beforeTableId" if left else "afterTableId": table["id"]},
                )
            )
            continue
        a, b = left[0], right[0]
        headers_a = [(c["row"], c["column"], c["text"]) for c in a["cells"] if c.get("isHeader")]
        headers_b = [(c["row"], c["column"], c["text"]) for c in b["cells"] if c.get("isHeader")]
        if headers_a != headers_b:
            differences.append(
                difference(
                    "REVIEW",
                    key[0] + " · 열 머리글·단위·기간 대응 확인 필요",
                    str(headers_a),
                    str(headers_b),
                    beforeTableId=a["id"],
                    afterTableId=b["id"],
                )
            )
            continue

        # A row label anchors a row across reordering. Duplicate/empty labels are not guessed.
        def rows(table):
            result = defaultdict(list)
            for ri in range(table["rowCount"]):
                cells = sorted(
                    (c for c in table["cells"] if c["row"] == ri), key=lambda c: c["column"]
                )
                result[cells[0]["text"] if cells else ""].append(cells)
            return result

        ar, br = rows(a), rows(b)
        for label in sorted(set(ar) | set(br)):
            old, new = ar.get(label, []), br.get(label, [])
            coords = {"beforeTableId": a["id"], "afterTableId": b["id"]}
            if not label or len(old) > 1 or len(new) > 1:
                differences.append(
                    difference("REVIEW", label or "행 대응 확인 필요", None, None, **coords)
                )
                continue
            if not old or not new:
                differences.append(
                    difference(
                        "REMOVED" if old else "ADDED",
                        label,
                        " | ".join(c["text"] for c in old[0]) if old else None,
                        " | ".join(c["text"] for c in new[0]) if new else None,
                        **coords,
                    )
                )
                continue
            ac = {c["column"]: c for c in old[0]}
            bc = {c["column"]: c for c in new[0]}
            for col in sorted(set(ac) | set(bc)):
                av, bv = ac.get(col, {}).get("text"), bc.get(col, {}).get("text")
                atag = ac.get(col, {}).get("sourceFact", {}).get("accountId")
                btag = bc.get(col, {}).get("sourceFact", {}).get("accountId")
                if atag and btag and atag != btag:
                    differences.append(
                        difference("CLASSIFICATION", label + " · XBRL 계정", atag, btag, **coords)
                    )
                if av == bv:
                    continue
                kind = (
                    "VALUE"
                    if decimal_value(av) is not None and decimal_value(bv) is not None
                    else "TEXT"
                )
                if any("단위" in str(value) for value in (av, bv)):
                    kind = "UNIT"
                elif all(valid_date(value) for value in (av, bv)):
                    kind = "DATE"
                differences.append(
                    difference(kind, label, av, bv, row=new[0][0]["row"], column=col, **coords)
                )
    # Narrative sections use unique titles; repeated titles are explicitly ambiguous.
    note_groups = []
    for document in (before, after):
        notes = defaultdict(list)
        for note in document.get("notes", []):
            if not note.get("tableIds"):
                notes[note.get("title", "")].append(note)
        note_groups.append(notes)
    for title in sorted(set(note_groups[0]) | set(note_groups[1])):
        old, new = note_groups[0].get(title, []), note_groups[1].get(title, [])
        if not title or len(old) > 1 or len(new) > 1:
            differences.append(difference("REVIEW", title + " · 본문 대응 확인 필요", None, None))
            continue
        left, right = old[0] if old else {}, new[0] if new else {}
        av, bv = left.get("text"), right.get("text")
        if av != bv:
            differences.append(
                difference(
                    "TEXT" if old and new else "REMOVED" if old else "ADDED",
                    title,
                    av,
                    bv,
                    beforeNoteKey=left.get("key"),
                    afterNoteKey=right.get("key"),
                )
            )
    return {
        "status": "PARTIAL" if any(d["kind"] == "REVIEW" for d in differences) else "COMPLETE",
        "differences": differences,
    }
