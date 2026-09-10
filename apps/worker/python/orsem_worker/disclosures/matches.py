"""Conservative D005/D002 candidate links; never automatically confirms fulfillment."""

from __future__ import annotations

import re
import unicodedata

from ..core import json_text, utcnow
from .primitives import classify_method, date_only
from .storage import insert, one, save, select


def match_text(value: str | None) -> str:
    return re.sub(r"[\s·ㆍ()（）\[\]{}]", "", unicodedata.normalize("NFKC", value or "")).lower()


def reporter_key(value: str | None) -> str | None:
    normalized = match_text(value)
    return (
        normalized
        if normalized and normalized not in ("확인필요", "미상", "unknown", "n/a", "na")
        else None
    )


def canonical_integer(value: str) -> str | None:
    match = re.fullmatch(r"([+-]?\d+)(?:\.(\d+))?", value)
    return str(int(match[1])) if match and not re.search(r"[1-9]", match[2] or "") else None


def absolute_integer(value: str) -> str | None:
    canonical = canonical_integer(value)
    return str(abs(int(canonical))) if canonical is not None else None


def item_date(item: dict, field: str) -> str | None:
    value = (item.get("rawJson") or {}).get(field)
    return (
        value
        if isinstance(value, str)
        and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
        and date_only(value) == value
        else None
    )


def confirmed(match: dict) -> bool:
    return match.get("reviewDecision") == "CONFIRMED" and (
        match.get("relationType") == "FULFILLS_PLAN"
        or match.get("source") == "MANUAL"
        or match.get("confirmedAt") is not None
        or match.get("confirmedByAdminId") is not None
    )


def pending(match: dict) -> bool:
    return match.get("reviewDecision") == "PENDING" and not confirmed(match)


def confirmed_relation(relation: dict) -> bool:
    return relation.get("reviewDecision") == "CONFIRMED" and (
        relation.get("relationType") == "FULFILLS_PLAN"
        or relation.get("relationType") == "EXECUTION_CANDIDATE"
        and relation.get("source") == "MANUAL"
    )


async def projection_links(tx, filing_id: str, detail_type: str) -> dict:
    if detail_type not in ("D002", "D005"):
        return {"relations": [], "matches": []}
    side = "from_filing_id" if detail_type == "D002" else "to_filing_id"
    relations = await select(tx, "filing_relations", f"{side}=:id", {"id": filing_id}, "FOR UPDATE")
    if detail_type == "D002":
        reports = await select(tx, "insider_reports", "filing_id=:id", {"id": filing_id})
        items = (
            await select(
                tx,
                "insider_transactions",
                "insider_report_id IN :ids",
                {"ids": [row["id"] for row in reports]},
            )
            if reports
            else []
        )
        match_column = "insider_transaction_id"
    else:
        plans = await select(tx, "trade_plans", "filing_id=:id", {"id": filing_id})
        items = (
            await select(
                tx,
                "trade_plan_items",
                "trade_plan_id IN :ids",
                {"ids": [row["id"] for row in plans]},
            )
            if plans
            else []
        )
        match_column = "trade_plan_item_id"
    matches = (
        await select(
            tx,
            "plan_execution_matches",
            f"{match_column} IN :ids",
            {"ids": [row["id"] for row in items]},
            "FOR UPDATE",
        )
        if items
        else []
    )
    return {
        "relations": [row for row in relations if confirmed_relation(row)],
        "matches": [row for row in matches if confirmed(row)],
    }


async def has_confirmed_links(tx, filing_id: str, detail_type: str) -> bool:
    links = await projection_links(tx, filing_id, detail_type)
    return bool(links["relations"] or links["matches"])


async def snapshot_links(tx, filing_id: str, detail_type: str) -> dict:
    links = await projection_links(tx, filing_id, detail_type)
    if links["relations"]:
        await tx.execute(
            "DELETE FROM filing_relations WHERE id IN :ids",
            {"ids": [row["id"] for row in links["relations"]]},
        )
    return links


