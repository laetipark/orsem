"""Native OpenDART disclosure parser public API."""

from __future__ import annotations

from .extractors import extract_trading
from .narrative import extract_d003, extract_d004
from .primitives import NORMALIZER_VERSION, PARSER_VERSION, OpenDartPayloadError, warning
from .tables import canonicalize_tables
from .xml_archive import normalize_xml, read_archive, root_cause


def parse_disclosure(
    archive_bytes: bytes,
    detail_type: str,
    parser_version: str = PARSER_VERSION,
    limits: dict | None = None,
) -> dict:
    if detail_type not in ("D001", "D002", "D003", "D004", "D005"):
        raise OpenDartPayloadError(
            f"지원하지 않는 OpenDART 상세유형입니다: {detail_type}", "UNSUPPORTED_DETAIL_TYPE"
        )
    archive = read_archive(archive_bytes, limits)
    selected = None
    aggregate_warnings, audits, candidate_errors = [], [], []
    budget: dict[str, int] = {}
    for candidate in archive["xmlCandidates"]:
        normalization = None
        try:
            normalized = normalize_xml(
                candidate["xml"], candidate["entryName"], candidate["sha256"]
            )
            normalization = normalized["audit"]
            audits.append(normalization)
            canonical = canonicalize_tables(normalized["xml"], candidate["entryName"], budget)
            extractor = (
                extract_d003
                if detail_type == "D003"
                else extract_d004
                if detail_type == "D004"
                else lambda tables, context: extract_trading(tables, detail_type, context)
            )
            extraction = extractor(canonical["tables"], canonical["documentContext"])
            if extraction["score"] == 0:
                aggregate_warnings.append(
                    warning(
                        "NO_RECOGNIZED_DISCLOSURE_TABLE",
                        "지원하는 표 헤더나 요약 필드를 찾지 못했습니다.",
                        entryName=candidate["entryName"],
                    )
                )
            item = {
                "entryName": candidate["entryName"],
                "tables": canonical["tables"],
                "extraction": extraction,
                "warnings": canonical["warnings"],
            }
            if (
                selected is None
                or extraction["score"] > selected["extraction"]["score"]
                or extraction["score"] == selected["extraction"]["score"]
                and candidate["entryName"] < selected["entryName"]
            ):
                selected = item
        except Exception as exc:
            normalization = getattr(exc, "normalizationAudit", None) or normalization
            if normalization and normalization not in audits:
                audits.append(normalization)
            original = normalization.get("originalValidation") if normalization else None
            message = original.get("message") if original else str(exc)
            candidate_errors.append(
                {
                    "candidateName": candidate["entryName"],
                    "candidateSha256": candidate["sha256"],
                    "errorCode": getattr(exc, "code", "CANDIDATE_EXTRACTION_FAILED"),
                    "rootCause": root_cause(message),
                    **{
                        key: original[key]
                        for key in ("line", "column")
                        if original and key in original
                    },
                    "originalMessage": message,
                    "repairAttempted": bool(
                        normalization and normalization["status"] != "UNCHANGED"
                    ),
                    "repairCodes": list(
                        dict.fromkeys(item["code"] for item in normalization["repairs"])
                    )
                    if normalization
                    else [],
                    **({"normalizationAudit": normalization} if normalization else {}),
                }
            )
            code = getattr(exc, "code", "")
            if code.startswith("FORBIDDEN_XML_") or code in (
                "XML_COMPLEXITY_LIMIT",
                "XML_NORMALIZATION_LIMIT",
            ):
                raise OpenDartPayloadError(
                    str(exc), code, candidateErrors=candidate_errors
                ) from exc
            aggregate_warnings.append(
                warning("XML_CANDIDATE_REJECTED", str(exc), entryName=candidate["entryName"])
            )
            if normalization and normalization["status"] == "REVIEW_REQUIRED":
                aggregate_warnings.append(
                    warning(
                        "XML_NORMALIZATION_REVIEW_REQUIRED",
                        "XML 호환 보정이 모호하거나 검증에 실패한 후보가 있어 검토가 필요합니다.",
                        entryName=candidate["entryName"],
                    )
                )
    if selected is None:
        raise OpenDartPayloadError(
            "해석 가능한 XML 후보가 없습니다.", "NO_PARSEABLE_XML", candidateErrors=candidate_errors
        )
    result = {key: value for key, value in selected["extraction"].items() if key != "score"}
    return {
        **result,
        "detailType": detail_type,
        "parserVersion": parser_version,
        "source": {
            "archiveSha256": archive["archiveSha256"],
            "archiveByteLength": archive["archiveByteLength"],
            "selectedEntryName": selected["entryName"],
            "candidateEntries": [c["entryName"] for c in archive["xmlCandidates"]],
            "normalizerVersion": NORMALIZER_VERSION,
            "normalizationAudits": audits,
            "candidateErrors": candidate_errors,
        },
        "warnings": aggregate_warnings + selected["warnings"] + result["warnings"],
        "tablesScanned": len(selected["tables"]),
    }
