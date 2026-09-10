"""Native metadata provider adapters and durable, replayable coverage cursors."""

from __future__ import annotations

import asyncio
import re
import unicodedata
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode, urlsplit

from orsem_worker.core import sha256, utcnow

from .common import Checkpoints, ConnectorRequestError, fetch_json, instant, iso, public_url
from .policy import EXTERNAL_POLICIES, REGISTRY, approved, canonical_url, without_content

US_MARKETS = {"NASDAQ", "NYSE", "AMEX"}
FREE_APPROVALS = {"MARKETAUX": None, "ALPHAVANTAGE": None, "FINNHUB": None}
ALPACA_APPROVAL = None


def bounded(value, limit, *, nullable=False):
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError("Invalid provider metadata string.")
    return value


def zoned(value):
    value = bounded(value, 256)
    if not re.search(r"(?:Z|[+-]\d\d:\d\d)$", value):
        raise ValueError("Provider publication timestamp lacks an offset.")
    result = instant(value)
    if result is None:
        raise ValueError("Invalid provider timestamp.")
    return iso(result)


def array(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError("Invalid provider metadata list.")
    return value


class Adapter:
    rightsMode = "STORE_METADATA_ONLY"

    def __init__(self, ctx, name):
        self.ctx, self.name = ctx, name
        self.discoveryMetadata = {}
        self.discoveryWasTruncated = False
        self.discoveryFailureCount = 0

    def configured(self):
        return False

    def health(self):
        enabled = self.configured()
        return {
            "connector": self.name,
            "status": "DEGRADED" if enabled else "UNCONFIGURED",
            "message": f"Configured; awaiting {self.name} discovery results."
            if enabled
            else f"{self.name} disabled, credentials missing, or rights require review.",
            "checkedAt": utcnow(),
            "rightsMode": self.rightsMode,
            "metadata": {"configured": enabled, "healthSource": self.name + "_INGESTION"},
        }


class SecSubmissions(Adapter):
    rightsMode = "OFFICIAL_PUBLIC_DATA"

    def __init__(self, ctx):
        super().__init__(ctx, "SEC")
        self.attempted = self.completed = self.skipped = 0

    def configured(self):
        return bool(self.ctx.config.secUserAgent)

    async def submission_file(self, cik, filename=None):
        filename = filename or f"CIK{cik}.json"
        if not self.configured() or not re.fullmatch(r"\d{10}", cik) or cik == "0000000000":
            raise ValueError("SEC configuration/CIK invalid.")
        if filename != f"CIK{cik}.json" and not re.fullmatch(
            rf"CIK{cik}-submissions-\d+\.json", filename
        ):
            raise ValueError("Unsafe SEC history filename.")
        try:
            value = await fetch_json(
                self.ctx,
                "SEC",
                f"https://data.sec.gov/submissions/{filename}",
                operation="submissions",
                headers={"User-Agent": self.ctx.config.secUserAgent, "Accept": "application/json"},
            )
            self.attempted += 1
            self.completed += 1
            return value
        except Exception as error:
            if getattr(error, "requestAttempted", True):
                self.attempted += 1
            else:
                self.skipped += 1
            raise
        finally:
            self.discoveryMetadata.update(
                requestsAttempted=self.attempted,
                requestsCompleted=self.completed,
                requestsSkipped=self.skipped,
            )

    @staticmethod
    def candidates(cik, name, rows, tickers):
        if not isinstance(rows, dict):
            raise ValueError("Invalid SEC rows.")  # noqa: TRY004 - preserve the deployed provider validation exception contract
        accessions = array(rows.get("accessionNumber"), 20000)
        for key in ("filingDate", "form", "primaryDocument"):
            if len(array(rows.get(key), 20000)) != len(accessions):
                raise ValueError("SEC columns differ in length.")
        for key in ("acceptanceDateTime", "reportDate"):
            if key in rows and len(array(rows[key], 20000)) != len(accessions):
                raise ValueError("SEC columns differ in length.")
        result = []
        for index, accession in enumerate(accessions):
            if not isinstance(accession, str) or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession):
                raise ValueError("Invalid SEC accession.")
            primary = bounded(rows["primaryDocument"][index], 1024)
            if any(
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", segment) or segment in (".", "..")
                for segment in primary.split("/")
            ):
                raise ValueError("Unsafe SEC document path.")
            accepted = rows.get("acceptanceDateTime", [None] * len(accessions))[index]
            published = (
                iso(instant(accepted))
                if isinstance(accepted, str) and re.search(r"(?:Z|[+-]\d\d:\d\d)$", accepted)
                else None
            )
            original: dict[str, Any] = {}
            truncated = False
            for key, values in rows.items():
                if (
                    not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", key)
                    or not isinstance(values, list)
                    or index >= len(values)
                ):
                    continue
                value = values[index]
                if isinstance(value, (dict, list)):
                    continue
                if len(original) >= 40:
                    truncated = True
                    continue
                if isinstance(value, str) and len(value) > 2048:
                    value = value[:2048]
                    truncated = True
                original[key] = value
            form = bounded(rows["form"][index], 256)
            result.append(
                {
                    "connector": "SEC",
                    "externalId": accession,
                    "title": f"{form} — {name}",
                    "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{primary}",
                    "publishedAt": published,
                    "sourceName": "SEC EDGAR",
                    "tickers": sorted(set(tickers)),
                    "tags": [form],
                    "rightsMode": "OFFICIAL_PUBLIC_DATA",
                    "metadata": {
                        "cik": cik,
                        "form": form,
                        "filingDate": rows["filingDate"][index],
                        "reportDate": rows.get("reportDate", [None] * len(accessions))[index],
                        "acceptanceDateTime": accepted,
                        "primaryDocument": primary,
                        "originalFiling": original,
                        "originalFilingTruncated": truncated,
                    },
                }
            )
        return result

    async def batches(self, scope, store, *, backfill=False, **kwargs):
        if not self.configured() or not scope:
            return
        cik = str(next((c.get("cik") for c in scope if c.get("cik")), "")).zfill(10)
        if cik == "0000000000":
            return
        stream = f"SUBMISSIONS:CIK:{cik}"
        checkpoint = await store.load(self.name, stream)
        revision, previous = checkpoint["revision"], checkpoint["metadata"]
        parsed = await self.submission_file(cik)
        if str(parsed.get("cik", "")).zfill(10) != cik:
            raise ValueError("SEC submissions CIK mismatch.")
        name = bounded(parsed.get("name"), 16000)
        filings = parsed.get("filings", {})
        files = [bounded(file.get("name"), 255) for file in array(filings.get("files", []), 2000)]
        if any(not re.fullmatch(rf"CIK{cik}-submissions-\d+\.json", f) for f in files):
            raise ValueError("Unsafe SEC history filename.")
        tickers = [c["ticker"] for c in scope if c.get("ticker")]
        recent = self.candidates(cik, name, filings.get("recent"), tickers)
        baseline = previous.get("baselineComplete") is True and isinstance(
            previous.get("newestKnownAccession"), str
        )
        gap = not any(c["externalId"] == previous.get("newestKnownAccession") for c in recent)
        pending = [v for v in previous.get("pendingFiles", []) if isinstance(v, str)]
        additions = (
            files
            if (not baseline or gap or backfill) and not pending
            else [f for f in files if gap or f not in previous.get("completedFiles", [])]
            if pending or gap
            else []
        )
        remaining = list(dict.fromkeys(pending + additions))
        completed = list(previous.get("completedFiles", [])) if pending else []
        metadata = {
            **previous,
            "provider": "SEC",
            "capability": "SUBMISSIONS_GAP_RECOVERY",
            "lastFetchedAt": iso(),
            "lastSourceFile": "recent",
            "newestKnownAccession": recent[0]["externalId"]
            if recent
            else previous.get("newestKnownAccession"),
            "pendingFiles": remaining,
            "completedFiles": completed,
            "cursor": remaining[0] if remaining else None,
            "baselineComplete": baseline or not remaining,
            "incomplete": bool(remaining),
            "truncated": False,
            "mode": "BACKFILL" if backfill or not baseline else "POLL",
        }
        if not remaining:
            metadata["lastSuccessfulObservedAt"] = iso()
        self.discoveryMetadata.update(metadata, checkpoint=stream)
        yield {
            "candidates": recent,
            "suppressAlerts": backfill or not baseline,
            "checkpoint": {"stream": stream, "expected": revision, "metadata": dict(metadata)},
        }
        revision += 1
        requests = 1
        while remaining and requests < self.ctx.config.secBackfillMaxRequests:
            filename = remaining[0]
            rows = await self.submission_file(cik, filename)
            requests += 1
            candidates = self.candidates(cik, name, rows, tickers)
            remaining = remaining[1:]
            completed = [*completed, filename]
            metadata = {
                **metadata,
                "lastFetchedAt": iso(),
                "lastSourceFile": filename,
                "pendingFiles": remaining,
                "completedFiles": completed,
                "cursor": remaining[0] if remaining else None,
                "baselineComplete": baseline or not remaining,
                "incomplete": bool(remaining),
            }
            if not remaining:
                metadata["lastSuccessfulObservedAt"] = iso()
            self.discoveryMetadata.update(metadata, checkpoint=stream)
            yield {
                "candidates": candidates,
                "suppressAlerts": True,
                "checkpoint": {"stream": stream, "expected": revision, "metadata": dict(metadata)},
            }
            revision += 1
        self.discoveryWasTruncated |= bool(remaining)
        self.discoveryMetadata.update(requestsInIssuerRun=requests)


