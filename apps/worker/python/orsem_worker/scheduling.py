"""Idempotent native BullMQ JobSchedulers matching the deployed cadence snapshot."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path

from redis.exceptions import AuthenticationError, AuthorizationError
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from .constants import QueueName as Q

DEFINITIONS = json.loads(Path(__file__).with_name("schedules.json").read_text())
RETENTION = {"count": 100}
RETIRED_NAMES = {"ingest-krx-eod", "ingest-alpaca-eod"}
MANAGED_NAMES = {
    "refresh-market-indicator-quotes",
    "refresh-market-indicator-history",
    "dispatch-processing-outbox",
    "check-connectors",
    "poll-opendart",
    "sync-opendart-corp-codes",
    "sync-sec-cik",
    "translate-news-batch",
    "discover-news-links",
    "sync-alpaca-assets",
    "sync-toss-stocks",
    "ingest-toss-candles",
} | RETIRED_NAMES
LEGACY_REPEAT_KEY = re.compile(r"[0-9a-f]{32}", re.IGNORECASE)
log = logging.getLogger("orsem.scheduling")


async def advance_scheduler(ctx, queue_name, job):
    """Advance a claimed native occurrence before its handler, as the Node worker does.

    Python BullMQ 2.26 does not advance JobSchedulers from Worker. The Lua producer
    check makes re-entry after a handler retry or an ambiguous Redis reply harmless.
    Keep transient retries inside processing so the worker continues renewing locks.
    """
    scheduler_id = getattr(job, "repeatJobKey", None)
    if not scheduler_id:
        return None
    options = job.opts
    if (
        not isinstance(scheduler_id, str)
        or not isinstance(getattr(job, "id", None), str)
        or not job.id
        or not isinstance(options, dict)
        or not isinstance(options.get("repeat"), dict)
    ):
        raise ValueError("Invalid scheduler occurrence metadata.")
    delay = 0.25
    while True:
        try:
            return await ctx.queues[queue_name].jobScheduler.upsertJobScheduler(
                scheduler_id,
                options["repeat"],
                job.name,
                job.data,
                options,
                override=False,
                producer_id=job.id,
            )
        except (AuthenticationError, AuthorizationError):
            # Credential/ACL failures inherit ConnectionError but cannot recover by waiting.
            raise
        except (RedisConnectionError, RedisTimeoutError):
            if ctx.stopping.is_set():
                raise
            if delay == 0.25:
                log.warning("Redis unavailable while advancing a scheduler; retrying.")
            try:
                await asyncio.wait_for(ctx.stopping.wait(), timeout=delay)
            except TimeoutError:
                delay = min(delay * 2, 5.0)
            else:
                raise


def schedules(config):
    result = []

    def add(queue, name, definition, data=None, attempts=1, backoff=None):
        options = {"attempts": attempts, "removeOnComplete": RETENTION, "removeOnFail": RETENTION}
        if backoff:
            options["backoff"] = {"type": "exponential", "delay": backoff}
        result.append(
            {
                "queue": str(queue),
                "name": name,
                "id": definition["id"],
                "repeat": {
                    "pattern": definition["pattern"],
                    "tz": definition.get("timezone", "Asia/Seoul"),
                },
                "data": data or {},
                "opts": options,
            }
        )

    def basic(queue, name, identity, pattern):
        add(queue, name, {"id": identity, "pattern": pattern})

    for name, pattern in [
        ("refresh-market-indicator-quotes", "* * * * *"),
        ("refresh-market-indicator-history", "10 */6 * * *"),
    ]:
        basic(Q.MARKET_DATA, name, name, pattern)
    basic(Q.OUTBOX, "dispatch-processing-outbox", "processing-outbox-minute", "* * * * *")
    basic(Q.CONNECTOR_HEALTH, "check-connectors", "connector-health-ten-minutes", "*/10 * * * *")
    if config.newsTranslationEnabled:
        basic(Q.NEWS_TRANSLATION, "translate-news-batch", "news-translation-minute", "* * * * *")
    if config.secUserAgent:
        add(Q.CONNECTOR_HEALTH, "sync-sec-cik", DEFINITIONS["SEC_CIK_SYNC_SCHEDULE"])
    if config.openDartApiKey:
        for schedule in DEFINITIONS["OPENDART_POLL_SCHEDULES"]:
            add(
                Q.POLL,
                "poll-opendart",
                schedule,
                {
                    "detailType": schedule["detailType"],
                    "suppressAlerts": False,
                    "reason": "SCHEDULED",
                },
                3,
                30000,
            )
        add(
            Q.POLL,
            "sync-opendart-corp-codes",
            DEFINITIONS["OPENDART_CORP_CODE_SCHEDULE"],
            attempts=3,
            backoff=60000,
        )
    enabled = {
        "NEWS_RSS": bool(config.newsRssFeeds),
        "GDELT": config.gdeltEnabled,
        "ALPACA_NEWS": config.alpacaNewsEnabled,
        "MARKETAUX": config.marketauxNewsEnabled,
        "ALPHAVANTAGE": config.alphaVantageNewsEnabled,
        "FINNHUB": config.finnhubNewsEnabled,
    }
    for schedule in DEFINITIONS["NEWS_DISCOVERY_SCHEDULES"]:
        connectors = schedule["payload"]["connectors"]
        if all(enabled.get(connector, True) for connector in connectors):
            add(
                Q.CONNECTOR_HEALTH if "SEC" in connectors else Q.MARKET_NEWS,
                "discover-news-links",
                schedule,
                schedule["payload"],
            )
    if config.alpacaApiKey and config.alpacaApiSecret:
        add(
            Q.MARKET_DATA,
            "sync-alpaca-assets",
            DEFINITIONS["ALPACA_ASSET_SYNC_SCHEDULE"],
            {"reason": "SCHEDULED"},
            3,
            60000,
        )
    if config.marketDataProvider == "toss" and config.tossClientId and config.tossClientSecret:
        add(
            Q.MARKET_DATA,
            "sync-toss-stocks",
            {"id": "toss-stock-info-daily", "pattern": "30 7 * * *"},
            {"reason": "SCHEDULED"},
            3,
            30000,
        )
        for schedule in DEFINITIONS["TOSS_CANDLE_SCHEDULES"]:
            add(
                Q.MARKET_DATA,
                "ingest-toss-candles",
                schedule,
                {
                    "interval": schedule["interval"],
                    "lookbackDays": schedule["lookbackDays"],
                    "maxPages": 1,
                    "reason": "SCHEDULED",
                },
                3,
                30000,
            )
    return result


async def require_native_schedulers(ctx):
    # Node 5.x can add native iteration metadata while consuming a legacy repeat.
    # Our native IDs are descriptive; managed MD5 keys still require migration.
    # Fail before registration/startup I/O; a reviewed deployment converts only managed repeats.
    for name, queue in ctx.queues.items():
        repeat_key = f"{ctx.config.redisPrefix}:{name}:repeat"
        for key in await ctx.redis.zrange(repeat_key, 0, -1):
            legacy_managed = bool(LEGACY_REPEAT_KEY.fullmatch(key)) and (
                await ctx.redis.hget(f"{repeat_key}:{key}", "name") in MANAGED_NAMES
            )
            if legacy_managed or not await queue.isJobScheduler(key):
                raise RuntimeError(
                    f"Legacy repeat schedule remains in {name}; run the deployment migration first."
                )


async def configure(ctx, initial=True):
    await require_native_schedulers(ctx)
    desired = schedules(ctx.config)
    desired_keys = {(row["queue"], row["id"]) for row in desired}
    managed_names = {row["name"] for row in desired} | MANAGED_NAMES
    for name, queue in ctx.queues.items():
        for existing in await queue.getJobSchedulers():
            if (
                existing.get("name") in managed_names
                and (name, existing["key"]) not in desired_keys
            ):
                await queue.removeJobScheduler(existing["key"])
    for row in desired:
        await ctx.queues[row["queue"]].upsertJobScheduler(
            row["id"], row["repeat"], row["name"], row["data"], row["opts"]
        )
    if initial:
        await ctx.enqueue(
            Q.MARKET_DATA,
            "refresh-market-indicator-history",
            {},
            {
                "jobId": "market-indicators-initial-history",
                "attempts": 1,
                "removeOnComplete": True,
                "removeOnFail": RETENTION,
            },
        )
        if ctx.config.tossClientId and ctx.config.tossClientSecret:
            await ctx.enqueue(
                Q.MARKET_DATA,
                "ingest-toss-candles",
                {"interval": "1d", "lookbackDays": 366, "maxPages": 3, "reason": "SCHEDULED"},
                {
                    "jobId": "toss-initial-daily-history",
                    "attempts": 3,
                    "backoff": {"type": "exponential", "delay": 30000},
                    "removeOnComplete": False,
                    "removeOnFail": False,
                },
            )
    return desired
