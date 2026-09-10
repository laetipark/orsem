"""Connector health reflects committed ingestion, with no extra news probes."""

from orsem_worker.core import identifier, utcnow

from .common import decoded_row, instant, iso, save_row


class Health:
    def __init__(self, ctx, discovery):
        self.ctx, self.discovery = ctx, discovery

    async def check_all(self, payload=None):
        urls, _, invalid = await self.discovery.ir_sources()
        checks = []
        for adapter in self.discovery.adapters(urls):
            check = adapter.health()
            if check["status"] != "UNCONFIGURED":
                existing = decoded_row(
                    await self.ctx.db.fetch_one(
                        "SELECT * FROM connector_health WHERE connector=:name",
                        {"name": adapter.name.lower()},
                    )
                )
                metadata = existing.get("metadata_json") or {} if existing else {}
                usable = (
                    existing
                    and existing["status"] != "UNCONFIGURED"
                    and metadata.get("healthSource") == check["metadata"]["healthSource"]
                    and (
                        adapter.name != "SEC"
                        or metadata.get("ingestionStateAvailable") is not False
                    )
                )
                check.update(
                    status=existing["status"] if usable else "DEGRADED",
                    message=existing.get("message")
                    if usable
                    else f"Configured; awaiting the first {adapter.name} discovery result.",
                    metadata={
                        **metadata,
                        **check["metadata"],
                        "ingestionStateAvailable": bool(usable),
                    },
                )
            if adapter.name == "IR" and invalid:
                check.update(
                    status="DEGRADED",
                    message=f"{len(invalid)} active IR source(s) violate the approved RSS profile, company or rights contract.",
                )
                check["metadata"]["invalidRegisteredSources"] = len(invalid)
            checks.append(check)
        existing = decoded_row(
            await self.ctx.db.fetch_one("SELECT * FROM connector_health WHERE connector='opendart'")
        )
        pause_service = self.ctx.services.get("opendart_health")
        paused = (
            await pause_service.open_dart_paused_until()
            if pause_service and self.ctx.config.openDartApiKey
            else None
        )
        checks.insert(
            0,
            {
                "connector": "OPENDART",
                "status": "UNCONFIGURED"
                if not self.ctx.config.openDartApiKey
                else "DEGRADED"
                if paused or not existing or not existing.get("last_success_at")
                else "HEALTHY",
                "message": "OPENDART_API_KEY missing"
                if not self.ctx.config.openDartApiKey
                else f"OpenDART request circuit is paused until {iso(paused)}."
                if paused
                else None
                if existing and existing.get("last_success_at")
                else "Configured; awaiting the first successful OpenDART request.",
                "checkedAt": utcnow(),
                "rightsMode": "OFFICIAL_PUBLIC_DATA",
                "metadata": {"pausedUntil": iso(paused)} if paused else {},
            },
        )
        configured = self.ctx.config.marketDataProvider == "toss" and bool(
            self.ctx.config.tossClientId and self.ctx.config.tossClientSecret
        )
        existing = decoded_row(
            await self.ctx.db.fetch_one("SELECT * FROM connector_health WHERE connector='toss'")
        )
        checks.append(
            {
                "connector": "TOSS",
                "status": "UNCONFIGURED"
                if not configured
                else existing["status"]
                if existing and existing["status"] != "UNCONFIGURED"
                else "DEGRADED",
                "message": "Toss is disabled or its credentials are missing."
                if not configured
                else existing.get("message")
                if existing
                else "Configured; awaiting the first successful Toss candle ingestion.",
                "checkedAt": utcnow(),
                "rightsMode": "PRIVATE_DISPLAY_ONLY",
                "metadata": {
                    **(existing.get("metadata_json") or {} if existing else {}),
                    "healthSource": "TOSS_INGESTION",
                    "credentialsConfigured": configured,
                },
            }
        )
        ai = await self.ctx.services["classifier"].probe_health()
        checks.append(
            {
                "connector": "AI",
                "status": ai["status"],
                "message": ai["message"],
                "checkedAt": ai["checkedAt"],
                "rightsMode": "PRIVATE_DISPLAY_ONLY",
                "metadata": {
                    "healthSource": "OPENAI_COMPATIBLE_MODELS",
                    "enabled": ai["enabled"],
                    "configuredModelPresent": ai["configuredModelPresent"],
                },
            }
        )
        for check in checks:
            metadata = check.get("metadata", {})
            if (
                metadata.get("healthSource") == "TOSS_INGESTION"
                and metadata.get("credentialsConfigured")
                or metadata.get("configured")
                and metadata.get("ingestionStateAvailable")
            ):
                continue
            row = decoded_row(
                await self.ctx.db.fetch_one(
                    "SELECT * FROM connector_health WHERE connector=:connector",
                    {"connector": check["connector"].lower()},
                )
            )
            exists = row is not None
            row = row or {
                "id": identifier(),
                "connector": check["connector"].lower(),
                "last_success_at": None,
                "last_failure_at": None,
            }
            preserve = str(metadata.get("healthSource", "")).endswith("_INGESTION")
            if preserve and metadata.get("ingestionStateAvailable") is False:
                row["last_success_at"] = None
            if not preserve and check["status"] == "HEALTHY":
                row["last_success_at"] = utcnow()
            elif not preserve and check["status"] in ("DEGRADED", "FAILED"):
                row["last_failure_at"] = utcnow()
            row.update(
                status=check["status"],
                message=check["message"],
                checked_at=instant(check["checkedAt"]),
                metadata_json={"rightsMode": check["rightsMode"], **metadata},
            )
            await save_row(self.ctx.db, "connector_health", row, new=not exists)
        return checks
