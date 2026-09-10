"""Native Python entrypoint for the existing Redis queues and MySQL schema."""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import signal
from datetime import timedelta
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from bullmq import Queue, UnrecoverableError, WaitingChildrenError
from bullmq import Worker as BullMQWorker
from bullmq.timer import Timer
from bullmq.worker import getCompleted
from redis.asyncio import Redis

from .config import load_config, load_environment
from .constants import QueueName as Q
from .core import Database, RuntimeContext, json_text, utcnow
from .jobs import validate_job
from .raw_documents import RawDocumentStore
from .scheduling import RETIRED_NAMES, advance_scheduler, configure, require_native_schedulers

log = logging.getLogger("orsem.worker")
QUEUE_JOBS = {
    Q.POLL: {"poll-opendart", "backfill-opendart", "sync-opendart-corp-codes"},
    Q.FILING: {"enrich-filing", "apply-parse-projection"},
    Q.AI_REVIEW: {"review-parse-with-ai"},
    Q.NEWS_TRANSLATION: {"translate-news-batch"},
    Q.OUTBOX: {"dispatch-processing-outbox"},
    Q.CONNECTOR_HEALTH: {"check-connectors", "discover-news-links", "sync-sec-cik"},
    Q.MARKET_NEWS: {"discover-news-links"},
    Q.MARKET_DATA: {
        "sync-alpaca-assets",
        "ingest-toss-candles",
        "sync-toss-stocks",
        "refresh-market-indicator-quotes",
        "refresh-market-indicator-history",
    }
    | RETIRED_NAMES,
}


class JobDeferred(WaitingChildrenError):
    """BullMQ Python's supported skip-finish signal after an explicit delayed transition."""


class Worker(BullMQWorker):
    """BullMQ 2.26 intake with complete draining and interruptible fetch retries."""

    running: bool
    processing: set[asyncio.Task[Any]]

    async def run(self):
        # Keep the pinned library's fetch/process transitions. Its run() exits
        # when any handler returns None during closing, even if another handler
        # still needs its lock renewed. Exit only when all processing is done.
        if self.running:
            raise RuntimeError("Worker is already running")
        await self._ensure_client_names()
        self.lockManager.start()
        self.stalledCheckTimer = Timer(
            self.opts["stalledInterval"] / 1000, self.runStalledJobsCheck, self.emit
        )
        self.running = True
        token_postfix = 0
        try:
            while not self.closed:
                while (
                    not self.waiting
                    and len(self.processing) < self.opts["concurrency"]
                    and not self.closing
                ):
                    token_postfix += 1
                    token = f"{self.id}:{token_postfix}"
                    self.processing.add(
                        asyncio.create_task(
                            self.retryIfFailed(
                                partial(self.getNextJob, token),
                                {
                                    "delay_in_ms": self.opts["runRetryDelay"],
                                    "only_emit_error": True,
                                },
                            )
                        )
                    )
                jobs, pending = await getCompleted(self.processing, self.emit)
                pending.update(asyncio.create_task(self.processJob(job, job.token)) for job in jobs)
                self.processing = pending
                if self.closing and not self.processing:
                    break
        finally:
            self.running = False
            if self.stalledCheckTimer is not None:
                self.stalledCheckTimer.stop()
            await self.lockManager.close()

    async def retryIfFailed(self, fn, opts=None):
        async def while_running():
            if self.closing or self.closed:
                return None
            return await fn()

        return await super().retryIfFailed(while_running, opts)


