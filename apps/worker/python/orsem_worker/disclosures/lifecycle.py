"""Parse quality gates, persisted-audit validation and current-review lifecycle."""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, NoReturn

from ..constants import Direction, TransactionNature
from ..core import json_text, utcnow
from .policy import TYPES, document_kind, source_review
from .primitives import OpenDartPayloadError, date_only, fits_decimal
from .storage import insert, one, save, select

REJECTED_WARNINGS = {
    "TABLE_NOT_FOUND",
    "REQUIRED_HEADER_NOT_FOUND",
    "NO_DATA_ROWS",
    "ROWS_FOUND_BUT_INVALID",
    "HEADER_SELECTED_AS_VALUE",
    "MISSING_REQUIRED_QUANTITY",
    "INVALID_INTEGER",
    "INVALID_DECIMAL",
    "INVALID_SHARE_UNIT",
    "INVALID_DATE",
    "NUMERIC_OUT_OF_RANGE",
    "NUMERIC_SCALE_EXCEEDED",
    "AMBIGUOUS_DISCLOSURE_SUMMARY",
    "MISSING_AGENDAS",
    "MISSING_DISCLOSURE_FIELD",
    "INVALID_MEETING_TIME",
    "DISCLOSURE_DATE_CONFLICT",
    "INVALID_DATE_RANGE",
    "UNRECOGNIZED_TENDER_DOCUMENT_KIND",
    "INVALID_TENDER_QUANTITY_RANGE",
    "MISSING_TENDER_SECURITIES",
}


def numeric(value: str | None) -> str | None:
    if not value:
        return None
    normalized = re.sub(r"[,%\s]", "", value).removeprefix("+")
    return (
        normalized
        if re.fullmatch(r"-?\d+(?:\.\d+)?", normalized) and fits_decimal(normalized)
        else None
    )


def confidence_of(parsed: dict) -> float:
    kind = parsed["detailType"]
    if kind == "D002":
        row_confidence = min((row["confidence"] for row in parsed["transactions"]), default=0)
    elif kind == "D005":
        row_confidence = min(
            (0.25 if row["nature"] == "UNKNOWN" else 0.9 for row in parsed["planItems"]), default=0
        )
    elif kind == "D001":
        row_confidence = 0.95 if parsed["nonTradingReport"] else 0.8 if parsed["changes"] else 0.5
    else:
        row_confidence = parsed["confidence"]
    return min(parsed.get("confidence", 1), row_confidence)


def warnings_of(parsed: dict) -> list:
    rows = parsed.get("transactions", parsed.get("planItems", parsed.get("changes", [])))
    unique = {}
    for item in parsed["warnings"] + [w for row in rows for w in row["warnings"]]:
        key = ":".join(
            str(item.get(k, "")) for k in ("code", "entryName", "tableIndex", "rowIndex", "field")
        )
        unique[key] = item
    return list(unique.values())


def warning_requires_review(warning: dict) -> bool:
    return warning["code"] not in ("NO_RECOGNIZED_DISCLOSURE_TABLE", "XML_CANDIDATE_REJECTED")


def validation_status(status: str, warnings: list) -> str:
    return (
        "REJECTED"
        if any(warning["code"] in REJECTED_WARNINGS for warning in warnings)
        else "PASSED"
        if status == "SUCCEEDED"
        else "REVIEW_REQUIRED"
    )


def assert_source_invariant(run: dict, parsed: dict) -> None:
    if (
        source_review(parsed["detailType"])
        and parsed["source"]["archiveSha256"] != run["rawSha256"]
    ):
        raise OpenDartPayloadError(
            "The parsed audit source does not match its immutable parse run source.",
            "PARSE_SOURCE_SHA_INVARIANT",
        )


def assert_document_kind(filing: dict, parsed: dict) -> None:
    if parsed["detailType"] == "D004" and parsed["documentKind"] != document_kind(
        filing["reportName"]
    ):
        raise OpenDartPayloadError(
            "The parsed tender document kind does not match its filing title.",
            "FILING_DOCUMENT_KIND_INVARIANT",
        )


def text_warnings(parsed: dict) -> list:
    warnings = []

    def inspect(value, maximum, field, row_index=None):
        if value and len(value) > maximum:
            warnings.append(
                {
                    "code": "PROJECTION_TEXT_TRUNCATED",
                    "message": f"{field} 원문이 DB projection 한도 {maximum}자를 초과해 표시값만 잘랐습니다. 전체 값은 원문 ZIP과 parse audit에 보존됩니다.",
                    "field": field,
                    **({"rowIndex": row_index} if row_index is not None else {}),
                }
            )

    if "reporterName" in parsed:
        inspect(parsed["reporterName"], 255, "reporterName")
    if parsed["detailType"] in ("D002", "D005"):
        for field in ("relationshipRaw", "positionRaw"):
            inspect(parsed[field], 255, field)
        for row in parsed.get("transactions", parsed.get("planItems", [])):
            for field in ("securityTypeRaw", "methodRaw"):
                inspect(row[field], 500, field, row["rowIndex"])
    elif parsed["detailType"] == "D001":
        for row in parsed["changes"]:
            inspect(row["methodRaw"], 500, "methodRaw", row["rowIndex"])
    return warnings


