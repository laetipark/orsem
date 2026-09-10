"""Shutdown regressions using BullMQ's real processing and connection lifecycle."""

import asyncio
import os
import signal
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from bullmq import Queue
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError

from orsem_worker import runtime
from orsem_worker.constants import QueueName as Q
from orsem_worker.core import RuntimeContext


def context():
    return RuntimeContext(
        SimpleNamespace(),
        SimpleNamespace(close=AsyncMock()),
        SimpleNamespace(aclose=AsyncMock()),
        SimpleNamespace(aclose=AsyncMock()),
    )


def synthetic_worker(concurrency=1):
    worker = runtime.Worker(
        "synthetic-shutdown",
        None,
        {
            "connection": "redis://127.0.0.1:16390/0",
            "autorun": False,
            "concurrency": concurrency,
            "stalledInterval": 999999,
        },
    )
    worker._ensure_client_names = AsyncMock()
    worker.lockManager = SimpleNamespace(start=Mock(), close=AsyncMock(), cancel_all_jobs=Mock())
    worker.blockingRedisConnection.close = AsyncMock()
    worker.redisConnection.close = AsyncMock()
    return worker


async def wait_until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0.001)


@pytest.mark.asyncio
async def test_periodics_stop_before_hooks_and_shared_io_remains_until_close():
    ctx = context()
    started, terminated = asyncio.Event(), asyncio.Event()

    async def callback():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            terminated.set()

    task = ctx.periodic("shutdown-test", 1, callback)
    await started.wait()
    ctx.on_close(terminated.wait)
    await asyncio.wait_for(ctx.stop_periodics(), 0.2)
    assert terminated.is_set() and task.cancelled()
    ctx.http.aclose.assert_not_awaited()
    ctx.redis.aclose.assert_not_awaited()
    ctx.db.close.assert_not_awaited()
    await asyncio.wait_for(ctx.close(), 0.2)
    ctx.http.aclose.assert_awaited_once()
    ctx.redis.aclose.assert_awaited_once()
    ctx.db.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_close_hook_failure_still_closes_other_hooks_and_all_resources():
    ctx = context()
    good_hook = AsyncMock()
    ctx.on_close(good_hook)
    ctx.on_close(AsyncMock(side_effect=ValueError("sensitive provider details")))
    queue = SimpleNamespace(close=AsyncMock(side_effect=ValueError("private queue details")))
    ctx.queues["test"] = queue
    with pytest.raises(RuntimeError, match=r"^Worker resources did not all close\.$"):
        await ctx.close()
    good_hook.assert_awaited_once()
    queue.close.assert_awaited_once()
    ctx.http.aclose.assert_awaited_once()
    ctx.redis.aclose.assert_awaited_once()
    ctx.db.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_shutdown_drains_fetch_to_handler_handoff_before_closing_connections():
    ctx, worker, idle_worker = context(), synthetic_worker(), synthetic_worker()
    fetched, release_fetch, handled, release_handler = (asyncio.Event() for _ in range(4))

    async def fetch(token):
        fetched.set()
        await release_fetch.wait()
        return SimpleNamespace(token=token)

    async def handle(job, token):
        handled.set()
        await release_handler.wait()

    worker.getNextJob = fetch
    worker.processJob = handle
    idle_worker.getNextJob = AsyncMock(return_value=None)
    running = asyncio.create_task(worker.run())
    idle_running = asyncio.create_task(idle_worker.run())
    await fetched.wait()
    closing = asyncio.create_task(
        runtime.shutdown(ctx, [(worker, running), (idle_worker, idle_running)])
    )
    await wait_until(lambda: worker.closing)
    assert idle_worker.closing
    release_fetch.set()
    try:
        await asyncio.wait_for(handled.wait(), 0.2)
        assert not closing.done()
        worker.lockManager.close.assert_not_awaited()
        worker.redisConnection.close.assert_not_awaited()
        ctx.db.close.assert_not_awaited()
    finally:
        release_handler.set()
        await asyncio.wait_for(closing, 1)
    assert running.done() and idle_running.done()
    assert worker.closed and idle_worker.closed
    assert not worker.processing and not idle_worker.processing
    ctx.db.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_concurrent_handler_finishing_does_not_stop_other_handlers_lock_renewal():
    ctx, worker = context(), synthetic_worker(2)
    releases = [asyncio.Event(), asyncio.Event()]
    started = []
    tokens = []

    async def fetch(token):
        number = len(tokens)
        tokens.append(token)
        return SimpleNamespace(token=token, number=number)

    async def handle(job, token):
        started.append(job.number)
        await releases[job.number].wait()

    worker.getNextJob = fetch
    worker.processJob = handle
    running = asyncio.create_task(worker.run())
    await wait_until(lambda: len(started) == 2)
    closing = asyncio.create_task(runtime.shutdown(ctx, [(worker, running)]))
    await wait_until(lambda: worker.closing)
    releases[0].set()
    try:
        await asyncio.sleep(0.01)
        assert not running.done() and not closing.done()
        worker.lockManager.close.assert_not_awaited()
        assert len(set(tokens)) == 2
    finally:
        releases[1].set()
        await asyncio.wait_for(closing, 1)
    assert not worker.processing


