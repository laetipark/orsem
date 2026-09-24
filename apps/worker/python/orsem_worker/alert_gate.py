"""Read-only active-filing eligibility, shared by fan-out and final push delivery."""

from __future__ import annotations

import re

from .core import as_instant, utcnow
from .storage import one, select

FILING_ALERT_INELIGIBLE = (
    "Filing classification or active parse no longer matches the queued alert."
)
EVENT_TYPES = {
    "D001": "LARGE_HOLDER",
    "D002": "INSIDER_OWNERSHIP",
    "D003": "PROXY_SOLICITATION",
    "D004": "TENDER_OFFER",
    "D005": "TRADE_PLAN",
}


def text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def source_review_confirmed(run, now=None):
    if not run:
        return False
    review = (run.get("resultJson") or {}).get("sourceReview")
    if not isinstance(review, dict):
        return False
    at = review.get("confirmedAt")
    if not (
        review.get("parseRunId") == run["id"]
        and review.get("rawSha256") == run["rawSha256"]
        and re.fullmatch(r"[a-f0-9]{64}", run["rawSha256"], re.IGNORECASE)
        and re.fullmatch(
            r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
            str(review.get("confirmedByAdminId", "")),
            re.IGNORECASE,
        )
        and isinstance(at, str)
        and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", at)
    ):
        return False
    try:
        return as_instant(at) <= (as_instant(now) if now else utcnow())
    except ValueError:
        return False


async def alert_filing_context(db, alert):
    event = (
        await one(db, "event_clusters", "id=:id", {"id": alert["eventClusterId"]})
        if alert.get("eventClusterId")
        else None
    )
    memberships = (
        await select(
            db,
            "event_cluster_items",
            "event_cluster_id=:id AND item_type='FILING'",
            {"id": event["id"]},
            "ORDER BY is_primary DESC",
        )
        if event
        else []
    )
    payload = alert.get("payloadJson") or {}
    filing_id, receipt = text(payload.get("filingId")), text(payload.get("rceptNo"))
    filing = (
        await one(db, "filings", "id=:id", {"id": filing_id})
        if filing_id
        else await one(db, "filings", "rcept_no=:id", {"id": receipt})
        if receipt
        else await one(db, "filings", "id=:id", {"id": memberships[0]["itemId"]})
        if memberships
        else None
    )
    return event, memberships, filing


async def filing_alert_is_eligible(db, alert):
    from .disclosures.policy import classify_filing

    if alert["status"] == "CANCELLED":
        return False
    event, memberships, filing = await alert_filing_context(db, alert)
    if (alert.get("eventClusterId") and not event) or (
        event and event["state"] in ("CANCELLED", "SUPERSEDED")
    ):
        return False
    payload = alert.get("payloadJson") or {}
    receipt = text(payload.get("rceptNo"))
    if not memberships and not text(payload.get("filingId")) and not receipt:
        return True
    if not filing or (receipt and filing["rceptNo"] != receipt):
        return False
    if event and not any(item["itemId"] == filing["id"] for item in memberships):
        return False
    if filing["source"] != "OPENDART":
        return True
    if event and (event.get("metadataJson") or {}).get("suppressAlerts") is True:
        return False
    kind = filing.get("canonicalType")
    classification = classify_filing(
        filing["reportName"],
        filing.get("sourceDetailType"),
        manual_canonical_type=kind if filing["classificationStatus"] == "MANUAL_OVERRIDE" else None,
    )
    if (
        kind not in EVENT_TYPES
        or filing["classificationStatus"] not in ("CONFIRMED", "MANUAL_OVERRIDE")
        or classification["classificationStatus"] not in ("CONFIRMED", "MANUAL_OVERRIDE")
        or classification["canonicalType"] != kind
        or payload.get("detailType") != kind
    ):
        return False
    if event and event["canonicalEventType"] not in (EVENT_TYPES[kind], "CORRECTION"):
        return False
    if payload.get("phase") != "PARSED" or not filing.get("activeParseRunId"):
        return False
    match = re.search(r":parsed:([a-f0-9-]{36}):", alert["idempotencyKey"])
    run_id = text(payload.get("parseRunId")) or (match[1] if match else None)
    if not run_id or run_id != filing["activeParseRunId"]:
        return False
    run = await one(db, "parse_runs", "id=:id", {"id": run_id})
    if not run:
        return False
    result = run.get("resultJson") or {}
    parsed, crosscheck = result.get("parsed"), result.get("crosscheck") or {}
    result_type = parsed.get("detailType") if isinstance(parsed, dict) else None
    if kind in ("D003", "D004"):
        confirmed = (
            crosscheck.get("status") == "NOT_APPLICABLE"
            and crosscheck.get("reason") == f"NO_SUMMARY_API_FOR_{kind}"
            and source_review_confirmed(run)
        )
    elif kind == "D005":
        confirmed = crosscheck.get("status") == "NOT_APPLICABLE"
    else:
        rows = crosscheck.get("exactReceiptMatches")
        confirmed = (
            crosscheck.get("status") == "OK"
            and isinstance(rows, list)
            and any(
                isinstance(row, dict) and row.get("rcept_no") == filing["rceptNo"] for row in rows
            )
        )
    return bool(
        run["filingId"] == filing["id"]
        and run["status"] == "SUCCEEDED"
        and run["validationStatus"] == "PASSED"
        and result.get("projectionApplied") is True
        and result.get("suppressAlerts") is not True
        and (result.get("staging") or {}).get("mode") != "OFFLINE_INACTIVE"
        and event
        and (event.get("metadataJson") or {}).get("parseRunId") == run["id"]
        and result_type == run.get("resultType")
        and confirmed
        and all(run.get(field) == kind for field in ("inputType", "extractorType", "resultType"))
    )