class NewsApiBudget:
    def __init__(self, ctx):
        self.ctx, self.store = ctx, Checkpoints(ctx.db)

    async def reserve(self, provider, daily, per_minute=None, now=None):
        now = now or utcnow()
        stamp = int(now.timestamp() * 1000)
        if (
            not isinstance(daily, int)
            or not 1 <= daily <= 1000
            or (per_minute is not None and (not isinstance(per_minute, int) or per_minute < 1))
        ):
            raise ValueError("Invalid news request budget.")
        async with self.ctx.db.transaction() as tx:
            metadata = await self.store.locked(tx, provider, "NEWS_API_BUDGET")
            reservations = metadata.get("reservations", [])
            if (
                not isinstance(reservations, list)
                or len(reservations) > 10000
                or any(not isinstance(v, (int, float)) or v < 0 for v in reservations)
            ):
                raise ValueError("Stored news budget invalid.")
            reservations = sorted(v for v in reservations if v > stamp - 86400000)
            retry = instant(metadata.get("retryAt"))
            recent = [v for v in reservations if v > stamp - 60000]
            blocked = [retry] if retry and retry > now else []
            if len(reservations) >= daily:
                blocked.append(
                    datetime.fromtimestamp((reservations[-daily] + 86400000) / 1000, UTC)
                )
            if per_minute and len(recent) >= per_minute:
                blocked.append(datetime.fromtimestamp((recent[-per_minute] + 60000) / 1000, UTC))
            if blocked:
                raise ConnectorRequestError(
                    provider, "news-budget", 429, retry_at=max(blocked), request_attempted=False
                )
            reservations.append(stamp)
            next_run = (
                datetime.fromtimestamp((reservations[-daily] + 86400000) / 1000, UTC)
                if len(reservations) >= daily
                else now
            )
            updated = {
                **metadata,
                "version": 1,
                "reservations": reservations,
                "retryAt": None,
                "lastError": None,
                "dailyRequestBudget": daily,
                "rollingRequestBudget": daily,
                "rollingRequestCount": len(reservations),
                "requestBudgetWindow": "ROLLING_24_HOURS",
            }
            await self.store.write(tx, provider, "NEWS_API_BUDGET", updated)
            await tx.execute(
                "INSERT INTO api_usage_counters (id,connector,usage_date,request_count,last_request_at,created_at,updated_at) VALUES (UUID(),:connector,:day,1,:now,:now,:now) ON DUPLICATE KEY UPDATE request_count=request_count+1,last_request_at=:now,updated_at=:now",
                {"connector": provider, "day": now.date(), "now": now},
            )
            return {**updated, "nextRunAt": iso(next_run)}

    async def defer(self, provider, retry_at, reason):
        if not re.fullmatch(r"[A-Z_0-9]{1,64}", reason):
            raise ValueError("Unsafe budget reason.")
        async with self.ctx.db.transaction() as tx:
            metadata = await self.store.locked(tx, provider, "NEWS_API_BUDGET")
            previous = instant(metadata.get("retryAt"))
            await self.store.write(
                tx,
                provider,
                "NEWS_API_BUDGET",
                {
                    **metadata,
                    "retryAt": iso(max(previous, retry_at) if previous else retry_at),
                    "lastError": reason,
                },
            )