@pytest.mark.asyncio
async def test_forced_drain_cancels_handler_and_closes_resources():
    ctx, worker = context(), synthetic_worker()
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def fetch(token):
        return SimpleNamespace(token=token)

    async def handle(job, token):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    worker.getNextJob = fetch
    worker.processJob = handle
    running = asyncio.create_task(worker.run())
    await started.wait()
    await asyncio.wait_for(runtime.shutdown(ctx, [(worker, running)], drain_seconds=0.01), 1)
    assert cancelled.is_set() and running.done() and worker.forceClosing
    assert all(task.done() for task in worker.processing)
    ctx.db.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_fetch_retry_stops_after_connection_failure_during_shutdown():
    worker = synthetic_worker()

    async def unavailable():
        worker.closing = True
        raise RedisConnectionError("synthetic Redis outage")

    fetch = AsyncMock(side_effect=unavailable)
    assert await asyncio.wait_for(worker.retryIfFailed(fetch, {"delay_in_ms": 15000}), 0.2) is None
    fetch.assert_awaited_once()
    await worker.close()


@pytest.mark.asyncio
async def test_fetch_retry_retains_normal_recovery_before_shutdown():
    worker = synthetic_worker()
    fetch = AsyncMock(side_effect=[RedisConnectionError("transient"), "job"])
    assert await worker.retryIfFailed(fetch, {"delay_in_ms": 0}) == "job"
    assert fetch.await_count == 2
    await worker.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_startup_signal_or_failure_cancels_initialization_and_closes_context(
    monkeypatch, fail
):
    ctx = context()
    callbacks = {}
    monkeypatch.setattr(runtime, "load_environment", lambda: None)
    monkeypatch.setattr(runtime, "make_context", AsyncMock(return_value=ctx))
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "add_signal_handler", lambda sig, fn: callbacks.update({sig: fn}))
    remove = Mock()
    monkeypatch.setattr(loop, "remove_signal_handler", remove)
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def initializing(context, workers):
        assert set(callbacks) == {signal.SIGTERM, signal.SIGINT}
        started.set()
        if fail:
            raise ValueError("synthetic startup failure")
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(runtime, "start", initializing)
    running = asyncio.create_task(runtime.run())
    await started.wait()
    if fail:
        with pytest.raises(ValueError, match="synthetic startup failure"):
            await asyncio.wait_for(running, 0.2)
    else:
        callbacks[signal.SIGTERM]()
        await asyncio.wait_for(running, 0.2)
        assert cancelled.is_set()
    assert remove.call_count == 2
    ctx.db.close.assert_awaited_once()


redis_test = pytest.mark.skipif(
    not os.environ.get("ORSEM_TEST_REDIS_URL"), reason="Requires disposable ORSEM_TEST_REDIS_URL."
)


