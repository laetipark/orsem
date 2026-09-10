"""Offline parser corpus audit; prose and raw provenance are represented by hashes."""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Any

from orsem_worker.core import json_text, sha256, utcnow
from orsem_worker.disclosures.parser import parse_disclosure
from orsem_worker.disclosures.policy import (
    CLASSIFIER_VERSION,
    TYPES,
    classify_filing,
    document_kind,
    reuse_fingerprint,
)
from orsem_worker.disclosures.primitives import NORMALIZER_VERSION, PARSER_VERSION
from orsem_worker.disclosures.xml_archive import normalize_xml, read_archive, validation_issue

from .common import AdminError, csv, json_value, prepare_output, read_source, write_private

OMITTED = {"source", "warnings", "provenance", "parserVersion", "tablesScanned"}
TEXT_FIELDS = re.compile(r"Raw$|Name$|^reporterName$|^headerPath$|^title$|^meetingLocation$")


def rows_of(parsed):
    parsed = parsed or {}
    return next(
        (
            parsed[key]
            for key in ("transactions", "changes", "planItems", "agendas", "securities")
            if parsed.get(key) is not None
        ),
        [],
    )


def warnings_of(parsed):
    return sorted(
        {
            w["code"]
            for w in (
                parsed.get("warnings", [])
                + [w for row in rows_of(parsed) for w in row.get("warnings", [])]
            )
        }
    )


def confidence_of(parsed):
    if isinstance(parsed.get("confidence"), (float, int)):
        return parsed["confidence"]
    rows = rows_of(parsed)
    return (
        (0.8 if rows else 0.5)
        if parsed["detailType"] == "D001"
        else min((row.get("confidence", 0) for row in rows), default=0)
        if parsed["detailType"] == "D002"
        else min((0.25 if row.get("nature") == "UNKNOWN" else 0.9 for row in rows), default=0)
    )


def field_map(value, prefix="", output=None):
    output = {} if output is None else output
    if isinstance(value, list):
        output[prefix + ".length"] = len(value)
        for index, item in enumerate(value):
            field_map(item, f"{prefix}[{index}]", output)
    elif isinstance(value, dict):
        for key, child in value.items():
            if key in OMITTED:
                continue
            field = f"{prefix}.{key}" if prefix else key
            if TEXT_FIELDS.search(key) and isinstance(child, str):
                output[field] = {
                    "sha256": sha256(child),
                    "characters": len(child.encode("utf-16-le")) // 2,
                }
            else:
                field_map(child, field, output)
    elif value is None or isinstance(value, (str, int, float, bool)):
        output[prefix] = value
    return output


def field_differences(previous, current):
    if not previous:
        return {"status": "NO_BASELINE", "fields": []}
    if previous.get("detailType") != current.get("detailType"):
        return {"status": "TYPE_CHANGED", "fields": []}
    before, after = field_map(previous), field_map(current)
    fields = [
        {"field": field, "previous": before.get(field), "current": after.get(field)}
        for field in sorted(before.keys() | after.keys())
        if before.get(field) != after.get(field)
    ]
    return {"status": "CHANGED" if fields else "UNCHANGED", "fields": fields}


def provenance_audit(parsed):
    fields = []

    def visit(value, prefix=""):
        if isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, f"{prefix}[{index}]")
        elif isinstance(value, dict):
            for name, source in value.get("provenance", {}).items():
                entry = {"field": f"{prefix}.{name}" if prefix else name}
                for raw, target in (
                    ("sourceEntryName", "source_entry_name"),
                    ("tableIndex", "table_index"),
                    ("rowIndex", "row_index"),
                    ("columnIndex", "column_index"),
                    ("sourceRowIndex", "source_row_index"),
                    ("sourceColumnIndex", "source_column_index"),
                    ("sourcePath", "source_path"),
                ):
                    if raw in source:
                        entry[target] = source[raw]
                entry.update(
                    header_path_sha256=sha256(json_text(source.get("headerPath"))),
                    raw_text_sha256=sha256(source["rawText"]),
                    raw_text_characters=len(source["rawText"].encode("utf-16-le")) // 2,
                )
                fields.append(entry)
            for key, child in value.items():
                if key not in OMITTED:
                    visit(child, f"{prefix}.{key}" if prefix else key)

    visit(parsed)
    return fields


