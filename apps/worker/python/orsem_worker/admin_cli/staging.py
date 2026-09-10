"""Explicit, inactive corpus staging; never activates projections or queues work."""

from __future__ import annotations

import asyncio
import math
import os
from collections import Counter
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from orsem_worker.core import db_time, sha256, utcnow
from orsem_worker.disclosures.parser import parse_disclosure
from orsem_worker.disclosures.policy import (
    CLASSIFIER_VERSION,
    TYPES,
    classify_filing,
    document_kind,
    reuse_fingerprint,
)
from orsem_worker.disclosures.primitives import NORMALIZER_VERSION, PARSER_VERSION
from orsem_worker.disclosures.xml_archive import merge_candidate_errors, normalize_xml, read_archive

from .common import AdminError, connect, json_value, prepare_output, read_source, write_private
from .corpus import field_map, rows_of
from .review_export import utc_instant

REJECTED = {
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
}
SKIPPED = {"UNSUPPORTED_FILING_TYPE", "FILING_TYPE_UNCONFIRMED"}


def classify(filing):
    return classify_filing(
        filing["report_name"],
        filing.get("source_detail_type"),
        manual_canonical_type=filing.get("canonical_type")
        if filing.get("classification_status") == "MANUAL_OVERRIDE"
        else None,
    )


def fingerprint(raw, canonical, kind="OTHER"):
    return reuse_fingerprint(
        raw, PARSER_VERSION, NORMALIZER_VERSION, CLASSIFIER_VERSION, canonical, kind
    )


def source_order(candidate):
    return (
        utc_instant(candidate["document"]["retrieved_at"]),
        candidate["document"]["id"],
        utc_instant(candidate["previous"]["started_at"]),
        candidate["previous"]["id"],
    )


def staged_crosscheck(candidate):
    return (
        {"status": "NOT_APPLICABLE", "reason": candidate["errorCode"]}
        if candidate["errorCode"] in SKIPPED
        else {"status": "NOT_RUN"}
    )


def same_json(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
            return False
        if not math.isfinite(left) or not math.isfinite(right):
            return left == right
        if int(left) == left or int(right) == right:
            return left == right
        return abs(left - right) <= 2.220446049250313e-16 * max(1, abs(left), abs(right)) * 4
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list)
            and isinstance(right, list)
            and len(left) == len(right)
            and all(same_json(a, b) for a, b in zip(left, right))
        )
    if isinstance(left, dict) or isinstance(right, dict):
        return (
            isinstance(left, dict)
            and isinstance(right, dict)
            and left.keys() == right.keys()
            and all(same_json(left[k], right[k]) for k in left)
        )
    return type(left) is type(right) and left == right


def assert_reusable(saved, candidate, current, audit_hash):
    result = json_value(saved["result_json"], {})
    staging = result.get("staging") or {}
    expected = {
        "raw_sha256": candidate["previous"]["raw_sha256"],
        "parser_version": PARSER_VERSION,
        "normalizer_version": NORMALIZER_VERSION,
        "classifier_version": candidate["resolved"]["classifierVersion"],
        "input_type": candidate["resolved"]["canonicalType"],
        "extractor_type": candidate["extractorType"],
        "result_type": (candidate["parsed"] or {}).get("detailType"),
        "status": candidate["status"],
        "validation_status": candidate["validation"],
        "error_code": candidate["errorCode"],
    }
    okay = (
        all(saved.get(key) == value for key, value in expected.items())
        and str(saved["confidence"]) == f"{candidate['confidence']:.6f}"
        and result.get("projectionApplied") is False
        and result.get("protectedActiveParseRunId") == current.get("active_parse_run_id")
        and "sourceReview" not in result
        and same_json(result.get("crosscheck"), staged_crosscheck(candidate))
        and same_json(result.get("parsed"), candidate["parsed"])
        and same_json(json_value(saved.get("candidate_errors_json")), candidate["candidateErrors"])
        and same_json(json_value(saved.get("normalization_audits_json")), candidate["audits"])
        and staging.get("mode") == "OFFLINE_INACTIVE"
        and staging.get("corpusSha256") == audit_hash
        and staging.get("sourceDocumentId") == candidate["document"]["id"]
        and staging.get("requiresIndividualReview") is True
        and current.get("active_parse_run_id") != saved["id"]
    )
    if not okay:
        raise AdminError("EXISTING_FINGERPRINT_RUN_NOT_REUSABLE")
    return result


