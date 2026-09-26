"""Explicit administrative commands. No scheduler or worker starts during CLI execution."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
import sys
import time
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx
from bullmq import Job, Queue
from redis.asyncio import Redis

from .admin_cli.common import AdminError
from .config import load_config, load_environment
from .connectors.discovery import GROUP_SQL
from .connectors.policy import CompanyMatcher, company_aliases
from .connectors.projections import replace_relevance
from .constants import QueueName
from .core import Database, RuntimeContext, identifier, json_text, utcnow
from .jobs import validate_job
from .market.common import camel, instant, iso, obj
from .market.masters import EtfMaster
from .market.selection import Selection
from .market.toss import TossClient
from .scheduling import DEFINITIONS

DELEGATED_COMMANDS = {
    "parser-corpus-audit",
    "stage-parser-corpus",
    "export-parser-review-audit",
    "parser-rollout-backup",
}


class CliError(RuntimeError):
    """Safe operator-facing error code, never provider responses or credentials."""


def output(value):
    print(json_text(value), flush=True)


async def backfill_news_relevance(db, apply=False):
    companies = await db.fetch_all("SELECT id,name_ko,name_en,ticker,stock_code,market FROM companies")
    aliases = await db.fetch_all("SELECT * FROM company_aliases")
    matcher = CompanyMatcher(
        company_aliases((camel(c) for c in companies), (camel(a) for a in aliases))
    )
    del companies, aliases

    def classify(row):
        raw = obj(row.get("raw_metadata_json"))
        evidence = "\n".join(
            v for v in (row.get("title"), raw.get("description")) if isinstance(v, str)
        )
        matches = {company_id: "METADATA_ALIAS" for company_id in matcher(evidence)}
        if row["source"] == "IR" and row.get("company_id"):
            matches[row["company_id"]] = "REGISTERED_IR"
        if row["source"] == "SEC":
            values = raw.get("companyIds")
            for company_id in [
                *(values if isinstance(values, list) else []),
                row.get("company_id"),
            ]:
                if isinstance(company_id, str) and re.fullmatch(
                    r"[a-f0-9-]{36}", company_id, re.IGNORECASE
                ):
                    matches[company_id] = "SEC_CIK"
        return evidence, list(matches.items())

    summary = {"scanned": 0, "relatedSources": 0, "relations": 0, "applied": apply}
    after = ""
    while True:
        rows = await db.fetch_all(
            "SELECT id,title,company_id,source,raw_metadata_json FROM source_items "
            "WHERE source IN ('IR','NEWS_RSS','GDELT','SEC') AND id>:after ORDER BY id LIMIT 100",
            {"after": after},
        )
        if not rows:
            return summary
        for snapshot in rows:
            count = 0
            if apply:
                async with db.transaction() as tx:
                    row = await tx.fetch_one(
                        "SELECT id,title,company_id,source,raw_metadata_json FROM source_items WHERE id=:id FOR UPDATE",
                        {"id": snapshot["id"]},
                    )
                    if row:
                        evidence, matches = classify(row)
                        count = len(matches)
                        await replace_relevance(tx, row["id"], evidence, matches)
            else:
                count = len(classify(snapshot)[1])
            summary["scanned"] += 1
            summary["relations"] += count
            summary["relatedSources"] += int(count > 0)
        after = rows[-1]["id"]


async def preview_market_leaders(ctx):
    toss = TossClient(ctx)
    try:
        selection = Selection(ctx, toss, None)
        result = []
        for region in ("kr", "us"):
            row = await selection.collect(region)
            result.append(
                {
                    "region": region,
                    "selectionMonth": row["raw"]["selectionMonth"],
                    "basisDate": row["basisDate"],
                    "observedAt": row["observedAt"],
                    "sourceCount": row["sourceCount"],
                    "eligibleCount": row["eligibleCount"],
                    "excludedCount": len(row["excluded"]),
                    "leaders": row["leaders"],
                }
            )
        return result
    finally:
        await toss.close()


async def sync_korean_etfs(ctx, apply=False):
    toss = TossClient(ctx)
    try:
        return await EtfMaster(ctx, toss).sync({"force": True, "dryRun": not apply})
    finally:
        await toss.close()


class SecCollection:
    def __init__(self, ctx, writer=output):
        self.ctx, self.output = ctx, writer
        self.queue = None
        self.owned_jobs = []
        self.stage = "configuration"

    async def load_scope(self):
        return await self.ctx.db.fetch_all("""SELECT c.id,c.ticker,c.name_ko,c.cik FROM companies c
          WHERE c.is_listed=1 AND c.market IN ('NASDAQ','NYSE','AMEX') AND (
          EXISTS (SELECT 1 FROM market_leader_company_links w WHERE w.company_id=c.id AND w.priority IN ('P1','P2'))
          OR c.id IN (""" + GROUP_SQL + """)
          OR EXISTS (SELECT 1 FROM ir_sources ir WHERE ir.company_id=c.id AND ir.is_active=1)
          OR EXISTS (SELECT 1 FROM source_checkpoints cp WHERE cp.connector='TOSS' AND cp.stream LIKE 'PRICE_BARS:%'
          AND cp.last_success_at>=UTC_TIMESTAMP()-INTERVAL 1 DAY
          AND CAST(SUBSTRING_INDEX(cp.stream,':',-1) AS BINARY)=CAST(c.id AS BINARY))) ORDER BY c.ticker,c.id""")

    async def report_state(self):
        health = (
            await self.ctx.db.fetch_one("""SELECT status,checked_at,last_success_at,
          JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.httpStatus')) http_status,
          JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.healthSource')) health_source
          FROM connector_health WHERE connector='sec'""")
            or {}
        )
        cooldown = (
            await self.ctx.db.fetch_one("""SELECT
          JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.retryAt')) retry_at,
          JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.providerStatus')) provider_status
          FROM source_checkpoints WHERE connector='SEC' AND stream='ACCESS_COOLDOWN'""")
            or {}
        )
        retry = instant(cooldown["retry_at"]) if cooldown.get("retry_at") else None
        self.output(
            {
                "stage": "provider_state",
                "status": health.get("status"),
                "healthSource": health.get("health_source"),
                "checkedAtUTC": health.get("checked_at"),
                "lastSuccessAtUTC": health.get("last_success_at"),
                "httpStatus": health.get("http_status"),
                "cooldownActive": bool(retry and retry > utcnow()),
                "cooldownProviderStatus": cooldown.get("provider_status"),
                "retryAtUTC": iso(retry) if retry else None,
                "retryAtKST": retry.astimezone(ZoneInfo("Asia/Seoul")).isoformat()
                if retry
                else None,
            }
        )

    async def snapshot(self, label):
        coverage = await self.ctx.db.fetch_one("""SELECT COUNT(*) registered,
          COALESCE(SUM(cik IS NOT NULL AND cik <> ''),0) mapped,COUNT(DISTINCT cik) issuers
          FROM companies WHERE is_listed=1 AND market IN ('NASDAQ','NYSE','AMEX')""")
        sources = await self.ctx.db.fetch_one(
            "SELECT COUNT(*) filings,MAX(first_observed_at) latest_observation_utc FROM source_items WHERE source='SEC'"
        )
        events = await self.ctx.db.fetch_one(
            "SELECT COUNT(*) events FROM event_clusters WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.source'))='SEC'"
        )
        push = await self.ctx.db.fetch_one("""SELECT COUNT(*) deliveries FROM push_deliveries p WHERE EXISTS (
          SELECT 1 FROM news_items n JOIN source_items s ON s.id=n.source_item_id
          WHERE s.source='SEC' AND CAST(p.dedupe_key AS BINARY) LIKE CAST(CONCAT('%:news:',n.id) AS BINARY))""")
        observations = await self.ctx.db.fetch_all(
            "SELECT id,CAST(first_observed_at AS CHAR) observed FROM source_items WHERE source='SEC'"
        )
        result = {k: int(coverage[k]) for k in ("registered", "mapped", "issuers")}
        result.update(
            {
                "filings": int(sources["filings"]),
                "events": int(events["events"]),
                "pushDeliveries": int(push["deliveries"]),
                "latestObservationUTC": sources["latest_observation_utc"],
            }
        )
        self.output({"stage": label, **result})
        return {**result, "observations": {r["id"]: r["observed"] for r in observations}}

    async def run_job(self, name, payload, label):
        if self.queue is None:
            raise CliError("QUEUE_NOT_INITIALIZED")
        self.stage = label
        payload = validate_job(name, payload)
        job = await self.queue.add(
            name,
            payload,
            {
                "jobId": "sec-collection-" + identifier(),
                "attempts": 1,
                "removeOnComplete": False,
                "removeOnFail": False,
            },
        )
        self.owned_jobs.append(job.id)
        start = last_progress = time.monotonic()
        while time.monotonic() - start < 600:
            current = await Job.fromId(self.queue, job.id)
            if current is None:
                raise CliError("SUBMITTED_JOB_MISSING")
            state = await current.getState()
            if state == "completed":
                result = current.returnvalue
                if name == "discover-news-links":
                    if (
                        not isinstance(result, list)
                        or len(result) != 1
                        or result[0].get("connector") != "SEC"
                    ):
                        raise CliError("INVALID_DISCOVERY_RESULT")
                    self.output(
                        {
                            "stage": label,
                            **{k: result[0].get(k) for k in ("status", "seen", "created")},
                        }
                    )
                    if result[0].get("status") != "HEALTHY":
                        raise CliError("SEC_DISCOVERY_NOT_HEALTHY")
                else:
                    self.output(
                        {
                            "stage": label,
                            "result": {
                                k: v
                                for k, v in obj(result).items()
                                if isinstance(v, (int, float, bool))
                            },
                        }
                    )
                    if obj(result).get("disabled"):
                        raise CliError("CIK_SYNC_DISABLED")
                return result
            if state == "failed":
                raise CliError("WORKER_JOB_FAILED")
            if time.monotonic() - last_progress > 15:
                self.output(
                    {
                        "stage": label,
                        "state": state,
                        "elapsedSeconds": int(time.monotonic() - start),
                    }
                )
                last_progress = time.monotonic()
            await asyncio.sleep(0.5)
        raise CliError("WORKER_JOB_WAIT_TIMEOUT")

    async def run(self, status=False, verify=False, collect_only=False):
        before = await self.snapshot("before")
        if status:
            await self.report_state()
            return
        if not self.ctx.config.secUserAgent:
            raise CliError("SEC_USER_AGENT_REQUIRED")
        self.queue = Queue(
            str(QueueName.CONNECTOR_HEALTH),
            {"connection": self.ctx.config.redisUrl, "prefix": self.ctx.config.redisPrefix},
        )
        self.ctx.queues[QueueName.CONNECTOR_HEALTH] = self.queue
        schedulers = await self.queue.getJobSchedulers()
        discovery = next(
            row
            for row in DEFINITIONS["NEWS_DISCOVERY_SCHEDULES"]
            if "SEC" in row["payload"]["connectors"]
        )
        for name, schedule in [
            ("sync-sec-cik", DEFINITIONS["SEC_CIK_SYNC_SCHEDULE"]),
            ("discover-news-links", discovery),
        ]:
            matched = [
                row
                for row in schedulers
                if row.get("key") == schedule["id"]
                and row.get("name") == name
                and row.get("pattern") == schedule["pattern"]
                and row.get("tz") == schedule["timezone"]
            ]
            self.output(
                {
                    "stage": "schedule",
                    "name": name,
                    "count": len(matched),
                    "pattern": schedule["pattern"],
                    "timezone": schedule["timezone"],
                }
            )
            if len(matched) != 1:
                raise CliError("EXPECTED_SCHEDULE_NOT_REGISTERED_ONCE")
        if not collect_only:
            await self.run_job("sync-sec-cik", {}, "map_cik")
        companies = await self.load_scope()
        eligible = [row for row in companies if row.get("cik")]
        self.output(
            {
                "stage": "scope",
                "selected": len(companies),
                "mapped": len(eligible),
                "unmapped": len(companies) - len(eligible),
                "tickers": [r["ticker"] for r in eligible],
            }
        )
        if not eligible:
            raise CliError("NO_MAPPED_COMPANIES_IN_SCOPE")

        async def collect(label):
            for offset in range(0, len(eligible), 100):
                await self.run_job(
                    "discover-news-links",
                    {
                        "connectors": ["SEC"],
                        "priorities": [],
                        "companyIds": [r["id"] for r in eligible[offset : offset + 100]],
                        "reason": "BACKFILL",
                        "suppressAlerts": True,
                    },
                    f"{label}_{offset // 100 + 1}",
                )

        await collect("collect")
        first = await self.snapshot("after")
        if first["pushDeliveries"] != before["pushDeliveries"]:
            raise CliError("BACKFILL_GENERATED_ALERTS")
        if first["filings"] == 0 or first["events"] == 0:
            raise CliError("NO_SEC_FILINGS_OR_EVENTS")
        if verify:
            await collect("recollect")
            second = await self.snapshot("after_recollection")
            changed = sum(
                second["observations"].get(key) != value
                for key, value in first["observations"].items()
            )
            self.output(
                {
                    "stage": "verification",
                    "existingFirstObservationsChanged": changed,
                    "additionalFilings": second["filings"] - first["filings"],
                    "additionalEvents": second["events"] - first["events"],
                    "additionalPushDeliveries": second["pushDeliveries"] - before["pushDeliveries"],
                }
            )
            if changed or second["pushDeliveries"] != before["pushDeliveries"]:
                raise CliError("RECOLLECTION_INVARIANT_FAILED")

    async def close(self):
        if self.queue:
            for job_id in self.owned_jobs:
                try:
                    job = await Job.fromId(self.queue, job_id)
                    if job and await job.getState() in ("completed", "failed"):
                        await job.remove()
                except Exception:  # noqa: BLE001 - best-effort cleanup only for this command's terminal jobs
                    logging.getLogger(__name__).warning("SEC collection job cleanup deferred.")


def parser():
    root = argparse.ArgumentParser(prog="orsem-worker cli")
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("backfill-news-relevance", "sync-korean-etfs"):
        command = commands.add_parser(name)
        group = command.add_mutually_exclusive_group()
        group.add_argument("--apply", action="store_true")
        group.add_argument("--dry-run", action="store_true")
    repair = commands.add_parser("news-repair")
    repair.add_argument("--company-ids", nargs="+", required=True)
    repair.add_argument("--output-dir", required=True)
    repair.add_argument("--max-sources", type=int, default=1000)
    repair_mode = repair.add_mutually_exclusive_group()
    repair_mode.add_argument("--apply", action="store_true")
    repair_mode.add_argument("--dry-run", action="store_true")
    rollback = commands.add_parser("news-repair-rollback")
    rollback.add_argument("--repair-dir", required=True)
    rollback.add_argument("--output-dir", required=True)
    rollback_mode = rollback.add_mutually_exclusive_group()
    rollback_mode.add_argument("--apply", action="store_true")
    rollback_mode.add_argument("--dry-run", action="store_true")
    commands.add_parser("preview-market-leaders")
    collect = commands.add_parser("collect-sec")
    collect.add_argument("--status", action="store_true")
    collect.add_argument("--verify", action="store_true")
    collect.add_argument("--collect-only", action="store_true")
    for name in sorted(DELEGATED_COMMANDS):
        delegated = commands.add_parser(name, add_help=False)
        delegated.add_argument("arguments", nargs=argparse.REMAINDER)
    return root


async def execute(args):
    if hasattr(args, "arguments"):
        from .admin_cli import run

        try:
            output(await run(args.command, args.arguments))
        except AdminError as error:
            output({"error": error.code, **error.details})
            raise SystemExit(1) from None
        except Exception:  # noqa: BLE001 - administrative tools can encounter credential-bearing DB errors
            output({"error": "OPERATION_FAILED"})
            raise SystemExit(1) from None
        return
    load_environment()
    if not os.environ.get("DATABASE_URL"):
        raise CliError("DATABASE_REQUIRED")
    config = load_config()
    ctx = RuntimeContext(
        config,
        Database.from_url(config.databaseUrl),
        Redis.from_url(config.redisUrl, decode_responses=True),
        httpx.AsyncClient(
            timeout=config.httpTimeoutMs / 1000, follow_redirects=False, trust_env=False
        ),
    )
    collect = None
    try:
        if args.command == "backfill-news-relevance":
            output(await backfill_news_relevance(ctx.db, args.apply))
        elif args.command == "news-repair":
            from .connectors.news_repair import repair_news_company_links

            output(
                await repair_news_company_links(
                    ctx.db,
                    args.company_ids,
                    args.output_dir,
                    apply=args.apply,
                    max_sources=args.max_sources,
                )
            )
        elif args.command == "news-repair-rollback":
            from .connectors.news_repair import rollback_news_company_links

            output(
                await rollback_news_company_links(
                    ctx.db, args.repair_dir, args.output_dir, apply=args.apply
                )
            )
        elif args.command == "preview-market-leaders":
            output(await preview_market_leaders(ctx))
        elif args.command == "sync-korean-etfs":
            output(await sync_korean_etfs(ctx, args.apply))
        elif args.command == "collect-sec":
            collect = SecCollection(ctx)
            await collect.run(args.status, args.verify, args.collect_only)
    except Exception as error:  # noqa: BLE001 - redact credentials and provider bodies at CLI boundary
        output(
            {
                "stage": collect.stage if collect else args.command,
                "error": str(error)
                if isinstance(error, CliError)
                else error.code
                if isinstance(error, AdminError)
                else "OPERATION_FAILED",
            }
        )
        if collect:
            try:
                await collect.report_state()
            except Exception:  # noqa: BLE001 - diagnostics must not replace original failure
                logging.getLogger(__name__).warning("SEC diagnostic snapshot unavailable.")
        raise SystemExit(1) from None
    finally:
        if collect:
            await collect.close()
        await ctx.close()


def main():
    args = (
        SimpleNamespace(command=sys.argv[1], arguments=sys.argv[2:])
        if len(sys.argv) > 1 and sys.argv[1] in DELEGATED_COMMANDS
        else parser().parse_args()
    )
    for name in ("httpx", "httpcore", "websockets", "sqlalchemy.engine"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    try:
        asyncio.run(execute(args))
    except CliError as error:
        print(json_text({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