async def dismiss_stale_reviews(tx, relations: list) -> None:
    if not relations:
        return
    reviews = await select(
        tx,
        "reviews",
        "subject_type='FILING_RELATION' AND subject_id IN :ids AND status='OPEN'",
        {"ids": [row["id"] for row in relations]},
    )
    for review in reviews:
        review.update(
            {
                "status": "DISMISSED",
                "resolution": json_text({"resolution": "SUPERSEDED_BY_REPARSE"}),
                "resolvedByAdminId": None,
                "resolvedAt": utcnow(),
            }
        )
        await save(tx, "reviews", review)


async def link_candidates(
    tx, filing_id: str, company_id: str, reporter_name: str, transactions: list
) -> None:
    reporter = reporter_key(reporter_name)
    if not reporter or not transactions:
        return
    filings = await select(
        tx,
        "filings",
        "company_id=:id AND detail_type='D005' AND effective_state='ACTIVE'",
        {"id": company_id},
        "ORDER BY rcept_date DESC,first_observed_at DESC LIMIT 100",
    )
    if not filings:
        return
    plans = await select(
        tx,
        "trade_plans",
        "filing_id IN :ids AND plan_status='PLANNED'",
        {"ids": [row["id"] for row in filings]},
    )
    plans = [row for row in plans if reporter_key(row["reporterName"]) == reporter]
    if not plans:
        return
    items = await select(
        tx, "trade_plan_items", "trade_plan_id IN :ids", {"ids": [row["id"] for row in plans]}
    )
    plan_by_id, filing_by_id = (
        {row["id"]: row for row in plans},
        {row["id"]: row for row in filings},
    )
    existing = (
        await select(
            tx,
            "plan_execution_matches",
            "trade_plan_item_id IN :ids",
            {"ids": [row["id"] for row in items]},
        )
        if items
        else []
    )
    matched = (
        await select(
            tx,
            "insider_transactions",
            "id IN :ids",
            {"ids": [row["insiderTransactionId"] for row in existing]},
        )
        if existing
        else []
    )
    matched_by_id = {row["id"]: row for row in matched}
    consumed: dict[str, int] = {}
    reserved: dict[str, int] = {}
    for match in existing:
        transaction = matched_by_id.get(match["insiderTransactionId"])
        quantity = (
            absolute_integer(transaction["quantity"])
            if transaction and transaction.get("quantity")
            else None
        )
        if quantity is None:
            continue
        item_id = match["tradePlanItemId"]
        if confirmed(match):
            consumed[item_id] = consumed.get(item_id, 0) + int(quantity)
        elif pending(match) and int(quantity) > 0:
            reserved[item_id] = reserved.get(item_id, 0) + int(quantity)
    for transaction in sorted(
        transactions, key=lambda row: (row.get("eventDate") or "", row["id"])
    ):
        if (
            not transaction.get("eventDate")
            or transaction["nature"] == "UNKNOWN"
            or transaction["direction"] == "UNKNOWN"
            or transaction.get("quantity") is None
        ):
            continue
        security, quantity = (
            match_text(transaction["securityTypeRaw"]),
            absolute_integer(transaction["quantity"]),
        )
        if not security or quantity is None or int(quantity) <= 0:
            continue
        actual = int(quantity)
        transaction_matches = [
            match for match in existing if match["insiderTransactionId"] == transaction["id"]
        ]
        if any(confirmed(match) for match in transaction_matches):
            continue
        for match in transaction_matches:
            if pending(match):
                key = match["tradePlanItemId"]
                reserved[key] = max(0, reserved.get(key, 0) - actual)
        candidates = []
        for item in items:
            if any(
                match["tradePlanItemId"] == item["id"]
                and not pending(match)
                and not confirmed(match)
                for match in transaction_matches
            ):
                continue
            plan = plan_by_id.get(item["tradePlanId"])
            plan_filing = filing_by_id.get(plan["filingId"]) if plan else None
            start, end = item_date(item, "plannedStartDate"), item_date(item, "plannedEndDate")
            if (
                not plan
                or not plan_filing
                or not start
                or not end
                or transaction["eventDate"] < start
                or transaction["eventDate"] > end
                or plan_filing["rceptDate"] > transaction["eventDate"]
                or not item.get("methodRaw")
                or not item.get("securityTypeRaw")
                or item.get("plannedQuantity") is None
            ):
                continue
            planned_quantity = canonical_integer(item["plannedQuantity"])
            if planned_quantity is None:
                continue
            planned = abs(int(planned_quantity))
            already = consumed.get(item["id"], 0)
            if planned - already <= 0 or actual > planned - already:
                continue
            classification = classify_method(item["methodRaw"], planned_quantity, True)
            if (
                classification["nature"] == "UNKNOWN"
                or classification["direction"] == "UNKNOWN"
                or classification["nature"] != transaction["nature"]
                or classification["direction"] != transaction["direction"]
                or match_text(item["securityTypeRaw"]) != security
            ):
                continue
            if actual <= planned - already - reserved.get(item["id"], 0):
                candidates.append(
                    {
                        "item": item,
                        "filing": plan_filing,
                        "planned": planned,
                        "actual": actual,
                        "consumed": already,
                        "sameDay": plan_filing["rceptDate"] == transaction["eventDate"],
                    }
                )
        retained = {candidate["item"]["id"] for candidate in candidates}
        discard = [
            match["id"]
            for match in transaction_matches
            if pending(match) and match["tradePlanItemId"] not in retained
        ]
        if discard:
            await tx.execute(
                "DELETE FROM plan_execution_matches WHERE id IN :ids", {"ids": discard}
            )
        for candidate in candidates:
            exact = candidate["consumed"] == 0 and candidate["actual"] == candidate["planned"]
            alternatives = len(candidates) > 1
            confidence = (
                "0.600000"
                if alternatives
                else "0.650000"
                if candidate["sameDay"]
                else "0.900000"
                if exact
                else "0.750000"
            )
            fields = [
                "companyId",
                "reporterName",
                f"alternativePlanItem:{len(candidates)}" if alternatives else "uniquePlanItem",
                "eventDateWithinPlanWindow",
                "planReceiptSameDateOrderUnknown"
                if candidate["sameDay"]
                else "planReceiptBeforeEventDate",
                "transactionNature",
                "direction",
                "securityType",
                "quantityExact" if exact else "quantityWithinRemainingPlan",
            ]
            item_id = candidate["item"]["id"]
            if not any(match["tradePlanItemId"] == item_id for match in transaction_matches):
                await insert(
                    tx,
                    "plan_execution_matches",
                    {
                        "tradePlanItemId": item_id,
                        "insiderTransactionId": transaction["id"],
                        "relationType": "EXECUTION_CANDIDATE",
                        "confidence": confidence,
                        "source": "HEURISTIC",
                        "confirmedByAdminId": None,
                        "confirmedAt": None,
                        "reviewDecision": "PENDING",
                        "reviewedByAdminId": None,
                        "reviewedAt": None,
                        "matchedFieldsJson": fields,
                    },
                )
            reserved[item_id] = reserved.get(item_id, 0) + actual
            relation = await one(
                tx,
                "filing_relations",
                "from_filing_id=:from_id AND to_filing_id=:to_id AND relation_type='EXECUTION_CANDIDATE'",
                {"from_id": filing_id, "to_id": candidate["filing"]["id"]},
            )
            if not relation:
                relation = await insert(
                    tx,
                    "filing_relations",
                    {
                        "fromFilingId": filing_id,
                        "toFilingId": candidate["filing"]["id"],
                        "relationType": "EXECUTION_CANDIDATE",
                        "confidence": confidence,
                        "source": "HEURISTIC",
                        "reviewRequired": True,
                        "reviewDecision": "PENDING",
                        "reviewedByAdminId": None,
                        "reviewedAt": None,
                        "matchedFieldsJson": fields,
                    },
                )
            key = "plan-execution:" + relation["id"]
            if not await one(
                tx,
                "reviews",
                "subject_type='FILING_RELATION' AND subject_id=:id AND dedupe_key=:key",
                {"id": relation["id"], "key": key},
            ):
                reason = (
                    f"D002 소유변동에 호환되는 D005 계획 항목이 {len(candidates)}개입니다. 특정 후보를 명시해 관리자 검토해야 합니다."
                    if alternatives
                    else "D005 거래계획과 D002 소유변동의 유일한 실행 후보입니다. 자동 이행 확정 없이 관리자 검토가 필요합니다."
                )
                await insert(
                    tx,
                    "reviews",
                    {
                        "subjectType": "FILING_RELATION",
                        "subjectId": relation["id"],
                        "dedupeKey": key,
                        "reason": reason,
                        "status": "OPEN",
                        "classificationResult": "REVIEW_REQUIRED",
                        "resolution": None,
                        "resolvedByAdminId": None,
                        "resolvedAt": None,
                    },
                )
    await reconcile_relations(tx, filing_id, [row["id"] for row in transactions])