def revalidate(previous, filing, document, evidence):
    if not filing or not document:
        raise AdminError("SNAPSHOT_REFERENCE_MISSING")
    path, data = read_source(document, previous["raw_sha256"])
    resolved = classify(filing)
    kind = document_kind(filing["report_name"])
    evidence_fingerprint = fingerprint(previous["raw_sha256"], resolved["canonicalType"], kind)
    extractor = resolved["canonicalType"] if resolved["canonicalType"] in TYPES else None
    reuse = fingerprint(previous["raw_sha256"], extractor, kind)
    if (
        not evidence
        or evidence.get("raw_sha256") != previous["raw_sha256"]
        or not evidence.get("source_verified")
        or not evidence.get("source_unchanged")
        or evidence.get("reuse_fingerprint") != evidence_fingerprint
    ):
        raise AdminError("CORPUS_EVIDENCE_MISMATCH")
    parsed = None
    error_code = None
    errors = []
    audits = []
    started = utcnow()
    try:
        if resolved["canonicalType"] not in TYPES or resolved["classificationStatus"] not in (
            "CONFIRMED",
            "MANUAL_OVERRIDE",
        ):
            archive = read_archive(data)
            audits = [
                normalize_xml(c["xml"], c["entryName"], c["sha256"])["audit"]
                for c in archive["xmlCandidates"]
            ]
            error_code = (
                "UNSUPPORTED_FILING_TYPE"
                if resolved["classificationStatus"] == "UNSUPPORTED"
                else "FILING_TYPE_UNCONFIRMED"
            )
        else:
            parsed = parse_disclosure(data, resolved["canonicalType"])
            audits = parsed["source"].get("normalizationAudits", [])
            errors = parsed["source"].get("candidateErrors", [])
            if parsed["detailType"] != resolved["canonicalType"]:
                error_code = "FILING_TYPE_INVARIANT"
    except Exception as error:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
        error_code = getattr(error, "code", "PARSER_FAILED")
        errors = getattr(error, "candidateErrors", [])
        audits = [item["normalizationAudit"] for item in errors if item.get("normalizationAudit")]
        if getattr(error, "normalizationAudit", None):
            audits.append(vars(error)["normalizationAudit"])
    if sha256(path.read_bytes()) != previous["raw_sha256"]:
        raise AdminError("SOURCE_CHANGED_DURING_PARSE")
    errors = merge_candidate_errors(errors, audits)
    rows = rows_of(parsed)
    warnings = (parsed or {}).get("warnings", []) + [
        w for row in rows for w in row.get("warnings", [])
    ]
    validation = (
        "REJECTED"
        if error_code or any(w["code"] in REJECTED for w in warnings)
        else "REVIEW_REQUIRED"
    )
    if error_code and error_code not in SKIPPED and evidence.get("outcome") != "FAILED":
        raise AdminError("NEW_FAILURE_SINCE_CORPUS_AUDIT")
    if parsed and evidence.get("fields") is not None and field_map(parsed) != evidence["fields"]:
        raise AdminError("FIELD_DRIFT_SINCE_CORPUS_AUDIT")
    confidence = parsed.get("confidence") if parsed else 0
    if not isinstance(confidence, (int, float)) or not math.isfinite(confidence):
        confidence = (
            (0.8 if rows else 0)
            if parsed and parsed["detailType"] == "D001"
            else min(
                (
                    row.get("confidence", 0.25 if row.get("nature") == "UNKNOWN" else 0.9)
                    for row in rows
                ),
                default=0,
            )
        )
    return {
        "previous": previous,
        "filing": filing,
        "document": document,
        "resolved": resolved,
        "evidence": evidence,
        "extractorType": extractor,
        "reuse": reuse,
        "parsed": parsed,
        "warnings": warnings,
        "candidateErrors": errors,
        "audits": audits,
        "errorCode": error_code,
        "validation": validation,
        "confidence": confidence,
        "startedAt": started,
        "finishedAt": utcnow(),
        "status": "SKIPPED" if error_code in SKIPPED else "FAILED" if error_code else "PARTIAL",
    }


