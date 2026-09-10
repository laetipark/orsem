"""Immutable parse runs, review gates and transactional projection activation."""

from __future__ import annotations

import logging
from datetime import timedelta

from ..core import utcnow
from .client import next_midnight
from .lifecycle import (
    assert_document_kind,
    assert_source_invariant,
    company_lock,
    confidence_of,
    dismiss_review,
    text_warnings,
    update_review_lifecycle,
    validate_persisted,
    validation_status,
    warning_requires_review,
    warnings_of,
)
from .matches import has_confirmed_links
from .parser import parse_disclosure
from .policy import (
    assert_type_invariant,
    can_process,
    crosscheck_allows_projection,
    document_kind,
    reuse_fingerprint,
    source_review,
    update_classification,
)
from .primitives import NORMALIZER_VERSION, PARSER_VERSION, OpenDartApiError, OpenDartPayloadError
from .projection import apply_summary_only, materialize_event, replace_projection
from .storage import insert, one, save
from .xml_archive import merge_candidate_errors


class FilingEnrichment:
    def __init__(self, ctx, client, health):
        self.ctx, self.client, self.health = ctx, client, health

    async def record_health(self, status, message, metadata):
        try:
            await self.health.record_open_dart(status, message, metadata)
        except Exception as error:  # noqa: BLE001 - health persistence must not replace the source result
            logging.getLogger(__name__).warning(
                "OpenDART health persistence failed (%s).", type(error).__name__
            )

    async def pause_health(self, until, message):
        try:
            await self.health.pause_open_dart_until(until, message)
        except Exception as error:  # noqa: BLE001 - retain the provider retry policy
            logging.getLogger(__name__).warning(
                "OpenDART pause persistence failed (%s).", type(error).__name__
            )

    async def enqueue_ai(self, filing_id, run_id, parsed, tx=None):
        return await self.ctx.services["disclosure_ai"].enqueue_review(
            filing_id, run_id, parsed, tx
        )

    async def enqueue_persisted_ai(self, filing, run):
        parsed = validate_persisted((run.get("resultJson") or {}).get("parsed"))
        if parsed["detailType"] != filing["detailType"]:
            raise OpenDartPayloadError(
                "Persisted AI parse type mismatch.", "INVALID_PERSISTED_PARSE_AUDIT"
            )
        return await self.enqueue_ai(filing["id"], run["id"], parsed)

    async def enrich(self, job: dict) -> dict:
        async with self.ctx.db.transaction() as tx:
            snapshot = await one(tx, "filings", "id=:id", {"id": job["filingId"]}, lock=True)
            if not snapshot or snapshot["rceptNo"] != job["rceptNo"]:
                raise ValueError("Filing job does not match a persisted filing.")
            update_classification(snapshot, snapshot["reportName"], job["detailType"])
            await save(tx, "filings", snapshot)
        if not can_process(snapshot):
            raise OpenDartPayloadError(
                f"Document classification {snapshot['classificationStatus']} cannot select a supported extractor.",
                "UNSUPPORTED_FILING_TYPE"
                if snapshot["classificationStatus"] == "UNSUPPORTED"
                else "FILING_TYPE_UNCONFIRMED",
            )
        try:
            pause = await self.client.paused_until()
            if pause:
                raise OpenDartApiError(
                    "020", f"Persisted OpenDART circuit is open until {pause.isoformat()}."
                )
            content = await self.client.fetch_document(job["rceptNo"])
            await self.record_health("HEALTHY", None, {"operation": "DOCUMENT"})
        except Exception as error:
            if isinstance(error, OpenDartApiError) and error.status == "020":
                await self.pause_health(next_midnight(), error.apiMessage)
            else:
                await self.record_health(
                    "FAILED"
                    if isinstance(error, OpenDartApiError) and error.retryPolicy == "NONE"
                    else "DEGRADED",
                    str(error)[:4000],
                    {"operation": "DOCUMENT"},
                )
            raise
        stored = await self.ctx.services["raw_documents"].put(content)
        async with company_lock(self.ctx.db, snapshot["companyId"]):
            document = await one(
                self.ctx.db,
                "filing_documents",
                "filing_id=:id AND sha256=:sha",
                {"id": snapshot["id"], "sha": stored["sha256"]},
            )
            if not document:
                document = await insert(
                    self.ctx.db,
                    "filing_documents",
                    {
                        "filingId": snapshot["id"],
                        "objectUri": stored["objectUri"],
                        "sha256": stored["sha256"],
                        "mediaType": "application/zip",
                        "byteSize": str(stored["byteSize"]),
                        "originalFilename": job["rceptNo"] + ".zip",
                        "retrievedAt": utcnow(),
                        "rightsMode": "OFFICIAL_PUBLIC_DATA",
                    },
                )
            filing = await one(self.ctx.db, "filings", "id=:id", {"id": snapshot["id"]})
            if (
                not filing
                or filing["rceptNo"] != job["rceptNo"]
                or not can_process(filing)
                or filing["canonicalType"] != snapshot["canonicalType"]
                or filing["classifierVersion"] != snapshot["classifierVersion"]
            ):
                raise ValueError("Filing changed while its document was downloaded.")
            fingerprint = reuse_fingerprint(
                stored["sha256"],
                PARSER_VERSION,
                NORMALIZER_VERSION,
                filing["classifierVersion"],
                filing["detailType"],
                document_kind(filing["reportName"])
                if source_review(filing["detailType"])
                else "OTHER",
            )
            run = await one(
                self.ctx.db,
                "parse_runs",
                "filing_id=:id AND reuse_fingerprint=:fingerprint",
                {"id": filing["id"], "fingerprint": fingerprint},
            )
            if run and run["status"] in ("SUCCEEDED", "PARTIAL"):
                parsed = validate_persisted((run.get("resultJson") or {}).get("parsed"))
                assert_type_invariant(filing, run, parsed["detailType"])
                assert_source_invariant(run, parsed)
                assert_document_kind(filing, parsed)
                result = {
                    "parseRunId": run["id"],
                    "status": run["status"],
                    "rawSha256": stored["sha256"],
                }
                projected = (run.get("resultJson") or {}).get("projectionApplied") is not False
                if not projected:
                    await self.enqueue_persisted_ai(filing, run)
                    return result
                prior_crosscheck = (run.get("resultJson") or {}).get("crosscheck")
                if (
                    isinstance(prior_crosscheck, dict)
                    and prior_crosscheck.get("status") == "FAILED"
                ):
                    result = await self.retry_crosscheck(
                        filing, run, parsed, job.get("suppressAlerts", False), stored["sha256"]
                    )
                    await self.enqueue_ai(filing["id"], run["id"], parsed)
                    return result
                async with self.ctx.db.transaction() as tx:
                    locked = await one(tx, "filings", "id=:id", {"id": filing["id"]}, lock=True)
                    if (
                        not locked
                        or locked["rceptNo"] != job["rceptNo"]
                        or locked["canonicalType"] != filing["canonicalType"]
                    ):
                        raise ValueError("Filing changed while reusing its parse run.")
                    assert_type_invariant(locked, run, parsed["detailType"])
                    await dismiss_review(
                        tx,
                        locked["id"],
                        f"document:{locked['rceptNo']}:014",
                        "DOCUMENT_BECAME_AVAILABLE",
                        utcnow(),
                    )
                    await update_review_lifecycle(
                        tx,
                        locked["id"],
                        run["id"],
                        "동일한 유형·버전·원문 파싱 결과를 재사용했습니다.",
                        run["status"] != "SUCCEEDED",
                    )
                await self.enqueue_persisted_ai(filing, run)
                return result
            previous = (
                await one(
                    self.ctx.db,
                    "parse_runs",
                    "filing_id=:id",
                    {"id": filing["id"]},
                    order="created_at DESC,id DESC",
                )
                if not run
                else None
            )
            run = run or {
                "filingId": filing["id"],
                "parserVersion": PARSER_VERSION,
                "rawSha256": stored["sha256"],
                "inputType": filing["detailType"],
                "extractorType": filing["detailType"],
                "resultType": None,
                "normalizerVersion": NORMALIZER_VERSION,
                "classifierVersion": filing["classifierVersion"],
                "reuseFingerprint": fingerprint,
                "supersedesRunId": previous["id"] if previous else None,
            }
            run.update(
                {
                    "status": "RUNNING",
                    "confidence": None,
                    "classificationResult": None,
                    "startedAt": utcnow(),
                    "finishedAt": None,
                    "warningsJson": None,
                    "errorCode": None,
                    "errorMessage": None,
                    "resultJson": None,
                    "resultType": None,
                    "validationStatus": "PENDING",
                    "candidateErrorsJson": None,
                    "normalizationAuditsJson": None,
                }
            )
            run = await save(self.ctx.db, "parse_runs", run)
            parsed_audit = None
            try:
                parsed = parse_disclosure(content, filing["detailType"])
                parsed_audit = parsed
                assert_source_invariant(run, parsed)
                run["resultType"] = parsed["detailType"]
                run["candidateErrorsJson"] = merge_candidate_errors(
                    parsed["source"].get("candidateErrors"),
                    parsed["source"].get("normalizationAudits"),
                )
                run["normalizationAuditsJson"] = parsed["source"].get("normalizationAudits")
                assert_type_invariant(filing, run, parsed["detailType"])
                assert_document_kind(filing, parsed)
                crosscheck = await self.fetch_crosscheck(filing, job["rceptNo"])
                confidence = confidence_of(parsed)
                warnings = warnings_of(parsed) + text_warnings(parsed)
                status = (
                    "PARTIAL"
                    if confidence < 0.8
                    or any(map(warning_requires_review, warnings))
                    or not crosscheck_allows_projection(
                        parsed["detailType"], crosscheck, filing["rceptNo"]
                    )
                    else "SUCCEEDED"
                )
                projection_applied = True
                async with self.ctx.db.transaction() as tx:
                    locked = await one(tx, "filings", "id=:id", {"id": filing["id"]}, lock=True)
                    if (
                        not locked
                        or locked["rceptNo"] != job["rceptNo"]
                        or locked["canonicalType"] != filing["canonicalType"]
                        or locked["classifierVersion"] != run["classifierVersion"]
                    ):
                        raise ValueError("Filing changed while its document was parsed.")
                    assert_type_invariant(locked, run, parsed["detailType"])
                    assert_document_kind(locked, parsed)
                    newest = await one(
                        tx,
                        "parse_runs",
                        "filing_id=:id",
                        {"id": locked["id"]},
                        order="created_at DESC,id DESC",
                    )
                    superseded = bool(newest and newest["id"] != run["id"])
                    protects_manual = locked["effectiveState"] == "ACTIVE" and (
                        await has_confirmed_links(tx, locked["id"], "D002")
                        or await has_confirmed_links(tx, locked["id"], "D005")
                    )
                    if (
                        protects_manual
                        or superseded
                        or status != "SUCCEEDED"
                        or source_review(parsed["detailType"])
                    ):
                        projection_applied, status = False, "PARTIAL"
                        if source_review(parsed["detailType"]):
                            warnings.append(
                                {
                                    "code": "SOURCE_REVIEW_REQUIRED",
                                    "message": "이 공시 유형은 관리자 원문 대조와 별도 확정 후 활성화합니다.",
                                }
                            )
                        if superseded:
                            warnings.append(
                                {
                                    "code": "SUPERSEDED_PARSE_INPUT",
                                    "message": "A newer parse input exists; this older input cannot replace the active projection.",
                                }
                            )
                        if protects_manual:
                            warnings.append(
                                {
                                    "code": "MANUAL_PLAN_LINK_REQUIRES_REVIEW",
                                    "message": "A manually confirmed D005/D002 execution link references the active projection. The new parse was retained for audit, but projection replacement was deferred for administrator review.",
                                }
                            )
                    else:
                        await replace_projection(
                            tx,
                            locked["id"],
                            locked["companyId"],
                            parsed,
                            crosscheck,
                            locked["effectiveState"],
                            run["id"],
                        )
                    run.update(
                        {
                            "status": status,
                            "validationStatus": validation_status(status, warnings),
                            "confidence": f"{confidence:.6f}",
                            "classificationResult": "RULE_CONFIRMED"
                            if status == "SUCCEEDED"
                            else "REVIEW_REQUIRED",
                            "finishedAt": utcnow(),
                            "warningsJson": [
                                f"{warning['code']}: {warning['message']}" for warning in warnings
                            ],
                            "resultJson": {
                                "parsed": parsed,
                                "crosscheck": crosscheck,
                                "rawDocumentId": document["id"],
                                "queuedDetailType": job["detailType"],
                                "projectionApplied": projection_applied,
                                **(
                                    {"protectedActiveParseRunId": locked.get("activeParseRunId")}
                                    if not projection_applied
                                    else {}
                                ),
                            },
                        }
                    )
                    await save(tx, "parse_runs", run)
                    if crosscheck.get("status") == "FAILED" and crosscheck.get("retryPolicy") in (
                        "SHORT_BACKOFF",
                        "NEXT_KST_DAY",
                    ):
                        await self.schedule_crosscheck_retry(
                            tx, locked, job.get("suppressAlerts", False), crosscheck
                        )
                    await self.save_issues(tx, run["id"], warnings)
                    await dismiss_review(
                        tx,
                        locked["id"],
                        f"document:{locked['rceptNo']}:014",
                        "DOCUMENT_BECAME_AVAILABLE",
                        run["finishedAt"],
                    )
                    if projection_applied:
                        locked["activeParseRunId"] = run["id"]
                        await save(tx, "filings", locked)
                    await materialize_event(
                        tx,
                        locked,
                        parsed,
                        run["id"],
                        status,
                        job.get("suppressAlerts", False) or not projection_applied,
                        projection_applied,
                    )
                    await self.enqueue_ai(locked["id"], run["id"], parsed, tx)
                return {"parseRunId": run["id"], "status": status, "rawSha256": stored["sha256"]}
            except Exception as error:
                run.update(
                    {
                        "status": "FAILED",
                        "confidence": None,
                        "classificationResult": "REVIEW_REQUIRED",
                        "finishedAt": utcnow(),
                        "warningsJson": None,
                        "errorCode": error.code
                        if isinstance(error, OpenDartPayloadError)
                        else "PARSER_FAILED",
                        "errorMessage": str(error)[:4000],
                        "validationStatus": "REJECTED",
                    }
                )
                if isinstance(error, OpenDartPayloadError):
                    audits = (
                        (parsed_audit or {}).get("source", {}).get("normalizationAudits", [])
                        + [
                            item["normalizationAudit"]
                            for item in error.candidateErrors
                            if item.get("normalizationAudit")
                        ]
                        + ([error.normalizationAudit] if error.normalizationAudit else [])
                    )
                    run["normalizationAuditsJson"] = audits
                    run["candidateErrorsJson"] = merge_candidate_errors(
                        error.candidateErrors
                        + (parsed_audit or {}).get("source", {}).get("candidateErrors", []),
                        audits,
                    )
                run["resultJson"] = {
                    **({"parsed": parsed_audit} if parsed_audit else {}),
                    "projectionApplied": False,
                    "protectedActiveParseRunId": filing.get("activeParseRunId"),
                    "queuedDetailType": job["detailType"],
                }
                await save(self.ctx.db, "parse_runs", run)
                await self.record_parse_failure(
                    filing, run["id"], run["errorCode"], run["errorMessage"]
                )
                raise

    async def fetch_crosscheck(self, filing: dict, receipt: str) -> dict:
        kind = filing["detailType"]
        if source_review(kind):
            return {"status": "NOT_APPLICABLE", "reason": f"NO_SUMMARY_API_FOR_{kind}"}
        if kind == "D005":
            return {"status": "NOT_APPLICABLE"}
        if kind not in ("D001", "D002"):
            raise OpenDartPayloadError("Unsupported crosscheck type.", "UNSUPPORTED_FILING_TYPE")
        company = await self.ctx.db.fetch_one(
            "SELECT company.corp_code FROM filings filing INNER JOIN companies company ON company.id=filing.company_id WHERE filing.id=:id",
            {"id": filing["id"]},
        )
        if not company or not company["corp_code"]:
            return {"status": "NO_CORP_CODE"}
        try:
            rows = (
                await self.client.fetch_major_stock(company["corp_code"])
                if kind == "D001"
                else await self.client.fetch_ele_stock(company["corp_code"])
            )
            await self.record_health(
                "HEALTHY", None, {"operation": "MAJORSTOCK" if kind == "D001" else "ELESTOCK"}
            )
            matches = [row for row in rows if row["rcept_no"] == receipt]
            return {
                "status": "OK" if matches else "NO_RECEIPT_MATCH",
                "exactReceiptMatches": matches,
            }
        except Exception as error:  # noqa: BLE001 - optional crosscheck failure is retained for retry
            if isinstance(error, OpenDartApiError) and error.status == "020":
                await self.pause_health(next_midnight(), error.apiMessage)
            else:
                await self.record_health(
                    "FAILED"
                    if isinstance(error, OpenDartApiError) and error.retryPolicy == "NONE"
                    else "DEGRADED",
                    str(error)[:4000],
                    {"operation": "SUMMARY"},
                )
            return {
                "status": "FAILED",
                "message": str(error)[:4000],
                "apiStatus": error.status if isinstance(error, OpenDartApiError) else None,
                "retryPolicy": error.retryPolicy
                if isinstance(error, OpenDartApiError)
                else "SHORT_BACKOFF",
            }

    async def schedule_crosscheck_retry(self, tx, filing, suppress, crosscheck):
        key = f"opendart:{filing['id']}:summary-crosscheck"
        outbox = await one(
            tx, "job_outbox", "kind='ENRICH_FILING' AND dedupe_key=:key", {"key": key}
        )
        outbox = outbox or {
            "kind": "ENRICH_FILING",
            "dedupeKey": key,
            "payloadJson": {
                "filingId": filing["id"],
                "rceptNo": filing["rceptNo"],
                "detailType": filing["detailType"],
                "suppressAlerts": suppress,
            },
        }
        outbox.update(
            {
                "status": "PENDING",
                "availableAt": next_midnight()
                if crosscheck.get("retryPolicy") == "NEXT_KST_DAY"
                else utcnow() + timedelta(minutes=15),
                "lockedAt": None,
                "lastError": None,
            }
        )
        await save(tx, "job_outbox", outbox)

    async def save_issues(self, tx, run_id, warnings):
        await tx.execute("DELETE FROM parse_issues WHERE parse_run_id=:id", {"id": run_id})
        for warning in warnings:
            await insert(
                tx,
                "parse_issues",
                {
                    "parseRunId": run_id,
                    "severity": "WARNING" if warning_requires_review(warning) else "INFO",
                    "code": warning["code"][:128],
                    "message": warning["message"],
                    "contextJson": warning,
                },
            )

    async def retry_crosscheck(self, filing, run, parsed, suppress, raw_sha256):
        assert_type_invariant(filing, run, parsed["detailType"])
        crosscheck = await self.fetch_crosscheck(filing, filing["rceptNo"])
        warnings = warnings_of(parsed) + text_warnings(parsed)
        confidence = confidence_of(parsed)
        status = (
            "PARTIAL"
            if confidence < 0.8
            or any(map(warning_requires_review, warnings))
            or not crosscheck_allows_projection(parsed["detailType"], crosscheck, filing["rceptNo"])
            else "SUCCEEDED"
        )
        async with self.ctx.db.transaction() as tx:
            locked = await one(tx, "filings", "id=:id", {"id": filing["id"]}, lock=True)
            locked_run = await one(
                tx,
                "parse_runs",
                "id=:id AND filing_id=:filing AND raw_sha256=:sha",
                {"id": run["id"], "filing": filing["id"], "sha": raw_sha256},
                lock=True,
            )
            if (
                not locked
                or not locked_run
                or locked["rceptNo"] != filing["rceptNo"]
                or locked["detailType"] != parsed["detailType"]
                or locked.get("activeParseRunId") != locked_run["id"]
                or (locked_run.get("resultJson") or {}).get("projectionApplied") is not True
            ):
                raise OpenDartPayloadError(
                    "Persisted crosscheck retry no longer matches its active projection.",
                    "STALE_CROSSCHECK_RETRY",
                )
            assert_type_invariant(locked, locked_run, parsed["detailType"])
            await apply_summary_only(tx, locked, crosscheck)
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
                        **(locked_run.get("resultJson") or {}),
                        "parsed": parsed,
                        "crosscheck": crosscheck,
                        "projectionApplied": True,
                        "crosscheckRetriedAt": now.isoformat(timespec="milliseconds").replace(
                            "+00:00", "Z"
                        ),
                    },
                }
            )
            await save(tx, "parse_runs", locked_run)
            await self.save_issues(tx, locked_run["id"], warnings)
            if crosscheck.get("status") == "FAILED" and crosscheck.get("retryPolicy") in (
                "SHORT_BACKOFF",
                "NEXT_KST_DAY",
            ):
                await self.schedule_crosscheck_retry(tx, locked, suppress, crosscheck)
            await dismiss_review(
                tx,
                locked["id"],
                f"document:{locked['rceptNo']}:014",
                "DOCUMENT_BECAME_AVAILABLE",
                now,
            )
            await dismiss_review(
                tx, locked["id"], f"parse:{locked_run['id']}:failed", "PARSE_RETRY_SUCCEEDED", now
            )
            await materialize_event(tx, locked, parsed, locked_run["id"], status, suppress, True)
        return {"parseRunId": run["id"], "status": status, "rawSha256": raw_sha256}

    async def record_parse_failure(self, filing, run_id, code, message):
        async with self.ctx.db.transaction() as tx:
            locked = await one(tx, "filings", "id=:id", {"id": filing["id"]}, lock=True)
            if not locked:
                return
            event = await one(
                tx, "event_clusters", "dedupe_key=:key", {"key": "opendart:filing:" + locked["id"]}
            )
            if event and not locked.get("activeParseRunId"):
                event.update(
                    {
                        "state": "CANCELLED"
                        if locked["effectiveState"] in ("CANCELLED", "WITHDRAWN")
                        else "SUPERSEDED"
                        if locked["effectiveState"] == "SUPERSEDED"
                        else "REVIEW_REQUIRED",
                        "summary": f"[{locked['detailType']} 원문 분석 실패] {locked['reportName']}",
                        "metadataJson": {
                            **(event.get("metadataJson") or {}),
                            "phase": "PARSE_FAILED",
                            "parseRunId": run_id,
                            "errorCode": code,
                        },
                    }
                )
                await save(tx, "event_clusters", event)
            run = await one(tx, "parse_runs", "id=:id", {"id": run_id})
            await tx.execute("DELETE FROM parse_issues WHERE parse_run_id=:id", {"id": run_id})
            for candidate in (run or {}).get("candidateErrorsJson") or []:
                await insert(
                    tx,
                    "parse_issues",
                    {
                        "parseRunId": run_id,
                        "severity": "ERROR",
                        "code": str(candidate.get("errorCode", "XML_CANDIDATE_REJECTED"))[:128],
                        "message": str(candidate.get("originalMessage", message))[:20000],
                        "contextJson": candidate,
                    },
                )
            await update_review_lifecycle(tx, locked["id"], run_id, f"{code}: {message}", True)

    async def record_document_unavailable_review(self, job: dict, message: str) -> None:
        async with self.ctx.db.transaction() as tx:
            filing = await one(
                tx,
                "filings",
                "id=:id AND rcept_no=:receipt",
                {"id": job["filingId"], "receipt": job["rceptNo"]},
                lock=True,
            )
            if not filing:
                return
            event = await one(
                tx, "event_clusters", "dedupe_key=:key", {"key": "opendart:filing:" + filing["id"]}
            )
            if event and not filing.get("activeParseRunId"):
                event.update(
                    {
                        "state": "CANCELLED"
                        if filing["effectiveState"] in ("CANCELLED", "WITHDRAWN")
                        else "SUPERSEDED"
                        if filing["effectiveState"] == "SUPERSEDED"
                        else "REVIEW_REQUIRED",
                        "processedAt": utcnow(),
                        "summary": f"[{filing['detailType']} 원문 대기 만료] {filing['reportName']}",
                        "metadataJson": {
                            **(event.get("metadataJson") or {}),
                            "phase": "DOCUMENT_UNAVAILABLE",
                            "apiStatus": "014",
                        },
                    }
                )
                await save(tx, "event_clusters", event)
            key = f"document:{filing['rceptNo']}:014"
            if not await one(
                tx,
                "reviews",
                "subject_type='FILING' AND subject_id=:id AND dedupe_key=:key",
                {"id": filing["id"], "key": key},
            ):
                await insert(
                    tx,
                    "reviews",
                    {
                        "subjectType": "FILING",
                        "subjectId": filing["id"],
                        "dedupeKey": key,
                        "reason": f"OpenDART 원문이 10분/1시간/6시간 재시도 후에도 준비되지 않았습니다: {message[:1000]}",
                        "status": "OPEN",
                        "classificationResult": "REVIEW_REQUIRED",
                        "resolution": None,
                        "resolvedByAdminId": None,
                        "resolvedAt": None,
                    },
                )
