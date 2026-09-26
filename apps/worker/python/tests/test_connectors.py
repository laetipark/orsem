"""Offline security, rights, replay, and deployed fact-contract regression tests."""

import copy
import json
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from orsem_worker.config import load_config
from orsem_worker.connectors import register
from orsem_worker.connectors.classifier import (
    AI_CLASSIFIER_PROMPT_HASH,
    AI_CLASSIFIER_SYSTEM_PROMPT,
    review_suggestion,
)
from orsem_worker.connectors.common import (
    Checkpoints,
    ConnectorRequestError,
    public_url,
    request_bytes,
)
from orsem_worker.connectors.feeds import (
    excerpt,
    parse_registered_feed,
    publication_instant,
    safe_xml,
)
from orsem_worker.connectors.policy import (
    RSS_FEEDS,
    CompanyMatcher,
    candidate_hash,
    candidate_metadata,
    resolve_provider_entities,
)
from orsem_worker.connectors.projections import build_official_references
from orsem_worker.connectors.providers import (
    AlpacaNews,
    FreeNews,
    Gdelt,
    NewsApiBudget,
    SecSubmissions,
)
from orsem_worker.connectors.sec_access import (
    SecAccessCooldownError,
    SecAccessPolicyError,
    SecHttp,
    retry_time,
)
from orsem_worker.connectors.translation import source_allows_translation, translation_input
from orsem_worker.connectors.translation_facts import validate_facts
from orsem_worker.core import json_text, utcnow


class MemoryDb:
    def __init__(self):
        self.states = {}
        self.counters = 0
        self.failure = False

    @asynccontextmanager
    async def transaction(self):
        old = copy.deepcopy(self.states)
        try:
            yield self
        except BaseException:
            self.states = old
            raise

    async def fetch_one(self, sql, params=None):
        if self.failure:
            raise RuntimeError("storage unavailable")
        params = params or {}
        if "source_checkpoints" in sql:
            key = (params.get("connector"), params.get("stream"))
            if key not in self.states:
                return None
            return {"metadata_json": copy.deepcopy(self.states[key])}
        return None

    async def execute(self, sql, params=None):
        if self.failure:
            raise RuntimeError("storage unavailable")
        params = params or {}
        if "INSERT INTO source_checkpoints" in sql:
            self.states.setdefault((params["connector"], params["stream"]), {})
        elif "metadata_json=:metadata" in sql:
            self.states[(params["connector"], params["stream"])] = json.loads(params["metadata"])
        elif "api_usage_counters" in sql:
            self.counters += 1
        return 1


def context(env=None, transport=None):
    return SimpleNamespace(
        config=load_config(env or {}),
        db=MemoryDb(),
        services={},
        http=httpx.AsyncClient(
            transport=transport or httpx.MockTransport(lambda request: httpx.Response(599))
        ),
    )


@pytest.mark.parametrize(
    "row",
    json.loads((Path(__file__).parent / "fixtures/connectors_translation_facts.json").read_text()),
    ids=lambda row: row["before"],
)
def test_deployed_translation_fact_vectors(row):
    if row["reject"]:
        with pytest.raises(ValueError, match=row.get("reason") or "changed"):
            validate_facts(row["before"], row["after"])
    else:
        validate_facts(row["before"], row["after"])


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/a",
        "https://[::1]/a",
        "https://169.254.169.254/",
        "https://user:password@example.com/",
        "https://localhost/",
        "https://192.168.1.1/",
        "file:///etc/passwd",
        "https://[::ffff:127.0.0.1]/",
    ],
)
def test_private_or_credential_urls_rejected(url):
    with pytest.raises(ValueError):
        public_url(url)


@pytest.mark.parametrize(
    "xml",
    [
        '<!DOCTYPE rss [<!ENTITY a "secret">]><rss>&a;</rss>',
        '<rss><?evil read="file:///etc/passwd"?></rss>',
        "<rss>" + "<item>" * 65 + "</item>" * 65 + "</rss>",
    ],
)
def test_xml_rejects_entities_instructions_depth(xml):
    with pytest.raises(ValueError):
        safe_xml(xml)