def classification_columns(filing, resolved):
    provenance = (
        {
            **json_value(filing.get("classification_provenance_json"), {}),
            **resolved["classificationProvenanceJson"],
        }
        if filing.get("classification_status") == "MANUAL_OVERRIDE"
        else resolved["classificationProvenanceJson"]
    )
    values = {
        "canonical_type": resolved["canonicalType"],
        "source_detail_type": resolved["sourceDetailType"],
        "title_detected_type": resolved["titleDetectedType"],
        "classification_status": resolved["classificationStatus"],
        "classifier_version": resolved["classifierVersion"],
        "classification_provenance_json": provenance,
    }
    if resolved["canonicalType"] in TYPES:
        values["detail_type"] = resolved["canonicalType"]
    return values


async def stage_review(connection, candidate, run_id, at):
    reviews = await connection.query(
        "SELECT * FROM reviews WHERE subject_type='FILING' AND subject_id=%s AND (review_group='PARSE' OR dedupe_key LIKE 'parse:%%') ORDER BY created_at DESC,id DESC FOR UPDATE",
        (candidate["filing"]["id"],),
    )
    id = str(uuid4())
    code = candidate["errorCode"]
    reason = (
        f"지원 범위 밖 공시({candidate['resolved']['canonicalType']}): 원문 보존, 추출 제외"
        if code == "UNSUPPORTED_FILING_TYPE"
        else "공시 유형 미확정: 원문 보존, 추출 보류"
        if code == "FILING_TYPE_UNCONFIRMED"
        else f"비활성 재검증: {code}"
        if code
        else "비활성 재검증: 원문 교차검증 미실행 및 개별 품질 검토 필요"
    )
    await connection.insert(
        "reviews",
        {
            "id": id,
            "subject_type": "FILING",
            "subject_id": candidate["filing"]["id"],
            "dedupe_key": "parse:" + run_id,
            "review_group": "PARSE",
            "parse_run_id": run_id,
            "reopened_from_review_id": reviews[0]["id"] if reviews else None,
            "superseded_by_review_id": None,
            "status": "RESOLVED",
            "classification_result": "REVIEW_REQUIRED",
            "reason": reason,
            "created_at": at,
            "updated_at": at,
            "resolution": None,
            "resolved_by_admin_id": None,
            "resolved_at": None,
        },
    )
    for review in reviews:
        if review["status"] == "OPEN":
            await connection.update(
                "reviews",
                {
                    "status": "SUPERSEDED",
                    "review_group": "PARSE",
                    "superseded_by_review_id": id,
                    "resolved_at": at,
                    "updated_at": at,
                    "resolution": {
                        "resolution": "SUPERSEDED_BY_STAGED_PARSE",
                        "parseRunId": run_id,
                    },
                },
                "id=%s AND status='OPEN'",
                (review["id"],),
            )
    await connection.update("reviews", {"status": "OPEN"}, "id=%s", (id,))


