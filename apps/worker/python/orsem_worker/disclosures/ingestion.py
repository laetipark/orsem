"""Transactional OpenDART receipts, correction candidates and processing outbox."""

from __future__ import annotations

import logging
import re
from typing import Any

from ..constants import QueueName
from ..core import utcnow
from .client import add_days, kst_date, next_midnight
from .policy import (
    EVENT_TYPES,
    TYPES,
    can_process,
    canonical_report_name,
    should_deliver,
    submission,
    update_classification,
)
from .primitives import OpenDartApiError
from .storage import insert, one, save, select, update


async def enqueue_backfill(ctx, payload: dict) -> int:
    """Enqueue the deployed 90-day chunks with stable BullMQ deduplication IDs."""
    start, end = add_days(payload["startDate"], 0), add_days(payload["endDate"], 0)
    if start > end:
        raise ValueError("Date window start is after end.")
    if any(kind not in TYPES for kind in payload["detailTypes"]):
        raise ValueError("Unsupported OpenDART poll type.")
    count = 0
    for kind in payload["detailTypes"]:
        cursor = start
        while cursor <= end:
            window_end = min(add_days(cursor, 89), end)
            await ctx.enqueue(
                QueueName.POLL,
                "backfill-opendart",
                {
                    "detailType": kind,
                    "startDate": cursor,
                    "endDate": window_end,
                    "suppressAlerts": True,
                    "reason": "BACKFILL",
                },
                {
                    "jobId": f"backfill-{kind}-{cursor}-{window_end}",
                    "attempts": 3,
                    "backoff": {"type": "exponential", "delay": 60000},
                    "removeOnComplete": False,
                    "removeOnFail": False,
                },
            )
            cursor = add_days(window_end, 1)
            count += 1
    return count