def validate_persisted(parsed: Any) -> dict:
    """Validate the existing passthrough audit contract without stripping provenance."""

    def fail() -> NoReturn:
        raise OpenDartPayloadError(
            "Invalid persisted parse audit.", "INVALID_PERSISTED_PARSE_AUDIT"
        )

    def text(value, maximum=16384, nullable=True):
        if value is None and nullable:
            return
        if not isinstance(value, str) or len(value) > maximum:
            fail()

    def integer(value, maximum=None):
        if type(value) is not int or value < 0 or maximum is not None and value > maximum:
            fail()

    def number(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
            fail()

    def numeric_field(value):
        if value is not None and (
            not isinstance(value, str)
            or not re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d{1,6})?", value)
            or numeric(value) != value
        ):
            fail()

    def date_field(value):
        if value is not None and (
            not isinstance(value, str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
            or date_only(value) != value
        ):
            fail()

    def warnings(value, maximum):
        if not isinstance(value, list) or len(value) > maximum:
            fail()
        for item in value:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("code"), str)
                or not 1 <= len(item["code"]) <= 128
            ):
                fail()
            text(item.get("message"), 20000, False)
            for key, text_limit in (("entryName", 4096), ("field", 128)):
                if key in item:
                    text(item[key], text_limit, False)
            for key in ("tableIndex", "rowIndex"):
                if key in item:
                    integer(item[key])

    try:
        if not isinstance(parsed, dict) or parsed.get("detailType") not in TYPES:
            fail()
        text(parsed["parserVersion"], 64, False)
        if not parsed["parserVersion"]:
            fail()
        source = parsed["source"]
        if not re.fullmatch(r"[0-9a-f]{64}", source["archiveSha256"]):
            fail()
        integer(source["archiveByteLength"], 50 * 1024**2)
        text(source["selectedEntryName"], 4096)
        if (
            not isinstance(source["candidateEntries"], list)
            or len(source["candidateEntries"]) > 200
        ):
            fail()
        for item in source["candidateEntries"]:
            text(item, 4096, False)
        integer(parsed["tablesScanned"], 2000)
        warnings(parsed["warnings"], 500000)
        kind = parsed["detailType"]
        texts = {
            "D001": ["reportTypeRaw", "reporterName", "reportReasonRaw"],
            "D002": ["reporterName", "relationshipRaw", "positionRaw"],
            "D005": ["reporterName", "relationshipRaw", "positionRaw"],
            "D003": [
                "solicitorName",
                "targetCompanyName",
                "relationshipRaw",
                "meetingTimeRaw",
                "meetingLocation",
                "purposeRaw",
            ],
            "D004": ["offerorName", "targetCompanyName", "purposeRaw", "conditionsRaw"],
        }[kind]
        for key in texts:
            text(parsed[key])
        for key in {
            "D001": [],
            "D002": [],
            "D005": [],
            "D003": ["meetingDate", "solicitationStartDate", "solicitationEndDate"],
            "D004": ["subscriptionStartDate", "subscriptionEndDate", "settlementDate"],
        }[kind]:
            date_field(parsed[key])
        if kind == "D001":
            if (
                parsed["reportReasonKind"]
                not in ("HOLDINGS_CHANGE", "CONTRACT_CHANGE", "REPORTING_STATUS_CHANGE", "UNKNOWN")
                or type(parsed["nonTradingReport"]) is not bool
            ):
                fail()
            for key in ("sharesAfter", "sharesChange", "ownershipRateAfter", "ownershipRateChange"):
                numeric_field(parsed[key])
            if "confidence" in parsed:
                number(parsed["confidence"])
        if kind in ("D003", "D004"):
            number(parsed["confidence"])
        if kind == "D003":
            if (
                parsed["electronicVoting"] is not None
                and type(parsed["electronicVoting"]) is not bool
            ):
                fail()
            if parsed["meetingAt"] is not None:
                instant = datetime.fromisoformat(parsed["meetingAt"])
                if instant.tzinfo is None:
                    fail()
        if kind == "D004" and parsed["documentKind"] not in (
            "REPORT",
            "EXPLANATION",
            "RESULT",
            "OTHER",
        ):
            fail()
        rows = parsed[
            {
                "D001": "changes",
                "D002": "transactions",
                "D003": "agendas",
                "D004": "securities",
                "D005": "planItems",
            }[kind]
        ]
        if not isinstance(rows, list) or len(rows) > (
            10000 if kind in ("D003", "D004") else 100000
        ):
            fail()
        for row in rows:
            integer(row["ordinal" if kind == "D003" else "rowIndex"])
            if kind == "D003":
                text(row["title"], nullable=False)
                continue
            text(row["securityTypeRaw"], nullable=False)
            if kind != "D004":
                text(row["methodRaw"], nullable=False)
                if row["direction"] not in Direction:
                    fail()
                warnings(row["warnings"], 32)
            fields = (
                ["quantity"]
                if kind == "D001"
                else ["quantity", "unitPrice", "amount", "sharesAfter"]
                if kind == "D002"
                else ["quantity", "priceMin", "priceMax"]
                if kind == "D005"
                else [
                    "unitPrice",
                    "minQuantity",
                    "maxQuantity",
                    "heldQuantity",
                    "expectedHoldingsMin",
                    "expectedHoldingsMax",
                    "offeredQuantity",
                    "acquiredQuantity",
                    "actualAmount",
                ]
            )
            for field in fields:
                numeric_field(row[field])
            if kind in ("D001", "D002"):
                date_field(row["eventDate"])
            if kind == "D005":
                date_field(row["plannedStartDate"])
                date_field(row["plannedEndDate"])
            if kind in ("D002", "D005") and row["nature"] not in TransactionNature:
                fail()
            if kind == "D002":
                text(row["quantityUnitRaw"])
                text(row["currency"])
                number(row["confidence"])
                if row["amountSource"] not in ("CALCULATED", None):
                    fail()
            if kind == "D004":
                text(row["currency"])
    except (KeyError, TypeError, ValueError, AttributeError):
        fail()
    return parsed


