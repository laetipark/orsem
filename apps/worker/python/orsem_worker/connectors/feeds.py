"""Registered RSS/Atom ingestion. Article URLs are never fetched."""

import html
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

from defusedxml import ElementTree

from orsem_worker.core import sha256

from .common import (
    MAX_METADATA_BYTES,
    Checkpoints,
    ConnectorRequestError,
    failure_message,
    instant,
    iso,
    pinned_https_bytes,
    public_url,
    retry_after,
)
from .policy import RSS_FEEDS, approved, canonical_url, ir_profile, summary_allowed

DROP_WITH_CONTENT = {
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "iframe",
    "object",
    "form",
    "button",
    "nav",
    "header",
    "footer",
    "aside",
}
BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote"}


def normalize_text(text):
    text = "".join(c for c in html.unescape(text) if ord(c) >= 32 and ord(c) != 127)
    return re.sub(
        r"\s+", " ", re.sub(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff]", "", text)
    ).strip()


def html_blocks(value, roots=()):
    if len(value.encode("utf-8")) > MAX_METADATA_BYTES:
        raise ValueError("Article HTML exceeded its size limit.")
    tokens = re.findall(r"<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]{0,8192}>|[^<]+|<", value)
    stack = []
    root_depth = 0 if not roots else None
    dropped = 0
    active: dict[str, Any] | None = None
    blocks: list[dict[str, Any]] = []
    total = 0

    def add(tag, raw, ordered=False):
        nonlocal total
        text = normalize_text(raw)
        if not text:
            return
        if len(text) > 3500 or len(blocks) >= 600 or total + len(text) > 500000:
            raise ValueError("Article content exceeded its size limit.")
        total += len(text)
        if tag == "li":
            last = blocks[-1] if blocks else None
            if (
                last
                and last["type"] == "LIST"
                and last["ordered"] == ordered
                and len(last["items"]) < 200
                and sum(map(len, last["items"])) + len(text) <= 3500
            ):
                last["items"].append(text)
            else:
                blocks.append({"type": "LIST", "ordered": ordered, "items": [text]})
        elif tag == "blockquote":
            blocks.append({"type": "QUOTE", "text": text})
        elif re.fullmatch("h[1-6]", tag):
            blocks.append({"type": "HEADING", "level": max(2, int(tag[1])), "text": text})
        else:
            blocks.append({"type": "PARAGRAPH", "text": text})

    for token in tokens:
        if token.startswith("<!--") or token.upper().startswith("<!DOCTYPE"):
            continue
        if token.startswith("<![CDATA["):
            if root_depth is not None and not dropped and active:
                active["text"] += token[9:-3]
            continue
        if not token.startswith("<"):
            if root_depth is not None and not dropped:
                if active:
                    active["text"] += " " + token
                elif normalize_text(token):
                    add("p", token)
            continue
        if token == "<":
            raise ValueError("Oversized or malformed HTML tag.")
        match = re.fullmatch(r"<\s*(/?)\s*([a-zA-Z][\w:-]*)([\s\S]*?)/?\s*>", token)
        if not match:
            continue
        closing, name, attrs = match.groups()
        name = name.lower()
        self_closing = bool(
            re.search(r"/\s*>$", token) or name in ("br", "hr", "img", "meta", "link", "input")
        )

        def attr(key, attrs=attrs):
            m = re.search(
                rf"""(?:^|\s){key}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))""",
                attrs,
                re.IGNORECASE,
            )
            return next((g for g in m.groups() if g is not None), "") if m else None

        if not closing:
            stack.append(name)
            if root_depth is None and any(
                (not s.get("tag") or s["tag"].lower() == name)
                and (not s.get("id") or s["id"] == attr("id"))
                and (not s.get("className") or s["className"] in (attr("class") or "").split())
                for s in roots
            ):
                root_depth = len(stack)
            if root_depth is not None and name in DROP_WITH_CONTENT:
                dropped += 1
            if root_depth is not None and not dropped:
                if name == "br" and active:
                    active["text"] += "\n"
                if name in BLOCK_TAGS:
                    if active:
                        add(active["tag"], active["text"], active["ordered"])
                    parent = next((p for p in reversed(stack) if p in ("ol", "ul")), None)
                    active = {"tag": name, "text": "", "ordered": parent == "ol"}
            if self_closing:
                if root_depth is not None and name in DROP_WITH_CONTENT:
                    dropped -= 1
                stack.pop()
            continue
        before = len(stack)
        if root_depth is not None and not dropped and active and active["tag"] == name:
            add(active["tag"], active["text"], active["ordered"])
            active = None
        if root_depth is not None and name in DROP_WITH_CONTENT and dropped:
            dropped -= 1
        if name in stack:
            del stack[len(stack) - 1 - stack[::-1].index(name) :]
        if root_depth is not None and roots and before == root_depth:
            root_depth = None
    if active and not dropped and root_depth is not None:
        add(active["tag"], active["text"], active["ordered"])
    if roots and not blocks:
        raise ValueError("Official article body was not found.")
    return blocks


