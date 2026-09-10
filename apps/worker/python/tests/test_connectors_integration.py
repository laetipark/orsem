"""Opt-in transactional tests against the disposable migrated database only."""

import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from orsem_worker.config import load_config
from orsem_worker.connectors.common import Checkpoints, decoded_row, save_row
from orsem_worker.connectors.discovery import Discovery
from orsem_worker.connectors.policy import RSS_FEEDS
from orsem_worker.connectors.providers import NewsApiBudget
from orsem_worker.core import Database, identifier, utcnow

URL = os.environ.get("ORSEM_CONNECTORS_TEST_DB", "")
pytestmark = pytest.mark.skipif(
    not URL, reason="Set ORSEM_CONNECTORS_TEST_DB to disposable migrated MySQL"
)


@pytest_asyncio.fixture
async def ctx():
    if "/orsem_test?" not in URL:
        raise RuntimeError("Only disposable orsem_test is allowed")
    db = Database.from_url(URL)
    context = SimpleNamespace(
        config=load_config({}),
        db=db,
        services={"push_fanout": SimpleNamespace(enqueue_news=AsyncMock())},
    )
    yield context
    await db.close()


@pytest.mark.asyncio
async def test_sec_persist_idempotency_share_classes_and_receipt_projection(ctx):
    cik = str(int(identifier().replace("-", "")[:8], 16)).zfill(10)
    companies = []
    for index in range(2):
        company = identifier()
        companies.append(company)
        await save_row(
            ctx.db,
            "companies",
            {
                "id": company,
                "market": "NASDAQ",
                "ticker": "S" + company[:7].upper(),
                "cik": cik,
                "name_ko": "Synthetic SEC",
                "is_listed": True,
            },
            new=True,
        )
    accession = f"{cik}-26-000001"
    candidate = {
        "connector": "SEC",
        "externalId": accession,
        "title": "4 — Synthetic SEC",
        "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/primary.xml",
        "publishedAt": None,
        "sourceName": "SEC EDGAR",
        "tickers": [],
        "tags": ["4"],
        "rightsMode": "OFFICIAL_PUBLIC_DATA",
        "metadata": {
            "cik": cik,
            "form": "4",
            "filingDate": "2026-09-10",
            "reportDate": "2026-09-09",
            "acceptanceDateTime": "2026-09-10T12:00:00",
            "primaryDocument": "primary.xml",
            "originalFiling": {"form": "4"},
        },
    }
    job = {"reason": "SCHEDULED", "priorities": ["P1"], "suppressAlerts": False}
    service = Discovery(ctx)
    assert await service.persist(candidate, {}, job)
    source = decoded_row(
        await ctx.db.fetch_one(
            "SELECT * FROM source_items WHERE source='SEC' AND external_id=:id", {"id": accession}
        )
    )
    assert source["published_at"] is None and source["raw_metadata_json"]["companyIds"] == sorted(
        companies
    )
    observed = source["first_observed_at"]
    raw_hash = source["raw_hash"]
    assert not await service.persist(candidate, {}, job)
    source2 = decoded_row(
        await ctx.db.fetch_one("SELECT * FROM source_items WHERE id=:id", {"id": source["id"]})
    )
    assert source2["first_observed_at"] == observed and source2["raw_hash"] == raw_hash
    events = await ctx.db.fetch_all(
        "SELECT * FROM event_clusters WHERE dedupe_key LIKE :key", {"key": f"SEC:{source['id']}:%"}
    )
    assert len(events) == 2 and all(
        e["canonical_event_type"] == "OTHER" and e["occurred_at"] is None for e in events
    )
    news = await ctx.db.fetch_all(
        "SELECT * FROM news_items WHERE source_item_id=:id", {"id": source["id"]}
    )
    assert len(news) == 1 and news[0]["description"] is None
    assert ctx.services["push_fanout"].enqueue_news.await_count == 1


