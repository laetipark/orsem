"""Bounded archive extraction and auditable, narrowly scoped DART XML repairs."""

from __future__ import annotations

import hashlib
import html
import io
import re
import zipfile
from bisect import bisect_right
from collections import Counter
from typing import Any, NoReturn
from xml.dom import minidom
from xml.parsers.expat import ExpatError

from .primitives import NORMALIZER_VERSION, OpenDartApiError, OpenDartPayloadError

ARCHIVE_LIMITS = {
    "maxArchiveBytes": 50 * 1024**2,
    "maxEntries": 200,
    "maxEntryBytes": 50 * 1024**2,
    "maxTotalUncompressedBytes": 250 * 1024**2,
}
TEXT_ELEMENTS = {"TITLE", "P", "TD", "TE", "TU", "TH", "SPAN", "COVER-TITLE", "IMG-CAPTION"}
DART_ELEMENTS = {
    "DOCUMENT",
    "DOCUMENT-NAME",
    "FORMULA-VERSION",
    "COMPANY-NAME",
    "BODY",
    "COVER",
    "COVER-TITLE",
    "TABLE",
    "COLGROUP",
    "COL",
    "TBODY",
    "TR",
    "TD",
    "P",
    "PGBRK",
    "SECTION-1",
    "SECTION-2",
    "SECTION-3",
    "SECTION-4",
    "SECTION-5",
    "TITLE",
    "TABLE-GROUP",
    "TE",
    "TU",
    "LIBRARY",
    "THEAD",
    "TH",
    "SPAN",
    "IMAGE",
    "IMG",
    "IMG-CAPTION",
    "SUMMARY",
    "EXTRACTION",
    "CORRECTION",
    "BR",
    "B",
    "I",
    "U",
    "SUP",
    "SUB",
}
XML_NAME = re.compile(r"[:_\w][:_\w.\-·]*", re.UNICODE)
ENTITY = re.compile(r"&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);")


def sha256(value: bytes | str) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def assert_safe_xml(xml: str, entry_name: str = "payload") -> None:
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", xml, re.IGNORECASE):
        raise OpenDartPayloadError(
            f"DTD 또는 ENTITY 선언이 포함된 XML은 처리하지 않습니다: {entry_name}",
            "FORBIDDEN_XML_DECLARATION",
        )
    if re.search(
        r"""\bxmlns(?::[A-Za-z_][\w.-]*)?\s*=\s*(['"])https?://www\.w3\.org/2001/XInclude\1""",
        xml,
        re.IGNORECASE,
    ) or re.search(r"</?xi:(?:include|fallback)\b", xml, re.IGNORECASE):
        raise OpenDartPayloadError("XInclude은 처리하지 않습니다.", "FORBIDDEN_XML_INCLUDE")
    if re.search(r"<\?(?!xml(?:\s|\?>))", xml, re.IGNORECASE):
        raise OpenDartPayloadError(
            "XML 선언 외의 처리 명령은 허용하지 않습니다.", "FORBIDDEN_XML_PROCESSING_INSTRUCTION"
        )


def assert_safe_entry_name(name: str) -> None:
    if len(name) > 4096:
        raise OpenDartPayloadError(
            "ZIP 엔트리 이름이 4096자를 초과했습니다.", "ZIP_ENTRY_NAME_TOO_LONG"
        )
    if (
        not name
        or "\0" in name
        or name.startswith(("/", "\\"))
        or re.match(r"^[A-Za-z]:[\\/]", name)
        or ".." in name.replace("\\", "/").split("/")
    ):
        raise OpenDartPayloadError(
            f"안전하지 않은 ZIP 엔트리 경로입니다: {name}", "ZIP_PATH_TRAVERSAL"
        )