def excerpt(value):
    if not value.strip():
        return None
    try:
        blocks = html_blocks(value)
        text = "\n\n".join(
            t for b in blocks for t in (b["items"] if b["type"] == "LIST" else [b["text"]])
        ).strip()
        return text[:3000] or None
    except ValueError:
        return None


def publication_instant(value, feed):
    if not value:
        return None
    if (
        feed.get("publishedAtMode") == "SOURCE_LOCAL_TIME"
        and feed.get("publishedTimeZone") == "Asia/Seoul"
    ):
        match = re.fullmatch(
            r"(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+[+-]\d{4})?",
            value,
        )
        if not match:
            return None
        try:
            day, month, year, hour, minute, second = match.groups()
            months = [
                "jan",
                "feb",
                "mar",
                "apr",
                "may",
                "jun",
                "jul",
                "aug",
                "sep",
                "oct",
                "nov",
                "dec",
            ]
            dt = datetime(
                int(year),
                months.index(month.lower()) + 1,
                int(day),
                int(hour),
                int(minute),
                int(second),
                tzinfo=timezone(timedelta(hours=9)),
            )
            return iso(dt)
        except ValueError:
            return None
    if not re.search(
        r"(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)$", value, re.IGNORECASE
    ):
        return None
    return iso(instant(value)) if instant(value) else None


def safe_xml(value):
    if len(value.encode("utf-8")) > MAX_METADATA_BYTES:
        raise ValueError("RSS response exceeded its size limit.")

    def pi(match):
        text = match[0]
        if (
            text.startswith("<?xml-stylesheet")
            and re.fullmatch(r"<\?xml-stylesheet(?:\s+[^<]*)?\?>", text)
            and len(text.encode()) <= 4096
        ):
            return ""
        if re.match(r"<\?xml\s", text):
            return text
        raise ValueError("XML processing instruction rejected.")

    clean = re.sub(r"<\?[\s\S]*?\?>", pi, value)
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)", clean, re.IGNORECASE):
        raise ValueError("DTD/entity declarations are not allowed.")
    # Validate structure before building a tree, keeping hostile deep XML bounded.
    from xml.parsers import expat

    parser = expat.ParserCreate()
    depth = nodes = 0

    def start_element(name, attributes):
        nonlocal depth, nodes
        depth += 1
        nodes += 1
        if depth > 64 or nodes > 100000:
            raise ValueError("XML structural limit exceeded.")

    def end_element(name):
        nonlocal depth
        depth -= 1

    parser.StartElementHandler = start_element
    parser.EndElementHandler = end_element
    try:
        parser.Parse(clean, True)
    except expat.ExpatError as error:
        raise ValueError("Invalid RSS XML.") from error
    # The deployed feed parser uses processEntities=false. Preserve lexical entities
    # outside CDATA so provenance strings and stable metadata hashes remain identical.
    parts = re.split(r"(<!\[CDATA\[[\s\S]*?\]\]>)", clean)
    entity_preserved = "".join(
        part if part.startswith("<![CDATA[") else part.replace("&", "&amp;")
        for part in parts
    )
    root = ElementTree.fromstring(entity_preserved)
    count = 0
    stack = [(root, 1)]
    while stack:
        node, depth = stack.pop()
        count += 1
        if depth > 64 or count > 100000:
            raise ValueError("XML structural limit exceeded.")
        stack.extend((child, depth + 1) for child in node)
    return root