@pytest.mark.asyncio
async def test_feed_dedupe_transaction_and_manual_relevance_preserved(ctx):
    service = Discovery(ctx)
    company = identifier()
    suffix = identifier()
    await save_row(
        ctx.db,
        "companies",
        {
            "id": company,
            "market": "NASDAQ",
            "ticker": "R" + company[:7].upper(),
            "name_ko": "Synthetic RSS",
            "is_listed": True,
        },
        new=True,
    )
    feed_id, feed = next((key, f) for key, f in RSS_FEEDS.items() if f.get("enabled", True))
    candidate = {
        "connector": "NEWS_RSS",
        "externalId": "fixture-" + suffix,
        "title": "Synthetic authority announces update " + suffix,
        "url": "https://publisher.example/" + suffix,
        "publishedAt": "2026-09-10T01:00:00Z",
        "sourceName": "Synthetic authority",
        "tickers": [],
        "tags": [],
        "rightsMode": feed["policy"]["rightsMode"],
        "sourceKind": feed["sourceKind"],
        "sourcePolicy": feed["policy"],
        "metadata": {
            "feedId": feed_id,
            "feedUrl": feed["url"],
            "originalTitle": "Synthetic",
            "originalGuid": suffix,
        },
    }
    job = {"reason": "SCHEDULED", "priorities": [], "suppressAlerts": True}
    assert await service.persist(candidate, {}, job, matched=[company])
    source = await ctx.db.fetch_one(
        "SELECT * FROM source_items WHERE external_id=:id", {"id": candidate["externalId"]}
    )
    await ctx.db.execute(
        "UPDATE news_source_companies SET match_method='MANUAL_REVIEW' WHERE source_item_id=:id",
        {"id": source["id"]},
    )
    candidate["title"] += " revised"
    assert not await service.persist(candidate, {}, job, matched=[])
    links = await ctx.db.fetch_all(
        "SELECT * FROM news_source_companies WHERE source_item_id=:id", {"id": source["id"]}
    )
    assert len(links) == 1 and links[0]["match_method"] == "MANUAL_REVIEW"
    source2 = await ctx.db.fetch_one(
        "SELECT * FROM source_items WHERE id=:id", {"id": source["id"]}
    )
    assert source2["news_article_id"] == source["news_article_id"]
    assert ctx.services["push_fanout"].enqueue_news.await_count == 0


@pytest.mark.asyncio
async def test_failed_projection_rolls_back_source_and_never_advances_checkpoint(ctx, monkeypatch):
    import orsem_worker.connectors.discovery as module

    service = Discovery(ctx)
    suffix = identifier()
    candidate = {
        "connector": "SEC",
        "externalId": "9999999999-26-" + suffix.replace("-", "")[:6],
        "title": "Synthetic",
        "url": "https://www.sec.gov/Archives/test.xml",
        "publishedAt": None,
        "sourceName": "SEC EDGAR",
        "tickers": [],
        "tags": [],
        "rightsMode": "OFFICIAL_PUBLIC_DATA",
        "metadata": {},
    }

    async def fail(*args):
        raise RuntimeError("synthetic projection failure")

    monkeypatch.setattr(module, "attach_article", fail)
    with pytest.raises(RuntimeError, match="synthetic projection"):
        await service.persist(candidate, {}, {"reason": "BACKFILL"})
    assert (
        await ctx.db.fetch_one(
            "SELECT id FROM source_items WHERE external_id=:id", {"id": candidate["externalId"]}
        )
        is None
    )


@pytest.mark.asyncio
async def test_checkpoint_revision_and_rolling_budget_use_real_schema(ctx):
    stream = "CONNECTOR_TEST:" + identifier()
    store = Checkpoints(ctx.db)
    await store.commit("SEC", stream, 0, {"cursor": "opaque", "incomplete": True})
    saved = await ctx.db.fetch_one(
        "SELECT checkpoint_cursor,last_success_at FROM source_checkpoints WHERE connector='SEC' AND stream=:stream",
        {"stream": stream},
    )
    assert saved["checkpoint_cursor"] == "opaque" and saved["last_success_at"] is None
    await store.commit("SEC", stream, 1, {"cursor": "complete", "incomplete": False})
    with pytest.raises(RuntimeError, match="conflict"):
        await store.commit("SEC", stream, 1, {"cursor": "stale", "incomplete": False})
    budget = NewsApiBudget(ctx)
    provider = "TEST_" + identifier()[:8]
    await budget.reserve(provider, 1)
    row = await ctx.db.fetch_one(
        "SELECT request_count FROM api_usage_counters WHERE connector=:provider",
        {"provider": provider},
    )
    assert int(row["request_count"]) == 1


