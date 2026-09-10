"""Provider and scheduling boundaries use synthetic responses; no external I/O."""

from datetime import UTC, datetime, timedelta
from itertools import pairwise
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from orsem_worker.disclosures import register
from orsem_worker.disclosures.client import OpenDartClient, add_days
from orsem_worker.disclosures.ingestion import OpenDartIngestion, enqueue_backfill
from orsem_worker.disclosures.primitives import OpenDartApiError


def context(client=None):
    ctx = SimpleNamespace(
        config=SimpleNamespace(openDartApiKey="synthetic-only", pollOverlapDays=3),
        db=SimpleNamespace(execute=AsyncMock()),
        enqueue=AsyncMock(),
        services={
            "opendart_health": SimpleNamespace(
                record_open_dart=AsyncMock(), pause_open_dart_until=AsyncMock()
            )
        },
    )
    if client is None:
        client = SimpleNamespace(paused_until=AsyncMock(return_value=None))
    return ctx, OpenDartIngestion(ctx, client)


async def test_corp_master_batches_500_and_preserves_identity_columns():
    rows = [
        {
            "corp_code": f"{n:08d}",
            "stock_code": "00AB12" if n % 2 else "",
            "modify_date": "20260910",
            "corp_name": "synthetic company",
            "corp_eng_name": "",
        }
        for n in range(1001)
    ]
    ctx, service = context(
        SimpleNamespace(
            paused_until=AsyncMock(return_value=None), fetch_corp_codes=AsyncMock(return_value=rows)
        )
    )
    assert await service.sync_corp_codes() == 1001
    calls = ctx.db.execute.call_args_list
    assert [len(call.args[1]) // 7 for call in calls] == [500, 500, 1]
    for call in calls:
        sql, params = call.args
        update = sql.partition("ON DUPLICATE KEY UPDATE")[2]
        assert "id=" not in update and "cik=" not in update
        assert "synthetic company" not in sql
        assert params["date_0"] == "2026-09-10"
    assert calls[0].args[1]["stock_0"] is None
    assert calls[0].args[1]["listed_1"] is True
    assert calls[0].args[1]["stock_1"] == "00AB12"


async def test_corp_invalid_calendar_date_cannot_write_a_partial_chunk():
    rows = [
        {
            "corp_code": "12345678",
            "stock_code": "",
            "modify_date": "20260230",
            "corp_name": "synthetic",
            "corp_eng_name": "",
        }
    ]
    ctx, service = context(
        SimpleNamespace(
            paused_until=AsyncMock(return_value=None), fetch_corp_codes=AsyncMock(return_value=rows)
        )
    )
    with pytest.raises(ValueError):
        await service.sync_corp_codes()
    ctx.db.execute.assert_not_awaited()


async def test_backfill_covers_leap_date_without_overlap_and_preserves_dedupe_options():
    ctx, _ = context()
    payload = {"detailTypes": ["D001", "D005"], "startDate": "2024-01-01", "endDate": "2024-07-01"}
    assert await enqueue_backfill(ctx, payload) == 6
    jobs = [call.args for call in ctx.enqueue.call_args_list]
    assert [(job[2]["startDate"], job[2]["endDate"]) for job in jobs[:3]] == [
        ("2024-01-01", "2024-03-30"),
        ("2024-03-31", "2024-06-28"),
        ("2024-06-29", "2024-07-01"),
    ]
    assert {job[2]["detailType"] for job in jobs} == {"D001", "D005"}
    for queue, name, data, options in jobs:
        assert (
            name == "backfill-opendart"
            and data["suppressAlerts"] is True
            and data["reason"] == "BACKFILL"
        )
        assert options == {
            "jobId": f"backfill-{data['detailType']}-{data['startDate']}-{data['endDate']}",
            "attempts": 3,
            "backoff": {"type": "exponential", "delay": 60000},
            "removeOnComplete": False,
            "removeOnFail": False,
        }


async def test_long_checkpoint_gap_keeps_current_poll_and_suppresses_historical_alerts(monkeypatch):
    import orsem_worker.disclosures.ingestion as module

    checkpoint = {"id": "checkpoint", "lastSuccessDate": "2025-12-01"}
    monkeypatch.setattr(module, "one", AsyncMock(return_value=checkpoint))
    monkeypatch.setattr(module, "insert", AsyncMock(return_value={"id": "run"}))
    saves = AsyncMock(side_effect=lambda db, table, data: data)
    monkeypatch.setattr(module, "save", saves)
    client = SimpleNamespace(
        paused_until=AsyncMock(return_value=None),
        list_disclosures=AsyncMock(return_value={"page": 1, "totalPages": 0, "items": []}),
    )
    ctx, service = context(client)
    result = await service.poll(
        {"detailType": "D002", "endDate": "2026-09-10", "reason": "SCHEDULED"}
    )
    assert result["startDate"] == "2026-06-13" and result["endDate"] == "2026-09-10"
    windows = [call.args[2] for call in ctx.enqueue.call_args_list]
    assert windows[0]["startDate"] == "2025-11-28" and windows[-1]["endDate"] == "2026-06-12"
    for prior, following in pairwise(windows):
        assert add_days(prior["endDate"], 1) == following["startDate"]
    assert all(window["suppressAlerts"] is True for window in windows)
    assert checkpoint["lastSuccessDate"] == "2026-09-10"
    client.list_disclosures.assert_awaited_once_with("D002", "2026-06-13", "2026-09-10", 1)


async def test_explicit_overlong_backfill_is_rejected_before_enqueue(monkeypatch):
    import orsem_worker.disclosures.ingestion as module

    monkeypatch.setattr(module, "one", AsyncMock(return_value=None))
    ctx, service = context()
    with pytest.raises(ValueError, match="90-day"):
        await service.poll(
            {
                "detailType": "D003",
                "reason": "BACKFILL",
                "startDate": "2026-01-01",
                "endDate": "2026-09-10",
            }
        )
    ctx.enqueue.assert_not_awaited()
    ctx.db.execute.assert_not_awaited()


async def test_paused_regular_poll_skips_but_historical_job_retains_retry(monkeypatch):
    import orsem_worker.disclosures.ingestion as module

    monkeypatch.setattr(module, "one", AsyncMock(return_value=None))
    pause = datetime.now(UTC) + timedelta(hours=1)
    ctx, service = context(SimpleNamespace(paused_until=AsyncMock(return_value=pause)))
    result = await service.poll({"detailType": "D002", "endDate": "2026-09-10"})
    assert result["pages"] == result["itemsCreated"] == 0
    with pytest.raises(OpenDartApiError) as error:
        await service.poll({"detailType": "D002", "reason": "BACKFILL"})
    assert error.value.retryPolicy == "NEXT_KST_DAY"
    ctx.db.execute.assert_not_awaited()


async def test_health_write_failure_keeps_successful_corp_result():
    ctx, service = context(
        SimpleNamespace(
            paused_until=AsyncMock(return_value=None), fetch_corp_codes=AsyncMock(return_value=[])
        )
    )
    ctx.services["opendart_health"].record_open_dart.side_effect = OSError("synthetic unavailable")
    assert await service.sync_corp_codes() == 0


@pytest.mark.parametrize("value", [0, False, [], {}])
def test_optional_source_strings_do_not_silently_coerce_false_values(value):
    client = OpenDartClient(SimpleNamespace())
    with pytest.raises(TypeError):
        client.validate_item(
            {
                "corp_code": "12345678",
                "corp_name": "synthetic",
                "modify_date": "20260910",
                "stock_code": value,
            },
            "CORP_CODE",
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("total_page", 1.5),
        ("page_no", 0),
        ("page_count", 0),
        ("total_count", -1),
        ("total_count", "NaN"),
        ("list", None),
    ],
)
async def test_malformed_response_pagination_cannot_advance_checkpoint(field, value):
    client = OpenDartClient(
        SimpleNamespace(config=SimpleNamespace(openDartApiKey="synthetic-only"))
    )
    client.request_json = AsyncMock(return_value={"status": "000", "message": "ok", field: value})
    with pytest.raises((ValueError, TypeError)):
        await client.list_disclosures("D002", "2026-09-01", "2026-09-10", 1)