async def apply_filing(connection, candidates, audit_hash):
    name = "orsem:company:" + candidates[0]["filing"]["company_id"]
    lock = await connection.query("SELECT GET_LOCK(%s,30) AS acquired", (name,))
    if not lock or int(lock[0].get("acquired") or 0) != 1:
        raise AdminError("COMPANY_LOCK_TIMEOUT")
    try:
        return await apply_filing_locked(connection, candidates, audit_hash)
    finally:
        await connection.query("SELECT RELEASE_LOCK(%s)", (name,))


async def apply_filing_locked(connection, candidates, audit_hash):
    await connection.begin()
    try:
        first = candidates[0]
        filings = await connection.query(
            "SELECT * FROM filings WHERE id=%s FOR UPDATE", (first["filing"]["id"],)
        )
        current = filings[0] if filings else None
        if not current or any(
            current[key] != first["filing"][key]
            for key in ("rcept_no", "report_name", "company_id")
        ):
            raise AdminError("FILING_CHANGED_SINCE_SNAPSHOT")
        resolved = classify(current)
        if any(
            resolved[key] != first["resolved"][key]
            for key in ("canonicalType", "classificationStatus")
        ):
            raise AdminError("CLASSIFICATION_CHANGED_SINCE_SNAPSHOT")
        documents = await connection.query(
            "SELECT * FROM filing_documents WHERE filing_id=%s ORDER BY retrieved_at DESC,id DESC",
            (current["id"],),
        )
        newest = max(candidates, key=source_order)
        if not documents or documents[0]["sha256"] != newest["document"]["sha256"]:
            raise AdminError("NEWER_SOURCE_OUTSIDE_CORPUS")
        runs = await connection.query(
            "SELECT * FROM parse_runs WHERE filing_id=%s ORDER BY created_at DESC,id DESC",
            (current["id"],),
        )
        existing = {r["reuse_fingerprint"]: r for r in runs if r.get("reuse_fingerprint")}
        if newest["reuse"] in existing and any(c["reuse"] not in existing for c in candidates):
            raise AdminError("MIXED_REUSE_WOULD_REORDER_SOURCE")
        for candidate in candidates:
            if not any(
                d["sha256"] == candidate["document"]["sha256"]
                and d["object_uri"] == candidate["document"]["object_uri"]
                for d in documents
            ):
                raise AdminError("DOCUMENT_CHANGED_SINCE_SNAPSHOT")
            if candidate["reuse"] in existing:
                assert_reusable(existing[candidate["reuse"]], candidate, current, audit_hash)
        await connection.update(
            "filings", classification_columns(current, resolved), "id=%s", (current["id"],)
        )
        inserted = reused = 0
        for candidate in sorted(candidates, key=source_order):
            saved = existing.get(candidate["reuse"])
            if saved:
                result = assert_reusable(saved, candidate, current, audit_hash)
                candidate.update(
                    stagedRunId=saved["id"],
                    protectedActiveParseRunId=result.get("protectedActiveParseRunId"),
                    reused=True,
                    existingProjectionApplied=False,
                )
                reused += 1
                continue
            latest = await connection.query(
                "SELECT id,created_at FROM parse_runs WHERE filing_id=%s ORDER BY created_at DESC,id DESC LIMIT 1",
                (current["id"],),
            )
            previous_at = utc_instant(latest[0]["created_at"]) if latest else None
            if previous_at and previous_at > utcnow() + timedelta(seconds=1):
                raise AdminError("LATEST_RUN_CLOCK_NOT_UTC_OR_FUTURE")
            while previous_at and previous_at >= utcnow():
                await asyncio.sleep(0.001)
            now = db_time()
            id = str(uuid4())
            code = candidate["errorCode"]
            result = {
                "parsed": candidate["parsed"],
                "crosscheck": staged_crosscheck(candidate),
                "projectionApplied": False,
                "protectedActiveParseRunId": current.get("active_parse_run_id"),
                "staging": {
                    "mode": "OFFLINE_INACTIVE",
                    "corpusSha256": audit_hash,
                    "sourceDocumentId": candidate["document"]["id"],
                    "sourceRetrievedAt": candidate["document"]["retrieved_at"],
                    "rightsMode": candidate["document"]["rights_mode"],
                    "previousRunId": candidate["previous"]["id"],
                    "requiresIndividualReview": True,
                },
            }
            row = {
                "id": id,
                "filing_id": current["id"],
                "parser_version": PARSER_VERSION,
                "normalizer_version": NORMALIZER_VERSION,
                "classifier_version": resolved["classifierVersion"],
                "raw_sha256": candidate["previous"]["raw_sha256"],
                "reuse_fingerprint": candidate["reuse"],
                "input_type": resolved["canonicalType"],
                "extractor_type": candidate["extractorType"],
                "result_type": (candidate["parsed"] or {}).get("detailType"),
                "supersedes_run_id": latest[0]["id"] if latest else None,
                "status": candidate["status"],
                "validation_status": candidate["validation"],
                "confidence": f"{candidate['confidence']:.6f}",
                "classification_result": "REVIEW_REQUIRED",
                "started_at": db_time(candidate["startedAt"]),
                "finished_at": db_time(candidate["finishedAt"]),
                "created_at": now,
                "updated_at": now,
                "error_code": code,
                "error_message": f"Offline inactive parse: {code}" if code else None,
                "warnings_json": [f"{w['code']}: {w['message']}" for w in candidate["warnings"]]
                + [
                    f"OFFLINE_EXTRACTION_SKIPPED: {code}"
                    if code in SKIPPED
                    else "OFFLINE_CROSSCHECK_NOT_RUN: Candidate remains inactive pending source crosscheck and individual quality review."
                ],
                "candidate_errors_json": candidate["candidateErrors"],
                "normalization_audits_json": candidate["audits"],
                "result_json": result,
            }
            await connection.insert("parse_runs", row)
            existing[candidate["reuse"]] = row
            await stage_review(connection, candidate, id, now)
            candidate.update(
                stagedRunId=id, protectedActiveParseRunId=current.get("active_parse_run_id")
            )
            inserted += 1
        await connection.commit()
        return {"inserted": inserted, "reused": reused}
    except BaseException:
        await connection.rollback()
        raise


