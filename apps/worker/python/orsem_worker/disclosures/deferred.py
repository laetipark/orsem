"""Apply explicitly requested administrator projections against immutable baselines."""

from __future__ import annotations

from ..alert_gate import source_review_confirmed
from ..core import json_text, utcnow
from .lifecycle import (
    assert_document_kind,
    assert_source_invariant,
    company_lock,
    confidence_of,
    text_warnings,
    update_review_lifecycle,
    validate_persisted,
    validation_status,
    warning_requires_review,
    warnings_of,
)
from .matches import snapshot_links
from .policy import assert_type_invariant, crosscheck_allows_projection, source_review
from .primitives import OpenDartPayloadError
from .projection import materialize_event, replace_projection
from .storage import insert, one, save


def iso(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def resolve_review(
    tx, filing_id: str, run_id: str, admin_id: str, now, resolution="PROJECTION_APPLIED"
):
    review = await one(
        tx,
        "reviews",
        "subject_type='FILING' AND subject_id=:id AND dedupe_key=:key AND status='OPEN'",
        {"id": filing_id, "key": "parse:" + run_id},
    )
    if review:
        review.update(
            {
                "status": "RESOLVED",
                "resolution": json_text({"resolution": resolution, "requestedByAdminId": admin_id}),
                "resolvedByAdminId": admin_id,
                "resolvedAt": now,
            }
        )
        await save(tx, "reviews", review)


class DeferredProjection:
    def __init__(self, ctx, enrichment):
        self.ctx, self.enrichment = ctx, enrichment

    async def apply(self, job: dict) -> dict:
        snapshot = await one(self.ctx.db, "filings", "id=:id", {"id": job["filingId"]})
        if not snapshot:
            raise OpenDartPayloadError(
                "Deferred projection references a missing filing.", "INVALID_DEFERRED_PROJECTION"
            )
        async with company_lock(self.ctx.db, snapshot["companyId"]):
            run = await one(
                self.ctx.db,
                "parse_runs",
                "id=:id AND filing_id=:filing",
                {"id": job["parseRunId"], "filing": job["filingId"]},
            )
            filing = await one(self.ctx.db, "filings", "id=:id", {"id": job["filingId"]})
            if not run or not filing:
                raise OpenDartPayloadError(
                    "Deferred projection references a missing filing or parse run.",
                    "INVALID_DEFERRED_PROJECTION",
                )
            if run.get("validationStatus") in ("REJECTED", "LEGACY"):
                raise OpenDartPayloadError(
                    "Rejected or legacy parse requires a fresh validated run.",
                    "PARSE_VALIDATION_REJECTED",
                )
            result = run.get("resultJson")
            if not result or type(result.get("projectionApplied")) is not bool:
                raise OpenDartPayloadError(
                    "Parse run is not a deferred projection.", "INVALID_DEFERRED_PROJECTION"
                )
            parsed = None
            if result["projectionApplied"] is False:
                try:
                    parsed = validate_persisted(result.get("parsed"))
                except OpenDartPayloadError:
                    raise OpenDartPayloadError(
                        "Deferred projection contains an invalid persisted parse audit.",
                        "INVALID_DEFERRED_PROJECTION",
                    ) from None
            if parsed and parsed["detailType"] != filing["detailType"]:
                raise OpenDartPayloadError(
                    "Deferred parse detail type does not match its filing.",
                    "INVALID_DEFERRED_PROJECTION",
                )
            assert_type_invariant(
                filing, run, parsed["detailType"] if parsed else run.get("resultType")
            )
            if parsed:
                assert_source_invariant(run, parsed)
                assert_document_kind(filing, parsed)
                if validation_status(run["status"], warnings_of(parsed)) == "REJECTED":
                    raise OpenDartPayloadError(
                        "Invalid extracted rows cannot be manually activated.",
                        "PARSE_VALIDATION_REJECTED",
                    )
            crosscheck = (
                result.get("crosscheck")
                if isinstance(result.get("crosscheck"), dict)
                else {"status": "MISSING"}
            )
            crosscheck_only = job.get("crosscheckOnly") is True
            if crosscheck_only and (
                not isinstance(result.get("staging"), dict)
                or result["staging"].get("mode") != "OFFLINE_INACTIVE"
            ):
                raise OpenDartPayloadError(
                    "Crosscheck-only job requires an offline staged result.",
                    "INVALID_CROSSCHECK_REQUEST",
                )
            if not crosscheck_allows_projection(
                filing["detailType"], crosscheck, filing["rceptNo"]
            ):
                if crosscheck_only:
                    crosscheck = await self.enrichment.fetch_crosscheck(filing, filing["rceptNo"])
                else:
                    raise OpenDartPayloadError(
                        "An applicable source crosscheck must finish before projection activation.",
                        "PARSE_CROSSCHECK_REQUIRED",
                    )
            async with self.ctx.db.transaction() as tx:
                locked = await one(tx, "filings", "id=:id", {"id": filing["id"]}, lock=True)
                locked_run = await one(
                    tx,
                    "parse_runs",
                    "id=:id AND filing_id=:filing",
                    {"id": run["id"], "filing": filing["id"]},
                    lock=True,
                )
                if not locked or not locked_run:
                    raise ValueError("Deferred projection disappeared while being applied.")
                assert_type_invariant(
                    locked,
                    locked_run,
                    parsed["detailType"] if parsed else locked_run.get("resultType"),
                )
                if parsed:
                    assert_source_invariant(locked_run, parsed)
                    assert_document_kind(locked, parsed)
                if locked_run.get("validationStatus") in ("REJECTED", "LEGACY"):
                    raise OpenDartPayloadError(
                        "Rejected parse cannot be activated.", "PARSE_VALIDATION_REJECTED"
                    )
                if (
                    locked["rceptNo"] != filing["rceptNo"]
                    or locked["detailType"] != filing["detailType"]
                    or locked["companyId"] != snapshot["companyId"]
                    or parsed
                    and parsed["detailType"] != locked["detailType"]
                ):
                    raise OpenDartPayloadError(
                        "Deferred projection no longer matches its locked filing.",
                        "INVALID_DEFERRED_PROJECTION",
                    )

                def summary(applied):
                    return {
                        "parseRunId": locked_run["id"],
                        "status": locked_run["status"],
                        "projectionApplied": applied,
                    }

                current_result = locked_run.get("resultJson") or {}
                if locked["effectiveState"] != "ACTIVE":
                    if current_result.get("projectionApplied") is False:
                        locked_run["resultJson"] = {
                            **current_result,
                            "projectionApplied": False,
                            "projectionSuppressedReason": "INACTIVE_FILING",
                            "projectionSkippedAt": iso(utcnow()),
                        }
                        await save(tx, "parse_runs", locked_run)
                    await resolve_review(
                        tx,
                        locked["id"],
                        locked_run["id"],
                        job["requestedByAdminId"],
                        utcnow(),
                        "PROJECTION_SKIPPED_INACTIVE_FILING",
                    )
                    return summary(False)
                if current_result.get("projectionApplied") is True:
                    if locked.get("activeParseRunId") != locked_run["id"]:
                        raise OpenDartPayloadError(
                            "The deferred parse was applied previously but is no longer the active projection.",
                            "INVALID_DEFERRED_PROJECTION",
                        )
                    await resolve_review(
                        tx, locked["id"], locked_run["id"], job["requestedByAdminId"], utcnow()
                    )
                    return summary(True)
                if current_result.get("projectionApplied") is not False or not parsed:
                    raise OpenDartPayloadError(
                        "Locked parse run is no longer a deferred projection.",
                        "INVALID_DEFERRED_PROJECTION",
                    )
                protected = current_result.get("protectedActiveParseRunId")
                if protected is not None and not isinstance(protected, str):
                    raise OpenDartPayloadError(
                        "Deferred projection has an invalid protected baseline.",
                        "INVALID_DEFERRED_PROJECTION",
                    )
                reason = None
                if (
                    "protectedActiveParseRunId" in current_result
                    and locked.get("activeParseRunId") != protected
                ):
                    reason = "활성 projection이 검토 대기 이후 변경되어 오래된 재파싱 적용을 중단했습니다."
                newest = await one(
                    tx,
                    "parse_runs",
                    "filing_id=:id",
                    {"id": locked["id"]},
                    order="created_at DESC,id DESC",
                )
                if not reason and newest and newest["id"] != locked_run["id"]:
                    reason = "더 최신인 parse run이 존재하여 오래된 재파싱 적용을 중단했습니다."
                if reason:
                    locked_run["resultJson"] = {
                        **current_result,
                        "projectionApplied": False,
                        "projectionSuppressedReason": reason,
                    }
                    await save(tx, "parse_runs", locked_run)
                    await update_review_lifecycle(tx, locked["id"], locked_run["id"], reason, True)
                    return summary(False)
                if crosscheck_only:
                    checked_at = iso(utcnow())
                    attempts = current_result.get("crosscheckAttempts")
                    attempts = attempts if isinstance(attempts, list) else []
                    locked_run["resultJson"] = {
                        **current_result,
                        "crosscheck": crosscheck,
                        "crosscheckCheckedAt": checked_at,
                        "crosscheckRequestedByAdminId": job["requestedByAdminId"],
                        "crosscheckAttempts": attempts
                        + [
                            {
                                "checkedAt": checked_at,
                                "requestedByAdminId": job["requestedByAdminId"],
                                "result": crosscheck,
                            }
                        ],
                        "projectionApplied": False,
                    }
                    message = (
                        "공식 요약 근거를 저장했습니다. 원문 행과 비교한 뒤 별도로 적용을 확정해 주세요."
                        if crosscheck.get("status") in ("OK", "NOT_APPLICABLE")
                        else "공식 요약 조회를 완료하지 못했습니다. 결과는 비활성으로 유지하며 다시 검증할 수 있습니다."
                    )
                    locked_run.update(
                        {
                            "status": "PARTIAL",
                            "validationStatus": "REVIEW_REQUIRED",
                            "classificationResult": "REVIEW_REQUIRED",
                            "warningsJson": [
                                warning
                                for warning in locked_run.get("warningsJson") or []
                                if not warning.startswith(
                                    (
                                        "OFFLINE_CROSSCHECK_NOT_RUN:",
                                        "OFFICIAL_SUMMARY_REVIEW_REQUIRED:",
                                    )
                                )
                            ]
                            + ["OFFICIAL_SUMMARY_REVIEW_REQUIRED: " + message],
                        }
                    )
                    await save(tx, "parse_runs", locked_run)
                    await update_review_lifecycle(
                        tx,
                        locked["id"],
                        locked_run["id"],
                        f"공식 요약 검증 {crosscheck.get('status')}: 원문 필드와 개별 비교·확정 필요",
                        True,
                    )
                    return {**summary(False), "crosscheckOnly": True}
                if source_review(parsed["detailType"]):
                    if not source_review_confirmed(locked_run):
                        raise OpenDartPayloadError(
                            "This candidate requires an explicit administrator source review.",
                            "PARSE_SOURCE_REVIEW_REQUIRED",
                        )
                    if not await one(
                        tx, "admins", "id=:id AND is_active=1", {"id": job["requestedByAdminId"]}
                    ):
                        raise OpenDartPayloadError(
                            "The projection requester is no longer an active administrator.",
                            "INVALID_PROJECTION_REQUESTER",
                        )
                links = await snapshot_links(tx, locked["id"], parsed["detailType"])
                await replace_projection(
                    tx,
                    locked["id"],
                    locked["companyId"],
                    parsed,
                    crosscheck,
                    locked["effectiveState"],
                    locked_run["id"],
                )
                warnings = warnings_of(parsed) + text_warnings(parsed)
                needs_relink = bool(links["relations"] or links["matches"])
                if needs_relink:
                    warnings.append(
                        {
                            "code": "MANUAL_PLAN_LINK_INVALIDATED_BY_APPROVED_REPARSE",
                            "message": "Administrator-approved projection replacement invalidated prior manual D005/D002 links; the prior decisions remain in the parse audit snapshot and require relinking.",
                        }
                    )
                confidence = confidence_of(parsed)
                status = (
                    "PARTIAL"
                    if confidence < 0.8
                    or any(map(warning_requires_review, warnings))
                    or not crosscheck_allows_projection(
                        parsed["detailType"], crosscheck, locked["rceptNo"]
                    )
                    else "SUCCEEDED"
                )
                classification = locked_run.get("classificationResult")
                classification = (
                    classification
                    if classification in ("AI_CONFIRMED", "AI_SUGGESTED")
                    else "RULE_CONFIRMED"
                    if status == "SUCCEEDED"
                    else "REVIEW_REQUIRED"
                )
                now = utcnow()
                locked_run.update(
                    {
                        "status": status,
                        "validationStatus": validation_status(status, warnings),
                        "confidence": f"{confidence:.6f}",
                        "classificationResult": classification,
                        "finishedAt": now,
                        "warningsJson": [f"{w['code']}: {w['message']}" for w in warnings],
                        "errorCode": None,
                        "errorMessage": None,
                        "resultJson": {
                            **current_result,
                            "projectionApplied": True,
                            "projectionAppliedAt": iso(now),
                            "projectionAppliedByAdminId": job["requestedByAdminId"],
                            "supersededManualLinks": links,
                        },
                    }
                )
                await save(tx, "parse_runs", locked_run)
                await self.enrichment.save_issues(tx, locked_run["id"], warnings)
                if crosscheck.get("status") == "FAILED" and crosscheck.get("retryPolicy") in (
                    "SHORT_BACKOFF",
                    "NEXT_KST_DAY",
                ):
                    await self.enrichment.schedule_crosscheck_retry(tx, locked, False, crosscheck)
                locked["activeParseRunId"] = locked_run["id"]
                await save(tx, "filings", locked)
                await resolve_review(
                    tx, locked["id"], locked_run["id"], job["requestedByAdminId"], now
                )
                if needs_relink:
                    key = "relink-after-projection:" + locked_run["id"]
                    if not await one(
                        tx,
                        "reviews",
                        "subject_type='FILING' AND subject_id=:id AND dedupe_key=:key",
                        {"id": locked["id"], "key": key},
                    ):
                        await insert(
                            tx,
                            "reviews",
                            {
                                "subjectType": "FILING",
                                "subjectId": locked["id"],
                                "dedupeKey": key,
                                "reason": "승인된 재파싱으로 기존 수동 거래계획 연결이 무효화되었습니다. 새 projection 후보를 검토해 다시 연결해야 합니다.",
                                "status": "OPEN",
                                "classificationResult": "REVIEW_REQUIRED",
                                "resolution": None,
                                "resolvedByAdminId": None,
                                "resolvedAt": None,
                            },
                        )
                await materialize_event(
                    tx,
                    locked,
                    parsed,
                    locked_run["id"],
                    status,
                    current_result.get("suppressAlerts") is True
                    or (current_result.get("staging") or {}).get("mode") == "OFFLINE_INACTIVE",
                    True,
                )
                return summary(True)