async def test_disclosure_registration_is_complete_and_has_no_external_side_effects():
    ctx, _ = context()
    handlers = await register(ctx)
    assert set(handlers) == {
        "poll-opendart",
        "backfill-opendart",
        "sync-opendart-corp-codes",
        "enrich-filing",
        "apply-parse-projection",
        "review-parse-with-ai",
    }
    assert handlers["backfill-opendart"] == ctx.services["opendart_ingestion"].poll
    assert callable(ctx.services["enrichment"].record_document_unavailable_review)
    assert callable(ctx.services["opendart"].company_information)
    assert callable(ctx.services["sec_ownership"].ingest_pending)
    ctx.enqueue.assert_not_awaited()
    ctx.db.execute.assert_not_awaited()


async def test_optional_crosscheck_health_failures_preserve_exact_source_result():
    from orsem_worker.disclosures.enrichment import FilingEnrichment

    ctx, _ = context()
    ctx.db.fetch_one = AsyncMock(return_value={"corp_code": "12345678"})
    health = SimpleNamespace(
        record_open_dart=AsyncMock(side_effect=OSError("synthetic unavailable")),
        pause_open_dart_until=AsyncMock(),
    )
    row = {"rcept_no": "20260910000000", "sp_stock_lmp_cnt": "10000"}
    client = SimpleNamespace(fetch_ele_stock=AsyncMock(return_value=[row]))
    service = FilingEnrichment(ctx, client, health)
    result = await service.fetch_crosscheck(
        {"id": "synthetic", "detailType": "D002"}, row["rcept_no"]
    )
    assert result == {"status": "OK", "exactReceiptMatches": [row]}
    client.fetch_ele_stock.side_effect = OpenDartApiError("020", "synthetic limit")
    health.pause_open_dart_until.side_effect = OSError("synthetic persistence unavailable")
    retry = await service.fetch_crosscheck(
        {"id": "synthetic", "detailType": "D002"}, row["rcept_no"]
    )
    assert (
        retry["status"] == "FAILED"
        and retry["apiStatus"] == "020"
        and retry["retryPolicy"] == "NEXT_KST_DAY"
    )


async def test_corp_stream_preserves_source_entities_and_all_rows_across_chunk_boundaries():
    client = OpenDartClient(SimpleNamespace())
    name = "A &amp; B &nbsp; C"
    xml = (
        "<result>"
        + "".join(
            f"<list><corp_code>{index:08d}</corp_code><corp_name>{name}</corp_name><stock_code/><modify_date>20260910</modify_date></list>"
            for index in range(1500)
        )
        + "</result>"
    )
    rows = []
    await client.read_corp_candidate(xml, rows)
    assert (
        len(rows) == 1500
        and rows[0]["corp_code"] == "00000000"
        and rows[-1]["corp_code"] == "00001499"
    )
    assert all(row["corp_name"] == name and row["stock_code"] == "" for row in rows)


async def test_corp_stream_rejects_nested_or_duplicate_required_fields():
    client = OpenDartClient(SimpleNamespace())
    for corp in [
        "<corp_code><value>12345678</value></corp_code>",
        "<corp_code>12345678</corp_code><corp_code>99999999</corp_code>",
    ]:
        with pytest.raises(ValueError):
            await client.read_corp_candidate(
                f"<result><list>{corp}<corp_name>synthetic</corp_name><modify_date>20260910</modify_date></list></result>",
                [],
            )
