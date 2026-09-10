"""Leased and bounded AI audits; suggestions never mutate deterministic projections."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from ..connectors.classifier import AI_CLASSIFIER_PROMPT_HASH, AI_CLASSIFIER_PROMPT_VERSION
from ..core import as_instant, identifier, json_text, sha256, utcnow
from .lifecycle import validate_persisted
from .primitives import OpenDartPayloadError
from .storage import insert, one, save

MAX_ROWS = 16


def iso(value):
    return as_instant(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def processing_lease_ms(timeout_ms: int, count: int) -> int:
    return min(
        4 * 3600000,
        max(30 * 60000, max(1000, timeout_ms) * max(1, min(MAX_ROWS, count)) + 5 * 60000),
    )


def claim_decision(status: str, updated_at, now, lease_ms: int) -> str:
    if status == "COMPLETED":
        return "COMPLETED"
    return (
        "CLAIM"
        if status != "PROCESSING"
        or as_instant(updated_at) <= as_instant(now) - timedelta(milliseconds=lease_ms)
        else "IN_FLIGHT"
    )


def recovery_reason(run: dict | None, now, lease_ms: int) -> str | None:
    if not run:
        return "MISSING_AI_RUN"
    return (
        "FAILED_AI_RUN"
        if run["status"] == "FAILED"
        else "PENDING_AI_RUN"
        if run["status"] == "PENDING"
        else "STALE_PROCESSING_AI_RUN"
        if run["status"] == "PROCESSING"
        and claim_decision(run["status"], run["updatedAt"], now, lease_ms) == "CLAIM"
        else None
    )


def rearm_plan(outbox: dict, run: dict | None, now, lease_ms: int) -> dict | None:
    if outbox["status"] not in ("COMPLETED", "FAILED"):
        return None
    reason = recovery_reason(run, now, lease_ms)
    if not reason:
        return None
    metadata = (outbox.get("payloadJson") or {}).get("aiReviewRearm")
    count = metadata.get("count") if isinstance(metadata, dict) else 0
    count = count if type(count) is int and count >= 0 else 0
    if count >= 3:
        return None
    latest = max(
        as_instant(outbox["updatedAt"]),
        as_instant(run["updatedAt"]) if run else as_instant(outbox["updatedAt"]),
    )
    return {
        "count": count + 1,
        "reason": reason,
        "availableAt": max(as_instant(now), latest + timedelta(minutes=30)),
    }


def select_candidates(parsed: dict) -> dict:
    if parsed["detailType"] not in ("D002", "D005"):
        return {"candidates": [], "totalEligibleRows": 0, "truncated": False}
    rows = parsed["transactions" if parsed["detailType"] == "D002" else "planItems"]
    eligible = []
    for row in rows:
        if row["nature"] == "UNKNOWN" or row["direction"] == "UNKNOWN":
            eligible.append(
                {
                    "rowIndex": row["rowIndex"],
                    "methodRaw": row["methodRaw"],
                    "securityTypeRaw": row["securityTypeRaw"],
                    "quantity": row["quantity"],
                    "deterministicNature": row["nature"],
                    "deterministicDirection": row["direction"],
                    "eventDate": row.get("eventDate"),
                    "plannedStartDate": row.get("plannedStartDate"),
                    "plannedEndDate": row.get("plannedEndDate"),
                }
            )
    eligible.sort(key=lambda row: row["rowIndex"])
    return {
        "candidates": eligible[:MAX_ROWS],
        "totalEligibleRows": len(eligible),
        "truncated": len(eligible) > MAX_ROWS,
    }


def aggregate_classification(reviews: list, truncated: bool = False) -> str:
    return (
        "REVIEW_REQUIRED"
        if truncated
        or not reviews
        or any(review["result"] == "REVIEW_REQUIRED" for review in reviews)
        else "AI_SUGGESTED"
        if any(review["result"] == "AI_SUGGESTED" for review in reviews)
        else "AI_CONFIRMED"
    )


def unique_conflict(error) -> bool:
    for candidate in (error, getattr(error, "orig", None), getattr(error, "driverError", None)):
        if candidate is not None and (
            getattr(candidate, "errno", None) == 1062
            or getattr(candidate, "code", None) == "ER_DUP_ENTRY"
            or getattr(candidate, "args", [None])[0] == 1062
        ):
            return True
    return False


class DisclosureAiReview:
    def __init__(self, ctx):
        self.ctx = ctx

    async def enqueue_review(self, filing_id: str, run_id: str, parsed: dict, tx=None) -> None:
        classifier = self.ctx.services["classifier"]
        if not classifier.enabled or not self.ctx.config.aiModel:
            return
        selection = select_candidates(parsed)
        if not selection["candidates"]:
            return
        key = f"ai-review:{run_id}:" + sha256(
            f"{self.ctx.config.aiModel}\0{AI_CLASSIFIER_PROMPT_HASH}"
        )
        lease = processing_lease_ms(self.ctx.config.aiTimeoutMs, len(selection["candidates"]))

        async def enqueue(db):
            now = utcnow()
            run = await one(
                db,
                "ai_runs",
                "subject_type='PARSE_RUN' AND subject_id=:id AND provider='OPENAI_COMPATIBLE' AND model=:model AND prompt_hash=:hash",
                {"id": run_id, "model": self.ctx.config.aiModel, "hash": AI_CLASSIFIER_PROMPT_HASH},
                lock=True,
            )
            outbox = await one(
                db,
                "job_outbox",
                "kind='REVIEW_PARSE_WITH_AI' AND dedupe_key=:key",
                {"key": key},
                lock=True,
            )
            if not outbox:
                reason = recovery_reason(run, now, lease)
                if not reason:
                    return
                available = (
                    max(now, as_instant(run["updatedAt"]) + timedelta(minutes=30)) if run else now
                )
                payload: dict[str, Any] = {"filingId": filing_id, "parseRunId": run_id}
                if run:
                    payload["aiReviewRearm"] = {
                        "count": 1,
                        "reason": reason,
                        "requestedAt": iso(now),
                        "notBefore": iso(available),
                        "previousOutboxStatus": None,
                        "previousLastError": None,
                    }
                try:
                    await insert(
                        db,
                        "job_outbox",
                        {
                            "kind": "REVIEW_PARSE_WITH_AI",
                            "dedupeKey": key,
                            "payloadJson": payload,
                            "status": "PENDING",
                            "availableAt": available,
                            "attempts": 1 if run else 0,
                            "lockedAt": None,
                            "lastError": f"AI review delivery recreated after {reason}."
                            if run
                            else None,
                        },
                    )
                    return
                except Exception as error:
                    if not unique_conflict(error):
                        raise
                    outbox = await one(
                        db,
                        "job_outbox",
                        "kind='REVIEW_PARSE_WITH_AI' AND dedupe_key=:key",
                        {"key": key},
                        lock=True,
                    )
                    if not outbox:
                        raise ValueError(
                            "AI outbox identity insert conflicted, but the canonical row was missing."
                        ) from error
            rearm = rearm_plan(outbox, run, now, lease)
            if not rearm:
                return
            outbox["payloadJson"] = {
                "filingId": filing_id,
                "parseRunId": run_id,
                "aiReviewRearm": {
                    "count": rearm["count"],
                    "reason": rearm["reason"],
                    "requestedAt": iso(now),
                    "notBefore": iso(rearm["availableAt"]),
                    "previousOutboxStatus": outbox["status"],
                    "previousLastError": outbox.get("lastError"),
                },
            }
            outbox.update(
                {
                    "status": "PENDING",
                    "availableAt": rearm["availableAt"],
                    "lockedAt": None,
                    "lastError": f"AI review delivery re-armed ({rearm['count']}/3) after {rearm['reason']}.",
                }
            )
            await save(db, "job_outbox", outbox)

        if tx is not None:
            await enqueue(tx)
        else:
            async with self.ctx.db.transaction() as transaction:
                await enqueue(transaction)

    async def review(self, job: dict) -> dict:
        filing = await one(self.ctx.db, "filings", "id=:id", {"id": job["filingId"]})
        parse_run = await one(
            self.ctx.db,
            "parse_runs",
            "id=:id AND filing_id=:filing",
            {"id": job["parseRunId"], "filing": job["filingId"]},
        )
        if not filing or not parse_run or filing["detailType"] not in ("D002", "D005"):
            raise OpenDartPayloadError(
                "AI review references a missing or ineligible filing parse run.",
                "INVALID_AI_REVIEW",
            )
        try:
            parsed = validate_persisted((parse_run.get("resultJson") or {}).get("parsed"))
        except OpenDartPayloadError:
            raise OpenDartPayloadError(
                "AI review requires a persisted D002 or D005 parse audit.", "INVALID_AI_REVIEW"
            ) from None
        if parsed["detailType"] != filing["detailType"]:
            raise OpenDartPayloadError(
                "AI review requires a persisted D002 or D005 parse audit.", "INVALID_AI_REVIEW"
            )
        selection = select_candidates(parsed)
        if not selection["candidates"]:
            return {
                "aiRunId": None,
                "status": "COMPLETED",
                "classificationResult": parse_run.get("classificationResult") or "RULE_CONFIRMED",
                "candidatesReviewed": 0,
                "totalEligibleRows": 0,
                "truncated": False,
                "deduplicated": False,
            }
        model = self.ctx.config.aiModel or "unconfigured"
        identity = {
            "subjectType": "PARSE_RUN",
            "subjectId": parse_run["id"],
            "provider": "OPENAI_COMPATIBLE",
            "model": model,
            "promptHash": AI_CLASSIFIER_PROMPT_HASH,
        }
        input_base = {
            "source": {
                "connector": filing["source"],
                "rightsMode": "OFFICIAL_PUBLIC_DATA",
                "selectedEntryName": parsed["source"]["selectedEntryName"],
                "archiveSha256": parsed["source"]["archiveSha256"],
                "archiveByteLength": parsed["source"]["archiveByteLength"],
            },
            "filingId": filing["id"],
            "rceptNo": filing["rceptNo"],
            "publicationDate": filing["rceptDate"],
            "firstObservedAt": iso(filing["firstObservedAt"]),
            "detailType": filing["detailType"],
            "parseRunId": parse_run["id"],
            "parserVersion": parse_run["parserVersion"],
            "rawSha256": parse_run["rawSha256"],
            "promptHash": AI_CLASSIFIER_PROMPT_HASH,
            **selection,
        }
        lease = processing_lease_ms(self.ctx.config.aiTimeoutMs, len(selection["candidates"]))
        claim_token = identifier()
        async with self.ctx.db.transaction() as tx:
            locked_run = await one(
                tx,
                "parse_runs",
                "id=:id AND filing_id=:filing",
                {"id": parse_run["id"], "filing": filing["id"]},
                lock=True,
            )
            if not locked_run:
                raise ValueError("AI audit target disappeared before its run was claimed.")
            claimed_at = utcnow()
            ai_run = await one(
                tx,
                "ai_runs",
                "subject_type=:subjectType AND subject_id=:subjectId AND provider=:provider AND model=:model AND prompt_hash=:promptHash",
                identity,
                lock=True,
            )

            def claim_input(previous):
                data = {
                    **input_base,
                    "processingClaim": {
                        "token": claim_token,
                        "claimedAt": iso(claimed_at),
                        "leaseMs": lease,
                    },
                }
                if previous:
                    data["retryOf"] = {
                        "status": previous["status"],
                        "updatedAt": iso(previous["updatedAt"]),
                        "errorMessage": previous.get("errorMessage"),
                    }
                return data

            claimed = False
            if not ai_run:
                try:
                    input_provenance = claim_input(None)
                    ai_run = await insert(
                        tx,
                        "ai_runs",
                        {
                            **identity,
                            "status": "PROCESSING",
                            "inputProvenanceJson": input_provenance,
                            "outputJson": None,
                            "errorMessage": None,
                        },
                    )
                    claimed = True
                except Exception as error:
                    if not unique_conflict(error):
                        raise
                    ai_run = await one(
                        tx,
                        "ai_runs",
                        "subject_type=:subjectType AND subject_id=:subjectId AND provider=:provider AND model=:model AND prompt_hash=:promptHash",
                        identity,
                        lock=True,
                    )
                    if not ai_run:
                        raise ValueError(
                            "AI identity insert conflicted, but the canonical row was missing."
                        ) from error
            if not claimed:
                decision = claim_decision(ai_run["status"], ai_run["updatedAt"], claimed_at, lease)
                if decision == "CLAIM":
                    input_provenance = claim_input(ai_run)
                    ai_run.update(
                        {
                            "status": "PROCESSING",
                            "inputProvenanceJson": input_provenance,
                            "errorMessage": None,
                        }
                    )
                    await save(tx, "ai_runs", ai_run)
                    claimed = True

        def summarize(existing):
            output = existing.get("outputJson") or {}
            aggregate = output.get("classificationResult")
            valid = (
                aggregate
                if aggregate
                in ("RULE_CONFIRMED", "AI_CONFIRMED", "AI_SUGGESTED", "REVIEW_REQUIRED")
                else None
            )
            completed = existing["status"] == "COMPLETED"
            return {
                "aiRunId": existing["id"],
                "status": existing["status"],
                "classificationResult": (valid if completed else None)
                or parse_run.get("classificationResult")
                or "REVIEW_REQUIRED",
                "candidatesReviewed": int(output.get("candidatesReviewed", 0)) if completed else 0,
                "totalEligibleRows": int(
                    output.get("totalEligibleRows", selection["totalEligibleRows"])
                )
                if completed
                else selection["totalEligibleRows"],
                "truncated": output.get("truncated") is True
                if completed
                else selection["truncated"],
                "deduplicated": True,
            }

        if not claimed:
            if decision == "IN_FLIGHT":
                raise ValueError(
                    f"AI review {ai_run['id']} is already processing under an active lease."
                )
            return summarize(ai_run)
        reviews, unexpected = [], []
        for candidate in selection["candidates"]:
            try:
                reviews.append(await self.ctx.services["classifier"].suggest(candidate))
            except Exception as error:  # noqa: BLE001 - classifier failures are retained as review evidence
                unexpected.append(str(error)[:4000])
                canonical = {
                    key: candidate[key]
                    for key in (
                        "methodRaw",
                        "securityTypeRaw",
                        "quantity",
                        "deterministicNature",
                        "deterministicDirection",
                    )
                }
                reviews.append(
                    {
                        "result": "REVIEW_REQUIRED",
                        "suggestion": None,
                        "reasons": ["AI review request failed safely."],
                        "audit": {
                            "inputHash": sha256(json_text(canonical)),
                            "model": self.ctx.config.aiModel,
                            "promptHash": AI_CLASSIFIER_PROMPT_HASH,
                            "promptVersion": AI_CLASSIFIER_PROMPT_VERSION,
                            "rawOutput": None,
                            "evidenceRefs": [],
                        },
                    }
                )
        classification = aggregate_classification(reviews, selection["truncated"])
        failed = [review for review in reviews if review.get("suggestion") is None]
        status = "FAILED" if failed else "COMPLETED"
        output = {
            "classificationResult": classification,
            "candidatesReviewed": len(reviews),
            "totalEligibleRows": selection["totalEligibleRows"],
            "truncated": selection["truncated"],
            "rows": [
                {
                    "rowIndex": candidate["rowIndex"],
                    "deterministicNature": candidate["deterministicNature"],
                    "deterministicDirection": candidate["deterministicDirection"],
                    "review": review,
                }
                for candidate, review in zip(selection["candidates"], reviews)
            ],
        }
        error_message = (
            (
                " ".join(
                    [reason for review in failed for reason in review["reasons"]] + unexpected
                )[:4000]
                or "AI review failed safely."
            )
            if failed
            else None
        )
        async with self.ctx.db.transaction() as tx:
            locked_run = await one(
                tx,
                "parse_runs",
                "id=:id AND filing_id=:filing",
                {"id": parse_run["id"], "filing": filing["id"]},
                lock=True,
            )
            locked_ai = await one(tx, "ai_runs", "id=:id", {"id": ai_run["id"]}, lock=True)
            if not locked_run or not locked_ai:
                raise ValueError("AI audit target disappeared before its result was persisted.")
            token = (
                (locked_ai.get("inputProvenanceJson") or {}).get("processingClaim", {}).get("token")
            )
            if locked_ai["status"] != "PROCESSING" or token != claim_token:
                return summarize(locked_ai)
            locked_ai.update(
                {
                    "status": status,
                    "inputProvenanceJson": input_provenance,
                    "outputJson": output,
                    "errorMessage": error_message,
                }
            )
            await save(tx, "ai_runs", locked_ai)
            locked_run["classificationResult"] = classification
            await save(tx, "parse_runs", locked_run)
            review = await one(
                tx,
                "reviews",
                "subject_type='FILING' AND subject_id=:id AND dedupe_key=:key AND status='OPEN'",
                {"id": filing["id"], "key": "parse:" + parse_run["id"]},
            )
            if review:
                review["classificationResult"] = classification
                marker = f"[AI:{locked_ai['id']}]"
                if marker not in review["reason"]:
                    review["reason"] += (
                        f"\n{marker} 로컬 AI가 UNKNOWN {len(reviews)}/{selection['totalEligibleRows']}개 행을 보조 검토했습니다. 결정론적 projection과 알림은 변경하지 않았습니다."
                    )
                await save(tx, "reviews", review)
        if status == "FAILED":
            raise ValueError(
                f"AI review failed after persisting audit {ai_run['id']}: {error_message}"
            )
        return {
            "aiRunId": ai_run["id"],
            "status": status,
            "classificationResult": classification,
            "candidatesReviewed": len(reviews),
            "totalEligibleRows": selection["totalEligibleRows"],
            "truncated": selection["truncated"],
            "deduplicated": False,
        }
