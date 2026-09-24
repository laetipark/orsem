"""New receipts notify once validated analysis is ready, across every delivery gate."""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from orsem_worker import alert_gate
from orsem_worker.core import utcnow
from orsem_worker.disclosures import ingestion, projection
from orsem_worker.outbox import delivery_payload
from orsem_worker.push import PushFanout, alert_message, alert_topic, preference_allows

RUN = "00000000-0000-4000-8000-000000000001"


def lifecycle(monkeypatch):
    filing = {
        "id": "filing",
        "companyId": "company",
        "source": "OPENDART",
        "detailType": "D002",
        "canonicalType": "D002",
        "classificationStatus": "CONFIRMED",
        "effectiveState": "ACTIVE",
        "firstObservedAt": utcnow(),
        "rceptNo": "20260924000001",
        "reportName": "임원ㆍ주요주주특정증권등소유상황보고서",
        "activeParseRunId": RUN,
    }
    parsed = {
        "detailType": "D002",
        "reporterName": "홍길동",
        "positionRaw": "대표이사",
        "transactions": [
            {
                "eventDate": "2026-09-24",
                "nature": "MARKET_BUY",
                "direction": "INCREASE",
                "quantity": "1000",
                "methodRaw": "장내매수",
            }
        ],
    }
    state = SimpleNamespace(
        filing=filing,
        parsed=parsed,
        event=None,
        alerts=[],
        outbox=[],
        memberships=[],
        run={
            "id": RUN,
            "filingId": filing["id"],
            "inputType": "D002",
            "extractorType": "D002",
            "resultType": "D002",
            "status": "SUCCEEDED",
            "validationStatus": "PASSED",
            "resultJson": {
                "projectionApplied": True,
                "parsed": parsed,
                "crosscheck": {
                    "status": "OK",
                    "exactReceiptMatches": [{"rcept_no": filing["rceptNo"]}],
                },
            },
        },
    )

    async def one(_db, table, _where, params=None, **_options):
        if table == "companies":
            return {"id": "company", "nameKo": "테스트종목"}
        if table == "filings":
            return state.filing
        if table == "parse_runs":
            return state.run
        if table == "event_clusters":
            return state.event
        if table == "event_cluster_items":
            return next(iter(state.memberships), None)
        if table == "alerts":
            return next(
                (row for row in state.alerts if row["idempotencyKey"] == params["key"]), None
            )
        raise AssertionError(table)

    async def insert(_db, table, data):
        row = {"id": f"{table}-{len(state.alerts)}", **deepcopy(data)}
        if table == "event_clusters":
            state.event = row
        elif table == "event_cluster_items":
            state.memberships.append(row)
        elif table == "alerts":
            state.alerts.append(row)
        elif table == "alert_outbox":
            state.outbox.append(row)
        else:
            raise AssertionError(table)
        return row

    async def save(_db, table, data):
        assert table == "event_clusters"
        state.event = {"id": "event", **deepcopy(data)}
        return state.event

    for module in (ingestion, projection, alert_gate):
        monkeypatch.setattr(module, "one", one)
    for module in (ingestion, projection):
        monkeypatch.setattr(module, "insert", insert)
        monkeypatch.setattr(module, "save", save)
    monkeypatch.setattr(
        alert_gate, "select", AsyncMock(side_effect=lambda *_a, **_k: state.memberships)
    )
    monkeypatch.setattr(projection, "update_review_lifecycle", AsyncMock())
    return state


async def test_new_receipt_waits_for_validated_analysis_then_enqueues_only_once(monkeypatch):
    state = lifecycle(monkeypatch)
    service = ingestion.OpenDartIngestion(None, None)
    await service.detection_event(None, state.filing, "테스트종목", False)
    assert not state.alerts and not state.outbox
    assert "D002" not in state.event["summary"]

    await projection.materialize_event(
        None, state.filing, state.parsed, RUN, "PARTIAL", False, False
    )
    assert not state.alerts
    await projection.materialize_event(None, state.filing, state.parsed, RUN, "SUCCEEDED", False)
    await projection.materialize_event(None, state.filing, state.parsed, RUN, "SUCCEEDED", False)
    assert len(state.alerts) == len(state.outbox) == 1
    alert = state.alerts[0]
    assert await alert_gate.filing_alert_is_eligible(None, alert)
    assert (
        alert["payloadJson"]["summary"]
        == "[매수신호] (테스트종목) 홍길동 대표이사 +1,000주 장내매수"
    )
    assert delivery_payload(alert, alert["payloadJson"])["operation"] == "SEND"
    assert alert_message(alert, "ANALYSIS")["title"] == "오르셈 · [매수신호] · 테스트종목"


@pytest.mark.parametrize("suppression", ["initial", "job", "run", "offline"])
async def test_backfill_and_offline_approval_remain_suppressed_on_later_reprocessing(
    monkeypatch, suppression
):
    state = lifecycle(monkeypatch)
    if suppression != "job":
        await ingestion.OpenDartIngestion(None, None).detection_event(
            None, state.filing, "테스트종목", suppression == "initial"
        )
    if suppression == "run":
        state.run["resultJson"]["suppressAlerts"] = True
    if suppression == "offline":
        state.run["resultJson"]["staging"] = {"mode": "OFFLINE_INACTIVE"}
    await projection.materialize_event(
        None, state.filing, state.parsed, RUN, "SUCCEEDED", suppression == "job"
    )
    await projection.materialize_event(None, state.filing, state.parsed, RUN, "SUCCEEDED", False)
    assert state.event["metadataJson"]["suppressAlerts"] is (suppression in ("initial", "job"))
    assert not state.alerts and not state.outbox


