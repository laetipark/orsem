"""Scheduler advancement regressions; real Redis is opt-in and isolated by prefix."""

import asyncio
import os
from collections import Counter
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from bullmq import Queue
from redis.asyncio import Redis
from redis.exceptions import AuthenticationError, AuthorizationError
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from orsem_worker.constants import QueueName as Q
from orsem_worker.runtime import Worker, processor
from orsem_worker.scheduling import advance_scheduler


def fixture_job():
    return SimpleNamespace(
        repeatJobKey="test-scheduler",
        id="repeat:test-scheduler:123",
        name="dispatch-processing-outbox",
        data={},
        opts={"repeat": {"every": 1000}, "attempts": 3},
    )


@pytest.mark.asyncio
async def test_ordinary_job_does_not_need_scheduler_context():
    assert await advance_scheduler(SimpleNamespace(), Q.OUTBOX, SimpleNamespace()) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [ValueError("invalid cron"), AuthenticationError("denied"), AuthorizationError("denied")],
)
async def test_deterministic_scheduler_errors_are_not_retried(error):
    update = AsyncMock(side_effect=error)
    ctx = SimpleNamespace(
        stopping=asyncio.Event(),
        queues={Q.OUTBOX: SimpleNamespace(jobScheduler=SimpleNamespace(upsertJobScheduler=update))},
    )
    with pytest.raises(type(error)):
        await advance_scheduler(ctx, Q.OUTBOX, fixture_job())
    assert update.await_count == 1


@pytest.mark.asyncio
async def test_scheduler_retry_stops_promptly_when_worker_is_stopping():
    unavailable = asyncio.Event()

    async def update(*args, **kwargs):
        unavailable.set()
        raise RedisConnectionError("synthetic Redis outage")

    ctx = SimpleNamespace(
        stopping=asyncio.Event(),
        queues={Q.OUTBOX: SimpleNamespace(jobScheduler=SimpleNamespace(upsertJobScheduler=update))},
    )
    pending = asyncio.create_task(advance_scheduler(ctx, Q.OUTBOX, fixture_job()))
    await unavailable.wait()
    ctx.stopping.set()
    with pytest.raises(RedisConnectionError):
        await asyncio.wait_for(pending, 0.2)


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get("ORSEM_TEST_REDIS_URL"),
    reason="Set ORSEM_TEST_REDIS_URL to the disposable test Redis.",
)
async def test_python_worker_continues_three_schedulers_with_retry_and_lost_redis_reply(
    monkeypatch,
):
    url = os.environ["ORSEM_TEST_REDIS_URL"]
    assert url == "redis://127.0.0.1:16390/0"
    prefix = "orsem-python-scheduler-" + uuid4().hex
    redis = Redis.from_url(url, decode_responses=True)
    queue = Queue(str(Q.OUTBOX), {"connection": url, "prefix": prefix})
    ctx = SimpleNamespace(queues={Q.OUTBOX: queue}, services={}, stopping=asyncio.Event())
    worker = None
    running = None
    scheduler_ids = ("continuing-alpha", "continuing-beta", "continuing-gamma")
    successful = Counter()
    attempts = Counter()
    active = []
    completed = []
    failures = []
    runtime_errors = []
    lost_reply = False
    real_update = queue.jobScheduler.upsertJobScheduler

    async def update(*args, **kwargs):
        nonlocal lost_reply
        result = await real_update(*args, **kwargs)
        if args[0] == scheduler_ids[0] and not lost_reply and kwargs.get("override") is False:
            # Redis accepted the Lua mutation, but the producer did not receive its reply.
            lost_reply = True
            raise RedisTimeoutError("synthetic lost Redis reply")
        return result

    async def handle(payload):
        tag = payload["tag"]
        attempts[tag] += 1
        if tag == scheduler_ids[0] and attempts[tag] == 1:
            raise RuntimeError("synthetic handler retry")
        successful[tag] += 1
        if all(successful[item] == 3 for item in scheduler_ids):
            # Stop consumption, preserving each already-created fourth occurrence.
            await queue.pause()
        return {"tag": tag, "ok": True}

    try:
        for scheduler_id in scheduler_ids:
            await queue.upsertJobScheduler(
                scheduler_id,
                {"every": 700},
                "dispatch-processing-outbox",
                {"tag": scheduler_id},
                {
                    "attempts": 3,
                    "backoff": {"type": "fixed", "delay": 20},
                    "removeOnComplete": False,
                },
            )
        monkeypatch.setattr(queue.jobScheduler, "upsertJobScheduler", update)
        worker = Worker(
            str(Q.OUTBOX),
            processor(ctx, Q.OUTBOX, {"dispatch-processing-outbox": handle}),
            {"connection": url, "prefix": prefix, "autorun": False, "drainDelay": 0.05},
        )
        worker.on("active", lambda job, *args: active.append(job.id))
        worker.on("completed", lambda job, *args: completed.append(job.id))
        worker.on("failed", lambda job, *args: failures.append(job.id))
        worker.on("error", lambda error, *args: runtime_errors.append(type(error).__name__))
        running = asyncio.create_task(worker.run())
        async with asyncio.timeout(15):
            while len(completed) < 9:
                await asyncio.sleep(0.03)
        assert await queue.isPaused()
        assert successful == Counter({item: 3 for item in scheduler_ids})
        assert lost_reply
        assert len(failures) == 1 and failures[0] in completed
        assert not runtime_errors
        assert len(completed) == len(set(completed)) == 9
        assert Counter(active) == Counter(
            {job_id: (2 if job_id == failures[0] else 1) for job_id in completed}
        )
        assert await redis.zcard(f"{prefix}:{Q.OUTBOX}:completed") == 9
        assert await redis.zcard(f"{prefix}:{Q.OUTBOX}:failed") == 0
        pending = await queue.getJobs(["wait", "paused", "delayed", "prioritized"])
        assert len(pending) == 3
        assert {job.repeatJobKey for job in pending} == set(scheduler_ids)
        assert len({job.id for job in pending}) == 3
        assert not set(completed) & {job.id for job in pending}
        for row in await queue.getJobSchedulers():
            assert row["iterationCount"] == 4
            expected = f"repeat:{row['key']}:{int(row['next'])}"
            assert expected in {job.id for job in pending}
        retried = next(job for job in await queue.getJobs(["completed"]) if job.id == failures[0])
        assert retried.attemptsMade == 2
    finally:
        ctx.stopping.set()
        if worker:
            await worker.close()
        if running:
            await running
        await queue.close()
        keys = [key async for key in redis.scan_iter(match=prefix + ":*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()
