"""Persist OpenDART circuit status and deduplicated operational alerts."""

from __future__ import annotations

from ..core import identifier, json_text, utcnow
from .storage import insert, one, save


class OpenDartHealth:
    def __init__(self, ctx, client):
        self.ctx, self.client = ctx, client

    async def record_open_dart(
        self, status: str, message: str | None, metadata: dict | None = None
    ) -> None:
        now = utcnow()
        await self.ctx.db.execute(
            """INSERT INTO connector_health
            (id,connector,status,message,checked_at,last_success_at,last_failure_at,metadata_json,created_at,updated_at)
            VALUES (:id,'opendart',:status,:message,:now,:success,:failure,:metadata,:now,:now)
            ON DUPLICATE KEY UPDATE status=VALUES(status),message=VALUES(message),checked_at=VALUES(checked_at),
            last_success_at=IF(:status='HEALTHY',:now,last_success_at),
            last_failure_at=IF(:status IN ('FAILED','DEGRADED'),:now,last_failure_at),metadata_json=VALUES(metadata_json),updated_at=:now""",
            {
                "id": identifier(),
                "status": status,
                "message": message,
                "now": now,
                "success": now if status == "HEALTHY" else None,
                "failure": now if status in ("DEGRADED", "FAILED") else None,
                "metadata": json_text({"rightsMode": "OFFICIAL_PUBLIC_DATA", **(metadata or {})}),
            },
        )

    async def open_dart_paused_until(self):
        return await self.client.paused_until()

    async def pause_open_dart_until(
        self, until, message="OpenDART daily request limit reached."
    ) -> None:
        value = until.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        checkpoint = await one(
            self.ctx.db, "source_checkpoints", "connector='OPENDART' AND stream='GLOBAL_RATE_LIMIT'"
        )
        checkpoint = checkpoint or {
            "connector": "OPENDART",
            "stream": "GLOBAL_RATE_LIMIT",
            "lastSuccessDate": None,
            "cursor": None,
            "lastSuccessAt": None,
        }
        checkpoint["metadataJson"] = {
            **(checkpoint.get("metadataJson") or {}),
            "pausedUntil": value,
            "pauseReason": "OPENDART_STATUS_020",
        }
        await save(self.ctx.db, "source_checkpoints", checkpoint)
        await self.record_open_dart("DEGRADED", message, {"pausedUntil": value, "status": "020"})
        key = f"connector:opendart:020:{value}:WEB:v1"
        async with self.ctx.db.transaction() as tx:
            if await one(tx, "alerts", "idempotency_key=:key", {"key": key}):
                return
            payload = {
                "phase": "OPERATIONAL",
                "connector": "OPENDART",
                "status": "020",
                "pausedUntil": value,
                "message": message,
            }
            alert = await insert(
                tx,
                "alerts",
                {
                    "eventClusterId": None,
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