class OpenDartIngestion:
    def __init__(self, ctx, client):
        self.ctx, self.client = ctx, client

    async def health(self, status, message, metadata):
        try:
            await self.ctx.services["opendart_health"].record_open_dart(status, message, metadata)
        except Exception as error:  # noqa: BLE001 - health failure must not relabel a completed ingestion
            logging.getLogger(__name__).warning(
                "OpenDART health persistence failed (%s).", type(error).__name__
            )

    async def pause(self, error):
        try:
            await self.ctx.services["opendart_health"].pause_open_dart_until(
                next_midnight(), error.apiMessage
            )
        except Exception as persistence_error:  # noqa: BLE001 - preserve the provider error and retry policy
            logging.getLogger(__name__).warning(
                "OpenDART pause persistence failed (%s).", type(persistence_error).__name__
            )

    async def poll(self, job: dict) -> dict:
        detail_type = job["detailType"]
        if detail_type not in TYPES:
            raise ValueError("Unsupported OpenDART poll type.")
        stream = "DISCLOSURE_LIST:" + detail_type
        checkpoint = await one(
            self.ctx.db,
            "source_checkpoints",
            "connector=:connector AND stream=:stream",
            {"connector": "OPENDART", "stream": stream},
        )
        pause = await self.client.paused_until()
        if pause:
            if job.get("reason") == "BACKFILL":
                raise OpenDartApiError(
                    "020", f"Persisted OpenDART circuit is open until {pause.isoformat()}."
                )
            end = job.get("endDate") or kst_date()
            return {
                "pages": 0,
                "itemsSeen": 0,
                "itemsCreated": 0,
                "startDate": job.get("startDate") or end,
                "endDate": end,
            }
        end = job.get("endDate") or kst_date()
        start = (
            job.get("startDate")
            or add_days(checkpoint["lastSuccessDate"], -self.ctx.config.pollOverlapDays)
            if checkpoint and checkpoint.get("lastSuccessDate")
            else job.get("startDate") or add_days(end, -(self.ctx.config.pollOverlapDays - 1))
        )
        if start > end:
            raise ValueError("OpenDART poll window is inverted.")
        if add_days(start, 89) < end:
            if job.get("startDate") or job.get("reason") == "BACKFILL":
                raise ValueError("OpenDART poll window exceeds the approved 90-day chunk.")
            current = add_days(end, -89)
            await enqueue_backfill(
                self.ctx,
                {
                    "detailTypes": [detail_type],
                    "startDate": start,
                    "endDate": add_days(current, -1),
                },
            )
            start = current
        run = await insert(
            self.ctx.db,
            "ingestion_runs",
            {
                "connector": "OPENDART",
                "stream": stream + ":BACKFILL" if job.get("reason") == "BACKFILL" else stream,
                "windowStart": start,
                "windowEnd": end,
                "status": "PROCESSING",
                "itemsSeen": "0",
                "itemsCreated": "0",
                "startedAt": utcnow(),
                "finishedAt": None,
                "errorMessage": None,
            },
        )
        pages = seen = created = 0
        try:
            page_number = 1
            while True:
                if page_number > 10000:
                    raise ValueError("OpenDART pagination exceeded the safety limit.")
                page = await self.client.list_disclosures(detail_type, start, end, page_number)
                if page["totalPages"] > 10000:
                    raise ValueError("OpenDART declared too many result pages.")
                if page["page"] != page_number and page["totalPages"] > 0:
                    raise ValueError("OpenDART returned an unexpected page number.")
                pages += 1
                seen += len(page["items"])
                for item in page["items"]:
                    created += int(
                        await self.persist_list_item(
                            item, detail_type, run["id"], job.get("suppressAlerts", False)
                        )
                    )
                if page["totalPages"] == 0 or page_number >= page["totalPages"]:
                    break
                page_number += 1
            if job.get("reason") != "BACKFILL":
                checkpoint = checkpoint or {"connector": "OPENDART", "stream": stream}
                checkpoint.update(
                    {
                        "lastSuccessDate": end,
                        "cursor": None,
                        "lastSuccessAt": utcnow(),
                        "metadataJson": {
                            "lastWindowStart": start,
                            "lastPages": pages,
                            "lastItemsSeen": seen,
                        },
                    }
                )
                await save(self.ctx.db, "source_checkpoints", checkpoint)
            run.update(
                {
                    "status": "COMPLETED",
                    "itemsSeen": str(seen),
                    "itemsCreated": str(created),
                    "finishedAt": utcnow(),
                }
            )
            await save(self.ctx.db, "ingestion_runs", run)
            await self.health("HEALTHY", None, {"operation": "LIST", "detailType": detail_type})
            return {
                "pages": pages,
                "itemsSeen": seen,
                "itemsCreated": created,
                "startDate": start,
                "endDate": end,
            }
        except Exception as error:
            run.update(
                {
                    "status": "FAILED",
                    "itemsSeen": str(seen),
                    "itemsCreated": str(created),
                    "finishedAt": utcnow(),
                    "errorMessage": str(error)[:4000],
                }
            )
            await save(self.ctx.db, "ingestion_runs", run)
            if isinstance(error, OpenDartApiError) and error.status == "020":
                await self.pause(error)
            else:
                await self.health(
                    "FAILED"
                    if isinstance(error, OpenDartApiError) and error.retryPolicy == "NONE"
                    else "DEGRADED",
                    str(error)[:4000],
                    {"operation": "LIST", "detailType": detail_type},
                )
            raise

    async def sync_corp_codes(self, _job: dict | None = None) -> int:
        try:
            pause = await self.client.paused_until()
            if pause:
                raise OpenDartApiError(
                    "020", f"Persisted OpenDART circuit is open until {pause.isoformat()}."
                )
            rows = await self.client.fetch_corp_codes()
            for offset in range(0, len(rows), 500):
                params: dict[str, Any] = {}
                values = []
                for index, row in enumerate(rows[offset : offset + 500]):
                    listed = re.fullmatch(r"[0-9A-Z]{6}", row["stock_code"]) is not None
                    source_date = add_days(
                        f"{row['modify_date'][:4]}-{row['modify_date'][4:6]}-{row['modify_date'][6:8]}",
                        0,
                    )
                    fields = {
                        "corp": row["corp_code"],
                        "stock": row["stock_code"] if listed else None,
                        "name": row["corp_name"][:255],
                        "english": row["corp_eng_name"][:255] or None,
                        "market": "KRX" if listed else "OTHER",
                        "listed": listed,
                        "date": source_date,
                    }
                    params.update({f"{key}_{index}": value for key, value in fields.items()})
                    values.append(
                        f"(UUID(),:corp_{index},:stock_{index},:stock_{index},NULL,:name_{index},"
                        f":english_{index},:market_{index},:listed_{index},:date_{index},UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))"
                    )
                # All source values remain bound parameters; preserve IDs on either unique key.
                await self.ctx.db.execute(
                    "INSERT INTO companies (id,corp_code,stock_code,ticker,cik,name_ko,name_en,market,is_listed,source_updated_date,created_at,updated_at) VALUES "
                    + ",".join(values)
                    + " ON DUPLICATE KEY UPDATE corp_code=VALUES(corp_code),stock_code=VALUES(stock_code),ticker=VALUES(ticker),name_ko=VALUES(name_ko),name_en=VALUES(name_en),market=VALUES(market),is_listed=VALUES(is_listed),source_updated_date=VALUES(source_updated_date),updated_at=UTC_TIMESTAMP(3)",
                    params,
                )
            await self.health("HEALTHY", None, {"operation": "CORP_CODE", "rows": len(rows)})
            return len(rows)
        except Exception as error:
            if isinstance(error, OpenDartApiError) and error.status == "020":
                await self.pause(error)
            else:
                await self.health(
                    "FAILED"
                    if isinstance(error, OpenDartApiError) and error.retryPolicy == "NONE"
                    else "DEGRADED",
                    str(error)[:4000],
                    {"operation": "CORP_CODE"},
                )
            raise

    async def persist_list_item(
        self, item: dict, detail_type: str, run_id: str, suppress_alerts: bool
    ) -> bool:
        async with self.ctx.db.transaction() as tx:
            company = await one(tx, "companies", "corp_code=:corp", {"corp": item["corp_code"]})
            if not company and item["stock_code"]:
                await update(
                    tx,
                    "companies",
                    {"corpCode": item["corp_code"], "ticker": item["stock_code"], "isListed": True},
                    "market='KRX' AND stock_code=:stock AND corp_code IS NULL",
                    {"stock": item["stock_code"]},
                )
                company = await one(
                    tx, "companies", "corp_code=:corp", {"corp": item["corp_code"]}, lock=True
                )
            if not company:
                await insert(
                    tx,
                    "companies",
                    {
                        "market": "KRX" if item["stock_code"] else "OTHER",
                        "corpCode": item["corp_code"],
                        "stockCode": item["stock_code"] or None,
                        "ticker": item["stock_code"] or None,
                        "cik": None,
                        "nameKo": item["corp_name"][:255],
                        "nameEn": None,
                        "isListed": bool(item["stock_code"]),
                        "sourceUpdatedDate": None,
                    },
                    ignore=True,
                )
                company = await one(
                    tx, "companies", "corp_code=:corp", {"corp": item["corp_code"]}, lock=True
                )
                if not company:
                    raise ValueError(
                        "Company insert conflicted with another unique identity; corp master reconciliation is required."
                    )
            filing = await one(
                tx,
                "filings",
                "source='OPENDART' AND rcept_no=:receipt",
                {"receipt": item["rcept_no"]},
                lock=True,
            )
            created = filing is None
            state = submission(item["report_nm"], item["rm"])
            now = utcnow()
            raw = {key: value for key, value in item.items() if key != "rcept_dt_raw"}
            raw["rcept_dt"] = item["rcept_dt_raw"]
            fields = {
                "companyId": company["id"],
                "reportName": item["report_nm"][:16000],
                "filerName": item["flr_nm"][:255],
                "rceptDate": item["rcept_dt"],
                "rm": item["rm"][:16000] or None,
                "submissionKind": state["submissionKind"],
                "lastSeenAt": now,
                "rawListJson": raw,
            }
            if filing is None:
                filing = {
                    "source": "OPENDART",
                    "rceptNo": item["rcept_no"],
                    "detailType": detail_type,
                    "effectiveState": state["effectiveState"],
                    "firstObservedAt": now,
                    "activeParseRunId": None,
                    **fields,
                }
            else:
                filing["effectiveState"] = (
                    state["effectiveState"]
                    if filing["effectiveState"] == "ACTIVE"
                    else filing["effectiveState"]
                )
                filing.update(fields)
            update_classification(filing, item["report_nm"], detail_type)
            filing = await save(tx, "filings", filing)
            await insert(
                tx,
                "filing_list_observations",
                {
                    "filingId": filing["id"],
                    "observedAt": now,
                    "queryDetailType": detail_type,
                    "rawListJson": raw,
                    "ingestionRunId": run_id,
                },
            )
            if not can_process(filing):
                return created
            dedupe = f"opendart:{filing['canonicalType']}:{item['rcept_no']}:enrich:{filing['classifierVersion']}"
            if not await one(
                tx, "job_outbox", "kind='ENRICH_FILING' AND dedupe_key=:key", {"key": dedupe}
            ):
                await insert(
                    tx,
                    "job_outbox",
                    {
                        "kind": "ENRICH_FILING",
                        "dedupeKey": dedupe,
                        "payloadJson": {
                            "filingId": filing["id"],
                            "rceptNo": filing["rceptNo"],
                            "detailType": filing["detailType"],
                            "suppressAlerts": suppress_alerts,
                        },
                        "status": "PENDING",
                        "availableAt": now,
                        "attempts": 0,
                        "lockedAt": None,
                        "lastError": None,
                    },
                )
            if created and state["submissionKind"] != "INITIAL":
                await self.link_correction(tx, filing, company["id"])
            elif created:
                await self.link_waiting_corrections(tx, filing, company["id"])
            if created:
                current = await one(tx, "filings", "id=:id", {"id": filing["id"]}) or filing
                await self.detection_event(tx, current, company["nameKo"], suppress_alerts)
            return created

    async def detection_event(self, tx, filing: dict, company_name: str, suppress: bool) -> None:
        if not can_process(filing):
            return
        dedupe = "opendart:filing:" + filing["id"]
        event = await one(tx, "event_clusters", "dedupe_key=:key", {"key": dedupe})
        if not event:
            event = await insert(
                tx,
                "event_clusters",
                {
                    "canonicalEventType": EVENT_TYPES[filing["detailType"]],
                    "companyId": filing["companyId"],
                    "occurredAt": None,
                    "publishedAt": None,
                    "firstObservedAt": filing["firstObservedAt"],
                    "processedAt": None,
                    "state": "CANCELLED"
                    if filing["effectiveState"] in ("CANCELLED", "WITHDRAWN")
                    else "SUPERSEDED"
                    if filing["effectiveState"] == "SUPERSEDED"
                    else "OPEN",
                    "evidenceGrade": "A",
                    "summary": f"[{filing['detailType']} 공시 감지] {company_name} — {filing['reportName']} (원문 분석 중)",
                    "dedupeKey": dedupe,
                    "metadataJson": {
                        "rceptNo": filing["rceptNo"],
                        "detailType": filing["detailType"],
                        "phase": "DETECTED",
                    },
                },
            )
            await insert(
                tx,
                "event_cluster_items",
                {
                    "eventClusterId": event["id"],
                    "itemType": "FILING",
                    "itemId": filing["id"],
                    "isPrimary": True,
                    "provenanceJson": {"source": "OPENDART", "phase": "LIST"},
                },
            )
        if suppress or not should_deliver(filing):
            return
        key = event["id"] + ":WEB:detected:v1"
        if await one(tx, "alerts", "idempotency_key=:key", {"key": key}):
            return
        payload = {
            "phase": "DETECTED",
            "filingId": filing["id"],
            "detailType": filing["detailType"],
            "companyName": company_name,
            "reportName": filing["reportName"],
            "rceptNo": filing["rceptNo"],
            "rceptDate": filing["rceptDate"],
            "officialUrl": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={filing['rceptNo']}",
            "message": "원문 분석 중이며 투자 매매 신호가 아닙니다.",
        }
        alert = await insert(
            tx,
            "alerts",
            {
                "eventClusterId": event["id"],
                "idempotencyKey": key,
                "status": "PENDING",
                "alertVersion": 1,
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

    async def link_correction(self, tx, filing: dict, company_id: str) -> None:
        candidates = await select(
            tx,
            "filings",
            "company_id=:company AND detail_type=:detail AND rcept_date<=:date",
            {"company": company_id, "detail": filing["detailType"], "date": filing["rceptDate"]},
            "ORDER BY rcept_date DESC,first_observed_at DESC LIMIT 20",
        )
        original = next(
            (
                row
                for row in candidates
                if row["id"] != filing["id"]
                and canonical_report_name(row["reportName"])
                == canonical_report_name(filing["reportName"])
                and row["filerName"] == filing["filerName"]
            ),
            None,
        )
        if not original:
            return
        relation_type = (
            "WITHDRAWS"
            if filing["submissionKind"] == "WITHDRAWAL"
            else "CANCELS"
            if filing["effectiveState"] == "CANCELLED"
            else "CORRECTS"
        )
        relation = await one(
            tx,
            "filing_relations",
            "from_filing_id=:from_id AND to_filing_id=:to_id AND relation_type=:type",
            {"from_id": filing["id"], "to_id": original["id"], "type": relation_type},
        )
        if not relation:
            relation = await insert(
                tx,
                "filing_relations",
                {
                    "fromFilingId": filing["id"],
                    "toFilingId": original["id"],
                    "relationType": relation_type,
                    "confidence": "0.700000",
                    "source": "HEURISTIC",
                    "reviewRequired": True,
                    "reviewDecision": "PENDING",
                    "reviewedByAdminId": None,
                    "reviewedAt": None,
                    "matchedFieldsJson": ["companyId", "detailType", "reportName", "filerName"],
                },
            )
        key = "lineage:" + relation["id"]
        if not await one(
            tx,
            "reviews",
            "subject_type='FILING_RELATION' AND subject_id=:id AND dedupe_key=:key",
            {"id": relation["id"], "key": key},
        ):
            await insert(
                tx,
                "reviews",
                {
                    "subjectType": "FILING_RELATION",
                    "subjectId": relation["id"],
                    "dedupeKey": key,
                    "reason": "정정·취소·철회 원공시 연결은 목록 메타데이터 기반 후보이므로 원문 또는 관리자 확인이 필요합니다.",
                    "status": "OPEN",
                    "classificationResult": "REVIEW_REQUIRED",
                    "resolution": None,
                    "resolvedByAdminId": None,
                    "resolvedAt": None,
                },
            )

    async def link_waiting_corrections(self, tx, original: dict, company_id: str) -> None:
        candidates = await select(
            tx,
            "filings",
            "company_id=:company AND detail_type=:detail AND rcept_date>=:date",
            {
                "company": company_id,
                "detail": original["detailType"],
                "date": original["rceptDate"],
            },
            "ORDER BY rcept_date ASC,first_observed_at ASC LIMIT 100",
        )
        for correction in candidates:
            if (
                correction["id"] != original["id"]
                and correction["submissionKind"] != "INITIAL"
                and correction["filerName"] == original["filerName"]
                and canonical_report_name(correction["reportName"])
                == canonical_report_name(original["reportName"])
            ):
                await self.link_correction(tx, correction, company_id)