@asynccontextmanager
async def company_lock(db, company_id: str):
    name = f"orsem:company:{company_id}"
    async with db.connection() as connection:
        result = await connection.fetch_one("SELECT GET_LOCK(:name,30) AS acquired", {"name": name})
        if not result or int(result.get("acquired") or 0) != 1:
            raise RuntimeError("Timed out acquiring the filing projection lock.")
        try:
            yield
        finally:
            await connection.fetch_one("SELECT RELEASE_LOCK(:name) AS released", {"name": name})


async def update_review_lifecycle(
    tx, filing_id: str, run_id: str, reason: str, needs_review: bool
) -> None:
    newest = await one(
        tx, "parse_runs", "filing_id=:id", {"id": filing_id}, order="created_at DESC,id DESC"
    )
    if newest and newest["id"] != run_id:
        return
    reviews = [
        row
        for row in await select(
            tx,
            "reviews",
            "subject_type='FILING' AND subject_id=:id",
            {"id": filing_id},
            "ORDER BY created_at DESC,id DESC",
        )
        if row.get("reviewGroup") == "PARSE" or row["dedupeKey"].startswith("parse:")
    ]
    current = next((row for row in reviews if row["dedupeKey"] == "parse:" + run_id), None)
    now = utcnow()
    if not current:
        current = await insert(
            tx,
            "reviews",
            {
                "subjectType": "FILING",
                "subjectId": filing_id,
                "dedupeKey": "parse:" + run_id,
                "reviewGroup": "PARSE",
                "parseRunId": run_id,
                "supersededByReviewId": None,
                "reopenedFromReviewId": reviews[0]["id"] if reviews else None,
                "reason": reason,
                "status": "RESOLVED",
                "classificationResult": "REVIEW_REQUIRED" if needs_review else "RULE_CONFIRMED",
                "resolution": None,
                "resolvedByAdminId": None,
                "resolvedAt": None,
            },
        )
    for previous in reviews:
        if previous["id"] == current["id"] or previous["status"] != "OPEN":
            continue
        previous.update(
            {
                "status": "SUPERSEDED",
                "supersededByReviewId": current["id"],
                "reviewGroup": "PARSE",
                "resolution": json_text(
                    {"resolution": "SUPERSEDED_BY_PARSE", "parseRunId": run_id}
                ),
                "resolvedAt": now,
            }
        )
        await save(tx, "reviews", previous)
    if current.get("resolvedByAdminId"):
        return
    current.update(
        {
            "reviewGroup": "PARSE",
            "parseRunId": run_id,
            "reason": reason,
            "status": "OPEN" if needs_review else "RESOLVED",
            "classificationResult": "REVIEW_REQUIRED" if needs_review else "RULE_CONFIRMED",
            "resolution": None
            if needs_review
            else json_text({"resolution": "AUTOMATIC_RECHECK_SUCCEEDED"}),
            "resolvedAt": None if needs_review else now,
        }
    )
    await save(tx, "reviews", current)


async def dismiss_review(tx, filing_id: str, key: str, resolution: str, resolved_at) -> None:
    review = await one(
        tx,
        "reviews",
        "subject_type='FILING' AND subject_id=:id AND dedupe_key=:key AND status='OPEN'",
        {"id": filing_id, "key": key},
    )
    if review:
        review.update(
            {
                "status": "DISMISSED",
                "resolution": json_text({"resolution": resolution}),
                "resolvedByAdminId": None,
                "resolvedAt": resolved_at,
            }
        )
        await save(tx, "reviews", review)
