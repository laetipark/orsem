"""Run only against the explicitly selected disposable migration database."""

import os
from datetime import timedelta
from types import SimpleNamespace

import pytest

from orsem_worker.core import Database, identifier, utcnow
from orsem_worker.outbox import ProcessingOutbox
from orsem_worker.push import PushDelivery, PushFanout
from orsem_worker.storage import insert, one, select, update

URL = os.environ.get("ORSEM_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not URL, reason="Set ORSEM_TEST_DATABASE_URL to the disposable test database."
)


@pytest.mark.asyncio
async def test_company_override_is_persisted_isolated_and_rechecked_at_delivery():
    assert "/orsem_test?" in URL and "unix_socket=/tmp/" in URL
    db = Database.from_url(URL)
    now = utcnow()
    old = now - timedelta(minutes=5)

    class Rollback(Exception):
        pass

    try:
        with pytest.raises(Rollback):
            async with db.transaction() as tx:
                company = await insert(
                    tx, "companies", {"market": "OTHER", "nameKo": "Python integration company"}
                )
                other = await insert(
                    tx, "companies", {"market": "OTHER", "nameKo": "Other integration company"}
                )
                member = await insert(
                    tx, "members", {"providerSubject": identifier(), "status": "APPROVED"}
                )
                second = await insert(
                    tx, "members", {"providerSubject": identifier(), "status": "APPROVED"}
                )
                owner = "MEMBER:" + member["id"]
                owner2 = "MEMBER:" + second["id"]
                for account in (owner, owner2):
                    await insert(
                        tx,
                        "notification_preferences",
                        {
                            "ownerKey": account,
                            "enabled": True,
                            "topicsJson": ["FILINGS"],
                            "watchlistOnly": True,
                            "filingTypesJson": ["D001", "D002", "D005"],
                            "createdAt": old,
                            "updatedAt": old,
                        },
                    )
                    await insert(
                        tx,
                        "push_subscriptions",
                        {
                            "ownerKey": account,
                            "endpoint": "https://fcm.googleapis.com/" + identifier(),
                            "endpointHash": identifier().replace("-", "") * 2,
                            "p256dh": "fake-key",
                            "auth": "fake-auth",
                            "deviceName": "test",
                            "expirationTime": None,
                            "lastSeenAt": old,
                            "createdAt": old,
                            "updatedAt": old,
                        },
                    )
                await insert(
                    tx,
                    "notification_company_preferences",
                    {
                        "ownerKey": owner,
                        "companyId": company["id"],
                        "enabled": True,
                        "createdAt": old,
                        "updatedAt": old,
                    },
                )
                event = await insert(
                    tx,
                    "event_clusters",
                    {
                        "canonicalEventType": "INSIDER_OWNERSHIP",
                        "companyId": company["id"],
                        "firstObservedAt": now,
                        "state": "DETECTED",
                        "evidenceGrade": "OFFICIAL",
                        "summary": "test",
                        "dedupeKey": identifier(),
                    },
                )
                alert = await insert(
                    tx,
                    "alerts",
                    {
                        "eventClusterId": event["id"],
                        "idempotencyKey": identifier(),
                        "status": "PENDING",
                        "alertVersion": 1,
                        "payloadJson": {"phase": "DETECTED", "companyName": "test"},
                        "createdAt": now,
                    },
                )
                fanout = PushFanout()
                assert await fanout.enqueue_alert(tx, alert, now) == 1
                assert await fanout.enqueue_alert(tx, alert, now) == 0
                deliveries = await select(
                    tx, "push_deliveries", "alert_id=:id", {"id": alert["id"]}
                )
                assert len(deliveries) == 1 and deliveries[0]["ownerKey"] == owner
                assert await fanout.resolve_delivery(tx, deliveries[0], utcnow()) is not None
                await update(
                    tx,
                    "notification_company_preferences",
                    {"enabled": False},
                    "owner_key=:owner AND company_id=:id",
                    {"owner": owner, "id": company["id"]},
                )
                assert await fanout.resolve_delivery(tx, deliveries[0], utcnow()) is None
                assert (
                    await one(
                        tx,
                        "notification_company_preferences",
                        "owner_key=:owner AND company_id=:id",
                        {"owner": owner, "id": other["id"]},
                    )
                    is None
                )

                class Client:
                    enabled = True

                    async def send(self, *args):
                        raise AssertionError("Disabled company must never reach push transport")

                ctx = SimpleNamespace(db=tx)
                result = await PushDelivery(ctx, fanout, Client()).dispatch()
                assert result["sent"] == 0
                delivery = await one(tx, "push_deliveries", "id=:id", {"id": deliveries[0]["id"]})
                assert delivery["status"] == "CANCELLED"
                raise Rollback()
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_processing_outbox_claims_once_preserves_job_payload_and_dedupe():
    assert "/orsem_test?" in URL and "unix_socket=/tmp/" in URL
    db = Database.from_url(URL)

    class Rollback(Exception):
        pass

    try:
        with pytest.raises(Rollback):
            async with db.transaction() as tx:
                data = {"filingId": identifier(), "parseRunId": identifier()}
                key = "integration:" + identifier()
                row = await insert(
                    tx,
                    "job_outbox",
                    {
                        "kind": "REVIEW_PARSE_WITH_AI",
                        "dedupeKey": key,
                        "payloadJson": data,
                        "status": "PENDING",
                        "availableAt": utcnow(),
                        "attempts": 0,
                        "lockedAt": None,
                        "lastError": None,
                    },
                )
                emitted = []

                async def enqueue(*args):
                    emitted.append(args)

                async def alerts():
                    return {"claimed": 0, "dispatched": 0}

                async def push():
                    return {"configured": False, "claimed": 0, "sent": 0}

                ctx = SimpleNamespace(
                    db=tx,
                    enqueue=enqueue,
                    services={"push_delivery": SimpleNamespace(dispatch=push)},
                )
                dispatcher = ProcessingOutbox(ctx)
                dispatcher.alerts = SimpleNamespace(dispatch=alerts)
                result = await dispatcher.dispatch()
                assert result["processing"] == {"claimed": 1, "dispatched": 1}
                assert (
                    len(emitted) == 1 and emitted[0][2] == data and emitted[0][3]["attempts"] == 9
                )
                assert len(emitted[0][3]["jobId"]) == 64
                assert (await dispatcher.dispatch())["processing"]["claimed"] == 0
                assert (await one(tx, "job_outbox", "id=:id", {"id": row["id"]}))[
                    "status"
                ] == "COMPLETED"
                raise Rollback()
    finally:
        await db.close()