def news_symbols(scope, provider):
    result = []
    for company in scope:
        ticker, market = company.get("ticker"), company.get("market")
        if (
            market in US_MARKETS
            and isinstance(ticker, str)
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.\-]{0,31}", ticker)
        ):
            result.append(ticker)
        elif (
            provider == "MARKETAUX"
            and market in ("KOSPI", "KOSDAQ")
            and re.fullmatch(r"\d{6}", company.get("stock_code") or "")
        ):
            result.append(company["stock_code"] + (".KS" if market == "KOSPI" else ".KQ"))
    return list(dict.fromkeys(result))


def valid_access(approval):
    return bool(
        approval
        and approval.get("entitlementConfirmed") is True
        and instant(approval.get("freeAccessVerifiedUntil"))
        and instant(approval["freeAccessVerifiedUntil"]) > utcnow()
    )


class FreeNews(Adapter):
    def __init__(self, ctx, provider, approval=None):
        super().__init__(ctx, provider)
        self.prefix = {
            "MARKETAUX": "marketaux",
            "ALPHAVANTAGE": "alphaVantage",
            "FINNHUB": "finnhub",
        }[provider]
        self.approval: dict[str, Any] = (
            approval if approval is not None else FREE_APPROVALS[provider]
        ) or {}
        self.budget = NewsApiBudget(ctx)

    def configured(self):
        a = self.approval
        return bool(
            getattr(self.ctx.config, self.prefix + "NewsEnabled")
            and getattr(
                self.ctx.config,
                "marketauxApiToken" if self.name == "MARKETAUX" else self.prefix + "ApiKey",
            )
            and valid_access(a)
            and approved(a.get("providerPolicy"))
            and a["providerPolicy"].get("policyVersion") == 2
            and a["providerPolicy"].get("rightsMode") == self.rightsMode
            and "ADMIN_UI" in a["providerPolicy"].get("allowedAudiences", [])
            and a["providerPolicy"].get("policyId") == EXTERNAL_POLICIES[self.name].get("policyId")
            and (
                self.name != "FINNHUB"
                or isinstance(a.get("verifiedRequestsPerMinute"), int)
                and a["verifiedRequestsPerMinute"] > 0
            )
            and any(approved(p.get("policy")) for p in a.get("publisherPolicies", {}).values())
        )

    async def request(self, symbols, start, end, page):
        key = getattr(
            self.ctx.config,
            "marketauxApiToken" if self.name == "MARKETAUX" else self.prefix + "ApiKey",
        )
        if self.name == "MARKETAUX":
            params = {
                "api_token": key,
                "symbols": ",".join(symbols),
                "filter_entities": "true",
                "limit": 3,
                "page": page,
                "published_after": start[:19],
                "published_before": end[:19],
                "domains": ",".join(self.approval["publisherPolicies"]),
                "group_similar": "false",
            }
            return await fetch_json(
                self.ctx,
                self.name,
                "https://api.marketaux.com/v1/news/all?" + urlencode(params),
                operation="news",
            )
        if self.name == "ALPHAVANTAGE":
            compact = lambda v: re.sub(r"[-:]", "", v)[:13]
            params = {
                "function": "NEWS_SENTIMENT",
                "apikey": key,
                "tickers": symbols[0],
                "time_from": compact(start),
                "time_to": compact(end),
                "sort": "LATEST",
                "limit": 1000,
            }
            value = await fetch_json(
                self.ctx,
                self.name,
                "https://www.alphavantage.co/query?" + urlencode(params),
                operation="news",
            )
            if isinstance(value, dict) and (value.get("Information") or value.get("Note")):
                raise ConnectorRequestError(
                    self.name, "news", 429, retry_at=utcnow() + timedelta(days=1)
                )
            if isinstance(value, dict) and value.get("Error Message"):
                raise ConnectorRequestError(self.name, "news", 403)
            return value
        return await fetch_json(
            self.ctx,
            self.name,
            "https://finnhub.io/api/v1/company-news?"
            + urlencode({"symbol": symbols[0], "from": start[:10], "to": end[:10]}),
            operation="news",
            headers={"X-Finnhub-Token": key},
        )

    def parse(self, raw, page):
        parsed, next_page, saturated = [], None, False
        if self.name == "MARKETAUX":
            items = array(raw.get("data"), 3)
            meta = raw.get("meta", {})
            if (
                meta.get("page") != page
                or meta.get("limit") != 3
                or meta.get("returned") != len(items)
                or not isinstance(meta.get("found"), int)
                or meta["found"] < len(items)
            ):
                raise ValueError("Invalid Marketaux pagination.")
            next_page = page + 1 if len(items) == 3 and page * 3 < meta["found"] else None
        elif self.name == "ALPHAVANTAGE":
            items = array(raw.get("feed"), 1000)
            if str(raw.get("items")) != str(len(items)):
                raise ValueError("Invalid Alpha Vantage count.")
            saturated = len(items) == 1000
        else:
            items = array(raw, 1000)
            saturated = len(items) == 1000
        for item in items:
            title = bounded(item.get("title" if self.name != "FINNHUB" else "headline"), 4000)
            url = bounded(item.get("url"), 4096)
            public_url(url)
            source = bounded(item.get("source"), 255)
            summary = item.get("description" if self.name == "MARKETAUX" else "summary")
            if summary is not None and (not isinstance(summary, str) or len(summary) > 16000):
                raise ValueError("Invalid provider summary.")
            fields, symbols = {}, []
            if self.name == "MARKETAUX":
                external = bounded(item.get("uuid"), 128)
                publication = zoned(item.get("published_at"))
                symbols = [
                    {
                        "symbol": bounded(e.get("symbol"), 64),
                        "country": e.get("country"),
                        "exchange": e.get("exchange"),
                    }
                    for e in array(item.get("entities", []), 1000)
                ]
            elif self.name == "ALPHAVANTAGE":
                external = None
                source_time = bounded(item.get("time_published"), 16)
                if not re.fullmatch(r"\d{8}T\d{6}", source_time):
                    raise ValueError("Invalid Alpha timestamp.")
                publication = iso(
                    datetime.strptime(source_time, "%Y%m%dT%H%M%S").replace(tzinfo=UTC)
                )
                symbols = [
                    {"symbol": bounded(e.get("ticker"), 64)}
                    for e in array(item.get("ticker_sentiment", []), 1000)
                ]
                fields = {
                    k: without_content(item[k])
                    for k in (
                        "ticker_sentiment",
                        "topics",
                        "overall_sentiment_score",
                        "overall_sentiment_label",
                    )
                    if k in item
                }
                fields["sentimentStatus"] = "UNVERIFIED_PROVIDER_METADATA"
            else:
                external = str(item.get("id"))
                if not re.fullmatch(r"\d+", external):
                    raise ValueError("Invalid Finnhub id.")
                timestamp = item.get("datetime")
                if not isinstance(timestamp, int) or not 0 <= timestamp <= 253402300799:
                    raise ValueError("Invalid Finnhub time.")
                publication = iso(datetime.fromtimestamp(timestamp, UTC))
                related = item.get("related", "")
                if not isinstance(related, str) or len(related) > 8000:
                    raise ValueError("Invalid Finnhub symbols.")
                symbols = [
                    {"symbol": v.strip(), "country": "us"} for v in related.split(",") if v.strip()
                ]
                fields = {k: item[k] for k in ("category", "related") if k in item}
            parsed.append(
                {
                    "id": external,
                    "title": title,
                    "url": url,
                    "source": source,
                    "publishedAt": publication,
                    "summary": summary,
                    "symbols": symbols,
                    "providerFields": fields,
                }
            )
        return parsed, next_page, saturated

    def candidate(self, item):
        url = public_url(item["url"], https=True)
        publisher = self.approval["publisherPolicies"].get(url.hostname)
        if (
            not publisher
            or publisher.get("domain") != url.hostname
            or item["source"] not in publisher.get("sourceNames", [])
            or not approved(publisher.get("policy"))
        ):
            return None
        provider_policy, publisher_policy = self.approval["providerPolicy"], publisher["policy"]
        if publisher_policy.get("rightsMode") != self.rightsMode:
            return None
        policy = {
            **provider_policy,
            "rightsStatus": "METADATA_ONLY",
            "allowedAudiences": ["ADMIN_UI"],
            "fullTextStorageAllowed": False,
            "notifyAllowed": False,
            "publicRedistributionAllowed": False,
        }
        for key in ("aiAllowed", "translationAllowed", "summaryStorageAllowed"):
            policy[key] = provider_policy.get(key) is True and publisher_policy.get(key) is True
        return {
            "connector": self.name,
            "externalId": item["id"] or sha256(canonical_url(item["url"])),
            "title": item["title"],
            "url": item["url"],
            "publishedAt": item["publishedAt"],
            "sourceName": item["source"],
            "tickers": [],
            "tags": [],
            "summary": item["summary"] if policy.get("summaryStorageAllowed") else None,
            "rightsMode": self.rightsMode,
            "sourceKind": "PRESS_RELEASE"
            if publisher.get("sourceKind") == "PRESS_RELEASE"
            else "AGGREGATOR",
            "sourcePolicy": policy,
            "metadata": {
                "discoveryProvider": self.name,
                "providerArticleId": item["id"],
                "externalIdentityKind": "PROVIDER_ID" if item["id"] else "CANONICAL_URL_SHA256",
                "providerPublishedAt": item["publishedAt"],
                "publishedTimestampMeaning": "PROVIDER_PUBLICATION_TIME",
                "providerSymbols": item["symbols"],
                "sourceDomain": url.hostname,
                "publisherPolicySnapshot": publisher_policy,
                "providerPolicySnapshot": provider_policy,
                "publisherSourceKind": publisher.get("sourceKind"),
                "independentVerification": publisher.get("independentVerification") is True,
                "metadataOnly": True,
                "allowedAudiences": ["ADMIN_UI"],
                "providerFields": without_content(item["providerFields"]),
                "marketRegion": "global",
                "attributionName": item["source"],
            },
        }

    async def batches(self, scope, store, **kwargs):
        if not self.configured():
            return
        symbols = news_symbols(scope, self.name)
        if not symbols:
            return
        rotation = await store.load(self.name, "NEWS_ROTATION")
        offset = (
            symbols.index(rotation["metadata"].get("nextSymbol"))
            if rotation["metadata"].get("nextSymbol") in symbols
            else 0
        )
        selected = symbols[offset : offset + (25 if self.name == "MARKETAUX" else 1)]
        stream = "NEWS:" + sha256(",".join(selected))
        state = await store.load(self.name, stream)
        previous, revision = state["metadata"], state["revision"]
        pending = previous.get("incomplete") is True and isinstance(previous.get("nextPage"), int)
        start = (
            previous.get("windowStart")
            if pending
            else iso(
                (instant(previous.get("cursor")) - timedelta(minutes=10))
                if instant(previous.get("cursor"))
                else utcnow() - timedelta(days=1)
            )
        )
        end = previous.get("windowEnd") if pending else iso()
        page = previous.get("nextPage") if pending else 1
        hashes = list(previous.get("pageHashes", [])) if pending else []
        for count in range(getattr(self.ctx.config, self.prefix + "NewsRequestsPerRun")):
            if not self.configured():
                raise ValueError("News access approval expired.")
            if (
                not isinstance(page, int)
                or not 1 <= page <= 100
                or not instant(start)
                or not instant(end)
            ):
                raise ValueError("Invalid news pagination cursor.")
            budget = await self.budget.reserve(
                self.name,
                getattr(self.ctx.config, self.prefix + "NewsDailyBudget"),
                self.approval.get("verifiedRequestsPerMinute"),
            )
            self.discoveryMetadata.update(budget, requestsAttempted=count + 1)
            try:
                if not self.configured():
                    raise ValueError("News access approval expired.")
                items, next_page, saturated = self.parse(
                    await self.request(selected, start, end, page), page
                )
                page_hash = sha256("\n".join(item["id"] or item["url"] for item in items))
                if items and page_hash in hashes:
                    raise ValueError("Repeated news page.")
                if items:
                    hashes.append(page_hash)
            except Exception as error:
                status = getattr(error, "httpStatus", 0)
                reason = {
                    401: "AUTHENTICATION",
                    402: "DAILY_LIMIT",
                    403: "ENTITLEMENT",
                    429: "RATE_LIMIT",
                }.get(status, "PROVIDER_FAILURE" if status >= 500 else "MALFORMED_RESPONSE")
                seconds = 86400 if status in (401, 402, 403) else 60 if status == 429 else 300
                retry = max(
                    getattr(error, "retryAt", None) or utcnow(),
                    utcnow() + timedelta(seconds=seconds),
                )
                await self.budget.defer(self.name, retry, reason)
                self.discoveryMetadata.update(
                    incomplete=True, nextRunAt=iso(retry), lastError=reason
                )
                raise
            if self.name == "FINNHUB":
                for item in items:
                    if not item["symbols"]:
                        item["symbols"] = [{"symbol": selected[0], "country": "us"}]
                        item["providerFields"]["requestedSymbol"] = selected[0]
            candidates = [candidate for item in items if (candidate := self.candidate(item))]
            incomplete = next_page is not None or saturated
            metadata = {
                **previous,
                "provider": self.name,
                "windowStart": start,
                "windowEnd": end,
                "cursor": previous.get("cursor") if incomplete else end,
                "nextPage": next_page,
                "pageHashes": hashes,
                "incomplete": incomplete,
                "truncated": saturated,
                "lastFetchedAt": iso(),
                "rejectedByPolicyCount": len(items) - len(candidates),
                "requestsInRun": count + 1,
            }
            self.discoveryMetadata.update(metadata)
            self.discoveryWasTruncated = incomplete
            yield {
                "candidates": candidates,
                "suppressAlerts": True,
                "checkpoint": {"stream": stream, "expected": revision, "metadata": dict(metadata)},
            }
            revision += 1
            if next_page is None:
                if not saturated:
                    await store.commit(
                        self.name,
                        "NEWS_ROTATION",
                        rotation["revision"],
                        {
                            "nextSymbol": symbols[(offset + len(selected)) % len(symbols)],
                            "cursor": end,
                            "incomplete": False,
                        },
                    )
                break
            page = next_page


