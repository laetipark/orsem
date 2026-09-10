"""Transactional outbox dispatch, stable job identities, and alert channel fan-out."""

from __future__ import annotations

from datetime import timedelta

from .alert_gate import (
    FILING_ALERT_INELIGIBLE,
    alert_filing_context,
    filing_alert_is_eligible,
    text,
)
from .constants import QueueName
from .core import sha256, utcnow
from .jobs import validate_job
from .storage import insert, one, select, update


def delivery_payload(alert, payload):
    phase = text(payload.get("phase"))
    headline = text(payload.get("summary")) or " — ".join(
        filter(None, (text(payload.get("companyName")), text(payload.get("reportName"))))
    )
    content = "\n".join(
        filter(None, (headline, text(payload.get("message")), text(payload.get("officialUrl"))))
    )[:1900]
    return {
        "alertId": alert["id"],
        "operation": "FOLLOW_UP" if phase == "PARSED" else "SEND",
        "stage": "ENRICHED" if phase == "PARSED" else "DETECTED",
        "content": content or "오르셈 새 관찰 이벤트",
        "externalMessageId": None,
    }


class AlertOutbox:
    def __init__(self, ctx):
        self.ctx = ctx

    async def dispatch(self):
        db, now = self.ctx.db, utcnow()
        await update(
            db,
            "alert_outbox",
            {"status": "PENDING", "lastError": "Recovered expired alert outbox lease."},
            "status='SENDING' AND available_at<=:now",
            {"now": now},
        )
        async with db.transaction() as tx:
            rows = await select(
                tx,
                "alert_outbox",
                "status='PENDING' AND available_at<=:now",
                {"now": now},
                "ORDER BY available_at,id LIMIT 50 FOR UPDATE SKIP LOCKED",
            )
            for row in rows:
                row.update(
                    status="SENDING",
                    availableAt=now + timedelta(minutes=10),
                    attempts=row["attempts"] + 1,
                )
                await update(
                    tx,
                    "alert_outbox",
                    {
                        "status": row["status"],
                        "availableAt": row["availableAt"],
                        "attempts": row["attempts"],
                    },
                    "id=:id",
                    {"id": row["id"]},
                )
        dispatched = 0
        for row in rows:
            try:
                await self.materialize(row["id"])
                dispatched += 1
            except Exception as error:  # noqa: BLE001 - isolate jobs and redact provider credentials
                await update(
                    db,
                    "alert_outbox",
                    {
                        "status": "FAILED" if row["attempts"] >= 10 else "PENDING",
                        "availableAt": utcnow()
                        + timedelta(seconds=min(3600, 2 ** row["attempts"])),
                        "lastError": f"Alert outbox dispatch failed ({type(error).__name__}).",
                    },
                    "id=:id AND status='SENDING'",
                    {"id": row["id"]},
                )
        return {"claimed": len(rows), "dispatched": dispatched}

    async def external_allowed(self, db, alert):
        if alert.get("eventClusterId") is None:
            return True
        event, memberships, filing = await alert_filing_context(db, alert)
        if not event or not event.get("companyId"):
            return False
        if memberships:
            if not filing:
                return False
            if (
                filing["source"] == "OPENDART"
                and filing["canonicalType"] not in self.ctx.config.openDartGlobalAlertTypes
            ):
                return False
        watch = await one(
            db, "market_leader_company_links", "company_id=:id", {"id": event["companyId"]}
        )
        return bool(watch and watch["realtimeAlerts"] and watch["priority"] in ("P1", "P2"))

    async def ensure_bot(self, db, consumer, device_id, alert_id, key, payload):
        destination = sha256(device_id) if device_id else None
        delivery = await one(
            db,
            "alert_deliveries",
            "alert_id=:alert AND channel=:channel AND destination_hash <=> :destination",
            {"alert": alert_id, "channel": consumer, "destination": destination},
        )
        if not delivery:
            delivery = await insert(
                db,
                "alert_deliveries",
                {
                    "alertId": alert_id,
                    "channel": consumer,
                    "destinationHash": destination,
                    "status": "PENDING",
                    "externalMessageId": None,
                    "sentAt": None,
                    "acknowledgedAt": None,
                    "errorMessage": None,
                },
            )
        existing = await one(
            db,
            "bot_deliveries",
            "consumer=:consumer AND dedupe_key=:key",
            {"consumer": consumer, "key": key},
        )
        if existing:
            if existing.get("alertDeliveryId") != delivery["id"]:
                await update(
                    db,
                    "bot_deliveries",
                    {"alertId": alert_id, "alertDeliveryId": delivery["id"]},
                    "id=:id",
                    {"id": existing["id"]},
                )
            return
        await insert(
            db,
            "bot_deliveries",
            {
                "consumer": consumer,
                "deviceId": device_id,
                "alertId": alert_id,
                "alertDeliveryId": delivery["id"],
                "dedupeKey": key,
                "status": "PENDING",
                "payload": payload,
                "availableAt": utcnow(),
                "leaseUntil": None,
                "externalMessageId": None,
                "acknowledgedAt": None,
                "attempts": 0,
                "lastError": None,
            },
        )

    async def materialize(self, outbox_id):
        snapshot = await one(self.ctx.db, "alert_outbox", "id=:id", {"id": outbox_id})
        if not snapshot or snapshot["status"] != "SENDING":
            return
        async with self.ctx.db.transaction() as tx:
            # Same lock order as correction approval: alert then outbox.
            alert = await one(tx, "alerts", "id=:id", {"id": snapshot["alertId"]}, lock=True)
            outbox = await one(tx, "alert_outbox", "id=:id", {"id": outbox_id}, lock=True)
            if not outbox or outbox["status"] != "SENDING":
                return
            if not alert or outbox["alertId"] != alert["id"]:
                raise ValueError("Alert outbox target missing or changed.")
            if alert["status"] == "CANCELLED" or not await filing_alert_is_eligible(tx, alert):
                await update(
                    tx,
                    "alert_outbox",
                    {"status": "CANCELLED", "lastError": FILING_ALERT_INELIGIBLE},
                    "id=:id",
                    {"id": outbox_id},
                )
                await update(tx, "alerts", {"status": "CANCELLED"}, "id=:id", {"id": alert["id"]})
                return
            if not await one(
                tx,
                "alert_deliveries",
                "alert_id=:id AND channel='WEB' AND destination_hash IS NULL",
                {"id": alert["id"]},
            ):
                await insert(
                    tx,
                    "alert_deliveries",
                    {
                        "alertId": alert["id"],
                        "channel": "WEB",
                        "destinationHash": None,
                        "status": "SENT",
                        "externalMessageId": None,
                        "sentAt": utcnow(),
                        "acknowledgedAt": None,
                        "errorMessage": None,
                    },
                )
            await self.ctx.services["push_fanout"].enqueue_alert(tx, alert)
            payload = delivery_payload(alert, outbox["payload"])
            allowed = await self.external_allowed(tx, alert)
            if allowed and outbox["channel"] in ("WEB", "DISCORD"):
                await self.ensure_bot(
                    tx, "DISCORD", None, alert["id"], outbox["idempotencyKey"] + ":discord", payload
                )
            if allowed and outbox["channel"] in ("WEB", "MESSENGERBOTR"):
                bindings = await select(
                    tx, "bot_room_bindings", "consumer='MESSENGERBOTR' AND is_active=1"
                )
                for device in dict.fromkeys(
                    row["deviceId"] for row in bindings if row.get("deviceId")
                ):
                    await self.ensure_bot(
                        tx,
                        "MESSENGERBOTR",
                        device,
                        alert["id"],
                        f"{outbox['idempotencyKey']}:messenger:{device}",
                        payload,
                    )
            await update(
                tx,
                "alert_outbox",
                {"status": "SENT", "lastError": None},
                "id=:id",
                {"id": outbox_id},
            )
            await update(tx, "alerts", {"status": "SENT"}, "id=:id", {"id": alert["id"]})


