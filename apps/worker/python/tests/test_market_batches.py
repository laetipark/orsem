from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from orsem_worker.market.common import insert_many
from orsem_worker.market.masters import _alpaca_select


@pytest.mark.asyncio
async def test_batches_bound_generator_consumption_and_preserve_values_and_identity():
    consumed = 0
    snapshots = []
    at = datetime(2026, 9, 11, tzinfo=UTC)

    def rows():
        nonlocal consumed
        for i in range(501):
            consumed += 1
            yield {
                "id": f"id-{i}",
                "firstObservedAt": at,
                "rawPayloadJson": {"text": "a'b; -- 한글"},
                "isListed": True,
            }

    async def execute(sql, params):
        snapshots.append((consumed, sql, params))

    count = await insert_many(
        SimpleNamespace(execute=execute),
        "synthetic_rows",
        rows(),
        ["rawPayloadJson", "isListed"],
        chunk_size=200,
    )
    assert count == 501
    assert [row[0] for row in snapshots] == [200, 400, 501]
    assert [len(row[2]) for row in snapshots] == [800, 800, 404]
    ids = []
    for _consumed, sql, params in snapshots:
        assert "a'b" not in sql
        update_sql = sql.split(" ON DUPLICATE KEY UPDATE ")[1]
        assert "first_observed_at" not in update_sql and "`id`" not in update_sql
        for name, value in params.items():
            if name.endswith("_id"):
                ids.append(value)
            elif name.endswith("_first_observed_at"):
                assert value == at.replace(tzinfo=None)
            elif name.endswith("_raw_payload_json"):
                assert value == '{"text":"a\'b; -- 한글"}'
    assert ids == [f"id-{i}" for i in range(501)]


@pytest.mark.asyncio
async def test_empty_batch_performs_no_write_and_generated_ids_are_distinct():
    db = SimpleNamespace(execute=AsyncMock())
    assert await insert_many(db, "companies", []) == 0
    db.execute.assert_not_awaited()
    assert await insert_many(db, "companies", [{"nameKo": "one"}, {"nameKo": "two"}]) == 2
    params = db.execute.await_args.args[1]
    assert params["b0_id"] != params["b1_id"]


@pytest.mark.asyncio
async def test_batch_rejects_mixed_fields_and_unbound_column_names():
    db = SimpleNamespace(execute=AsyncMock())
    with pytest.raises(ValueError):
        await insert_many(db, "companies", [{"nameKo": "one"}, {"nameEn": "two"}])
    with pytest.raises(ValueError):
        await insert_many(db, "companies", [{"nameKo); DROP": "unsafe column"}])
    with pytest.raises(ValueError):
        await insert_many(db, "companies", [{"nameKo": "one"}], chunk_size=501)
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_alpaca_company_lookup_stays_scoped_and_chunks_parameters():
    db = SimpleNamespace(fetch_all=AsyncMock(return_value=[]))
    await _alpaca_select(
        db,
        "companies",
        "ticker",
        (f"SYM{i}" for i in range(1001)),
        condition=" AND market IN ('NASDAQ','NYSE','AMEX')",
    )
    calls = db.fetch_all.await_args_list
    assert [len(call.args[1]) for call in calls] == [500, 500, 1]
    assert all("`ticker` IN (" in call.args[0] and "market IN" in call.args[0] for call in calls)
    assert {value for call in calls for value in call.args[1].values()} == {
        f"SYM{i}" for i in range(1001)
    }
