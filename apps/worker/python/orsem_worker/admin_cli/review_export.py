"""Consistent read-only parser-review CSV export with explicit KST conversion."""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

from dotenv import dotenv_values

from orsem_worker.config import repository_root
from orsem_worker.core import sha256

from .common import AdminError, connect, csv, json_value, prepare_output, write_private

CONTRACT = json.loads(Path(__file__).with_name("review_contract.json").read_text())
QUERIES = CONTRACT["QUERIES"]


def utc_instant(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    if not isinstance(value, str):
        raise AdminError("EXPORT_INVALID_TIMESTAMP")
    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?", value
    ):
        raise AdminError("EXPORT_INVALID_TIMESTAMP")
    try:
        return utc_instant(datetime.fromisoformat(value))
    except ValueError:
        raise AdminError("EXPORT_INVALID_TIMESTAMP") from None


def iso_utc(value):
    return utc_instant(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def kst_instant(value):
    return (
        utc_instant(value)
        .astimezone(timezone(timedelta(hours=9)))
        .isoformat(timespec="milliseconds")
        if value not in (None, "")
        else ""
    )


def source_date(value):
    if value in (None, ""):
        return ""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise AdminError("EXPORT_INVALID_SOURCE_DATE")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise AdminError("EXPORT_INVALID_SOURCE_DATE") from None


def source_dates(value):
    if value is None:
        return None
    try:
        dates = json_value(value)
    except ValueError:
        raise AdminError("EXPORT_INVALID_SOURCE_DATE") from None
    if not isinstance(dates, list):
        raise AdminError("EXPORT_INVALID_SOURCE_DATE")
    return [None if value is None else source_date(value) for value in dates]


async def capture_snapshot(connection):
    transaction = False
    try:
        await connection.query("SET SESSION time_zone='+00:00'")
        await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
        transaction = True
        await connection.query(QUERIES["firstRead"])
        clock = (await connection.query(QUERIES["snapshot"]))[0]
        if (
            clock.get("session_time_zone") != "+00:00"
            or clock.get("isolation_level") != "REPEATABLE-READ"
        ):
            raise AdminError("EXPORT_SNAPSHOT_SESSION_INVALID")
        utc_instant(clock["snapshot_utc"])
        violations = await connection.query(
            QUERIES["clock"].replace("?", "%s"), (clock["snapshot_utc"],)
        )
        if violations:
            raise AdminError("EXPORT_CLOCK_ERROR", {"count": len(violations)})
        failures = await connection.query(QUERIES["failures"])
        reviews = await connection.query(QUERIES["reviews"])
        metrics = await connection.query(QUERIES["metrics"])
        counts = {row["metric"]: int(row["count"]) for row in metrics}
        if counts.get("all_failed_runs") != len(failures) or counts.get("open_reviews") != len(
            reviews
        ):
            raise AdminError("EXPORT_SNAPSHOT_COUNT_MISMATCH")
        return {
            "snapshot_utc": clock["snapshot_utc"],
            "failures": failures,
            "reviews": reviews,
            "metrics": metrics,
        }
    finally:
        if transaction:
            await connection.rollback()


def prepare_rows(rows, snapshot):
    reference = utc_instant(snapshot)
    results = []
    for row in rows:
        for key in (
            "run_created_at",
            "run_updated_at",
            "started_at",
            "finished_at",
            "review_created_at",
            "review_updated_at",
        ):
            if row.get(key) and utc_instant(row[key]) > reference:
                raise AdminError(
                    "EXPORT_CLOCK_ERROR",
                    {"field": key, "id": row.get("parse_run_id") or row.get("review_id")},
                )
        result = {
            **row,
            "snapshot_kst": kst_instant(snapshot),
            "rcept_date": source_date(row.get("rcept_date")),
            "source_url": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo="
            + quote(row["rcept_no"], safe="")
            if row.get("source") == "OPENDART" and row.get("rcept_no")
            else "",
        }
        for key in ("event_dates_json", "planned_start_dates_json", "planned_end_dates_json"):
            result[key] = source_dates(row.get(key))
        for key in (
            "first_observed_at",
            "run_created_at",
            "run_updated_at",
            "started_at",
            "finished_at",
            "review_created_at",
            "review_updated_at",
        ):
            result[key + "_kst"] = kst_instant(row.get(key))
        # asyncmy returns JSON as text; mysql2 returns its structured JSON value.
        for key, value in result.items():
            if (
                key.endswith("_json") or key in ("superseded_by_run_ids", "open_review_ids")
            ) and isinstance(value, str):
                try:
                    result[key] = json.loads(value)
                except ValueError:
                    pass
        results.append(result)
    return results


async def export_audit(options, environment=None, connection=None):
    environment = os.environ if environment is None else environment
    directory = prepare_output(options.output_dir, empty=True)
    owned = None
    try:
        if connection is None:
            values = dotenv_values(repository_root() / ".env", interpolate=False)
            url = (
                environment.get("ORSEM_AUDIT_DATABASE_URL")
                or environment.get("DATABASE_URL")
                or values.get("DATABASE_URL")
            )
            socket = environment.get("ORSEM_AUDIT_SOCKET_PATH")
            if not url or socket and not environment.get("ORSEM_AUDIT_DATABASE_URL"):
                raise AdminError("EXPORT_DATABASE_CONFIG_REQUIRED")
            owned = connection = await connect(url, socket)
        snapshot = await capture_snapshot(connection)
        failures = prepare_rows(snapshot["failures"], snapshot["snapshot_utc"])
        reviews = prepare_rows(snapshot["reviews"], snapshot["snapshot_utc"])
        metrics = [
            {**row, "snapshot_kst": kst_instant(snapshot["snapshot_utc"])}
            for row in snapshot["metrics"]
        ]
        payloads = [
            (name, csv(rows, CONTRACT[columns]), len(rows), CONTRACT[columns])
            for name, rows, columns in (
                ("parser-failures.csv", failures, "FAILURE_COLUMNS"),
                ("open-reviews.csv", reviews, "REVIEW_COLUMNS"),
                ("latest-metrics.csv", metrics, "METRIC_COLUMNS"),
            )
        ]
        manifest = {
            "version": "parser-review-audit-v1",
            "snapshot_utc": iso_utc(snapshot["snapshot_utc"]),
            "snapshot_kst": kst_instant(snapshot["snapshot_utc"]),
            "transaction": "READ ONLY / REPEATABLE READ / MVCC established before reference clock",
            "session_time_zone": "+00:00",
            "instant_encoding": "UTC persisted instants converted once to ISO 8601 +09:00; source date-only values unchanged",
            "csv_encoding": "UTF-8 BOM, quoted cells, CRLF; opaque columns have an apostrophe text marker; formulas neutralized with an apostrophe",
            "note": "All historical FAILED runs are included. Latest metrics use one run per filing ordered by created_at DESC,id DESC. OPEN reviews overlap failures; do not add these counts.",
            "files": [
                {
                    "file": name,
                    "rows": count,
                    "sha256": sha256(content),
                    "opaque_text_columns": [c["label"] for c in columns if c.get("opaque")],
                }
                for name, content, count, columns in payloads
            ],
        }
        for name, content, _, _ in payloads:
            write_private(directory, name, content, exclusive=True)
        write_private(directory, "manifest.json", manifest, exclusive=True)
        return manifest
    finally:
        if owned:
            await owned.close()