async def metadata_only(connection, snapshot):
    await connection.begin()
    try:
        rows = await connection.query(
            "SELECT * FROM filings WHERE id=%s FOR UPDATE", (snapshot["id"],)
        )
        filing = rows[0] if rows else None
        if not filing or any(filing[k] != snapshot[k] for k in ("rcept_no", "report_name")):
            raise AdminError("FILING_CHANGED_SINCE_SNAPSHOT")
        await connection.update(
            "filings", classification_columns(filing, classify(filing)), "id=%s", (filing["id"],)
        )
        await connection.commit()
    except BaseException:
        await connection.rollback()
        raise


def manifest(candidates):
    return [
        {
            "previousRunId": c["previous"]["id"],
            "filingId": c["filing"]["id"],
            "reuseFingerprint": c["reuse"],
            "rawSha256": c["previous"]["raw_sha256"],
            "classification": c["resolved"],
            "extractorType": c["extractorType"],
            "protectedActiveParseRunId": c.get(
                "protectedActiveParseRunId", c["filing"].get("active_parse_run_id")
            ),
            "stagedRunId": c.get("stagedRunId"),
            "reused": c.get("reused", False),
            "existingProjectionApplied": c.get("existingProjectionApplied"),
            "status": c["status"],
            "validationStatus": c["validation"],
            "projectionApplied": False,
            "candidateErrors": c["candidateErrors"],
            "normalizationAudits": c["audits"],
            "crosscheck": staged_crosscheck(c),
            "confidence": c["confidence"],
            "warnings": c["warnings"],
            "fieldComparison": c["evidence"].get("field_diff"),
            "sourceDocumentId": c["document"]["id"],
            "sourceRetrievedAt": c["document"]["retrieved_at"],
            "sourceRightsMode": c["document"]["rights_mode"],
            "parsed": c["parsed"],
        }
        for c in candidates
    ]


