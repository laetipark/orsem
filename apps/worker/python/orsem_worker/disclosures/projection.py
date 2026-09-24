"""Replace validated query projections while preserving archived source facts."""

from __future__ import annotations

from ..core import utcnow
from .lifecycle import (
    assert_document_kind,
    assert_source_invariant,
    numeric,
    update_review_lifecycle,
)
from .matches import dismiss_stale_reviews, link_candidates, link_existing_candidates
from .policy import EVENT_TYPES, assert_type_invariant, should_deliver, source_review
from .primitives import OpenDartPayloadError
from .storage import insert, one, save, select
from .summary import parsed_summary


def cut(value, maximum):
    return value[:maximum] if value is not None else None


async def replace_projection(
    tx,
    filing_id: str,
    company_id: str,
    parsed: dict,
    crosscheck: dict,
    effective_state: str,
    run_id: str | None = None,
) -> None:
    kind = parsed["detailType"]
    if kind in ("D002", "D005"):
        side = "from_filing_id" if kind == "D002" else "to_filing_id"
        stale = await select(
            tx,
            "filing_relations",
            f"{side}=:id AND relation_type='EXECUTION_CANDIDATE'",
            {"id": filing_id},
        )
        await dismiss_stale_reviews(tx, stale)
        await tx.execute(
            f"DELETE FROM filing_relations WHERE {side}=:id AND relation_type='EXECUTION_CANDIDATE'",
            {"id": filing_id},
        )
    if kind == "D002":
        reports = await select(tx, "insider_reports", "filing_id=:id", {"id": filing_id})
        if reports:
            ids = [row["id"] for row in reports]
            transactions = await select(
                tx, "insider_transactions", "insider_report_id IN :ids", {"ids": ids}
            )
            if transactions:
                await tx.execute(
                    "DELETE FROM plan_execution_matches WHERE insider_transaction_id IN :ids",
                    {"ids": [row["id"] for row in transactions]},
                )
            await tx.execute(
                "DELETE FROM insider_transactions WHERE insider_report_id IN :ids", {"ids": ids}
            )
            await tx.execute("DELETE FROM insider_reports WHERE filing_id=:id", {"id": filing_id})
        matches = crosscheck.get("exactReceiptMatches")
        match = matches[0] if isinstance(matches, list) and matches else {}
        report = await insert(
            tx,
            "insider_reports",
            {
                "filingId": filing_id,
                "reporterName": cut(
                    parsed.get("reporterName")
                    if parsed.get("reporterName") is not None
                    else str(match.get("repror", "확인 필요")),
                    255,
                )
                or "확인 필요",
                "relationship": cut(parsed.get("relationshipRaw"), 255),
                "position": cut(
                    parsed.get("positionRaw")
                    if parsed.get("positionRaw") is not None
                    else str(match.get("isu_exctv_ofcps", "")) or None,
                    255,
                ),
                "isRegisteredExecutive": str(match["isu_exctv_rgist_at"]).upper() == "Y"
                if match.get("isu_exctv_rgist_at")
                else None,
                "isMajorShareholder": str(match["isu_main_shrholdr"]).upper() == "Y"
                if match.get("isu_main_shrholdr")
                else None,
                "ownershipBefore": None,
                "ownershipAfter": numeric(str(match.get("sp_stock_lmp_cnt", ""))),
                "ownershipChange": numeric(str(match.get("sp_stock_lmp_irds_cnt", ""))),
                "ownershipRateAfter": numeric(str(match.get("sp_stock_lmp_rate", ""))),
                "rawJson": {"parsedSummary": parsed, "crosscheck": crosscheck},
            },
        )
        transactions = []
        for row in parsed["transactions"]:
            transactions.append(
                await insert(
                    tx,
                    "insider_transactions",
                    {
                        "insiderReportId": report["id"],
                        "eventDate": row["eventDate"],
                        "securityTypeRaw": cut(row["securityTypeRaw"], 500) or "",
                        "methodRaw": cut(row["methodRaw"], 500) or "",
                        "nature": row["nature"],
                        "direction": row["direction"],
                        "quantity": row["quantity"],
                        "unitPrice": row["unitPrice"],
                        "amount": row["amount"],
                        "currency": "KRW" if row["currency"] == "KRW" else None,
                        "sharesAfter": row["sharesAfter"],
                        "parserConfidence": f"{row['confidence']:.6f}",
                        "rawJson": row,
                    },
                )
            )
        if effective_state == "ACTIVE":
            await link_candidates(tx, filing_id, company_id, report["reporterName"], transactions)
        return
    if kind == "D005":
        plans = await select(tx, "trade_plans", "filing_id=:id", {"id": filing_id})
        if plans:
            await tx.execute(
                "DELETE FROM trade_plan_items WHERE trade_plan_id IN :ids",
                {"ids": [row["id"] for row in plans]},
            )
            await tx.execute("DELETE FROM trade_plans WHERE filing_id=:id", {"id": filing_id})
        dates = sorted(
            date
            for row in parsed["planItems"]
            for date in (row["plannedStartDate"], row["plannedEndDate"])
            if date
        )
        plan = await insert(
            tx,
            "trade_plans",
            {
                "filingId": filing_id,
                "reporterName": cut(parsed.get("reporterName"), 255)
                if parsed.get("reporterName") is not None
                else "확인 필요",
                "plannedStartDate": dates[0] if dates else None,
                "plannedEndDate": dates[-1] if dates else None,
                "planStatus": effective_state
                if effective_state in ("CANCELLED", "WITHDRAWN", "SUPERSEDED")
                else "PLANNED",
                "rawJson": parsed,
            },
        )
        for row in parsed["planItems"]:
            await insert(
                tx,
                "trade_plan_items",
                {
                    "tradePlanId": plan["id"],
                    "securityTypeRaw": cut(row["securityTypeRaw"] or None, 500),
                    "methodRaw": cut(row["methodRaw"] or None, 500),
                    "plannedQuantity": row["quantity"],
                    "plannedUnitPrice": row["priceMin"]
                    if row["priceMin"] and row["priceMin"] == row["priceMax"]
                    else None,
                    "plannedAmount": None,
                    "rawJson": row,
                },
            )
        if effective_state == "ACTIVE":
            await link_existing_candidates(tx, company_id, plan["reporterName"])
        return
    if kind in ("D003", "D004"):
        if not run_id:
            raise ValueError("A disclosure projection requires its immutable parse run.")
        facts = {
            key: value
            for key, value in parsed.items()
            if key not in ("source", "warnings", "provenance", "agendas", "securities")
        }
        table, rows_table, parent_key = (
            ("proxy_solicitations", "proxy_agenda_items", "proxySolicitationId")
            if kind == "D003"
            else ("tender_offers", "tender_offer_securities", "tenderOfferId")
        )
        previous = await select(tx, table, "filing_id=:id", {"id": filing_id})
        if previous:
            parent_column = "proxy_solicitation_id" if kind == "D003" else "tender_offer_id"
            await tx.execute(
                f"DELETE FROM {rows_table} WHERE {parent_column} IN :ids",
                {"ids": [row["id"] for row in previous]},
            )
            await tx.execute(f"DELETE FROM {table} WHERE filing_id=:id", {"id": filing_id})
        record = {
            "filingId": filing_id,
            "parseRunId": run_id,
            "factsJson": facts,
            "provenanceJson": parsed["provenance"],
        }
        if kind == "D004":
            record["documentKind"] = parsed["documentKind"]
        parent = await insert(tx, table, record)
        for row in parsed["agendas" if kind == "D003" else "securities"]:
            data = (
                {"ordinal": row["ordinal"], "title": row["title"]}
                if kind == "D003"
                else {
                    "rowIndex": row["rowIndex"],
                    "factsJson": {key: value for key, value in row.items() if key != "provenance"},
                }
            )
            await insert(
                tx,
                rows_table,
                {parent_key: parent["id"], **data, "provenanceJson": row.get("provenance")},
            )
        return
    if kind != "D001":
        raise OpenDartPayloadError("Unsupported projection type.", "UNSUPPORTED_FILING_TYPE")
    reports = await select(tx, "large_holder_reports", "filing_id=:id", {"id": filing_id})
    if reports:
        await tx.execute(
            "DELETE FROM large_holding_changes WHERE large_holder_report_id IN :ids",
            {"ids": [row["id"] for row in reports]},
        )
        await tx.execute("DELETE FROM large_holder_reports WHERE filing_id=:id", {"id": filing_id})
    report = await insert(
        tx,
        "large_holder_reports",
        {
            "filingId": filing_id,
            "reporterName": cut(parsed.get("reporterName"), 255)
            if parsed.get("reporterName") is not None
            else "확인 필요",
            "reportReasonRaw": parsed["reportReasonRaw"],
            "holdingPurposeRaw": parsed["reportTypeRaw"],
            "sharesBefore": None,
            "sharesAfter": parsed["sharesAfter"],
            "ownershipRateBefore": None,
            "ownershipRateAfter": parsed["ownershipRateAfter"],
            "rawJson": {
                "parsed": parsed,
                "crosscheck": crosscheck,
                "reportReasonKind": parsed["reportReasonKind"],
                "nonTradingReport": parsed["nonTradingReport"],
            },
        },
    )
    for row in parsed["changes"]:
        await insert(
            tx,
            "large_holding_changes",
            {
                "largeHolderReportId": report["id"],
                "eventDate": row["eventDate"],
                "methodRaw": cut(row["methodRaw"] or None, 500),
                "direction": row.get("direction") or "UNKNOWN",
                "shareChange": row["quantity"],
                "amount": None,
                "rawJson": row,
            },
        )