class AlpacaNews(Adapter):
    def __init__(self, ctx, approval=None):
        super().__init__(ctx, "ALPACA_NEWS")
        self.approval: dict[str, Any] = (
            approval if approval is not None else ALPACA_APPROVAL
        ) or {}

    def configured(self):
        c = self.ctx.config
        return bool(
            c.alpacaNewsEnabled
            and c.alpacaApiKey
            and c.alpacaApiSecret
            and valid_access(self.approval)
            and any(
                approved(p.get("policy")) and p["policy"].get("rightsMode") == self.rightsMode
                for p in self.approval.get("publisherPolicies", {}).values()
            )
        )

    async def batches(self, scope, store, **kwargs):
        if not self.configured():
            return
        access = await store.load(self.name, "ACCESS_COOLDOWN")
        retry = instant(access["metadata"].get("retryAt"))
        if retry and retry > utcnow():
            raise ConnectorRequestError(
                self.name, "news", 429, retry_at=retry, request_attempted=False
            )
        symbols = sorted(set(news_symbols(scope, self.name)))
        if not symbols:
            return
        stream = "NEWS:" + sha256(",".join(symbols))
        state = await store.load(self.name, stream)
        previous, revision = state["metadata"], state["revision"]
        pending = previous.get("incomplete") is True
        horizon = utcnow() - timedelta(minutes=16)
        start = (
            previous.get("windowStart")
            if pending
            else iso(
                (instant(previous.get("cursor")) - timedelta(minutes=10))
                if instant(previous.get("cursor"))
                else horizon - timedelta(days=1)
            )
        )
        end = previous.get("windowEnd") if pending else iso(horizon)
        token = previous.get("nextPageToken") if pending else None
        tokens = set()
        for page in range(4):
            if not self.configured():
                raise ValueError("Alpaca news approval expired.")
            if (
                not instant(start)
                or not instant(end)
                or token is not None
                and (not isinstance(token, str) or len(token) > 4096)
            ):
                raise ValueError("Invalid Alpaca cursor.")
            if token in tokens:
                raise ValueError("Repeated Alpaca page token.")
            tokens.add(token)
            params = {
                "symbols": ",".join(symbols),
                "start": start,
                "end": end,
                "sort": "asc",
                "limit": 50,
                "include_content": "false",
            }
            if token:
                params["page_token"] = token
            self.discoveryMetadata["requestsAttempted"] = page + 1
            try:
                raw = await fetch_json(
                    self.ctx,
                    self.name,
                    "https://data.alpaca.markets/v1beta1/news?" + urlencode(params),
                    operation="news",
                    headers={
                        "APCA-API-KEY-ID": self.ctx.config.alpacaApiKey,
                        "APCA-API-SECRET-KEY": self.ctx.config.alpacaApiSecret,
                    },
                )
            except ConnectorRequestError as error:
                if error.httpStatus == 429:
                    await store.commit(
                        self.name,
                        "ACCESS_COOLDOWN",
                        access["revision"],
                        {
                            "retryAt": iso(error.retryAt or utcnow() + timedelta(seconds=60)),
                            "incomplete": True,
                        },
                    )
                raise
            items = array(raw.get("news"), 50)
            next_token = raw.get("next_page_token")
            if next_token is not None and (
                not isinstance(next_token, str) or len(next_token) > 4096
            ):
                raise ValueError("Invalid Alpaca page token.")
            candidates = []
            for item in items:
                external = str(item.get("id"))
                title = bounded(item.get("headline"), 16000)
                if not re.fullmatch(r"\d+", external):
                    raise ValueError("Invalid Alpaca id.")
                publication, updated = zoned(item.get("created_at")), zoned(item.get("updated_at"))
                url = public_url(item.get("url"), https=True)
                source = bounded(item.get("source"), 255)
                tickers = [bounded(symbol, 128) for symbol in array(item.get("symbols"), 1000)]
                publisher = self.approval["publisherPolicies"].get(source)
                if (
                    not publisher
                    or publisher.get("domain") != url.hostname
                    or not approved(publisher.get("policy"))
                    or publisher["policy"].get("rightsMode") != self.rightsMode
                ):
                    continue
                candidates.append(
                    {
                        "connector": self.name,
                        "externalId": external,
                        "title": title,
                        "url": item["url"],
                        "publishedAt": publication,
                        "updatedAt": updated,
                        "sourceName": source,
                        "tickers": tickers,
                        "tags": [],
                        "rightsMode": self.rightsMode,
                        "sourceKind": "INDEPENDENT_MEDIA",
                        "sourcePolicy": {
                            **publisher["policy"],
                            "aiAllowed": False,
                            "fullTextStorageAllowed": False,
                            "notifyAllowed": False,
                        },
                        "metadata": {
                            "rightsContext": "APPROVED_PUBLISHER_METADATA",
                            "discoveryProvider": self.name,
                            "providerArticleId": external,
                            "providerPublishedAt": publication,
                            "providerUpdatedAt": updated,
                            "metadataOnly": True,
                            "language": "en",
                            "marketRegion": "us",
                            "attributionName": source,
                        },
                    }
                )
            metadata = {
                **previous,
                "windowStart": start,
                "windowEnd": end,
                "nextPageToken": next_token,
                "cursor": previous.get("cursor") if next_token else end,
                "incomplete": bool(next_token),
                "lastFetchedAt": iso(),
                "requestsInRun": page + 1,
            }
            self.discoveryMetadata.update(metadata)
            self.discoveryWasTruncated = bool(next_token)
            yield {
                "candidates": candidates,
                "suppressAlerts": True,
                "checkpoint": {"stream": stream, "expected": revision, "metadata": metadata},
            }
            revision += 1
            if not next_token:
                break
            token = next_token