@pytest.mark.asyncio
async def test_native_admin_staging_apply_stays_inactive_and_reuses(ctx, tmp_path):
    import json

    from test_connectors_admin_cli import corpus_fixture

    from orsem_worker.admin_cli import run
    from orsem_worker.admin_cli.staging import stage_corpus
    from orsem_worker.core import json_text

    snapshot = corpus_fixture(tmp_path)
    filing = snapshot["filings"][0]
    previous = snapshot["runs"][0]
    document = snapshot["documents"][0]
    filing["rcept_no"] = str(int(identifier().replace("-", ""), 16) % 10**14).zfill(14)
    filing["active_parse_run_id"] = previous["id"]
    await save_row(
        ctx.db,
        "companies",
        {
            "id": filing["company_id"],
            "market": "KOSPI",
            "name_ko": "Synthetic admin staging",
            "is_listed": True,
        },
        new=True,
    )
    await save_row(
        ctx.db,
        "filings",
        {
            **filing,
            "active_parse_run_id": None,
            "source": "OPENDART",
            "filer_name": "Synthetic",
            "rcept_date": "2026-09-10",
            "submission_kind": "INITIAL",
            "effective_state": "ACTIVE",
            "first_observed_at": utcnow(),
            "last_seen_at": utcnow(),
        },
        new=True,
    )
    await save_row(
        ctx.db,
        "parse_runs",
        {
            **previous,
            "parser_version": "synthetic-old",
            "started_at": utcnow(),
            "finished_at": utcnow(),
            "result_json": {"projectionApplied": True},
        },
        new=True,
    )
    await ctx.db.execute(
        "UPDATE filings SET active_parse_run_id=:active WHERE id=:filing",
        {"active": previous["id"], "filing": filing["id"]},
    )
    await save_row(
        ctx.db, "filing_documents", {**document, "media_type": "application/zip"}, new=True
    )
    (tmp_path / "snapshot.json").write_text(json_text(snapshot))
    await run(
        "parser-corpus-audit",
        [
            "--snapshot",
            str(tmp_path / "snapshot.json"),
            "--old-results",
            str(tmp_path / "old.json"),
            "--output-dir",
            str(tmp_path / "audit"),
        ],
    )
    options = SimpleNamespace(
        snapshot=str(tmp_path / "snapshot.json"),
        corpus=str(tmp_path / "audit/corpus-audit.json"),
        output_dir=str(tmp_path / "stage1"),
        apply=True,
    )
    first = await stage_corpus(options, {"ORSEM_STAGE_DATABASE_URL": URL})
    assert first["inserted"] == 1 and first["activated"] == 0
    after = await ctx.db.fetch_one(
        "SELECT active_parse_run_id FROM filings WHERE id=:id", {"id": filing["id"]}
    )
    assert after["active_parse_run_id"] == previous["id"]
    candidates = json.loads((tmp_path / "stage1/staging-candidates.json").read_text())
    run_id = candidates[0]["stagedRunId"]
    saved = decoded_row(
        await ctx.db.fetch_one("SELECT * FROM parse_runs WHERE id=:id", {"id": run_id})
    )
    assert saved["result_json"]["projectionApplied"] is False and saved["status"] == "PARTIAL"
    options.output_dir = str(tmp_path / "stage2")
    second = await stage_corpus(options, {"ORSEM_STAGE_DATABASE_URL": URL})
    assert second["inserted"] == 0 and second["reused"] == 1
    await ctx.db.execute(
        "UPDATE filings SET active_parse_run_id=:run WHERE id=:id",
        {"run": run_id, "id": filing["id"]},
    )
    options.output_dir = str(tmp_path / "stage3")
    from orsem_worker.admin_cli.common import AdminError

    with pytest.raises(AdminError, match="NOT_REUSABLE"):
        await stage_corpus(options, {"ORSEM_STAGE_DATABASE_URL": URL})


@pytest.mark.asyncio
async def test_native_backup_restore_and_readonly_review_export(ctx, tmp_path):
    from orsem_worker.admin_cli.backup import backup, restore_check
    from orsem_worker.admin_cli.common import connect
    from orsem_worker.admin_cli.review_export import export_audit

    connection = await connect(URL)
    try:
        manifest = await export_audit(
            SimpleNamespace(output_dir=str(tmp_path / "export")), connection=connection
        )
        assert len(manifest["files"]) == 3
        saved = await backup(connection, str(tmp_path / "backup"))
        assert saved["tables"] > 20
    finally:
        await connection.close()
    from urllib.parse import parse_qs, urlsplit

    socket = parse_qs(urlsplit(URL).query)["unix_socket"][0]
    proof = await restore_check(
        SimpleNamespace(
            socket_path=socket,
            database="orsem_backup_" + identifier().replace("-", "")[:8] + "_test",
            backup_dir=str(tmp_path / "backup"),
            output_dir=str(tmp_path / "proof"),
        )
    )
    assert proof["dataMatches"] is True and "parse_runs" in proof["tablesVerified"]
