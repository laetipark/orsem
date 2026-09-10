"""Historical publications retain correction semantics with bounded SQL round trips."""

from contextlib import asynccontextmanager
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from orsem_worker.core import utcnow
from orsem_worker.market.indicators import Indicators


class RecordingDatabase:
    def __init__(self):
        self.fetch_all = AsyncMock(return_value=[])
        self.execute = AsyncMock()

    @asynccontextmanager
    async def transaction(self):
        yield self


@pytest.mark.asyncio
async def test_history_batches_keep_nearest_reference_and_first_observation():
    db = RecordingDatabase()
    now = utcnow()
    original = now - timedelta(days=2)
    days = [(date(1903, 1, 1) + timedelta(days=i)).isoformat() for i in range(401)]
    existing = [
        {
            "instrument_id": "us2y",
            "kind": "DAILY",
            "period": days[0],
            "source_date": days[0],
            "value": "1",
            "provider_at": None,
            "first_observed_at": original,
        }
    ]
    # Three current-observation batches, then three reference batches.
    db.fetch_all.side_effect = [existing, [], [], [], [], []]
    service = Indicators(SimpleNamespace(db=db), SimpleNamespace(enabled=False))
    rows = [
        {
            "instrumentId": "us2y",
            "kind": "DAILY",
            "period": day,
            "sourceDate": day,
            "providerAt": None,
            "value": str(i + 2),
            "raw": {"fixture": i},
        }
        for i, day in enumerate(days)
    ]
    assert await service.save_observations("TREASURY", rows, now) == 402
    assert db.fetch_all.await_count == 6
    assert db.execute.await_count == 3
    writes = []
    for call in db.execute.call_args_list:
        _, params = call.args
        count = len([key for key in params if key.endswith("_instrument_id")])
        assert count <= 200
        writes.extend(
            {
                key.split("_", 1)[1]: value
                for key, value in params.items()
                if key.startswith(f"b{i}_")
            }
            for i in range(count)
        )
    assert writes[0]["first_observed_at"] == original.replace(tzinfo=None)
    assert writes[1]["reference_value"] == "2"
    assert writes[1]["reference_date"] == days[0]
    assert writes[-1]["kind"] == "QUOTE"
    assert writes[-1]["reference_value"] == "401"
    assert writes[-1]["reference_date"] == days[-2]
    assert "first_observed_at`=VALUES" not in db.execute.call_args_list[0].args[0]


@pytest.mark.asyncio
async def test_rejected_stale_correction_never_becomes_reference_or_latest_quote():
    db = RecordingDatabase()
    now = utcnow()
    existing = [
        {
            "instrument_id": "us2y",
            "kind": "DAILY",
            "period": "1905-01-02",
            "source_date": "1905-01-02",
            "value": "8",
            "provider_at": now,
            "first_observed_at": now - timedelta(days=1),
        }
    ]
    db.fetch_all.side_effect = [existing, []]
    service = Indicators(SimpleNamespace(db=db), SimpleNamespace(enabled=False))
    rows = [
        {
            "instrumentId": "us2y",
            "kind": "DAILY",
            "period": day,
            "sourceDate": day,
            "providerAt": now - timedelta(seconds=1),
            "value": value,
            "raw": {},
        }
        for day, value in [("1905-01-02", "999"), ("1905-01-03", "9")]
    ]
    assert await service.save_observations("TREASURY", rows, now) == 2
    params = db.execute.call_args.args[1]
    assert params["b0_reference_value"] == "8"
    assert params["b1_reference_value"] == "8"
    assert all(value != "999" for value in params.values())


@pytest.mark.asyncio
async def test_empty_history_makes_no_lookup_or_write():
    db = RecordingDatabase()
    service = Indicators(SimpleNamespace(db=db), SimpleNamespace(enabled=False))
    assert await service.save_observations("TREASURY", [], utcnow()) == 0
    db.fetch_all.assert_not_awaited()
    db.execute.assert_not_awaited()
