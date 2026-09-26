"""Discovery orchestration and transactional metadata persistence."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from orsem_worker.core import identifier, utcnow

from .common import (
    Checkpoints,
    ConnectorRequestError,
    decoded_row,
    failure_message,
    instant,
    iso,
    save_row,
)
from .feeds import FeedConnector
from .policy import (
    CompanyMatcher,
    allows_audience,
    candidate_hash,
    candidate_metadata,
    candidate_summary,
    canonical_url,
    company_aliases,
    ir_profile,
    resolve_provider_entities,
)
from .projections import attach_article, refresh_official_references, replace_relevance, sec_events
from .providers import US_MARKETS, AlpacaNews, FreeNews, Gdelt, SecSubmissions
from .translation import input_hash, translation_input

SEC_POLICY = {
    "rightsMode": "OFFICIAL_PUBLIC_DATA",
    "aiAllowed": False,
    "fullTextStorageAllowed": False,
    "metadataStorageAllowed": True,
    "displayAllowed": True,
    "publicRedistributionAllowed": True,
    "notifyAllowed": True,
    "policyUrl": "https://www.sec.gov/privacy.htm",
    "checkedAt": "2026-09-05",
}
GROUP_SQL = """SELECT DISTINCT gi.company_id AS companyId FROM watchlist_group_items gi JOIN watchlist_groups g ON g.id=gi.group_id LEFT JOIN watchlist_rooms r ON r.id=g.room_id WHERE (g.room_id IS NULL OR r.id IS NOT NULL) AND (EXISTS (SELECT 1 FROM admins a WHERE COALESCE(r.owner_key,g.owner_key)=CONCAT('ADMIN:',a.id) AND a.is_active=1) OR EXISTS (SELECT 1 FROM members m WHERE COALESCE(r.owner_key,g.owner_key)=CONCAT('MEMBER:',m.id) AND m.role='VIEWER' AND m.status='APPROVED'))"""
ADMIN_SQL = """SELECT DISTINCT gi.company_id AS companyId FROM watchlist_group_items gi JOIN watchlist_groups g ON g.id=gi.group_id JOIN admins a ON g.owner_key=CONCAT('ADMIN:',a.id) AND a.is_active=1 WHERE g.room_id IS NULL ORDER BY gi.company_id"""
LEADERS_SQL = "SELECT company_id AS companyId FROM market_leader_company_links"
FREE = {"MARKETAUX", "ALPHAVANTAGE", "FINNHUB"}


class SecCheckpointReader:
    """Keep checkpoint read/decoding failures outside issuer response isolation."""

    def __init__(self, store):
        self.store = store

    async def load(self, connector, stream):
        try:
            return await self.store.load(connector, stream)
        except Exception:  # noqa: BLE001 - all checkpoint failures stop discovery, including invalid stored revisions
            raise RuntimeError("SEC discovery checkpoint unavailable.") from None


def camel(row):
    return {re.sub(r"_([a-z])", lambda m: m[1].upper(), key): value for key, value in row.items()}


def values(items):
    return list(
        dict.fromkeys(
            unicodedata.normalize("NFKC", item).strip()[:128]
            for item in items
            if isinstance(item, str) and item.strip()
        )
    )[:100]


def stream_name(job):
    if job.get("reason") == "DISCLOSURE_TRIGGER":
        return "LINK_DISCOVERY:P3_TRIGGER"
    if job.get("reason") == "BACKFILL":
        return "LINK_DISCOVERY:BACKFILL"
    return "LINK_DISCOVERY:" + ("_".join(job.get("priorities", [])) or "ALL")


class Discovery:
    def __init__(self, ctx):
        self.ctx = ctx
        self.store = Checkpoints(ctx.db)
        # GDELT pacing survives individual queue jobs and health calls.
        self.gdelt = Gdelt(ctx)

    async def ir_sources(self):
        urls = set(self.ctx.config.irFeedUrls)
        ids: dict[str, list[str]] = {}
        invalid: list[dict[str, Any]] = []
        for source in await self.ctx.db.fetch_all("SELECT * FROM ir_sources WHERE is_active=1"):
            profile = ir_profile(source["url"])
            company = (
                await self.ctx.db.fetch_one(
                    "SELECT * FROM companies WHERE id=:id AND is_listed=1",
                    {"id": source["company_id"]},
                )
                if profile and profile.get("companySymbols")
                else None
            )
            okay = (
                profile
                and profile.get("enabled")
                and source["source_type"].upper() == "RSS"
                and source["rights_mode"] == profile["policy"]["rightsMode"]
                and (
                    not profile.get("companySymbols")
                    or company
                    and company.get("ticker") in profile["companySymbols"]
                    and company["market"] in US_MARKETS
                )
            )
            if not okay or source["url"] not in urls and len(urls) >= 100:
                invalid.append(source)
                continue
            urls.add(source["url"])
            ids.setdefault(source["url"], []).append(source["company_id"])
        return sorted(urls), ids, invalid

    def adapters(self, ir_urls):
        return [
            *(FreeNews(self.ctx, name) for name in ("MARKETAUX", "ALPHAVANTAGE", "FINNHUB")),
            SecSubmissions(self.ctx),
            AlpacaNews(self.ctx),
            self.gdelt,
            FeedConnector(self.ctx, "IR", ir_urls),
            FeedConnector(self.ctx, "NEWS_RSS", self.ctx.config.newsRssFeeds),
        ]

    async def load_companies(self, job, *, free=False):
        ids = []
        if free:
            rows = await self.ctx.db.fetch_all(ADMIN_SQL)
            rows += await self.ctx.db.fetch_all(
                LEADERS_SQL + " WHERE region='us' ORDER BY company_id"
            )
            ids = [r["companyId"] for r in rows]
        elif job.get("reason") == "BACKFILL":
            ids = job.get("companyIds", [])
        elif job.get("reason") == "DISCLOSURE_TRIGGER":
            company_id = next(iter(job.get("companyIds", [])), None)
            if not company_id or not job.get("triggerFilingId"):
                return []
            filing = await self.ctx.db.fetch_one(
                "SELECT id FROM filings WHERE id=:id AND company_id=:company",
                {"id": job["triggerFilingId"], "company": company_id},
            )
            watch = await self.ctx.db.fetch_one(
                "SELECT priority FROM market_leader_company_links WHERE company_id=:id",
                {"id": company_id},
            )
            if not filing or watch and watch["priority"] != "P3":
                return []
            ids = [company_id]
        else:
            for priority in job.get("priorities", []):
                ids += [
                    r["company_id"]
                    for r in await self.ctx.db.fetch_all(
                        "SELECT company_id FROM market_leader_company_links WHERE priority=:priority ORDER BY created_at,id",
                        {"priority": priority},
                    )
                ]
        if (
            not free
            and job.get("reason") == "SCHEDULED"
            and set(job.get("connectors", [])) & {"SEC", "GDELT", "ALPACA_NEWS", *FREE}
        ):
            ids += [
                r["companyId"]
                for r in await self.ctx.db.fetch_all(GROUP_SQL + " UNION " + LEADERS_SQL)
            ]
            if set(job.get("connectors", [])) & {"GDELT", "ALPACA_NEWS"}:
                ids += [r["companyId"] for r in await self.ctx.db.fetch_all(LEADERS_SQL)]
        ids = list(dict.fromkeys(ids))
        companies = {}
        for offset in range(0, len(ids), 500):
            for company in await self.ctx.db.fetch_all(
                "SELECT * FROM companies WHERE id IN :ids" + (" AND is_listed=1" if free else ""),
                {"ids": ids[offset : offset + 500]},
            ):
                companies[company["id"]] = company
        return [companies[id] for id in ids if id in companies]

    async def sec_scopes(self, companies):
        ciks = list(
            dict.fromkeys(
                str(c["cik"]).zfill(10)
                for c in companies
                if c.get("cik") and re.fullmatch(r"\d{1,10}", str(c["cik"])) and int(c["cik"])
            )
        )
        groups: dict[str, list[dict[str, Any]]] = {cik: [] for cik in ciks}
        for offset in range(0, len(ciks), 500):
            batch = ciks[offset : offset + 500]
            for company in await self.ctx.db.fetch_all(
                "SELECT * FROM companies WHERE cik IN :ciks ORDER BY id",
                {"ciks": [*batch, *(str(int(cik)) for cik in batch)]},
            ):
                if str(company.get("cik") or "").zfill(10) in groups:
                    groups[str(company["cik"]).zfill(10)].append(company)
        return [group for group in groups.values() if group]

    async def discovery_batches(self, adapter, scope, *, backfill):
        """Isolate SEC issuer response failures without catching persistence errors."""
        store = SecCheckpointReader(self.store) if adapter.name == "SEC" else self.store
        iterator = adapter.batches(scope, store, backfill=backfill)
        try:
            while True:
                try:
                    batch = await anext(iterator)
                except StopAsyncIteration:
                    return
                except (ConnectorRequestError, ValueError) as error:
                    # Shared SEC cooldown/policy errors have distinct types and
                    # propagate. A defensive HTTP status check also stops denial
                    # responses from any adapter that did not use that policy.
                    if adapter.name != "SEC" or getattr(error, "httpStatus", None) in (403, 429):
                        raise
                    adapter.discoveryFailureCount += 1
                    failed = adapter.discoveryMetadata.setdefault("failedIssuers", [])
                    if len(failed) < 100:
                        failed.append(
                            {
                                "cik": str(scope[0]["cik"]).zfill(10),
                                "errorCode": "SEC_ISSUER_REQUEST_FAILED"
                                if isinstance(error, ConnectorRequestError)
                                else "SEC_SUBMISSIONS_INVALID",
                                "httpStatus": getattr(error, "httpStatus", None),
                            }
                        )
                    adapter.discoveryMetadata["issuerFailureCount"] = adapter.discoveryFailureCount
                    return
                # The consumer persists each yielded batch before requesting
                # another one. Its DB/checkpoint errors never enter this catch.
                yield batch
        finally:
            await iterator.aclose()

    async def persist(self, candidate, ir_ids, job, suppress=False, matched=()):
        policy = candidate.get("sourcePolicy") or (
            SEC_POLICY if candidate["connector"] == "SEC" else None
        )
        if (
            policy is None
            or candidate["connector"] == "NAVER"
            or not allows_audience(policy, "ADMIN_UI")
            or policy.get("rightsMode") != candidate["rightsMode"]
            or candidate["connector"] in FREE
            and policy.get("policyVersion") != 2
        ):
            return False
        metadata = candidate_metadata(candidate, policy)
        description = candidate_summary(candidate, policy)
        raw_hash = candidate_hash(candidate, metadata, description)
        external = (
            candidate.get("externalId")
            if isinstance(candidate.get("externalId"), str) and len(candidate["externalId"]) <= 255
            else None
        )
        tickers, tags = values(candidate.get("tickers", [])), values(candidate.get("tags", []))
        title = candidate["title"][:16000]
        async with self.ctx.db.transaction() as tx:
            cik = (
                candidate.get("metadata", {}).get("cik")
                if candidate["connector"] == "SEC"
                else None
            )
            symbols = [
                v
                for v in metadata.get("providerSymbols", [])
                if isinstance(v, dict) and isinstance(v.get("symbol"), str)
            ]
            lookups = values(
                [
                    value
                    for item in symbols
                    for value in (
                        item["symbol"],
                        re.sub(r"\.(KS|KQ)$", "", item["symbol"], flags=re.IGNORECASE),
                    )
                ]
            )
            master = (
                await tx.fetch_all(
                    "SELECT * FROM companies WHERE is_listed=1 AND (ticker IN :ids OR stock_code IN :ids)",
                    {"ids": lookups},
                )
                if lookups
                else []
            )
            mapping = resolve_provider_entities(symbols, [camel(c) for c in master])
            mapped = list(dict.fromkeys([*matched, *mapping["companyIds"]]))
            if cik:
                companies = await tx.fetch_all(
                    "SELECT * FROM companies WHERE cik IN :ciks ORDER BY id",
                    {"ciks": [cik, str(int(cik))]},
                )
            elif mapped:
                companies = await tx.fetch_all(
                    "SELECT * FROM companies WHERE id IN :ids", {"ids": mapped}
                )
            elif tickers and policy.get("policyVersion") != 2:
                companies = await tx.fetch_all(
                    "SELECT * FROM companies WHERE ticker IN :symbols OR stock_code IN :symbols LIMIT 2",
                    {"symbols": tickers},
                )
            else:
                companies = []
            if cik or mapped:
                tickers = sorted(values(c["ticker"] for c in companies if c.get("ticker")))
            feed_url = candidate.get("metadata", {}).get("feedUrl")
            registered = list(ir_ids.get(feed_url, []))
            profile = ir_profile(feed_url) if feed_url else None
            if profile and profile.get("enabled") and profile.get("companySymbols"):
                profile_companies = await tx.fetch_all(
                    "SELECT id FROM companies WHERE ticker IN :symbols AND market IN ('NASDAQ','NYSE','AMEX') AND is_listed=1",
                    {"symbols": profile["companySymbols"]},
                )
                if len(profile_companies) == 1 and profile_companies[0]["id"] not in registered:
                    registered.append(profile_companies[0]["id"])
            automatic = list(dict.fromkeys([*registered, *(c["id"] for c in companies)]))
            company_id = (
                registered[0]
                if len(registered) == 1
                else companies[0]["id"]
                if len(companies) == 1
                else None
            )
            if automatic:
                await tx.fetch_all(
                    "SELECT id FROM companies WHERE id IN :ids ORDER BY id FOR UPDATE",
                    {"ids": sorted(automatic)},
                )
            source = decoded_row(
                await tx.fetch_one(
                    "SELECT * FROM source_items WHERE source=:source AND "
                    + ("external_id=:identity" if external else "raw_hash=:identity")
                    + " FOR UPDATE",
                    {"source": candidate["connector"], "identity": external or raw_hash},
                )
            )
            if not source and candidate["connector"] == "IR" and profile and profile.get("enabled"):
                from orsem_worker.core import sha256

                old_sources = await tx.fetch_all(
                    "SELECT s.* FROM source_items s JOIN news_articles a ON s.news_article_id=a.id WHERE s.source='IR' AND a.url_hash=:hash ORDER BY s.first_observed_at,s.id",
                    {"hash": sha256(canonical_url(candidate["url"]))},
                )
                old = next(
                    (
                        s
                        for s in map(decoded_row, old_sources)
                        if ir_profile((s.get("raw_metadata_json") or {}).get("feedUrl", ""))
                    ),
                    None,
                )
                if old:
                    source = decoded_row(
                        await tx.fetch_one(
                            "SELECT * FROM source_items WHERE id=:id FOR UPDATE", {"id": old["id"]}
                        )
                    )
                    source["external_id"] = external
            created = source is None
            if source and (source.get("source_policy_json") or {}).get("policyVersion") == 2:
                if not allows_audience(source["source_policy_json"], "ADMIN_UI"):
                    return False
                if not candidate_summary(candidate, source["source_policy_json"]):
                    description = None
                raw_hash = candidate_hash(candidate, metadata, description)
            news = (
                decoded_row(
                    await tx.fetch_one(
                        "SELECT * FROM news_items WHERE source_item_id=:id", {"id": source["id"]}
                    )
                )
                if source
                else None
            )
            previous_input = translation_input(source, news) if source and news else None
            previous_translation = source.get("translation_json") if source else None
            previous_hash = source.get("raw_hash") if source else None
            source = source or {
                "id": identifier(),
                "source": candidate["connector"],
                "external_id": external,
                "first_observed_at": instant(candidate.get("observedAt")) or utcnow(),
            }
            old_metadata = source.get("raw_metadata_json") or {}
            source.update(
                company_id=company_id,
                url=candidate["url"],
                title=title,
                source_name=(candidate.get("sourceName") or "")[:255] or None,
                author=(candidate.get("metadata", {}).get("originalAuthor") or "")[:255] or None,
                published_at=instant(candidate.get("publishedAt")),
                processed_at=utcnow(),
                raw_hash=raw_hash,
                raw_object_uri=None,
                rights_mode=candidate["rightsMode"],
                source_kind=candidate.get("sourceKind")
                or {
                    "SEC": "OFFICIAL_DISCLOSURE",
                    "IR": "COMPANY_IR",
                    "NEWS_RSS": "OFFICIAL_RELEASE",
                }.get(candidate["connector"], "AGGREGATOR"),
                provenance_url=candidate["url"],
            )
            if (source.get("source_policy_json") or {}).get("policyVersion") != 2:
                source["source_policy_json"] = policy
            raw_metadata = {**(old_metadata if cik else {}), **metadata}
            if policy.get("policyVersion") == 2:
                raw_metadata.update(
                    manualCompanyIds=old_metadata.get("manualCompanyIds", []),
                    officialReferences=old_metadata.get("officialReferences", []),
                    officialVerification=old_metadata.get("officialVerification", "UNVERIFIED"),
                    newsReview=old_metadata.get("newsReview"),
                    entityResolution="UNRESOLVED_ENTITY" if mapping["unresolved"] else "RESOLVED",
                    resolvedEntities=mapping["resolved"],
                    unresolvedEntities=mapping["unresolved"],
                    firstObservedAt=iso(source["first_observed_at"]),
                    collectedAt=iso(),
                    providerUpdatedAt=candidate.get("updatedAt")
                    or metadata.get("providerUpdatedAt"),
                )
            if cik:
                raw_metadata["companyIds"] = sorted(c["id"] for c in companies)
            raw_metadata.update(
                tickers=tickers,
                tags=tags,
                matchedCompanyIds=list(matched),
                companyMatchMethod="UNAMBIGUOUS_METADATA_ALIAS_V2" if matched else None,
                discoveryReason=job.get("reason"),
                discoveryPriorities=job.get("priorities", []),
                triggerFilingId=job.get("triggerFilingId"),
                externalIdTruncatedToHash=candidate.get("externalId") is not None
                and external is None,
            )
            source["raw_metadata_json"] = raw_metadata
            next_input = translation_input(
                source,
                {"title": title, "description": description, "tickers_json": tickers or None},
            )
            if (
                not source.get("manual_translation_json")
                and previous_input
                and next_input
                and previous_translation
                and previous_translation.get("version") == 1
                and previous_translation.get("status") == "COMPLETED"
                and previous_translation.get("inputHash") == previous_hash
                and input_hash(previous_input) == input_hash(next_input)
            ):
                source["translation_json"] = {
                    **previous_translation,
                    "inputHash": raw_hash,
                    "sourceTextHash": input_hash(next_input),
                }
            await save_row(tx, "source_items", source, new=created)
            await attach_article(tx, source, automatic)
            await replace_relevance(
                tx,
                source["id"],
                "\n".join(v for v in (title, description) if v),
                [
                    (
                        c["id"],
                        "SEC_CIK"
                        if cik
                        else "PROVIDER_SYMBOL"
                        if c["id"] in mapping["companyIds"]
                        else "METADATA_ALIAS",
                    )
                    for c in companies
                ]
                + [(id, "REGISTERED_IR") for id in registered],
            )
            if candidate["connector"] == "SEC":
                await sec_events(tx, source, companies)
            news_new = news is None
            news = news or {"id": identifier(), "source_item_id": source["id"]}
            news.update(
                company_id=company_id,
                title=title,
                description=description,
                published_at=source["published_at"],
                tickers_json=tickers or None,
                tags_json=tags or None,
                engagement_json=None,
            )
            await save_row(tx, "news_items", news, new=news_new)
            if policy.get("policyVersion") == 2:
                await refresh_official_references(
                    tx,
                    source,
                    [
                        *automatic,
                        *(
                            id
                            for id in raw_metadata.get("manualCompanyIds", [])
                            if isinstance(id, str)
                        ),
                    ],
                    description,
                )
                group = (
                    "NEWS_ENTITY"
                    if mapping["unresolved"]
                    else "NEWS_OFFICIAL_LINK"
                    if source["raw_metadata_json"].get("officialReferences")
                    else None
                )
                if group:
                    dedupe = f"{group}:{raw_hash}"
                    existing = await tx.fetch_one(
                        "SELECT id FROM reviews WHERE subject_type='SOURCE_ITEM' AND subject_id=:id AND dedupe_key=:key",
                        {"id": source["id"], "key": dedupe},
                    )
                    if not existing:
                        await save_row(
                            tx,
                            "reviews",
                            {
                                "id": identifier(),
                                "subject_type": "SOURCE_ITEM",
                                "subject_id": source["id"],
                                "dedupe_key": dedupe,
                                "review_group": group,
                                "status": "OPEN",
                                "reason": "UNRESOLVED_ENTITY: 기존 상장기업 연결을 검토하세요."
                                if group == "NEWS_ENTITY"
                                else "공식 자료 후보의 관련성을 검토하세요. 수치·사실은 자동 확인되지 않습니다.",
                            },
                            new=True,
                        )
            if (
                created
                and candidate["connector"] == "SEC"
                and not suppress
                and not job.get("suppressAlerts")
                and job.get("reason") != "BACKFILL"
            ):
                await self.ctx.services["push_fanout"].enqueue_news(tx, camel(news), camel(source))
            return created

    async def record(
        self, name, check, *, stream=None, seen=0, created=0, success=False, metadata=None
    ):
        now = utcnow()
        metadata = {**check.get("metadata", {}), **(metadata or {})}
        async with self.ctx.db.transaction() as tx:
            row = decoded_row(
                await tx.fetch_one(
                    "SELECT * FROM connector_health WHERE connector=:name FOR UPDATE",
                    {"name": name.lower()},
                )
            )
            existing = row is not None
            row = row or {
                "id": identifier(),
                "connector": name.lower(),
                "last_success_at": None,
                "last_failure_at": None,
            }
            previous = row.get("metadata_json") or {}
            metadata["lastAttemptAt"] = (
                previous.get("lastAttemptAt")
                if metadata.get("requestAttempted") is False
                else iso(now)
            )
            if name == "SEC":
                metadata["submissionsLastSuccessAt"] = metadata.get(
                    "submissionsLastSuccessAt"
                ) or previous.get("submissionsLastSuccessAt")
            row.update(
                status=check["status"],
                message=check.get("message"),
                checked_at=now,
                metadata_json={"rightsMode": check.get("rightsMode"), **metadata},
            )
            if success:
                row["last_success_at"] = now
            if check["status"] in ("DEGRADED", "FAILED"):
                row["last_failure_at"] = now
            await save_row(tx, "connector_health", row, new=not existing)
            if stream and check["status"] != "UNCONFIGURED":
                checkpoint = await self.store.locked(tx, name, stream)
                await self.store.write(
                    tx,
                    name,
                    stream,
                    {
                        **checkpoint,
                        **metadata,
                        "seen": seen,
                        "created": created,
                        "rightsMode": check.get("rightsMode"),
                    },
                )
                if success:
                    await tx.execute(
                        "UPDATE source_checkpoints SET last_success_at=:now WHERE connector=:connector AND stream=:stream",
                        {"now": now, "connector": name, "stream": stream},
                    )

    async def discover(self, job):
        requested = set(job.get("connectors", []))
        if "NAVER" in requested:
            return []
        ir_urls, ir_ids, invalid = (
            await self.ir_sources() if "IR" in requested else (self.ctx.config.irFeedUrls, {}, [])
        )
        matchable = bool(requested & {"NEWS_RSS", "IR", "GDELT", "ALPACA_NEWS", *FREE})
        aliases = []
        if matchable:
            companies = await self.ctx.db.fetch_all(
                "SELECT id,name_ko,name_en,ticker,stock_code,market FROM companies"
            )
            extra = await self.ctx.db.fetch_all("SELECT * FROM company_aliases")
            aliases = company_aliases((camel(c) for c in companies), (camel(e) for e in extra))
            # The matcher keeps only its compact index. Drop the full master and
            # intermediate alias dictionaries before any provider I/O awaits.
            del companies, extra
        matcher = CompanyMatcher(aliases)
        del aliases
        regular_job = {**job, "connectors": list(requested - FREE)}
        companies = await self.load_companies(regular_job)
        free_scope = await self.load_companies(job, free=True) if requested & FREE else []
        us = [c for c in companies if c["market"] in US_MARKETS]
        sec_scopes = await self.sec_scopes(us) if "SEC" in requested else []
        missing = sum(
            not c.get("cik") or not re.fullmatch(r"\d{1,10}", str(c["cik"])) or not int(c["cik"])
            for c in us
        )
        scope_warning = (
            "No US companies in the requested discovery scope; no SEC requests were made."
            if not us
            else f"{missing} scoped US company/companies lack a valid SEC CIK."
            if missing
            else "No eligible SEC issuer remained in the discovery scope; no requests were made."
            if not sec_scopes
            else None
        )
        results, stream = [], stream_name(job)
        for adapter in self.adapters(ir_urls):
            if adapter.name not in requested:
                continue
            check = adapter.health()
            base_metadata = dict(check.get("metadata", {}))
            if adapter.name == "SEC":
                base_metadata.update(
                    scopedUsCompanyCount=len(us),
                    missingScopeCikCount=missing,
                    eligibleIssuerCount=len(sec_scopes),
                    emptyScope=not us,
                    requestsPlanned=bool(sec_scopes),
                )
            if check["status"] == "UNCONFIGURED":
                await self.record(
                    adapter.name, check, metadata={**base_metadata, "requestAttempted": False}
                )
                results.append(
                    {
                        "connector": adapter.name,
                        "status": "UNCONFIGURED",
                        "seen": 0,
                        "created": 0,
                        "message": check["message"],
                    }
                )
                continue
            run = {
                "id": identifier(),
                "connector": adapter.name,
                "stream": stream,
                "window_start": None,
                "window_end": None,
                "status": "PROCESSING",
                "items_seen": "0",
                "items_created": "0",
                "started_at": utcnow(),
                "finished_at": None,
                "error_message": None,
            }
            await save_row(self.ctx.db, "ingestion_runs", run, new=True)
            seen = created = 0
            try:
                scopes = (
                    sec_scopes
                    if adapter.name == "SEC"
                    else [free_scope]
                    if adapter.name in FREE
                    else [companies]
                    if adapter.name == "GDELT"
                    else [[]]
                    if adapter.name in ("IR", "NEWS_RSS")
                    else [companies[i : i + 25] for i in range(0, len(companies), 25)] or [[]]
                )
                for scope in scopes:
                    if adapter.name == "ALPACA_NEWS":
                        scope = [c for c in scope if c["market"] in US_MARKETS]
                    async for batch in self.discovery_batches(
                        adapter, scope, backfill=job.get("reason") == "BACKFILL"
                    ):
                        seen += len(batch["candidates"])
                        run["items_seen"] = str(seen)
                        selected = batch["candidates"]
                        if adapter.name == "SEC" and not batch.get("suppressAlerts"):
                            known: set[str] = set()
                            for offset in range(0, len(selected), 500):
                                ids = [
                                    c["externalId"]
                                    for c in selected[offset : offset + 500]
                                    if c.get("externalId")
                                ]
                                if ids:
                                    known.update(
                                        r["external_id"]
                                        for r in await self.ctx.db.fetch_all(
                                            "SELECT external_id FROM source_items WHERE source='SEC' AND external_id IN :ids",
                                            {"ids": ids},
                                        )
                                    )
                            selected = [c for c in selected if c.get("externalId") not in known]
                        for candidate in selected:
                            evidence = "\n".join(
                                v
                                for v in (
                                    candidate.get("title"),
                                    candidate.get("summary"),
                                    candidate.get("metadata", {}).get("description"),
                                )
                                if isinstance(v, str)
                            )
                            if await self.persist(
                                candidate,
                                ir_ids,
                                job,
                                bool(
                                    job.get("suppressAlerts")
                                    or job.get("reason") == "BACKFILL"
                                    or batch.get("suppressAlerts")
                                ),
                                matcher(evidence),
                            ):
                                created += 1
                                run["items_created"] = str(created)
                        if batch.get("checkpoint"):
                            checkpoint = batch["checkpoint"]
                            await self.store.commit(
                                adapter.name,
                                checkpoint["stream"],
                                checkpoint["expected"],
                                checkpoint["metadata"],
                            )
                is_feed = isinstance(adapter, FeedConnector)
                sec_failures = adapter.discoveryFailureCount if adapter.name == "SEC" else 0
                partial = adapter.failure_count if is_feed else sec_failures
                truncated = adapter.truncated if is_feed else adapter.discoveryWasTruncated
                if is_feed:
                    await adapter.commit_feeds()
                ownership: dict[str, Any] = {}
                if adapter.name == "SEC":
                    ownership = (
                        await self.ctx.services["sec_ownership"].ingest_pending(limit=3)
                        if self.ctx.config.secForm4Enabled and self.ctx.config.secUserAgent
                        else {"ownershipStatus": "DISABLED", "ownershipIncomplete": None}
                    )
                partial += int(ownership.get("ownershipFailed", 0))
                incomplete = ownership.get("ownershipIncomplete") is True
                warning = (
                    " ".join(
                        v
                        for v in (
                            scope_warning if adapter.name == "SEC" else None,
                            f"{sec_failures} SEC issuer discovery failure(s); completed batches were retained."
                            if sec_failures
                            else None,
                            f"SEC ownership documents remain pending ({ownership.get('ownershipPending', 0)})."
                            if incomplete
                            else None,
                            "Discovery recovery is incomplete; inspect the remaining cursor."
                            if truncated
                            else None,
                            f"{partial - sec_failures} supplementary feed/document processing failure(s); saved items were retained."
                            if partial > sec_failures
                            else None,
                        )
                        if v
                    )
                    or None
                )
                status = "DEGRADED" if warning else "HEALTHY"
                adapter_metadata = adapter.metadata if is_feed else adapter.discoveryMetadata
                complete = (
                    bool(sec_scopes) and not truncated and not sec_failures
                    if adapter.name == "SEC"
                    else not truncated
                )
                success = (
                    complete and not scope_warning and not incomplete and not partial
                    if adapter.name == "SEC"
                    else complete
                    and (
                        adapter.name not in FREE | {"ALPACA_NEWS"}
                        or adapter_metadata.get("requestsAttempted", 0) > 0
                    )
                )
                metadata = {
                    **base_metadata,
                    **ownership,
                    **adapter_metadata,
                    "ingestionStateAvailable": True,
                    "truncated": truncated,
                    "partialFailureCount": partial,
                    "discoverySeen": seen,
                    "discoveryCreated": created,
                    "requestAttempted": True
                    if is_feed
                    else adapter_metadata.get(
                        "requestsAttempted", adapter_metadata.get("requestsInRun", 0)
                    )
                    > 0,
                    "httpStatus": 200
                    if is_feed
                    or adapter_metadata.get(
                        "requestsCompleted",
                        adapter_metadata.get(
                            "requestsInRun", adapter_metadata.get("requestsAttempted", 0)
                        ),
                    )
                    > 0
                    else None,
                }
                if adapter.name == "SEC":
                    metadata.update(
                        submissionsStatus="HEALTHY" if complete else "DEGRADED",
                        submissionsHttpStatus=200
                        if adapter_metadata.get("requestsCompleted", 0) > 0
                        else None,
                        submissionsLastSuccessAt=iso() if complete else None,
                    )
                run.update(status="COMPLETED", finished_at=utcnow(), error_message=warning)
                await save_row(self.ctx.db, "ingestion_runs", run)
                await self.record(
                    adapter.name,
                    {**check, "status": status, "message": warning},
                    stream=stream,
                    seen=seen,
                    created=created,
                    success=success,
                    metadata=metadata,
                )
                results.append(
                    {
                        "connector": adapter.name,
                        "status": status,
                        "seen": seen,
                        "created": created,
                        "message": warning,
                    }
                )
            except Exception as error:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
                message = failure_message(error)
                run.update(status="FAILED", finished_at=utcnow(), error_message=message)
                await save_row(self.ctx.db, "ingestion_runs", run)
                metadata = {
                    **base_metadata,
                    **(
                        adapter.metadata
                        if isinstance(adapter, FeedConnector)
                        else adapter.discoveryMetadata
                    ),
                    "ingestionStateAvailable": True,
                }
                if hasattr(error, "httpStatus"):
                    metadata.update(
                        httpStatus=error.httpStatus,
                        requestOperation=getattr(error, "operation", None),
                        transportCategory=getattr(error, "transportCategory", None),
                        retryAt=iso(vars(error).get("retryAt"))
                        if getattr(error, "retryAt", None)
                        else None,
                        providerCode=getattr(error, "providerCode", None),
                        requestAttempted=getattr(error, "requestAttempted", True),
                        skipped=not getattr(error, "requestAttempted", True),
                    )
                if adapter.name == "SEC":
                    metadata["submissionsStatus"] = "DEGRADED"
                await self.record(
                    adapter.name,
                    {**check, "status": "DEGRADED", "message": message},
                    metadata=metadata,
                )
                results.append(
                    {
                        "connector": adapter.name,
                        "status": "DEGRADED",
                        "seen": seen,
                        "created": created,
                        "message": message,
                    }
                )
            if adapter.name == "IR":
                await self.ctx.db.execute(
                    "UPDATE ir_sources SET last_checked_at=:now WHERE is_active=1",
                    {"now": utcnow()},
                )
        if invalid:
            await self.ctx.db.execute(
                "UPDATE ir_sources SET last_checked_at=:now WHERE id IN :ids",
                {"now": utcnow(), "ids": [s["id"] for s in invalid]},
            )
        return results