class Gdelt(Adapter):
    def __init__(self, ctx):
        super().__init__(ctx, "GDELT")
        self.lock, self.next_request, self.retry, self.denials = asyncio.Lock(), None, None, 0
        self.domains = ctx.config.gdeltApprovedDomains
        self.policies = REGISTRY["APPROVED_GDELT_SOURCE_POLICIES"]

    def configured(self):
        return bool(
            self.ctx.config.gdeltEnabled
            and self.domains
            and all(
                domain in REGISTRY["APPROVED_GDELT_DOMAINS"]
                and approved(self.policies.get(domain))
                and self.policies[domain].get("rightsMode") == self.rightsMode
                for domain in self.domains
            )
        )

    async def search(self, query, window):
        params = {
            "query": query,
            "mode": "artlist",
            "format": "json",
            "sort": "datedesc",
            "maxrecords": 250,
            "startdatetime": instant(window["start"]).strftime("%Y%m%d%H%M%S"),
            "enddatetime": instant(window["end"]).strftime("%Y%m%d%H%M%S"),
        }
        async with self.lock:
            if self.retry and self.retry > utcnow():
                raise ConnectorRequestError(
                    self.name, "document-search", 429, retry_at=self.retry, request_attempted=False
                )
            if self.next_request and self.next_request > utcnow():
                await asyncio.sleep((self.next_request - utcnow()).total_seconds())
            try:
                raw = await fetch_json(
                    self.ctx,
                    self.name,
                    "https://api.gdeltproject.org/api/v2/doc/doc?" + urlencode(params),
                    operation="document-search",
                )
                self.retry, self.denials = None, 0
            except ConnectorRequestError as error:
                if error.httpStatus == 429:
                    self.denials += 1
                    self.retry = max(
                        utcnow() + timedelta(seconds=min(900, 60 * 2 ** min(10, self.denials - 1))),
                        error.retryAt or utcnow(),
                    )
                    raise ConnectorRequestError(
                        self.name, "document-search", 429, retry_at=self.retry
                    ) from None
                raise
            finally:
                self.next_request = utcnow() + timedelta(seconds=5)
        candidates = []
        for item in array(raw.get("articles", []), 250):
            title = bounded(item.get("title"), 16000)
            public_url(item.get("url"))
            seen = item.get("seendate")
            observed = None
            if isinstance(seen, str):
                try:
                    observed = iso(datetime.strptime(seen, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC))
                except ValueError:
                    observed = iso(instant(seen))
            candidates.append(
                {
                    "connector": self.name,
                    "externalId": None,
                    "title": title,
                    "url": item["url"],
                    "publishedAt": None,
                    "sourceName": item.get("domain"),
                    "tickers": [],
                    "tags": [],
                    "rightsMode": self.rightsMode,
                    "metadata": {
                        "observedBySourceAt": observed,
                        "originalSeenDate": seen,
                        "country": item.get("sourcecountry"),
                        "language": item.get("language"),
                    },
                }
            )
        return candidates

    def queries(self, scope):
        names = sorted(
            {
                re.sub(
                    r"\s+", " ", re.sub(r'["\\()]', " ", unicodedata.normalize("NFKC", name))
                ).strip()[:100]
                for company in scope
                for key in ("name_en", "name_ko")
                if isinstance(name := company.get(key), str) and len(name.strip()) >= 2
            }
        )
        topics = [
            '(economy OR inflation OR "interest rate" OR employment OR "central bank" OR "stock market")'
        ]
        topics.extend(
            "(" + " OR ".join('"' + name + '"' for name in names[i : i + 10]) + ")"
            for i in range(0, len(names), 10)
        )
        suffix = (
            " (sourcelang:english OR sourcelang:korean) ("
            + " OR ".join("domainis:" + domain for domain in self.domains)
            + ")"
        )
        return [topic + suffix for topic in topics]

    def candidate(self, candidate):
        host = urlsplit(candidate["url"]).hostname
        policy = self.policies.get(host) if host in self.domains else None
        if (
            policy is None
            or not approved(policy)
            or str(candidate["metadata"].get("language", "")).lower()
            not in (
                "english",
                "korean",
                "en",
                "ko",
            )
        ):
            return None
        return {
            **candidate,
            "externalId": sha256(canonical_url(candidate["url"])),
            "sourceKind": "INDEPENDENT_MEDIA",
            "sourcePolicy": {
                **policy,
                "aiAllowed": False,
                "fullTextStorageAllowed": False,
                "notifyAllowed": False,
            },
            "metadata": {
                **candidate["metadata"],
                "discoveryProvider": "GDELT",
                "rightsContext": "APPROVED_PUBLISHER_METADATA",
                "metadataOnly": True,
                "marketRegion": "global",
                "attributionName": "GDELT",
                "attributionUrl": "https://www.gdeltproject.org/",
            },
        }

    async def batches(self, scope, store, **kwargs):
        if not self.configured():
            return
        requests, incompletes, now = 0, {}, utcnow()
        for query in self.queries(scope):
            stream = "DOC_WINDOW:" + sha256(query)
            state = await store.load(self.name, stream)
            previous, revision = state["metadata"], state["revision"]
            cursor = instant(previous.get("cursor"))
            start = (
                cursor - timedelta(minutes=self.ctx.config.gdeltOverlapMinutes)
                if cursor
                else now - timedelta(days=1)
            )
            pending = previous.get("pendingWindows", [])
            if not isinstance(pending, list) or any(
                not isinstance(w, dict)
                or not instant(w.get("start"))
                or not instant(w.get("end"))
                or instant(w["end"]) <= instant(w["start"])
                or not isinstance(w.get("depth"), int)
                or w["depth"] < 0
                for w in pending
            ):
                raise ValueError("Invalid stored GDELT windows.")
            new_plan = not pending
            if new_plan:
                pending = [
                    {
                        "start": iso(start),
                        "end": iso(min(now, start + timedelta(days=1))),
                        "depth": 0,
                    }
                ]
            metadata = {
                **previous,
                "provider": self.name,
                "capability": "DOC_WINDOW_RECOVERY",
                "checkpoint": stream,
                "queryHash": sha256(query),
                "incomplete": True,
                "truncated": False,
            }
            if new_plan:
                if instant(pending[0]["end"]) <= start:
                    raise ValueError("Invalid GDELT clock window.")
                metadata.update(
                    pendingWindows=pending,
                    lastWindowStart=pending[0]["start"],
                    lastWindowEnd=pending[0]["end"],
                )
                yield {
                    "candidates": [],
                    "suppressAlerts": True,
                    "checkpoint": {
                        "stream": stream,
                        "expected": revision,
                        "metadata": dict(metadata),
                    },
                }
                revision += 1
            while pending:
                window = pending[0]
                metadata = {
                    **metadata,
                    "lastWindowStart": window["start"],
                    "lastWindowEnd": window["end"],
                    "pendingWindows": pending,
                    "requestsInRun": requests,
                }
                coverage = (
                    "OUTSIDE_DOC_HISTORY_REQUIRES_RECONCILIATION"
                    if instant(window["start"]) < now - timedelta(days=89)
                    else "REQUEST_BUDGET"
                    if requests >= 12
                    else None
                )
                if coverage:
                    metadata.update(incomplete=True, coverageError=coverage)
                    self.discoveryWasTruncated = True
                    self.discoveryMetadata.update(metadata)
                    yield {
                        "candidates": [],
                        "suppressAlerts": True,
                        "checkpoint": {
                            "stream": stream,
                            "expected": revision,
                            "metadata": dict(metadata),
                        },
                    }
                    revision += 1
                    if requests >= 12:
                        return
                    break
                raw = await self.search(query, window)
                requests += 1
                saturated = len(raw) >= 250
                if (
                    saturated
                    and window["depth"] < self.ctx.config.gdeltMaxSplitDepth
                    and instant(window["end"]) - instant(window["start"]) >= timedelta(minutes=30)
                ):
                    mid = datetime.fromtimestamp(
                        int(
                            (
                                instant(window["start"]).timestamp()
                                + instant(window["end"]).timestamp()
                            )
                            / 2
                        ),
                        UTC,
                    )
                    pending = [
                        {"start": window["start"], "end": iso(mid), "depth": window["depth"] + 1},
                        {"start": iso(mid), "end": window["end"], "depth": window["depth"] + 1},
                        *pending[1:],
                    ]
                    continue
                if not saturated:
                    pending = pending[1:]
                metadata = {
                    **metadata,
                    "cursor": metadata.get("cursor")
                    if saturated
                    else iso(
                        max(
                            instant(window["end"]),
                            cursor or datetime.fromtimestamp(0, UTC),
                        )
                    ),
                    "lastFetchedAt": iso(),
                    "pendingWindows": pending,
                    "incomplete": saturated or bool(pending),
                    "truncated": saturated,
                    "coverageError": "SATURATED_MINIMUM_WINDOW_OR_DEPTH" if saturated else None,
                    "lastItemCount": len(raw),
                    "requestsInRun": requests,
                    "latestObservedAt": max(
                        (
                            c["metadata"].get("observedBySourceAt")
                            for c in raw
                            if c["metadata"].get("observedBySourceAt")
                        ),
                        default=None,
                    ),
                }
                candidates = [c for item in raw if (c := self.candidate(item))]
                self.discoveryMetadata.update(
                    metadata, rejectedByPolicyCount=len(raw) - len(candidates)
                )
                incompletes[stream] = metadata["incomplete"]
                self.discoveryWasTruncated = any(incompletes.values())
                yield {
                    "candidates": candidates,
                    "suppressAlerts": True,
                    "checkpoint": {
                        "stream": stream,
                        "expected": revision,
                        "metadata": dict(metadata),
                    },
                }
                revision += 1
                if saturated:
                    break
