"""Canonical filing classification and immutable parse reuse identity."""

from __future__ import annotations

import re
import unicodedata

from ..core import json_text, sha256
from .primitives import OpenDartPayloadError

TYPES = ("D001", "D002", "D003", "D004", "D005")
CLASSIFIER_VERSION = "opendart-title-v2"
EVENT_TYPES = dict(
    zip(
        TYPES,
        ("LARGE_HOLDER", "INSIDER_OWNERSHIP", "PROXY_SOLICITATION", "TENDER_OFFER", "TRADE_PLAN"),
    )
)


def document_kind(name: str) -> str:
    title = re.sub(r"\s", "", unicodedata.normalize("NFKC", name))
    return (
        "RESULT"
        if "공개매수결과보고서" in title
        else "EXPLANATION"
        if "공개매수설명서" in title
        else "REPORT"
        if "공개매수신고서" in title or "의결권대리행사권유참고서류" in title
        else "OTHER"
    )


def classify_filing(
    report_name: str,
    source_detail_type: str | None = None,
    query_detail_type: str | None = None,
    manual_canonical_type: str | None = None,
) -> dict:
    normalized = re.sub(r"[\s·ㆍ\u119e.]", "", unicodedata.normalize("NFKC", report_name))
    detected = [
        detail
        for detail, family in zip(
            TYPES,
            (
                "주식등의대량보유상황보고서",
                "임원주요주주특정증권등소유상황보고서",
                "의결권대리행사권유",
                "공개매수",
                "임원주요주주특정증권등거래계획보고서",
            ),
        )
        if family in normalized
    ]
    title_type = detected[0] if len(detected) == 1 else None
    source = (source_detail_type or "").strip() or None
    known = source if source in TYPES else None
    manual = (manual_canonical_type or "").strip() or None
    canonical = manual or title_type or known
    status = (
        "MANUAL_OVERRIDE"
        if manual
        else "CONFLICT"
        if len(detected) > 1 or title_type and known and title_type != known
        else "UNKNOWN"
        if not canonical
        else "UNSUPPORTED"
        if canonical not in TYPES
        else "CONFIRMED"
    )
    return {
        "sourceDetailType": source,
        "titleDetectedType": title_type,
        "canonicalType": canonical,
        "classificationStatus": status,
        "classifierVersion": CLASSIFIER_VERSION,
        "classificationProvenanceJson": {
            "reportName": report_name,
            "normalizedTitle": normalized,
            "matchedTypes": detected,
            "sourceDetailType": source,
            "queryDetailType": query_detail_type,
            "manualCanonicalType": manual,
            "queryTypeUsedAsCanonical": False,
            "documentKind": document_kind(report_name),
        },
    }


def update_classification(
    filing: dict, report_name: str, query_detail_type: str | None = None
) -> dict:
    prior = filing.get("classificationProvenanceJson")
    manual = filing.get("classificationStatus") == "MANUAL_OVERRIDE"
    classification = classify_filing(
        report_name,
        filing.get("sourceDetailType"),
        query_detail_type,
        filing.get("canonicalType") if manual else None,
    )
    filing.update(classification)
    if manual and prior:
        filing["classificationProvenanceJson"] = {
            **prior,
            **classification["classificationProvenanceJson"],
        }
    if can_process(filing):
        filing["detailType"] = filing["canonicalType"]
    return filing


def can_process(filing: dict) -> bool:
    return filing.get("canonicalType") in TYPES and filing.get("classificationStatus") in (
        "CONFIRMED",
        "MANUAL_OVERRIDE",
    )


def submission(report_name: str, remarks: str) -> dict:
    text = unicodedata.normalize("NFKC", f"{report_name} {remarks}")
    if "철회" in text:
        return {"submissionKind": "WITHDRAWAL", "effectiveState": "WITHDRAWN"}
    if "취소" in text:
        return {"submissionKind": "CORRECTION", "effectiveState": "CANCELLED"}
    return {
        "submissionKind": "ATTACHMENT_CORRECTION"
        if re.search(r"첨부.*정정", text)
        else "CORRECTION"
        if "정정" in text
        else "INITIAL",
        "effectiveState": "ACTIVE",
    }


def canonical_report_name(value: str) -> str:
    return re.sub(
        r"\s+",
        "",
        re.sub(r"\[(?:기재|첨부)?정정\]|\(정정\)|정정", "", unicodedata.normalize("NFKC", value)),
    ).strip()


def should_deliver(filing: dict) -> bool:
    return filing["effectiveState"] == "ACTIVE" or bool(
        re.search(
            r"취소|철회",
            unicodedata.normalize("NFKC", f"{filing['reportName']} {filing.get('rm') or ''}"),
        )
    )


def source_review(detail_type: str) -> bool:
    return detail_type in ("D003", "D004")


def crosscheck_allows_projection(detail_type: str, crosscheck: dict, receipt: str) -> bool:
    if source_review(detail_type):
        return (
            crosscheck.get("status") == "NOT_APPLICABLE"
            and crosscheck.get("reason") == f"NO_SUMMARY_API_FOR_{detail_type}"
        )
    if detail_type == "D005":
        return crosscheck.get("status") == "NOT_APPLICABLE"
    return (
        detail_type in ("D001", "D002")
        and crosscheck.get("status") == "OK"
        and isinstance(crosscheck.get("exactReceiptMatches"), list)
        and any(
            isinstance(row, dict) and row.get("rcept_no") == receipt
            for row in crosscheck["exactReceiptMatches"]
        )
    )


def reuse_fingerprint(
    raw_sha256: str,
    parser_version: str,
    normalizer_version: str,
    classifier_version: str,
    extractor_type: str,
    kind: str = "OTHER",
) -> str:
    return sha256(
        json_text(
            [
                raw_sha256,
                parser_version,
                normalizer_version,
                classifier_version,
                extractor_type,
                kind,
            ]
        )
    )


def assert_type_invariant(filing: dict, run: dict, result_type: str | None = None) -> None:
    result_type = result_type if result_type is not None else run.get("resultType")
    if not can_process(filing) or not (
        filing.get("canonicalType")
        == run.get("inputType")
        == run.get("extractorType")
        == run.get("resultType")
        == result_type
    ):
        raise OpenDartPayloadError(
            "Canonical filing, parse input, extractor and result types must agree before projection or notification.",
            "FILING_TYPE_INVARIANT",
        )