def test_feed_metadata_no_body_fetch_or_untrusted_html():
    key, feed = next((key, feed) for key, feed in RSS_FEEDS.items() if feed.get("enabled", True))
    xml = "<rss><channel><item><title>Board announces results</title><link>https://publisher.example/results?utm_source=feed</link><guid>fixture</guid><pubDate>Thu, 10 Sep 2026 01:02:03 GMT</pubDate><description>&lt;p&gt;Revenue grew 12%.&lt;/p&gt;&lt;script&gt;secret&lt;/script&gt;</description><content>NEVER_STORE</content></item></channel></rss>"
    parsed = parse_registered_feed(key, feed, xml)
    item = parsed["candidates"][0]
    assert item["publishedAt"] == "2026-09-10T01:02:03.000Z"
    assert "NEVER_STORE" not in json_text(item)
    assert "secret" not in (item.get("summary") or "")
    assert excerpt("<p>Revenue <b>12%</b></p><script>leak</script>") == "Revenue 12%"
    assert publication_instant("2026-09-10T12:00:00", feed) is None


def test_candidate_hash_ignores_volatile_observation_and_body_v2():
    policy = {"policyVersion": 2}
    candidate = {
        "externalId": "1",
        "title": "Test",
        "url": "https://publisher.example/a",
        "publishedAt": None,
        "sourceName": "Publisher",
        "tickers": [],
        "tags": [],
        "rightsMode": "STORE_METADATA_ONLY",
        "metadata": {
            "providerFields": {"count": 2, "body": "private"},
            "collectedAt": "old",
            "unapproved": "private",
        },
    }
    metadata = candidate_metadata(candidate, policy)
    assert "private" not in json_text(metadata)
    before = candidate_hash(candidate, metadata, None)
    metadata["collectedAt"] = "new"
    assert candidate_hash(candidate, metadata, None) == before
    candidate["title"] = "Changed"
    assert candidate_hash(candidate, metadata, None) != before


@pytest.mark.asyncio
async def test_register_no_io_and_unreviewed_providers_inert():
    ctx = context(
        {
            "MARKETAUX_NEWS_ENABLED": "true",
            "MARKETAUX_API_TOKEN": "synthetic",
            "FINNHUB_NEWS_ENABLED": "true",
            "FINNHUB_API_KEY": "synthetic",
            "ALPACA_NEWS_ENABLED": "true",
            "ALPACA_API_KEY": "synthetic",
            "ALPACA_API_SECRET": "synthetic",
        }
    )
    handlers = await register(ctx)
    assert set(handlers) == {"discover-news-links", "check-connectors", "translate-news-batch"}
    assert not ctx.db.states
    assert all(
        not FreeNews(ctx, name).configured() for name in ("MARKETAUX", "ALPHAVANTAGE", "FINNHUB")
    )
    assert not AlpacaNews(ctx).configured() and not Gdelt(ctx).configured()
    assert await handlers["discover-news-links"]({"connectors": ["NAVER", "SEC"]}) == []
    await ctx.http.aclose()


@pytest.mark.asyncio
async def test_register_rejects_unregistered_feed_before_io():
    ctx = context({"NEWS_RSS_FEEDS": "unapproved"})
    with pytest.raises(ValueError, match="unregistered"):
        await register(ctx)
    assert not ctx.db.states
    await ctx.http.aclose()


@pytest.mark.asyncio
async def test_bounded_response_and_redirect_not_followed():
    requests = []

    def fetch(request):
        requests.append(request.url)
        return httpx.Response(
            302, headers={"location": "http://127.0.0.1/private"}, content=b"x" * 100
        )

    ctx = context(transport=httpx.MockTransport(fetch))
    with pytest.raises(ValueError, match="size limit"):
        await request_bytes(ctx, "https://publisher.example/", max_bytes=10)
    assert len(requests) == 1
    await ctx.http.aclose()


@pytest.mark.asyncio
async def test_sec_denial_persisted_and_next_call_skipped():
    requests = []

    def fetch(request):
        requests.append(request.url)
        return httpx.Response(
            403, content=b"Your Request Originates from an Undeclared Automated Tool"
        )

    ctx = context({"SEC_USER_AGENT": "Synthetic contact@example.com"}, httpx.MockTransport(fetch))
    client = SecHttp(ctx)
    with pytest.raises(SecAccessCooldownError) as first:
        await client.request("https://data.sec.gov/submissions/CIK0000000001.json")
    assert first.value.requestAttempted
    assert ctx.db.states[("SEC", "ACCESS_COOLDOWN")]["consecutiveFailures"] == 1
    with pytest.raises(SecAccessCooldownError) as second:
        await client.request("https://www.sec.gov/Archives/fixture.xml")
    assert not second.value.requestAttempted and len(requests) == 1
    await ctx.http.aclose()


