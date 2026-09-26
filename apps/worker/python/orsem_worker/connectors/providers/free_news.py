"""Approved metadata discovery for Marketaux, Alpha Vantage, and Finnhub."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

from orsem_worker.core import sha256, utcnow

from ..common import ConnectorRequestError, fetch_json, instant, iso, public_url
from ..policy import EXTERNAL_POLICIES, approved, canonical_url, without_content
from .base import Adapter, array, bounded, news_symbols, valid_access, zoned
from .budget import NewsApiBudget

FREE_APPROVALS = {"MARKETAUX": None, "ALPHAVANTAGE": None, "FINNHUB": None}


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