def _children(node, name):
    return [child for child in node if child.tag.split("}")[-1] == name]


def _text(node):
    return "".join(node.itertext()) if node is not None else ""


def _first(node, name):
    return next(iter(_children(node, name)), None)


def parse_registered_feed(feed_id, feed, xml, connector="NEWS_RSS"):
    if not approved(feed.get("policy")) or not feed.get("enabled", True):
        raise ValueError("RSS rights approval is required.")
    root = safe_xml(xml)
    name = root.tag.split("}")[-1]
    if name == "rss" and _first(root, "channel") is not None:
        entries = _children(_first(root, "channel"), "item")
    elif name == "feed":
        entries = _children(root, "entry")
    else:
        raise ValueError("RSS returned neither RSS nor Atom.")
    result: dict[str, Any] = {"candidates": [], "skippedItems": 0, "truncated": False}
    seen = set()
    for entry in entries:
        if len(result["candidates"]) >= 500:
            result["truncated"] = True
            break
        try:
            title_raw = _text(_first(entry, "title"))
            links = _children(entry, "link")
            link_raw = next((_text(link) for link in links if _text(link).strip()), "") or next(
                (
                    link.attrib.get("href", "")
                    for link in links
                    if link.attrib.get("rel", "") in ("", "alternate") and link.attrib.get("href")
                ),
                "",
            )
            guid = _text(_first(entry, "guid")) or _text(_first(entry, "id")) or None
            published_raw = (
                _text(_first(entry, "pubDate")) or _text(_first(entry, "published")) or None
            )
            updated_raw = _text(_first(entry, "updated")) or None
            if (
                not title_raw.strip()
                or not link_raw.strip()
                or len(title_raw) > 16000
                or len(link_raw) > 8000
                or len(guid or "") > 8000
                or len(published_raw or "") > 256
                or len(updated_raw or "") > 256
            ):
                raise ValueError("Invalid RSS metadata.")
            title = html.unescape(title_raw).strip()
            parsed = public_url(urljoin(feed["url"], html.unescape(link_raw).strip()))
            url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
            external_id = sha256(f"{feed_id}:{canonical_url(url)}")
            if external_id in seen:
                continue
            seen.add(external_id)
            published = publication_instant(html.unescape(published_raw or "").strip(), feed)
            description_html = _text(_first(entry, "description")) or _text(
                _first(entry, "summary")
            )
            if len(description_html) > 64000:
                raise ValueError("RSS description exceeds the item limit.")
            description = excerpt(description_html) if summary_allowed(feed["policy"]) else None
            updated = publication_instant(updated_raw or "", {})
            observed = iso()
            candidate = {
                "connector": connector,
                "externalId": external_id,
                "title": title,
                "url": url,
                "publishedAt": published,
                "observedAt": observed,
                "sourceName": feed["publisher"],
                "tickers": [],
                "tags": ["IR", "RSS"]
                if connector == "IR"
                else [*feed.get("categories", ["MARKET"]), "RSS"],
                "rightsMode": feed["policy"]["rightsMode"],
                "sourceKind": feed["sourceKind"],
                "sourcePolicy": feed["policy"],
                "metadata": {
                    "feedId": feed_id,
                    "feedUrl": feed["url"],
                    "publisher": feed["publisher"],
                    "publisherId": feed.get("publisherId"),
                    "originalAuthor": _text(_first(entry, "author"))
                    or _text(_first(entry, "creator"))
                    or None,
                    "originalCategories": [
                        _text(c) for c in _children(entry, "category") if _text(c)
                    ][:100],
                    "marketRegion": feed["marketRegion"],
                    "rightsContext": feed["rightsContext"],
                    "rightsPolicyUrl": feed["rightsPolicyUrl"],
                    "originalTitle": title_raw,
                    "originalLink": link_raw,
                    "originalGuid": guid,
                    "originalPublishedAt": published_raw,
                    "originalUpdatedAt": updated_raw,
                    "providerUpdatedAt": updated,
                    "collectedAt": observed,
                    "description": description,
                },
            }
            if updated:
                candidate["updatedAt"] = updated
            if feed["policy"].get("policyVersion") == 2:
                candidate["metadata"]["independentVerification"] = False
            result["candidates"].append(candidate)
        except (ValueError, TypeError, KeyError):
            result["skippedItems"] += 1
    return result