@pytest.mark.asyncio
async def test_sec_storage_failure_is_fail_closed():
    called = []
    ctx = context(
        {"SEC_USER_AGENT": "Synthetic contact@example.com"},
        transport=httpx.MockTransport(lambda request: called.append(request) or httpx.Response(200))
    )
    ctx.db.failure = True
    with pytest.raises(SecAccessPolicyError):
        await SecHttp(ctx).request("https://data.sec.gov/submissions/CIK0000000001.json")
    assert not called
    await ctx.http.aclose()


@pytest.mark.asyncio
async def test_budget_counts_failed_attempts_and_rolling_window():
    ctx = context()
    budget = NewsApiBudget(ctx)
    now = utcnow()
    await budget.reserve("MARKETAUX", 1, now=now)
    assert ctx.db.counters == 1
    with pytest.raises(ConnectorRequestError) as caught:
        await budget.reserve("MARKETAUX", 1, now=now + timedelta(hours=23))
    assert not caught.value.requestAttempted
    assert caught.value.retryAt == now.replace(
        microsecond=(now.microsecond // 1000) * 1000
    ) + timedelta(days=1)
    await budget.reserve("MARKETAUX", 1, now=now + timedelta(days=1, seconds=1))
    assert ctx.db.counters == 2
    await ctx.http.aclose()


@pytest.mark.asyncio
async def test_sec_checkpoint_only_after_batch_consumer_persistence():
    ctx = context({"SEC_USER_AGENT": "Synthetic contact@example.com"})
    connector = SecSubmissions(ctx)
    rows = {
        "accessionNumber": ["0000000001-26-000001"],
        "filingDate": ["2026-09-10"],
        "form": ["4"],
        "primaryDocument": ["primary.xml"],
        "acceptanceDateTime": ["2026-09-10T12:00:00"],
    }
    connector.submission_file = AsyncMock(
        return_value={"cik": 1, "name": "Synthetic", "filings": {"recent": rows, "files": []}}
    )
    store = Checkpoints(ctx.db)
    iterator = connector.batches([{"cik": "1", "ticker": "TEST"}], store)
    first = await anext(iterator)
    assert first["suppressAlerts"] and first["candidates"][0]["publishedAt"] is None
    assert not ctx.db.states
    cp = first["checkpoint"]
    await store.commit("SEC", cp["stream"], cp["expected"], cp["metadata"])
    assert ctx.db.states[("SEC", cp["stream"])]["baselineComplete"] is True
    with pytest.raises(RuntimeError, match="conflict"):
        await store.commit("SEC", cp["stream"], cp["expected"], cp["metadata"])
    await iterator.aclose()
    await ctx.http.aclose()


def test_sec_date_identity_safety_and_ai_non_upgrade():
    assert retry_time(None, utcnow(), 100) - utcnow() > timedelta(hours=5)
    with pytest.raises(ValueError):
        SecSubmissions.candidates(
            "0000000001",
            "Test",
            {
                "accessionNumber": ["0000000001-26-000001"],
                "form": ["4"],
                "filingDate": ["2026-09-10"],
                "primaryDocument": ["../private"],
            },
            [],
        )
    output = {
        "nature": "MARKET_BUY",
        "direction": "INCREASE",
        "confidence": 1,
        "rationale": "test",
        "evidence": ["positive"],
    }
    result = review_suggestion(output, ["positive quantity"], "INCREASE", "UNKNOWN")
    assert result["result"] == "REVIEW_REQUIRED"
    assert len(AI_CLASSIFIER_PROMPT_HASH) == 64 and AI_CLASSIFIER_SYSTEM_PROMPT


def test_provider_symbols_never_infer_conflicting_identity():
    companies = [
        {"id": "one", "ticker": "TEST", "stockCode": None, "market": "NASDAQ", "isListed": True}
    ]
    result = resolve_provider_entities(
        [{"symbol": "TEST", "country": "KR", "exchange": "NASDAQ"}], companies
    )
    assert not result["companyIds"] and result["unresolved"][0]["reason"] == "CONFLICTING_MARKET"
    matcher = CompanyMatcher(
        [
            {"companyId": "one", "alias": "Apple", "aliasType": "COMPANY_NAME"},
            {"companyId": "one", "alias": "AAPL", "aliasType": "SYMBOL"},
        ]
    )
    assert matcher("An apple fell") == [] and matcher("Results for $AAPL") == ["one"]


def test_translation_blocks_retired_and_restricted_sources():
    source = {
        "source": "NAVER",
        "title": "Company announces quarterly results",
        "rights_mode": "OFFICIAL_PUBLIC_DATA",
        "source_policy_json": {
            "rightsMode": "OFFICIAL_PUBLIC_DATA",
            "aiAllowed": True,
            "metadataStorageAllowed": True,
            "displayAllowed": True,
        },
    }
    assert translation_input(source, {}) is None
    source["source"] = "IR"
    source["rights_mode"] = "LINK_ONLY"
    assert not source_allows_translation(source)


def test_official_links_preserve_only_matching_review_hash():
    policy = {
        "rightsMode": "OFFICIAL_PUBLIC_DATA",
        "metadataStorageAllowed": True,
        "displayAllowed": True,
    }
    source = {
        "id": "news",
        "source": "IR",
        "url": "https://publisher.example/a",
        "title": "Results",
        "raw_hash": "new",
        "rights_mode": "OFFICIAL_PUBLIC_DATA",
        "source_policy_json": policy,
        "published_at": utcnow(),
    }
    official = {
        "id": "sec",
        "source": "SEC",
        "url": "https://www.sec.gov/Archives/000000000126000001/a.xml",
        "external_id": "0000000001-26-000001",
        "rights_mode": "OFFICIAL_PUBLIC_DATA",
        "raw_hash": "target",
        "source_policy_json": policy,
        "published_at": utcnow(),
        "company_id": "company",
    }
    previous = [
        {
            "kind": "SOURCE_ITEM",
            "id": "sec",
            "matchMethod": "EXPLICIT_ID",
            "status": "CONFIRMED",
            "sourceHash": "old",
            "targetHash": "target",
        }
    ]
    result = build_official_references(
        source, ["company"], ["0000000001-26-000001"], [], [official], previous=previous
    )
    assert (
        result["officialVerification"] == "LINKED"
        and result["officialReferences"][0]["status"] == "RELATED"
    )


def test_deployed_rss_entities_provenance_and_stable_hash_match():
    from orsem_worker.connectors.policy import candidate_summary

    fixture = json.loads(
        (Path(__file__).parent / "fixtures/connectors_rss_deployed.json").read_text()
    )
    parsed = parse_registered_feed(fixture["feedId"], RSS_FEEDS[fixture["feedId"]], fixture["xml"])
    candidate = parsed["candidates"][0]
    candidate.pop("observedAt")
    candidate["metadata"].pop("collectedAt")
    assert parsed == fixture["parsed"]
    policy = candidate["sourcePolicy"]
    assert (
        candidate_hash(
            candidate, candidate_metadata(candidate, policy), candidate_summary(candidate, policy)
        )
        == fixture["hash"]
    )


@pytest.mark.asyncio
async def test_schema_identifiers_accept_sha256_but_reject_sql_fragments():
    from orsem_worker.connectors.common import save_row

    db = SimpleNamespace(execute=AsyncMock())
    values = {"id": "synthetic", "raw_sha256": "a" * 64}
    await save_row(db, "parse_runs", values, new=True)
    sql, bound = db.execute.await_args.args
    assert "`raw_sha256`" in sql and ":raw_sha256" in sql
    assert all(bound[key] == value for key, value in values.items())
    for table, fields in (
        ("parse_runs; DROP TABLE filings", values),
        ("parse_runs", {"id": "synthetic", "raw_sha256`=NULL": "unsafe"}),
        ("3parse_runs", values),
        ("parse_runs", {"id": "synthetic", "3column": "unsafe"}),
    ):
        db.execute.reset_mock()
        with pytest.raises(ValueError):
            await save_row(db, table, fields, new=True)
        db.execute.assert_not_awaited()