@pytest.mark.asyncio
@redis_test
async def test_real_redis_empty_paused_queues_start_and_shutdown_without_drain_timeout(monkeypatch):
    url = os.environ["ORSEM_TEST_REDIS_URL"]
    assert url == "redis://127.0.0.1:16390/0"
    prefix = "orsem-python-shutdown-" + uuid4().hex
    redis = Redis.from_url(url, decode_responses=True)
    ctx = context()
    ctx.config = SimpleNamespace(redisUrl=url, redisPrefix=prefix)
    ctx.redis = redis
    ctx.db.fetch_one = AsyncMock(return_value={"ready": 1})
    ctx.queues = {name: Queue(str(name), {"connection": url, "prefix": prefix}) for name in Q}
    workers = []
    callbacks = {}
    monkeypatch.setattr(runtime, "load_environment", lambda: None)
    monkeypatch.setattr(runtime, "make_context", AsyncMock(return_value=ctx))
    monkeypatch.setattr(runtime, "require_native_schedulers", AsyncMock())
    monkeypatch.setattr(runtime, "register_modules", AsyncMock(return_value=([], {})))
    monkeypatch.setattr(runtime, "configure", AsyncMock())
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "add_signal_handler", lambda sig, fn: callbacks.update({sig: fn}))
    monkeypatch.setattr(loop, "remove_signal_handler", Mock())
    worker_class = runtime.Worker

    def create_worker(*args, **kwargs):
        worker = worker_class(*args, **kwargs)
        workers.append(worker)
        return worker

    monkeypatch.setattr(runtime, "Worker", create_worker)
    running = None
    try:
        for queue in ctx.queues.values():
            await queue.pause()
        running = asyncio.create_task(runtime.run())
        async with asyncio.timeout(5):
            while len(workers) != len(Q) or not all(worker.waiting for worker in workers):
                await asyncio.sleep(0.01)
        callbacks[signal.SIGTERM]()
        await asyncio.wait_for(running, 12)
        assert all(worker.closed and not worker.processing for worker in workers)
        assert all(not worker.running for worker in workers)
        ctx.db.close.assert_awaited_once()
    finally:
        ctx.stopping.set()
        if running and not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
        cleanup = Redis.from_url(url, decode_responses=True)
        keys = [key async for key in cleanup.scan_iter(match=prefix + ":*")]
        if keys:
            await cleanup.delete(*keys)
        await cleanup.aclose()


@pytest.mark.asyncio
@redis_test
async def test_real_redis_shutdown_keeps_concurrent_active_job_lock_until_acknowledged():
    url = os.environ["ORSEM_TEST_REDIS_URL"]
    assert url == "redis://127.0.0.1:16390/0"
    prefix = "orsem-python-shutdown-lock-" + uuid4().hex
    redis = Redis.from_url(url, decode_responses=True)
    ctx = context()
    queue = Queue(str(Q.OUTBOX), {"connection": url, "prefix": prefix})
    ctx.queues[Q.OUTBOX] = queue
    releases = [asyncio.Event(), asyncio.Event()]
    started, completed, errors = [], [], []

    async def handle(payload):
        number = payload["number"]
        started.append(number)
        await releases[number].wait()
        return {"ok": True}

    worker = runtime.Worker(
        str(Q.OUTBOX),
        runtime.processor(ctx, Q.OUTBOX, {"dispatch-processing-outbox": handle}),
        {
            "connection": url,
            "prefix": prefix,
            "autorun": False,
            "concurrency": 2,
            "lockDuration": 300,
            "lockRenewTime": 50,
        },
    )
    worker.on("completed", lambda job, *_: completed.append(job.id))
    worker.on("error", lambda error, *_: errors.append(type(error).__name__))
    running = closing = None
    try:
        jobs = [
            await queue.add("dispatch-processing-outbox", {"number": number}) for number in range(2)
        ]
        running = asyncio.create_task(worker.run())
        async with asyncio.timeout(3):
            while len(started) != 2:
                await asyncio.sleep(0.01)
        closing = asyncio.create_task(runtime.shutdown(ctx, [(worker, running)]))
        await wait_until(lambda: worker.closing)
        releases[0].set()
        await asyncio.sleep(0.7)
        assert not closing.done() and not worker.lockManager.closed
        assert await redis.pttl(f"{prefix}:{Q.OUTBOX}:{jobs[1].id}:lock") > 0
        assert completed == [jobs[0].id]
        releases[1].set()
        await asyncio.wait_for(closing, 2)
        assert set(completed) == {job.id for job in jobs}
        assert await redis.llen(f"{prefix}:{Q.OUTBOX}:active") == 0
        assert not errors
    finally:
        for release in releases:
            release.set()
        if closing:
            await closing
        elif running:
            await runtime.shutdown(ctx, [(worker, running)])
        else:
            await worker.close()
            await ctx.close()
        keys = [key async for key in redis.scan_iter(match=prefix + ":*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()