def decode_feed(feed_id, data):
    encoding = "utf-8"
    if feed_id in ("eia-today", "eia-press"):
        declaration = data[:256].decode("ascii", errors="replace")
        match = re.search(
            r"""^\s*<\?xml\b[^?]*\bencoding=["']([^"']+)["']""", declaration, re.IGNORECASE
        )
        declared = match[1].lower() if match else None
        if declared and declared not in ("utf-8", "utf8", "iso-8859-1", "windows-1252"):
            raise ValueError("Unsupported EIA encoding.")
        encoding = "cp1252" if declared in ("iso-8859-1", "windows-1252") else declared or encoding
    return data.decode(encoding, errors="strict")


class FeedConnector:
    def __init__(self, ctx, name, feeds, transport=None):
        self.ctx, self.name = ctx, name
        self.feeds = {}
        for key in dict.fromkeys(feeds):
            definition = RSS_FEEDS.get(key) if name == "NEWS_RSS" else ir_profile(key)
            if definition is None:
                raise ValueError("Feed is not registered.")
            if definition.get("enabled", True) and approved(definition["policy"]):
                self.feeds[key] = definition
        if name == "IR" and len(self.feeds) > 100:
            raise ValueError("IR feed limit exceeded.")
        self.configured = bool(self.feeds)
        self.store = Checkpoints(ctx.db)
        self.transport = transport or pinned_https_bytes
        self.pending = {}
        self.metadata = {}
        self.failure_count = 0
        self.truncated = False

    def health(self):
        return {
            "connector": self.name,
            "status": "DEGRADED" if self.configured else "UNCONFIGURED",
            "message": "Configured; health is determined by scheduled discovery."
            if self.configured
            else "No approved feeds enabled.",
            "checkedAt": iso(),
            "rightsMode": "OFFICIAL_PUBLIC_DATA"
            if self.name == "NEWS_RSS"
            else "PRIVATE_DISPLAY_ONLY",
            "metadata": {
                "healthSource": f"{self.name}_INGESTION",
                "configured": self.configured,
                "feeds": list(self.feeds),
            },
        }

    async def _state(self, url):
        return (await self.store.load(self.name, "RSS_HTTP:" + sha256(url)))["metadata"]

    async def _failure(self, url, message):
        self.pending.pop(url, None)
        stream = "RSS_HTTP:" + sha256(url)
        async with self.ctx.db.transaction() as tx:
            old = await self.store.locked(tx, self.name, stream)
            await self.store.write(
                tx,
                self.name,
                stream,
                {
                    **old,
                    "etag": None,
                    "lastModified": None,
                    "feedUrl": url,
                    "status": "DEGRADED",
                    "lastFailureAt": iso(),
                    "errorMessage": message[:1000],
                },
            )

    async def fetch_feed(self, feed_id):
        feed = self.feeds[feed_id]
        url = feed["url"]
        public_url(
            url, https=True, allowed_hosts=feed.get("allowedHosts", [urlsplit(url).hostname])
        )
        previous = await self._state(url)

        def safe(v):
            return (
                v if isinstance(v, str) and len(v) <= 1024 and not re.search(r"[\r\n]", v) else None
            )

        headers = {
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
            "Accept-Encoding": "identity",
            "User-Agent": "Orsem/0.1 (+https://orsem.laetipark.me; noncommercial RSS reader)",
        }
        for key, field in (("If-None-Match", "etag"), ("If-Modified-Since", "lastModified")):
            if safe(previous.get(field)):
                headers[key] = previous[field]
        response = await self.transport(
            url, self.ctx.config.httpTimeoutMs, MAX_METADATA_BYTES, headers
        )
        status = response.status_code
        if status == 304 and not (headers.get("If-None-Match") or headers.get("If-Modified-Since")):
            raise ValueError("RSS returned 304 without cached response.")
        if status not in (200, 304):
            raise ConnectorRequestError(
                self.name,
                feed_id,
                status,
                retry_at=retry_after(response.headers.get("retry-after")),
            )
        if status == 200:
            media = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if (
                media
                not in (
                    "application/rss+xml",
                    "application/atom+xml",
                    "application/xml",
                    "text/xml",
                )
                or response.headers.get("content-encoding", "identity") != "identity"
            ):
                raise ValueError("RSS media type/encoding not approved.")
        self.pending[url] = {
            "etag": safe(response.headers.get("etag"))
            or (previous.get("etag") if status == 304 else None),
            "lastModified": safe(response.headers.get("last-modified"))
            or (previous.get("lastModified") if status == 304 else None),
            "checkedAt": iso(),
            "httpStatus": status,
        }
        if status == 304:
            self.metadata["notModifiedCount"] += 1
            return {"candidates": [], "skippedItems": 0, "truncated": False}
        parsed = parse_registered_feed(
            feed_id, feed, decode_feed(feed_id, response.content), self.name
        )
        if parsed["skippedItems"] or parsed["truncated"]:
            await self._failure(
                url,
                f"{parsed['skippedItems']} malformed RSS item(s); truncated={parsed['truncated']}",
            )
        return parsed

    async def batches(self, scope, store, **kwargs):
        self.pending = {}
        self.failure_count = 0
        self.truncated = False
        self.metadata = {
            "failedFeedCount": 0,
            "notModifiedCount": 0,
            "skippedItemCount": 0,
            "collectionMode": "METADATA_ONLY",
            "truncated": False,
        }
        candidates = []
        for feed_id, feed in self.feeds.items():
            try:
                parsed = await self.fetch_feed(feed_id)
                candidates += parsed["candidates"]
                self.metadata["skippedItemCount"] += parsed["skippedItems"]
                self.truncated = self.truncated or parsed["truncated"]
            except Exception as exc:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
                self.metadata["failedFeedCount"] += 1
                await self._failure(feed["url"], failure_message(exc))
        self.failure_count = self.metadata["failedFeedCount"] + self.metadata["skippedItemCount"]
        self.metadata["truncated"] = self.truncated
        if (
            self.configured
            and self.metadata["failedFeedCount"] == len(self.feeds)
            or not candidates
            and self.metadata["skippedItemCount"]
        ):
            raise ValueError(
                f"{self.name} discovery failed: {self.metadata['failedFeedCount']} feeds failed, {self.metadata['skippedItemCount']} malformed items."
            )
        yield {"candidates": candidates}

    async def commit_feeds(self):
        for url, state in self.pending.items():
            stream = "RSS_HTTP:" + sha256(url)
            async with self.ctx.db.transaction() as tx:
                old = await self.store.locked(tx, self.name, stream)
                await self.store.write(
                    tx,
                    self.name,
                    stream,
                    {**old, **state, "feedUrl": url, "status": "HEALTHY", "errorMessage": None},
                )
                await tx.execute(
                    "UPDATE source_checkpoints SET last_success_at=UTC_TIMESTAMP(6) WHERE connector=:connector AND stream=:stream",
                    {"connector": self.name, "stream": stream},
                )
        self.pending = {}
