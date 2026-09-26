"""GDELT metadata discovery and replayable, bounded time-window recovery."""

from __future__ import annotations

import asyncio
import re
import unicodedata
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urlsplit

from orsem_worker.core import sha256, utcnow

from ..common import ConnectorRequestError, fetch_json, instant, iso, public_url
from ..policy import REGISTRY, approved, canonical_url
from .base import Adapter, array, bounded


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
