"""Startup must reject unconverted legacy repeats before changing queue state."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from orsem_worker.scheduling import configure, require_native_schedulers


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "job_name",
    ["dispatch-processing-outbox", "poll-opendart", "ingest-krx-eod"],
)
@pytest.mark.parametrize("key", ["df7a2b91" * 4, "DF7A2B91" * 4])
async def test_managed_legacy_hash_with_native_metadata_blocks_startup(job_name, key):
    redis = SimpleNamespace(
        zrange=AsyncMock(return_value=[key]), hget=AsyncMock(return_value=job_name)
    )
    queue = SimpleNamespace(
        isJobScheduler=AsyncMock(return_value=True),
        getJobSchedulers=AsyncMock(),
        removeJobScheduler=AsyncMock(),
        upsertJobScheduler=AsyncMock(),
    )
    ctx = SimpleNamespace(
        redis=redis,
        config=SimpleNamespace(redisPrefix="isolated"),
        queues={"orsem-outbox": queue},
        enqueue=AsyncMock(),
    )

    # No connector settings are present: the guard must fail before reading the
    # desired plan, removing disabled schedules, or publishing initial jobs.
    with pytest.raises(RuntimeError, match="Legacy repeat"):
        await configure(ctx)

    redis.hget.assert_awaited_once_with(f"isolated:orsem-outbox:repeat:{key}", "name")
    queue.getJobSchedulers.assert_not_awaited()
    queue.removeJobScheduler.assert_not_awaited()
    queue.upsertJobScheduler.assert_not_awaited()
    ctx.enqueue.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "job_name", "has_metadata", "accepted"),
    [
        ("processing-outbox-minute", "dispatch-processing-outbox", True, True),
        ("processing-outbox-minute", "dispatch-processing-outbox", False, False),
        ("0" * 32, "external-scheduler", True, True),
        ("0" * 32, "external-scheduler", False, False),
    ],
)
async def test_native_ids_and_unmanaged_schedules_keep_existing_rules(
    key, job_name, has_metadata, accepted
):
    ctx = SimpleNamespace(
        redis=SimpleNamespace(
            zrange=AsyncMock(return_value=[key]), hget=AsyncMock(return_value=job_name)
        ),
        config=SimpleNamespace(redisPrefix="isolated"),
        queues={
            "orsem-outbox": SimpleNamespace(isJobScheduler=AsyncMock(return_value=has_metadata))
        },
    )
    if accepted:
        await require_native_schedulers(ctx)
    else:
        with pytest.raises(RuntimeError, match="Legacy repeat"):
            await require_native_schedulers(ctx)