async def apply_summary_only(tx, filing: dict, crosscheck: dict) -> None:
    kind = filing["detailType"]
    if kind not in ("D001", "D002"):
        return
    table = "insider_reports" if kind == "D002" else "large_holder_reports"
    report = await one(tx, table, "filing_id=:id", {"id": filing["id"]})
    if not report:
        return
    matches = crosscheck.get("exactReceiptMatches")
    match = matches[0] if isinstance(matches, list) and matches else None
    if kind == "D002" and match:
        report.update(
            {
                "isRegisteredExecutive": str(match["isu_exctv_rgist_at"]).upper() == "Y"
                if match.get("isu_exctv_rgist_at")
                else None,
                "isMajorShareholder": str(match["isu_main_shrholdr"]).upper() == "Y"
                if match.get("isu_main_shrholdr")
                else None,
                "ownershipAfter": numeric(str(match.get("sp_stock_lmp_cnt", ""))),
                "ownershipChange": numeric(str(match.get("sp_stock_lmp_irds_cnt", ""))),
                "ownershipRateAfter": numeric(str(match.get("sp_stock_lmp_rate", ""))),
            }
        )
    report["rawJson"] = {**(report.get("rawJson") or {}), "crosscheck": crosscheck}
    await save(tx, table, report)


async def materialize_event(
    tx,
    filing: dict,
    parsed: dict,
    run_id: str,
    status: str,
    suppress_alerts: bool,
    projection_applied: bool = True,
) -> None:
    run = await one(
        tx, "parse_runs", "id=:run AND filing_id=:filing", {"run": run_id, "filing": filing["id"]}
    )
    if not run:
        raise ValueError("A parsed event requires its persisted parse run.")
    assert_type_invariant(filing, run, parsed["detailType"])
    assert_source_invariant(run, parsed)
    assert_document_kind(filing, parsed)
    reason = (
        "원문 파서의 확신도가 낮거나 경고가 있어 사람의 검토가 필요합니다."
        if projection_applied
        else "새 파싱 결과를 검토 자료로 보존했습니다. 품질 게이트 또는 수동 확정 관계 보호로 활성 결과를 교체하지 않았습니다."
    )
    await update_review_lifecycle(
        tx, filing["id"], run_id, reason, status != "SUCCEEDED" or not projection_applied
    )
    if not projection_applied:
        return
    if source_review(parsed["detailType"]):
        from ..alert_gate import source_review_confirmed

        if not source_review_confirmed(run):
            raise OpenDartPayloadError(
                "A source-reviewed disclosure cannot materialize an event without proof for this parse run.",
                "PARSE_SOURCE_REVIEW_REQUIRED",
            )
    if run.get("validationStatus") == "REJECTED":
        raise OpenDartPayloadError(
            "Rejected parse cannot materialize an event.", "PARSE_VALIDATION_REJECTED"
        )
    key = "opendart:filing:" + filing["id"]
    event = await one(tx, "event_clusters", "dedupe_key=:key", {"key": key})
    prior_metadata = (event or {}).get("metadataJson") or {}
    run_suppressed = (run.get("resultJson") or {}).get("suppressAlerts") is True or (
        (run.get("resultJson") or {}).get("staging") or {}
    ).get("mode") == "OFFLINE_INACTIVE"
    # Preserve how this receipt was first observed. A suppressed maintenance run
    # must not permanently mute a receipt originally discovered by the live poll.
    receipt_suppressed = prior_metadata.get("suppressAlerts", suppress_alerts or run_suppressed)
    suppress_alerts = suppress_alerts or receipt_suppressed is True or run_suppressed
    kind = parsed["detailType"]
    dates = (
        [row["eventDate"] for row in parsed["changes"]]
        if kind == "D001"
        else [row["eventDate"] for row in parsed["transactions"]]
        if kind == "D002"
        else [parsed["meetingDate"], parsed["solicitationStartDate"], parsed["solicitationEndDate"]]
        if kind == "D003"
        else [
            parsed["subscriptionStartDate"],
            parsed["subscriptionEndDate"],
            parsed["settlementDate"],
        ]
        if kind == "D004"
        else [
            date
            for row in parsed["planItems"]
            for date in (row["plannedStartDate"], row["plannedEndDate"])
        ]
    )
    earliest = min((date for date in dates if date), default=None)
    state = (
        "CANCELLED"
        if filing["effectiveState"] in ("CANCELLED", "WITHDRAWN")
        else "SUPERSEDED"
        if filing["effectiveState"] == "SUPERSEDED"
        else "VERIFIED"
        if status == "SUCCEEDED"
        else "REVIEW_REQUIRED"
    )
    company = await one(tx, "companies", "id=:id", {"id": filing["companyId"]})
    company_name = (company or {}).get("nameKo") or (company or {}).get("nameEn")
    summary = parsed_summary(parsed, company_name)
    event = event or {
        "companyId": filing["companyId"],
        "firstObservedAt": filing["firstObservedAt"],
        "dedupeKey": key,
    }
    event.update(
        {
            "canonicalEventType": EVENT_TYPES[kind],
            "occurredAt": None,
            "publishedAt": None,
            "processedAt": utcnow(),
            "state": state,
            "evidenceGrade": "A",
            "summary": summary,
            "metadataJson": {
                **prior_metadata,
                "suppressAlerts": receipt_suppressed,
                "rceptNo": filing["rceptNo"],
                "detailType": filing["detailType"],
                "phase": "PARSED",
                "parseRunId": run_id,
                "parseStatus": status,
                "projectionApplied": projection_applied,
                "earliestEventDate": earliest,
                "disclaimer": "투자 매매 신호가 아닌 공식 공시 관찰 근거",
            },
        }
    )
    event = await save(tx, "event_clusters", event)
    if not await one(
        tx,
        "event_cluster_items",
        "event_cluster_id=:event AND item_type='FILING' AND item_id=:filing",
        {"event": event["id"], "filing": filing["id"]},
    ):
        await insert(
            tx,
            "event_cluster_items",
            {
                "eventClusterId": event["id"],
                "itemType": "FILING",
                "itemId": filing["id"],
                "isPrimary": True,
                "provenanceJson": {"source": "OPENDART", "phase": "DOCUMENT"},
            },
        )
    if (
        suppress_alerts
        or status != "SUCCEEDED"
        or run.get("validationStatus") != "PASSED"
        or not should_deliver(filing)
    ):
        return
    key = f"{event['id']}:WEB:parsed:{run_id}:{status}:v1"
    if await one(tx, "alerts", "idempotency_key=:key", {"key": key}):
        return
    payload = {
        "phase": "PARSED",
        "filingId": filing["id"],
        "parseRunId": run_id,
        "detailType": filing["detailType"],
        "rceptNo": filing["rceptNo"],
        "reportName": filing["reportName"],
        "companyName": company_name,
        "summary": summary,
        "parseStatus": status,
        "evidenceGrade": "A",
        "officialUrl": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={filing['rceptNo']}",
        "message": "공식 공시 원문 확인 결과이며 투자 매매 신호가 아닙니다.",
    }
    alert = await insert(
        tx,
        "alerts",
        {
            "eventClusterId": event["id"],
            "idempotencyKey": key,
            "status": "PENDING",
            "alertVersion": 2,
            "payloadJson": payload,
        },
    )
    await insert(
        tx,
        "alert_outbox",
        {
            "alertId": alert["id"],
            "channel": "WEB",
            "idempotencyKey": key,
            "status": "PENDING",
            "payload": payload,
            "availableAt": utcnow(),
            "attempts": 0,
            "lastError": None,
        },
    )