async def reconcile_relations(tx, filing_id: str, transaction_ids: list) -> None:
    relations = await select(
        tx,
        "filing_relations",
        "from_filing_id=:id AND relation_type='EXECUTION_CANDIDATE' AND review_decision='PENDING'",
        {"id": filing_id},
    )
    if not relations:
        return
    plans = await select(
        tx, "trade_plans", "filing_id IN :ids", {"ids": [row["toFilingId"] for row in relations]}
    )
    items = (
        await select(
            tx, "trade_plan_items", "trade_plan_id IN :ids", {"ids": [row["id"] for row in plans]}
        )
        if plans
        else []
    )
    stale = []
    for relation in relations:
        plan_ids = {row["id"] for row in plans if row["filingId"] == relation["toFilingId"]}
        item_ids = [row["id"] for row in items if row["tradePlanId"] in plan_ids]
        remaining = (
            await one(
                tx,
                "plan_execution_matches",
                "trade_plan_item_id IN :items AND insider_transaction_id IN :transactions AND relation_type='EXECUTION_CANDIDATE' AND review_decision='PENDING'",
                {"items": item_ids, "transactions": transaction_ids},
            )
            if item_ids and transaction_ids
            else None
        )
        if not remaining:
            stale.append(relation)
    await dismiss_stale_reviews(tx, stale)
    if stale:
        await tx.execute(
            "DELETE FROM filing_relations WHERE id IN :ids", {"ids": [row["id"] for row in stale]}
        )


async def link_existing_candidates(tx, company_id: str, reporter_name: str) -> None:
    reporter = reporter_key(reporter_name)
    if not reporter:
        return
    filings = await select(
        tx,
        "filings",
        "company_id=:id AND detail_type='D002' AND effective_state='ACTIVE'",
        {"id": company_id},
        "ORDER BY rcept_date DESC,first_observed_at DESC LIMIT 500",
    )
    if not filings:
        return
    reports = await select(
        tx, "insider_reports", "filing_id IN :ids", {"ids": [row["id"] for row in filings]}
    )
    reports = [row for row in reports if reporter_key(row["reporterName"]) == reporter]
    if not reports:
        return
    transactions = await select(
        tx,
        "insider_transactions",
        "insider_report_id IN :ids",
        {"ids": [row["id"] for row in reports]},
    )
    for report in reports:
        await link_candidates(
            tx,
            report["filingId"],
            company_id,
            report["reporterName"],
            [row for row in transactions if row["insiderReportId"] == report["id"]],
        )