async def audit_corpus(options):
    output = prepare_output(options.output_dir)
    snapshot_bytes = Path(options.snapshot).read_bytes()
    old_bytes = Path(options.old_results).read_bytes()
    snapshot = json_value(snapshot_bytes)
    baseline = {
        row["id"]: (json_value(row.get("result_json"), {}) or {}).get("parsed")
        for row in json_value(old_bytes)
    }
    filings = {f["id"]: f for f in snapshot["filings"]}
    documents = {(d["filing_id"], d["sha256"]): d for d in snapshot["documents"]}
    rows = []
    for run in snapshot["runs"]:
        filing = filings.get(run["filing_id"])
        document = documents.get((run["filing_id"], run["raw_sha256"]))
        previous = baseline.get(run["id"])
        resolved = classify_filing(
            (filing or {}).get("report_name", ""),
            query_detail_type=(filing or {}).get("detail_type"),
        )
        kind = document_kind((filing or {}).get("report_name", ""))
        row: dict[str, Any] = {
            "run_id": run["id"],
            "filing_id": run["filing_id"],
            "rcept_no": (filing or {}).get("rcept_no"),
            "raw_sha256": run["raw_sha256"],
            "raw_document_id": (document or {}).get("id"),
            "old_status": run["status"],
            "stored_filing_type": (filing or {}).get("detail_type"),
            "previous_result_type": (previous or {}).get("detailType"),
            "title_detected_type": resolved["titleDetectedType"],
            "canonical_type": resolved["canonicalType"],
            "classification_status": resolved["classificationStatus"],
            "document_kind": kind,
            "classifier_version": resolved["classifierVersion"],
            "parser_version": PARSER_VERSION,
            "normalizer_version": NORMALIZER_VERSION,
            "reuse_fingerprint": reuse_fingerprint(
                run["raw_sha256"],
                PARSER_VERSION,
                NORMALIZER_VERSION,
                CLASSIFIER_VERSION,
                resolved["canonicalType"],
                kind,
            ),
            "source_verified": False,
            "source_unchanged": False,
            "normalization": [],
            "previous_row_count": len(rows_of(previous)),
        }
        path = None
        try:
            if not filing or not document:
                raise AdminError("SNAPSHOT_REFERENCE_MISSING")
            path, data = read_source(document, run["raw_sha256"])
            row["source_verified"] = True
            archive = read_archive(data)
            row["archive_entries"] = archive["entriesSeen"]
            for candidate in archive["xmlCandidates"]:
                item = {
                    "candidate_name": candidate["entryName"],
                    "candidate_sha256": candidate["sha256"],
                }
                try:
                    normalized = normalize_xml(
                        candidate["xml"], candidate["entryName"], candidate["sha256"]
                    )
                    second = normalize_xml(normalized["xml"], candidate["entryName"])
                    item.update(
                        strict_valid=validation_issue(normalized["xml"]) is None,
                        idempotent=second["xml"] == normalized["xml"]
                        and second["audit"]["status"] == "UNCHANGED",
                        audit=normalized["audit"],
                    )
                except Exception as error:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
                    item.update(
                        strict_valid=False,
                        idempotent=False,
                        error_code=getattr(error, "code", "NORMALIZATION_FAILED"),
                        audit=getattr(error, "normalizationAudit", None),
                    )
                row["normalization"].append(item)
            if resolved["classificationStatus"] == "UNSUPPORTED":
                row["outcome"] = "SKIPPED_UNSUPPORTED"
            elif (
                resolved["classificationStatus"] not in ("CONFIRMED", "MANUAL_OVERRIDE")
                or resolved["canonicalType"] not in TYPES
            ):
                row["outcome"] = "REVIEW_REQUIRED_TYPE"
            else:
                parsed = parse_disclosure(data, resolved["canonicalType"])
                confidence = confidence_of(parsed)
                warnings = warnings_of(parsed)
                row.update(
                    result_type=parsed["detailType"],
                    type_invariant=resolved["canonicalType"] == parsed["detailType"],
                    current_row_count=len(rows_of(parsed)),
                    confidence=confidence,
                    warning_codes=warnings,
                )
                row.update(
                    outcome="REVIEW_REQUIRED"
                    if not row["type_invariant"]
                    or confidence < 0.8
                    or any(
                        w not in ("NO_RECOGNIZED_DISCLOSURE_TABLE", "XML_CANDIDATE_REJECTED")
                        for w in warnings
                    )
                    else "EXTRACTED",
                    field_diff=field_differences(previous, parsed),
                    fields=field_map(parsed),
                    provenance=provenance_audit(parsed),
                    candidate_errors=parsed["source"].get("candidateErrors", []),
                    tables_scanned=parsed["tablesScanned"],
                )
        except Exception as error:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
            row.update(
                outcome="FAILED",
                error_code=getattr(error, "code", "AUDIT_FAILED"),
                candidate_errors=getattr(error, "candidateErrors", []),
            )
        if path and row["source_verified"]:
            row["source_unchanged"] = sha256(path.read_bytes()) == run["raw_sha256"]
        rows.append(row)
    summary = {
        "generated_at": utcnow().isoformat(),
        "snapshot_sha256": sha256(snapshot_bytes),
        "old_results_sha256": sha256(old_bytes),
        "parser_version": PARSER_VERSION,
        "normalizer_version": NORMALIZER_VERSION,
        "classifier_version": CLASSIFIER_VERSION,
        "runs": len(rows),
        "unique_filings": len({r["filing_id"] for r in rows}),
        "original_status_counts": dict(Counter(r["old_status"] for r in rows)),
        "outcomes": dict(Counter(r["outcome"] for r in rows)),
        "canonical_type_counts": dict(Counter(r["canonical_type"] or "UNKNOWN" for r in rows)),
        "sources_verified": sum(r["source_verified"] for r in rows),
        "sources_unchanged": sum(r["source_unchanged"] for r in rows),
        "all_candidates_strict_valid": sum(
            bool(r["normalization"]) and all(c["strict_valid"] for c in r["normalization"])
            for r in rows
        ),
        "all_candidates_idempotent": sum(
            bool(r["normalization"]) and all(c["idempotent"] for c in r["normalization"])
            for r in rows
        ),
        "normalized_variants": sum(
            any((c.get("audit") or {}).get("status") == "NORMALIZED" for c in r["normalization"])
            for r in rows
        ),
        "former_failed": dict(Counter(r["outcome"] for r in rows if r["old_status"] == "FAILED")),
        "field_comparison_counts": dict(
            Counter(r.get("field_diff", {}).get("status", "NOT_PARSED") for r in rows)
        ),
        "note": "Offline parser evidence only. No DB writes, network crosschecks, projection, notifications or production status changes. Extracted row count increases do not prove accuracy. Prose and raw field text are hashed. CSV identifiers should be imported as text.",
    }
    write_private(output, "corpus-audit.json", {"summary": summary, "runs": rows})
    csv_rows = [
        {
            **row,
            "strict_valid": all(c["strict_valid"] for c in row["normalization"]),
            "idempotent": all(c["idempotent"] for c in row["normalization"]),
            "normalization_statuses": [
                (c.get("audit") or {}).get("status", "FAILED") for c in row["normalization"]
            ],
            "diff_status": row.get("field_diff", {}).get("status"),
            "changed_fields": len(row["field_diff"]["fields"]) if row.get("field_diff") else None,
            "provenance_fields": len(row["provenance"]) if "provenance" in row else None,
        }
        for row in rows
    ]
    columns = [
        "run_id",
        "filing_id",
        "rcept_no",
        "raw_sha256",
        "raw_document_id",
        "old_status",
        "stored_filing_type",
        "previous_result_type",
        "title_detected_type",
        "canonical_type",
        "document_kind",
        "classification_status",
        "parser_version",
        "normalizer_version",
        "classifier_version",
        "reuse_fingerprint",
        "source_verified",
        "source_unchanged",
        "strict_valid",
        "idempotent",
        "normalization_statuses",
        "outcome",
        "error_code",
        "type_invariant",
        "previous_row_count",
        "current_row_count",
        "confidence",
        "warning_codes",
        "diff_status",
        "changed_fields",
        "provenance_fields",
    ]
    write_private(output, "corpus-audit.csv", csv(csv_rows, columns))
    write_private(output, "summary.json", summary)
    return summary
