"""Alpaca news metadata discovery with approval and continuation tokens."""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

from orsem_worker.core import sha256, utcnow

from ..common import ConnectorRequestError, fetch_json, instant, iso, public_url
from ..policy import approved
from .base import Adapter, array, bounded, news_symbols, valid_access, zoned

ALPACA_APPROVAL = None


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