class ProcessingOutbox:
    def __init__(self, ctx):
        self.ctx = ctx
        self.alerts = AlertOutbox(ctx)

    async def dispatch(self, _payload=None):
        db, now = self.ctx.db, utcnow()
        await update(
            db,
            "job_outbox",
            {"status": "PENDING", "lockedAt": None, "lastError": "Recovered stale outbox lease."},
            "status='PROCESSING' AND locked_at<:expired",
            {"expired": now - timedelta(minutes=10)},
        )
        async with db.transaction() as tx:
            rows = await select(
                tx,
                "job_outbox",
                "status='PENDING' AND available_at<=:now",
                {"now": now},
                "ORDER BY available_at,id LIMIT 50 FOR UPDATE SKIP LOCKED",
            )
            for row in rows:
                row.update(status="PROCESSING", lockedAt=now, attempts=row["attempts"] + 1)
                await update(
                    tx,
                    "job_outbox",
                    {
                        "status": row["status"],
                        "lockedAt": row["lockedAt"],
                        "attempts": row["attempts"],
                    },
                    "id=:id",
                    {"id": row["id"]},
                )
        dispatched = 0
        for row in rows:
            try:
                raw = row["payloadJson"]
                if not (
                    row["kind"] == "DISCOVER_NEWS_LINKS"
                    and isinstance(raw.get("connectors"), list)
                    and "NAVER" in raw["connectors"]
                ):
                    jobs = {
                        "ENRICH_FILING": (QueueName.FILING, "enrich-filing"),
                        "REVIEW_PARSE_WITH_AI": (QueueName.AI_REVIEW, "review-parse-with-ai"),
                        "APPLY_PARSE_PROJECTION": (QueueName.FILING, "apply-parse-projection"),
                        "DISCOVER_NEWS_LINKS": (QueueName.CONNECTOR_HEALTH, "discover-news-links"),
                    }
                    if row["kind"] not in jobs:
                        raise ValueError("Unsupported processing outbox kind.")
                    queue, name = jobs[row["kind"]]
                    if row["kind"] == "ENRICH_FILING":
                        filing = await one(db, "filings", "id=:id", {"id": raw.get("filingId", "")})
                        if not filing:
                            raise ValueError("Outbox filing no longer exists.")
                        raw = {
                            "filingId": filing["id"],
                            "rceptNo": filing["rceptNo"],
                            "detailType": filing["detailType"],
                            "suppressAlerts": raw.get("suppressAlerts") or False,
                        }
                    payload = validate_job(name, raw)
                    await self.ctx.enqueue(
                        queue,
                        name,
                        payload,
                        {
                            "jobId": sha256(f"{row['dedupeKey']}:{row['attempts']}"),
                            "attempts": 9 if name == "review-parse-with-ai" else 8,
                            "backoff": {"type": "exponential", "delay": 60000},
                            "removeOnComplete": {"count": 1000},
                            "removeOnFail": {"count": 1000},
                        },
                    )
                await update(
                    db,
                    "job_outbox",
                    {"status": "COMPLETED", "lockedAt": None, "lastError": None},
                    "id=:id AND status='PROCESSING'",
                    {"id": row["id"]},
                )
                dispatched += 1
            except Exception as error:  # noqa: BLE001 - isolate jobs and redact provider credentials
                await update(
                    db,
                    "job_outbox",
                    {
                        "status": "FAILED" if row["attempts"] >= 10 else "PENDING",
                        "availableAt": utcnow()
                        + timedelta(seconds=min(3600, 2 ** row["attempts"])),
                        "lockedAt": None,
                        "lastError": f"Processing outbox dispatch failed ({type(error).__name__}).",
                    },
                    "id=:id AND status='PROCESSING'",
                    {"id": row["id"]},
                )
        return {
            "processing": {"claimed": len(rows), "dispatched": dispatched},
            "alerts": await self.alerts.dispatch(),
            "push": await self.ctx.services["push_delivery"].dispatch(),
        }


async def register(ctx):
    dispatcher = ProcessingOutbox(ctx)
    ctx.services["outbox"] = dispatcher
    return {"dispatch-processing-outbox": dispatcher.dispatch}