def has_zip_magic(value: bytes) -> bool:
    return value[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")


def decode_xml(value: bytes, name: str) -> str:
    encoding = None
    if value.startswith(b"\xef\xbb\xbf"):
        encoding = "utf-8-sig"
    elif value.startswith((b"\xff\xfe", b"<\x00?\x00")):
        encoding = "utf-16le"
    elif value.startswith((b"\xfe\xff", b"\x00<\x00?")):
        encoding = "utf-16be"
    else:
        declaration = re.search(
            r"""<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']""",
            value[:512].decode("latin1"),
            re.IGNORECASE,
        )
        if declaration:
            key = declaration[1].strip().lower().replace("_", "-")
            encoding = {
                "utf8": "utf-8",
                "utf-8": "utf-8",
                "utf-16": "utf-16le",
                "utf-16le": "utf-16le",
                "utf-16be": "utf-16be",
                "euc-kr": "euc-kr",
                "cp949": "cp949",
                "ks-c-5601-1987": "cp949",
                "ksc5601": "cp949",
            }.get(key)
            if encoding is None:
                raise OpenDartPayloadError(
                    f"지원하지 않는 XML 인코딩({declaration[1]})입니다: {name}",
                    "UNSUPPORTED_XML_ENCODING",
                )
    try:
        xml = value.decode(encoding or "utf-8", errors="strict").lstrip("\ufeff")
    except (UnicodeError, LookupError) as exc:
        raise OpenDartPayloadError(
            f"XML을 안전하게 디코딩할 수 없습니다: {name}", "INVALID_XML_ENCODING"
        ) from exc
    if "\ufffd" in xml:
        raise OpenDartPayloadError(
            f"XML 디코딩 중 대체 문자가 발생했습니다: {name}", "INVALID_XML_ENCODING"
        )
    assert_safe_xml(xml, name)
    return xml


def read_archive(value: bytes, limits: dict | None = None, operation: str = "DOCUMENT") -> dict:
    bounds = {**ARCHIVE_LIMITS, **(limits or {})}
    for key, bound in bounds.items():
        if type(bound) is not int or not 0 < bound <= ARCHIVE_LIMITS.get(key, 0):
            raise OpenDartPayloadError(
                f"잘못된 아카이브 제한값입니다: {key}", "INVALID_ARCHIVE_LIMIT"
            )
    if not value:
        raise OpenDartPayloadError("빈 OpenDART 응답입니다.", "EMPTY_PAYLOAD")
    if len(value) > bounds["maxArchiveBytes"]:
        raise OpenDartPayloadError("아카이브가 허용 크기를 초과했습니다.", "ARCHIVE_TOO_LARGE")
    if not has_zip_magic(value):
        xml = decode_xml(value, "OpenDART API response")
        status = re.search(r"<status(?:\s[^>]*)?>([\s\S]*?)</status>", xml, re.IGNORECASE)
        message = re.search(r"<message(?:\s[^>]*)?>([\s\S]*?)</message>", xml, re.IGNORECASE)
        if status:
            raise OpenDartApiError(
                html.unescape(status[1]).strip(),
                html.unescape(message[1] if message else "OpenDART 오류 응답").strip(),
                operation,
            )
        raise OpenDartPayloadError("OpenDART 응답이 ZIP도 오류 XML도 아닙니다.", "UNKNOWN_PAYLOAD")
    candidates, total = [], 0
    try:
        with zipfile.ZipFile(io.BytesIO(value)) as archive:
            entries = archive.infolist()
            if len(entries) > bounds["maxEntries"]:
                raise OpenDartPayloadError(
                    "ZIP 엔트리 수가 제한을 초과했습니다.", "ZIP_TOO_MANY_ENTRIES"
                )
            for entry in entries:
                # ZipInfo truncates NUL in filename; inspect original filename as well.
                assert_safe_entry_name(entry.orig_filename)
                if entry.is_dir():
                    continue
                if entry.file_size > bounds["maxEntryBytes"]:
                    raise OpenDartPayloadError(
                        "ZIP 엔트리가 허용 크기를 초과했습니다.", "ZIP_ENTRY_TOO_LARGE"
                    )
                if total + entry.file_size > bounds["maxTotalUncompressedBytes"]:
                    raise OpenDartPayloadError(
                        "ZIP 전체 압축해제 크기가 제한을 초과했습니다.", "ZIP_TOTAL_TOO_LARGE"
                    )
                if entry.file_size and (
                    not entry.compress_size or entry.file_size / entry.compress_size > 200
                ):
                    raise OpenDartPayloadError(
                        "ZIP 엔트리 압축률이 200:1 제한을 초과했습니다.",
                        "ZIP_COMPRESSION_RATIO_LIMIT",
                    )
                with archive.open(entry) as stream:
                    content = stream.read(bounds["maxEntryBytes"] + 1)
                if len(content) > bounds["maxEntryBytes"]:
                    raise OpenDartPayloadError(
                        "ZIP 엔트리가 허용 크기를 초과했습니다.", "ZIP_ENTRY_TOO_LARGE"
                    )
                total += len(content)
                if total > bounds["maxTotalUncompressedBytes"]:
                    raise OpenDartPayloadError(
                        "ZIP 전체 압축해제 크기가 제한을 초과했습니다.", "ZIP_TOTAL_TOO_LARGE"
                    )
                if entry.filename.lower().endswith(".zip") or has_zip_magic(content):
                    raise OpenDartPayloadError("중첩 ZIP은 처리하지 않습니다.", "NESTED_ZIP")
                if entry.filename.lower().endswith(".xml") or re.match(
                    r"^\ufeff?\s*<", content[:256].decode("utf-8", errors="replace")
                ):
                    candidates.append(
                        {
                            "entryName": entry.filename,
                            "byteLength": len(content),
                            "sha256": sha256(content),
                            "xml": decode_xml(content, entry.filename),
                        }
                    )
    except (zipfile.BadZipFile, RuntimeError, OSError, NotImplementedError) as exc:
        raise OpenDartPayloadError("ZIP을 읽을 수 없습니다.", "INVALID_ZIP") from exc
    if not candidates:
        raise OpenDartPayloadError("아카이브에 XML 후보가 없습니다.", "XML_CANDIDATE_NOT_FOUND")
    return {
        "archiveSha256": sha256(value),
        "archiveByteLength": len(value),
        "entriesSeen": len(entries),
        "totalUncompressedBytes": total,
        "xmlCandidates": sorted(candidates, key=lambda item: item["entryName"]),
    }


def lexical_complexity(
    xml: str, budget: dict | None = None, max_depth: int = 128, max_nodes: int = 250000
) -> None:
    cursor = depth = nodes = 0
    while cursor < len(xml):
        start = xml.find("<", cursor)
        if start < 0:
            break
        special = next(
            (
                (prefix, end)
                for prefix, end in (("<!--", "-->"), ("<![CDATA[", "]]>"), ("<?", "?>"))
                if xml.startswith(prefix, start)
            ),
            None,
        )
        if special:
            end = xml.find(special[1], start + len(special[0]))
            if end < 0:
                return
            cursor = end + len(special[1])
            continue
        position, quote = start + 1, None
        while position < len(xml):
            char = xml[position]
            if quote:
                if char == quote:
                    quote = None
            elif char in ('"', "'"):
                quote = char
            elif char == ">":
                break
            position += 1
        if position >= len(xml):
            return
        token = xml[start + 1 : position].strip()
        if token and not token.startswith("!"):
            if token.startswith("/"):
                depth = max(0, depth - 1)
            else:
                nodes += 1
                if not token.endswith("/"):
                    depth += 1
                if depth > max_depth or nodes > max_nodes:
                    raise OpenDartPayloadError(
                        "XML 표 구조가 안전 처리 한도를 초과했습니다.", "XML_COMPLEXITY_LIMIT"
                    )
        cursor = position + 1
    if budget is not None:
        budget["nodes"] = budget.get("nodes", 0) + nodes
        if budget["nodes"] > max_nodes:
            raise OpenDartPayloadError(
                "XML 누적 노드가 안전 처리 한도를 초과했습니다.", "XML_COMPLEXITY_LIMIT"
            )


def literal_entity_copy(xml: str) -> tuple[str, dict[str, str], str | None]:
    """Keep undeclared named references literal, as the deployed DART reader does.

    Only the parser's temporary input uses collision-free text markers. No DTD is
    introduced or resolved, and callers retain the original source and its hash.
    """
    pattern = re.compile(r"&([A-Za-z_:][\w.:-]*);")
    names = {
        match[0]
        for match in pattern.finditer(xml)
        if match[1] not in {"amp", "lt", "gt", "quot", "apos"}
    }
    if not names:
        return xml, {}, None
    characters = set(xml)
    marker = next(
        (chr(point) for point in range(0xE000, 0xF900) if chr(point) not in characters), None
    )
    if marker is None:
        marker = "__ORSEM_XML_" + sha256(xml) + "_"
        while marker in xml:
            marker += "_"
    replacements = {name: f"{marker}{index:x}{marker}" for index, name in enumerate(sorted(names))}
    return (
        pattern.sub(lambda match: replacements.get(match[0], match[0]), xml),
        {value: key for key, value in replacements.items()},
        marker,
    )


def validation_issue(xml: str) -> dict | None:
    try:
        protected, _, _marker = literal_entity_copy(xml)
        document = minidom.parseString(protected)
        document.unlink()
        return None
    except ExpatError as exc:
        return {
            "code": "InvalidXml",
            "message": str(exc),
            "line": exc.lineno,
            "column": exc.offset + 1,
        }


def normalize_xml(
    xml: str, candidate_name: str = "payload", candidate_sha256: str | None = None
) -> dict:
    original_bytes = len(xml.encode())
    if original_bytes > 50 * 1024**2:
        raise OpenDartPayloadError(
            "XML 사본이 크기 한도를 초과했습니다.", "XML_NORMALIZATION_LIMIT"
        )
    assert_safe_xml(xml, candidate_name)
    lexical_complexity(xml)
    original_validation = validation_issue(xml)
    repairs: list[dict[str, Any]] = []
    replacements: list[tuple[int, str]] = []
    counts: Counter = Counter(
        {"BARE_AMPERSAND": 0, "LITERAL_ANGLE_BRACKET": 0, "ATTRIBUTE_QUOTE": 0}
    )
    line_starts = [0] + [i + 1 for i, char in enumerate(xml) if char == "\n"]
    repaired_source_bytes = 0

    def audit(status: str, normalized: str | None, validation: dict | None = None) -> dict:
        return {
            "candidateName": candidate_name,
            **({"candidateSha256": candidate_sha256} if candidate_sha256 else {}),
            "normalizerVersion": NORMALIZER_VERSION,
            "originalXmlSha256": sha256(xml),
            "normalizedXmlSha256": sha256(normalized) if normalized is not None else None,
            "originalBytes": original_bytes,
            "normalizedBytes": len(normalized.encode()) if normalized is not None else None,
            "status": status,
            "repairs": list(repairs),
            "repairCounts": dict(counts),
            "repairedSourceBytes": repaired_source_bytes,
            "repairedByteRatio": repaired_source_bytes / max(1, original_bytes),
            "originalValidation": original_validation,
            "normalizedValidation": validation,
        }

    def fail(message: str, code: str = "XML_NORMALIZATION_AMBIGUOUS") -> NoReturn:
        raise OpenDartPayloadError(message, code, normalizationAudit=audit("REVIEW_REQUIRED", None))

    def repair(offset: int, replacement: str, code: str) -> None:
        nonlocal repaired_source_bytes
        if original_validation is None:
            fail("유효한 XML을 변경하려는 정규화를 중단했습니다.")
        if len(repairs) >= 2048:
            fail("XML 보정 횟수가 한도를 초과했습니다.", "XML_NORMALIZATION_LIMIT")
        size = len(xml[offset].encode())
        repaired_source_bytes += size
        line = bisect_right(line_starts, offset)
        # Public provenance offsets retain the original JavaScript UTF-16 convention.
        utf16_start = len(xml[:offset].encode("utf-16le")) // 2
        repairs.append(
            {
                "code": code,
                "startOffset": utf16_start,
                "endOffset": utf16_start + len(xml[offset].encode("utf-16le")) // 2,
                "line": line,
                "column": len(xml[line_starts[line - 1] : offset].encode("utf-16le")) // 2 + 1,
                "originalBytes": size,
                "replacementBytes": len(replacement.encode()),
            }
        )
        replacements.append((offset, replacement))
        counts[code] += 1

    def ampersand(offset: int) -> None:
        if xml[offset] != "&" or ENTITY.match(xml, offset):
            return
        if re.match(r"&[A-Za-z_:][\w.:-]*;", xml[offset : offset + 128]):
            if original_validation:
                fail("선언되지 않은 이름 엔티티의 의미를 추정하지 않습니다.")
            return
        if original_validation:
            repair(offset, "&amp;", "BARE_AMPERSAND")

    closing_names = set(re.findall(r"</([:_\w][:_\w.\-·]*)\s*>", xml))
    stack: list[str] = []
    cursor = 0
    while cursor < len(xml):
        char = xml[cursor]
        if char == "&":
            ampersand(cursor)
            cursor += 1
            continue
        if char != "<":
            cursor += 1
            continue
        special = next(
            (
                (prefix, end)
                for prefix, end in (("<!--", "-->"), ("<![CDATA[", "]]>"), ("<?xml", "?>"))
                if xml.startswith(prefix, cursor)
            ),
            None,
        )
        if special:
            end = xml.find(special[1], cursor + len(special[0]))
            if end < 0:
                fail("종료되지 않은 XML 주석·CDATA·선언입니다.")
            cursor = end + len(special[1])
            continue
        if xml.startswith(("<!", "<?"), cursor):
            fail("허용하지 않는 XML 선언입니다.", "FORBIDDEN_XML_DECLARATION")
        if xml.startswith("</", cursor):
            match = XML_NAME.match(xml, cursor + 2)
            name = match[0] if match else None
            end = xml.find(">", cursor + 2)
            if (
                not name
                or end < 0
                or xml[cursor + 2 + len(name) : end].strip()
                or not stack
                or stack.pop() != name
            ):
                fail("실제 요소의 닫는 태그가 맞지 않아 XML 구조를 복구하지 않습니다.")
            cursor = end + 1
            continue
        match = XML_NAME.match(xml, cursor + 1)
        name = match[0] if match else None
        element = (name or "").upper()
        token_end = xml.find(">", cursor + 1)
        if (
            original_validation
            and stack
            and stack[-1].upper() in TEXT_ELEMENTS
            and element not in DART_ELEMENTS
            and (not name or name not in closing_names)
        ):
            token = xml[cursor + 1 : token_end] if token_end >= 0 else ""
            if (
                0 < len(token) <= 512
                and not re.search(r"[<>\r\n=]", token)
                and re.match(r"(?:\s*)[가-힣\d]|\s+[A-Za-z]|[IVX]+\.", token)
            ):
                repair(cursor, "&lt;", "LITERAL_ANGLE_BRACKET")
                for offset in range(cursor + 1, token_end):
                    ampersand(offset)
                repair(token_end, "&gt;", "LITERAL_ANGLE_BRACKET")
                cursor = token_end + 1
                continue
        if not name:
            fail("구조인지 본문인지 구분할 수 없는 꺾쇠 표현입니다.")
        position = cursor + 1 + len(name)
        attributes: set[str] = set()
        self_closing = closed = False
        while position < len(xml):
            whitespace_start = position
            while position < len(xml) and xml[position].isspace():
                position += 1
            if xml.startswith(">", position) or xml.startswith("/>", position):
                self_closing = xml.startswith("/>", position)
                position += 2 if self_closing else 1
                closed = True
                break
            if position == whitespace_start:
                fail("속성 경계를 구분할 공백이 없습니다.")
            attribute_match = XML_NAME.match(xml, position)
            attribute = attribute_match[0] if attribute_match else None
            if not attribute or attribute in attributes:
                fail("모호하거나 중복된 XML 속성입니다.")
            attributes.add(attribute)
            if len(attributes) > 128:
                fail("XML 요소의 속성 수가 한도를 초과했습니다.", "XML_NORMALIZATION_LIMIT")
            position += len(attribute)
            while position < len(xml) and xml[position].isspace():
                position += 1
            if not xml.startswith("=", position):
                fail("값이 없는 XML 속성의 의미는 추정하지 않습니다.")
            position += 1
            while position < len(xml) and xml[position].isspace():
                position += 1
            quote = xml[position] if position < len(xml) else ""
            if quote not in ('"', "'"):
                fail("따옴표 없는 속성값은 추정하지 않습니다.")
            position += 1
            value_closed = False
            while position < len(xml):
                character = xml[position]
                if character == quote:
                    rest = xml[position + 1 :]
                    boundary = re.match(r"\s*(?:/?>)|\s+[:_\w][:_\w.\-·]*\s*=", rest)
                    if original_validation is None or boundary:
                        position += 1
                        value_closed = True
                        break
                    if quote != '"' or f"{element}:{attribute.upper()}" != "TD:ENG":
                        fail("알려진 본문 주석 이외의 속성 따옴표는 자동 보정하지 않습니다.")
                    repair(position, "&quot;", "ATTRIBUTE_QUOTE")
                elif character == "<":
                    if not original_validation:
                        fail("유효한 XML의 속성값 안에 잘못된 꺾쇠가 있습니다.")
                    repair(position, "&lt;", "LITERAL_ANGLE_BRACKET")
                elif character == "&":
                    ampersand(position)
                position += 1
            if not value_closed:
                fail("닫히지 않은 XML 속성값입니다.")
        if not closed:
            fail("닫히지 않은 XML 시작 태그입니다.")
        if not self_closing:
            stack.append(name)
        cursor = position
    if stack:
        fail("닫히지 않은 실제 XML 요소가 남았습니다.")
    if repaired_source_bytes / max(1, original_bytes) > 0.05:
        fail("보정된 원문 바이트 비율이 한도를 초과했습니다.", "XML_NORMALIZATION_LIMIT")
    if original_validation is None:
        return {"xml": xml, "audit": audit("UNCHANGED", xml)}
    pieces: list[str] = []
    last = 0
    for offset, replacement in replacements:
        pieces.extend((xml[last:offset], replacement))
        last = offset + 1
    pieces.append(xml[last:])
    normalized = "".join(pieces)
    if len(normalized.encode()) > 50 * 1024**2:
        fail("정규화 사본이 XML 크기 한도를 초과했습니다.", "XML_NORMALIZATION_LIMIT")
    assert_safe_xml(normalized, candidate_name)
    lexical_complexity(normalized)
    issue = validation_issue(normalized)
    if issue:
        raise OpenDartPayloadError(
            f"XML 호환 보정 후에도 엄격한 문법 검증을 통과하지 못했습니다: {issue['message']}",
            "INVALID_XML",
            normalizationAudit=audit("REVIEW_REQUIRED", normalized, issue),
        )
    return {"xml": normalized, "audit": audit("NORMALIZED", normalized)}


def root_cause(message: str) -> str:
    for pattern, code in (
        (r"char '&' is not expected|entity|ampersand", "BARE_AMPERSAND"),
        (r"attribute|quote", "ATTRIBUTE_QUOTE"),
        (r"invalid name|invalid tag name", "INVALID_TAG_NAME"),
        (r"closing tag|angle bracket|mismatched tag", "LITERAL_ANGLE_BRACKET"),
    ):
        if re.search(pattern, message, re.IGNORECASE):
            return code
    return "OTHER_XML"


def merge_candidate_errors(errors: list | None = None, audits: list | None = None) -> list:
    merged: dict[tuple[str, str | None], dict[str, Any]] = {}
    for error in errors or []:
        merged.setdefault((error["candidateName"], error.get("candidateSha256")), error)
    for audit in audits or []:
        key = (audit["candidateName"], audit.get("candidateSha256"))
        original = audit.get("originalValidation")
        if (
            key in merged
            or audit["status"] != "NORMALIZED"
            or not original
            or audit.get("normalizedValidation") is not None
            or not audit.get("normalizedXmlSha256")
        ):
            continue
        repair_codes = list(dict.fromkeys(item["code"] for item in audit["repairs"]))
        cause = root_cause(original["message"])
        if cause != "INVALID_TAG_NAME" and cause not in repair_codes:
            cause = repair_codes[0] if repair_codes else cause
        merged[key] = {
            "candidateName": audit["candidateName"],
            **(
                {"candidateSha256": audit["candidateSha256"]}
                if audit.get("candidateSha256")
                else {}
            ),
            "errorCode": "XML_NORMALIZED",
            "rootCause": cause,
            **{k: original[k] for k in ("line", "column") if k in original},
            "originalMessage": original["message"],
            "repairAttempted": True,
            "repairCodes": repair_codes,
            "normalizationAudit": audit,
            "recovered": True,
        }
    return list(merged.values())