async def shutdown(ctx, workers, drain_seconds=600):
    """Quiesce all intake before draining handlers and releasing their I/O resources."""
    ctx.stopping.set()
    # BullMQ 2.26's pause flag is not checked by its intake loop. Its close()
    # snapshots processing, which can still be a fetch task that later starts a
    # handler. Stop every loop first and await run(), which observes that handoff.
    for worker, _task in workers:
        worker.closing = True
    log.info("Worker shutdown: intake stopped for %d queues.", len(workers))
    await ctx.stop_periodics()
    log.info("Worker shutdown: periodic producers stopped; draining active jobs.")
    deadline = asyncio.get_running_loop().time() + drain_seconds
    runs = {task for _worker, task in workers}
    while True:
        pending = {task for task in runs if not task.done()}
        pending.update(
            task for worker, _run in workers for task in worker.processing if not task.done()
        )
        if not pending:
            break
        remaining = max(0, deadline - asyncio.get_running_loop().time())
        _done, pending = await asyncio.wait(pending, timeout=remaining)
        if pending:
            # PM2's 660-second grace exceeds this 600-second handler budget.
            # Cancel only after the normal drain opportunity. Redis retains the
            # unacknowledged active jobs for ordinary stalled-job recovery.
            log.error("Worker drain timed out; cancelling %d pending tasks.", len(pending))
            await asyncio.gather(
                *(worker.close(force=True) for worker, _ in workers), return_exceptions=True
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            break
    await asyncio.gather(*runs, return_exceptions=True)
    log.info("Worker shutdown: handlers drained; closing queue connections.")
    try:
        results = await asyncio.gather(
            *(worker.close() for worker, _task in workers), return_exceptions=True
        )
        for result in results:
            if isinstance(result, BaseException):
                log.error("Worker queue close failed (%s)", type(result).__name__)
    finally:
        await ctx.close()
    log.info("Worker shutdown complete.")


async def defer_job(job, token, at):
    now = int(utcnow().timestamp() * 1000)
    delay = max(0, int(at.timestamp() * 1000) - now)
    await job.scripts.moveToDelayed(job.id, now, delay, token, {"skipAttempt": True})
    job.delay = delay
    raise JobDeferred()


def next_kst_midnight():
    local = utcnow().astimezone(ZoneInfo("Asia/Seoul"))
    return (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def processor(ctx, queue_name, handlers):
    async def process(job, token):
        from .disclosures.primitives import OpenDartApiError, OpenDartPayloadError

        # BullMQ Python exposes schedulers but does not advance them in Worker.
        # Advance under the active job lock before business work, including failures.
        await advance_scheduler(ctx, queue_name, job)
        if job.name not in QUEUE_JOBS[queue_name]:
            raise UnrecoverableError("Unsupported queue job.")
        if job.name in RETIRED_NAMES:
            return {"retired": True, "processed": 0}
        try:
            payload = validate_job(job.name, job.data)
        except ValueError:
            raise UnrecoverableError("Invalid job payload.") from None
        try:
            result = await handlers[job.name](payload)
            # BullMQ uses standard JSON without Decimal/datetime extensions.
            return json.loads(json_text(result)) if result is not None else None
        except OpenDartApiError as error:
            if job.name == "enrich-filing" and error.status == "014":
                retry = payload.get("documentRetryAttempt", 0)
                delays = (600, 3600, 21600)
                if retry < len(delays) and token:
                    await job.updateData({**payload, "documentRetryAttempt": retry + 1})
                    await defer_job(job, token, utcnow() + timedelta(seconds=delays[retry]))
                await ctx.services["enrichment"].record_document_unavailable_review(
                    payload, error.apiMessage
                )
                raise UnrecoverableError(
                    "OpenDART document remained unavailable after 10m/1h/6h retries."
                ) from None
            if error.retryPolicy == "NEXT_KST_DAY" and job.name != "poll-opendart" and token:
                await defer_job(job, token, next_kst_midnight())
            if error.retryPolicy in ("NONE", "NEXT_KST_DAY"):
                raise UnrecoverableError(f"OpenDART {error.status}.") from None
            raise
        except OpenDartPayloadError as error:
            if queue_name == Q.FILING:
                raise UnrecoverableError(f"OpenDART payload {error.code}.") from None
            raise

    return process


async def make_context(config=None):
    config = config or load_config()
    ctx = RuntimeContext(
        config,
        Database.from_url(config.databaseUrl),
        Redis.from_url(config.redisUrl, decode_responses=True),
        httpx.AsyncClient(
            timeout=config.httpTimeoutMs / 1000, follow_redirects=False, trust_env=False
        ),
    )
    ctx.services["raw_documents"] = RawDocumentStore(config)
    for name in Q:
        ctx.queues[name] = Queue(
            str(name), {"connection": config.redisUrl, "prefix": config.redisPrefix}
        )
    return ctx


async def register_modules(ctx):
    modules = [
        importlib.import_module("." + name, "orsem_worker")
        for name in ("push", "connectors", "disclosures", "market", "outbox")
    ]
    handlers = {}
    for module in modules:
        for name, handler in (await module.register(ctx)).items():
            if name in handlers:
                raise RuntimeError("Duplicate worker job handler.")
            handlers[name] = handler
    required = set().union(*QUEUE_JOBS.values()) - RETIRED_NAMES
    if set(handlers) != required:
        raise RuntimeError(
            f"Worker handler contract mismatch: missing={sorted(required - set(handlers))}, extra={sorted(set(handlers) - required)}"
        )
    return modules, handlers


async def start(ctx, workers):
    await ctx.db.fetch_one("SELECT 1 AS ready")
    await ctx.redis.ping()
    await require_native_schedulers(ctx)
    modules, handlers = await register_modules(ctx)
    await configure(ctx)
    for module in modules:
        if hasattr(module, "start"):
            await module.start(ctx)
    for name in Q:
        worker = Worker(
            str(name),
            processor(ctx, name, handlers),
            {
                "connection": ctx.config.redisUrl,
                "prefix": ctx.config.redisPrefix,
                "concurrency": 2 if name == Q.FILING else 1,
                "autorun": False,
                "lockDuration": 30000,
                "maxStalledCount": 1,
                "stalledInterval": 30000,
            },
        )
        worker.on(
            "error",
            lambda error, *args: log.error("Queue runtime error (%s)", type(error).__name__),
        )
        worker.on(
            "failed",
            lambda job, error, *args: log.warning(
                "Job %s failed (%s)", job.name, type(error).__name__
            ),
        )
        task = asyncio.create_task(worker.run(), name=f"queue:{name}")
        task.add_done_callback(
            lambda task: ctx.stopping.set() if not ctx.stopping.is_set() else None
        )
        workers.append((worker, task))
    log.info("Python worker ready: %d queues, %d handlers.", len(workers), len(handlers))


async def run():
    load_environment()
    ctx = await make_context()
    workers: list[tuple[Worker, asyncio.Task[Any]]] = []
    loop = asyncio.get_running_loop()
    signals = (signal.SIGTERM, signal.SIGINT)
    for signum in signals:
        loop.add_signal_handler(signum, ctx.stopping.set)
    # Provider initialization may itself be waiting on network I/O. Catch stop
    # signals before it begins and cancel that startup task instead of finishing
    # initialization and starting queue intake after the stop request.
    startup = asyncio.create_task(start(ctx, workers), name="worker-startup")
    stopped = asyncio.create_task(ctx.stopping.wait(), name="worker-stop-signal")
    try:
        done, _pending = await asyncio.wait({startup, stopped}, return_when=asyncio.FIRST_COMPLETED)
        if startup in done:
            await startup
        await stopped
    finally:
        ctx.stopping.set()
        if not startup.done():
            startup.cancel()
        stopped.cancel()
        await asyncio.gather(startup, stopped, return_exceptions=True)
        try:
            await shutdown(ctx, workers)
        finally:
            for signum in signals:
                loop.remove_signal_handler(signum)