async def test_old_detection_alerts_and_incomplete_results_cannot_reach_any_channel(monkeypatch):
    state = lifecycle(monkeypatch)
    await ingestion.OpenDartIngestion(None, None).detection_event(
        None, state.filing, "테스트종목", False
    )
    alert = {
        "id": "old-alert",
        "eventClusterId": state.event["id"],
        "status": "PENDING",
        "idempotencyKey": "old:detected",
        "payloadJson": {"phase": "DETECTED", "detailType": "D002", "filingId": "filing"},
    }
    assert not await alert_gate.filing_alert_is_eligible(None, alert)
    assert alert_topic(alert, state.event, "INITIAL") is None
    state.run["validationStatus"] = "REVIEW_REQUIRED"
    await projection.materialize_event(None, state.filing, state.parsed, RUN, "PARTIAL", False)
    assert not state.alerts


@pytest.mark.parametrize("topics", [["FILINGS"], ["ANALYSIS"], ["FILINGS", "ANALYSIS"]])
async def test_completed_analysis_reaches_each_subscriber_once(monkeypatch, topics):
    import orsem_worker.push as module

    assert preference_allows(
        owner_key="MEMBER:x",
        subscription_owner_key="MEMBER:x",
        authorized=True,
        enabled=True,
        topics=topics,
        topic="ANALYSIS",
        watchlist_only=False,
        watchlisted=False,
    )
    monkeypatch.setattr(
        module,
        "select",
        AsyncMock(
            side_effect=[
                [{"ownerKey": "MEMBER:x", "topicsJson": topics}],
                [{"id": "subscription", "ownerKey": "MEMBER:x"}],
            ]
        ),
    )
    monkeypatch.setattr(module, "one", AsyncMock(return_value=None))
    writes = AsyncMock()
    monkeypatch.setattr(module, "insert", writes)
    fanout = PushFanout()
    monkeypatch.setattr(fanout, "can_receive", AsyncMock(return_value=True))
    assert await fanout.enqueue(None, "ANALYSIS", "company", utcnow(), "alert:x", {}, utcnow()) == 1
    writes.assert_awaited_once()


async def test_temporary_maintenance_does_not_permanently_mute_a_live_receipt(monkeypatch):
    state = lifecycle(monkeypatch)
    await ingestion.OpenDartIngestion(None, None).detection_event(
        None, state.filing, "테스트종목", False
    )
    await projection.materialize_event(None, state.filing, state.parsed, RUN, "SUCCEEDED", True)
    assert state.event["metadataJson"]["suppressAlerts"] is False
    assert not state.alerts
    await projection.materialize_event(None, state.filing, state.parsed, RUN, "SUCCEEDED", False)
    assert len(state.alerts) == 1


def test_push_titles_keep_mixed_signals_and_sec_detection_keeps_its_topic():
    alert = {
        "eventClusterId": "event",
        "status": "PENDING",
        "id": "alert",
        "payloadJson": {"summary": "[매수신호] [매도신호] (종목) +100주 장내매수 · -50주 장내매도"},
    }
    assert alert_message(alert, "ANALYSIS")["title"] == "오르셈 · [매수신호] [매도신호]"
    alert["payloadJson"]["phase"] = "DETECTED"
    event = {"state": "VERIFIED", "canonicalEventType": "INSIDER_OWNERSHIP"}
    assert alert_topic(alert, event, "INITIAL", "SEC") == "FILINGS"
    assert alert_topic(alert, event, "INITIAL", "OPENDART") is None


@pytest.mark.parametrize(
    "change",
    [
        {},
        {"membership": False},
        {"source": "IR"},
        {"rightsMode": "NO_REDISTRIBUTION"},
        {"sourcePolicyJson": {"notifyAllowed": False}},
        {"sourcePolicyJson": {"policyVersion": 2}},
        {"sourceItemId": None},
    ],
)
async def test_sec_source_item_context_preserves_delivery_and_rechecks_current_rights(
    monkeypatch, change
):
    import orsem_worker.push as module

    event = {
        "id": "sec-event",
        "companyId": "us-company",
        "state": "OPEN",
        "canonicalEventType": "OTHER",
        "metadataJson": {"source": "SEC", "sourceItemId": change.get("sourceItemId", "sec-source")},
    }
    alert = {
        "id": "sec-alert",
        "eventClusterId": event["id"],
        "status": "PENDING",
        "payloadJson": {"phase": "DETECTED"},
    }
    source = {
        "id": "sec-source",
        "source": "SEC",
        "rightsMode": "OFFICIAL_PUBLIC_DATA",
        "sourcePolicyJson": {"notifyAllowed": True},
        **change,
    }
    monkeypatch.setattr(module, "filing_alert_is_eligible", AsyncMock(return_value=True))
    monkeypatch.setattr(module, "alert_filing_context", AsyncMock(return_value=(event, [], None)))

    async def one(_db, table, where, params):
        if table == "event_cluster_items":
            assert "item_type='SOURCE_ITEM'" in where
            assert params == {"event": "sec-event", "source": "sec-source"}
            return {"itemId": "sec-source"} if change.get("membership", True) else None
        assert table == "source_items" and params == {"id": "sec-source"}
        return source

    monkeypatch.setattr(module, "one", one)
    fanout = PushFanout()
    assert await fanout.context(None, alert) == (
        ("FILINGS", "us-company", None) if not change else (None, None, None)
    )
    if not change:
        # The same context path runs immediately before network delivery.
        source["sourcePolicyJson"] = {"notifyAllowed": False}
        assert await fanout.context(None, alert) == (None, None, None)