async def stage_corpus(options, environment=None):
    environment = os.environ if environment is None else environment
    output = prepare_output(options.output_dir, empty=True)
    snapshot_bytes = Path(options.snapshot).read_bytes()
    corpus_bytes = Path(options.corpus).read_bytes()
    snapshot = json_value(snapshot_bytes)
    corpus = json_value(corpus_bytes)
    summary_source = corpus["summary"]
    if (
        summary_source.get("snapshot_sha256") != sha256(snapshot_bytes)
        or summary_source.get("parser_version") != PARSER_VERSION
        or summary_source.get("normalizer_version") != NORMALIZER_VERSION
        or summary_source.get("classifier_version") != CLASSIFIER_VERSION
        or len(snapshot["runs"]) != len(corpus["runs"])
    ):
        raise AdminError("CORPUS_VERSION_OR_SNAPSHOT_MISMATCH")
    filings = {f["id"]: f for f in snapshot["filings"]}
    documents = {(d["filing_id"], d["sha256"]): d for d in snapshot["documents"]}
    evidence = {r["run_id"]: r for r in corpus["runs"]}
    candidates = [
        revalidate(
            previous,
            filings.get(previous["filing_id"]),
            documents.get((previous["filing_id"], previous["raw_sha256"])),
            evidence.get(previous["id"]),
        )
        for previous in snapshot["runs"]
    ]
    parsed_ids = {r["filing_id"] for r in snapshot["runs"]}
    summary = {
        "mode": "APPLY_INACTIVE" if options.apply else "DRY_RUN",
        "inputs": len(candidates),
        "metadataOnlyFilings": sum(f["id"] not in parsed_ids for f in snapshot["filings"]),
        "inserted": 0,
        "reused": 0,
        "activated": 0,
        "networkCrosschecks": 0,
        "notifications": 0,
        "statusCounts": dict(Counter(c["status"] for c in candidates)),
        "validationCounts": dict(Counter(c["validation"] for c in candidates)),
        "corpusSha256": sha256(corpus_bytes),
        "snapshotSha256": sha256(snapshot_bytes),
    }
    write_private(output, "staging-preflight.json", manifest(candidates), atomic=True)
    if options.apply:
        url = environment.get("ORSEM_STAGE_DATABASE_URL")
        if not url:
            raise AdminError("EXPLICIT_STAGE_DATABASE_REQUIRED")
        connection = await connect(url, environment.get("ORSEM_STAGE_SOCKET_PATH"))
        try:
            groups: dict[str, list[dict]] = {}
            for candidate in candidates:
                groups.setdefault(candidate["filing"]["id"], []).append(candidate)
            for group in groups.values():
                counts = await apply_filing(connection, group, summary["corpusSha256"])
                summary["inserted"] += counts["inserted"]
                summary["reused"] += counts["reused"]
                write_private(
                    output,
                    "staging-progress.json",
                    {
                        "updatedAt": utcnow().isoformat(),
                        "inserted": summary["inserted"],
                        "reused": summary["reused"],
                        "completed": [
                            {
                                "filingId": c["filing"]["id"],
                                "previousRunId": c["previous"]["id"],
                                "stagedRunId": c["stagedRunId"],
                                "reused": c.get("reused", False),
                            }
                            for c in candidates
                            if c.get("stagedRunId")
                        ],
                    },
                    atomic=True,
                )
            for filing in snapshot["filings"]:
                if filing["id"] not in groups:
                    await metadata_only(connection, filing)
        finally:
            await connection.close()
    write_private(output, "staging-summary.json", summary, atomic=True)
    write_private(output, "staging-candidates.json", manifest(candidates), atomic=True)
    return summary
