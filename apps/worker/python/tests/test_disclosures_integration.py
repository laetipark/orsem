"""Transaction behavior against an explicitly selected disposable MySQL schema."""

from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from orsem_worker.core import Database, identifier, sha256, utcnow
from orsem_worker.disclosures.ai_review import DisclosureAiReview
from orsem_worker.disclosures.deferred import DeferredProjection
from orsem_worker.disclosures.enrichment import FilingEnrichment
from orsem_worker.disclosures.health import OpenDartHealth
from orsem_worker.disclosures.ingestion import OpenDartIngestion
from orsem_worker.storage import insert, one, save, select

URL = os.environ.get("ORSEM_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="Requires disposable ORSEM_TEST_DATABASE_URL.")
FIXTURES = Path(__file__).parent / "fixtures" / "disclosures"


class Rollback(Exception):
    pass


def synthetic_archive(kind, unknown=False):
    name = "d004-report.xml" if kind == "D004" else kind.lower() + ".xml"
    raw = (FIXTURES / name).read_text()
    if unknown:
        raw = raw.replace("장내매수", "기타 증가")
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as zipped:
        zipped.writestr("report.xml", raw)
    return result.getvalue()


class SyntheticClient:
    enabled = True

    def __init__(self, kind="D002", unknown=False):
        self.kind = kind
        self.archive = synthetic_archive(kind, unknown)
        self.receipt = str(int(uuid4().hex, 16) % 10**14).zfill(14)
        self.corp = str(int(uuid4().hex, 16) % 10**8).zfill(8)
        self.summary_fail = False

    async def paused_until(self):
        return None

    async def fetch_document(self, receipt):
        assert receipt == self.receipt
        return self.archive

    async def fetch_ele_stock(self, corp):
        assert corp == self.corp
        if self.summary_fail:
            raise ValueError("synthetic summary unavailable")
        return [
            {
                "rcept_no": self.receipt,
                "repror": "홍길동",
                "isu_exctv_ofcps": "이사",
                "isu_exctv_rgist_at": "Y",
                "isu_main_shrholdr": "N",
                "sp_stock_lmp_cnt": "12000",
                "sp_stock_lmp_irds_cnt": "10000",
                "sp_stock_lmp_rate": "1.25",
            }
        ]

    def item(self):
        name = {
            "D001": "주식등의대량보유상황보고서",
            "D002": "임원ㆍ주요주주특정증권등소유상황보고서",
            "D003": "의결권대리행사권유참고서류",
            "D004": "공개매수신고서",
            "D005": "임원ㆍ주요주주특정증권등거래계획보고서",
        }[self.kind]
        return {
            "corp_code": self.corp,
            "corp_name": "Synthetic integration corporation",
            "stock_code": "",
            "corp_cls": "",
            "report_nm": name,
            "rcept_no": self.receipt,
            "flr_nm": "홍길동",
            "rcept_dt": "2026-09-01",
            "rcept_dt_raw": "20260901",
            "rm": "",
        }


async def context(tx, client, classifier):
    config = SimpleNamespace(
        openDartApiKey="synthetic-fixture-key",
        httpTimeoutMs=1000,
        pollOverlapDays=3,
        aiModel="synthetic-model" if classifier.enabled else None,
        aiTimeoutMs=1000,
    )

    async def put(content):
        return {
            "sha256": sha256(content),
            "byteSize": str(len(content)),
            "objectUri": "test://synthetic/" + sha256(content),
        }

    ctx = SimpleNamespace(
        db=tx,
        config=config,
        services={"classifier": classifier, "raw_documents": SimpleNamespace(put=put)},
    )
    health = OpenDartHealth(ctx, client)
    ctx.services["opendart_health"] = health
    ingestion = OpenDartIngestion(ctx, client)
    enrichment = FilingEnrichment(ctx, client, health)
    ctx.services["disclosure_ai"] = DisclosureAiReview(ctx)
    return ctx, ingestion, enrichment


async def detected_filing(tx, ingestion, client, suppress=False):
    run = await insert(
        tx,
        "ingestion_runs",
        {
            "connector": "OPENDART",
            "stream": "SYNTHETIC_TEST",
            "status": "PROCESSING",
            "startedAt": utcnow(),
            "itemsSeen": "0",
            "itemsCreated": "0",
        },
    )
    assert await ingestion.persist_list_item(client.item(), client.kind, run["id"], suppress)
    filing = await one(tx, "filings", "rcept_no=:receipt", {"receipt": client.receipt})
    assert not await ingestion.persist_list_item(client.item(), client.kind, run["id"], suppress)
    return filing


@pytest.mark.asyncio
async def test_receipt_enrichment_reuse_preserves_projection_ids_and_dates():
    assert "/orsem_test?" in URL and "unix_socket=/tmp/" in URL
    db = Database.from_url(URL)
    try:
        with pytest.raises(Rollback):
            async with db.transaction() as tx:
                client = SyntheticClient()
                _ctx, ingestion, enrichment = await context(
                    tx, client, SimpleNamespace(enabled=False)
                )
                filing = await detected_filing(tx, ingestion, client)
                job = {
                    "filingId": filing["id"],
                    "rceptNo": client.receipt,
                    "detailType": "D002",
                    "suppressAlerts": False,
                }
                result = await enrichment.enrich(job)
                assert result["status"] == "SUCCEEDED"
                saved = await one(tx, "filings", "id=:id", {"id": filing["id"]})
                assert saved["activeParseRunId"] == result["parseRunId"]
                report = await one(tx, "insider_reports", "filing_id=:id", {"id": filing["id"]})
                transactions = await select(
                    tx, "insider_transactions", "insider_report_id=:id", {"id": report["id"]}
                )
                assert len(transactions) == 2
                market = next(row for row in transactions if row["nature"] == "MARKET_BUY")
                assert market["eventDate"] == "2026-09-01"
                assert market["quantity"] == "10000.000000"
                assert market["amount"] == "325000000.000000"
                event = await one(
                    tx,
                    "event_clusters",
                    "dedupe_key=:key",
                    {"key": "opendart:filing:" + filing["id"]},
                )
                assert event["occurredAt"] is None and event["publishedAt"] is None
                assert event["metadataJson"]["earliestEventDate"] == "2026-09-01"
                assert await enrichment.enrich(job) == result
                reports = await select(tx, "insider_reports", "filing_id=:id", {"id": filing["id"]})
                assert [row["id"] for row in reports] == [report["id"]]
                outbox = await select(
                    tx,
                    "job_outbox",
                    "dedupe_key=:key",
                    {"key": f"opendart:D002:{client.receipt}:enrich:opendart-title-v2"},
                )
                assert len(outbox) == 1
                alerts = await select(tx, "alerts", "event_cluster_id=:id", {"id": event["id"]})
                assert len(alerts) == 1
                assert alerts[0]["payloadJson"]["phase"] == "PARSED"
                raise Rollback()
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_unknown_ai_audit_is_deduplicated_and_cannot_promote_projection():
    assert "/orsem_test?" in URL and "unix_socket=/tmp/" in URL

    class Classifier:
        enabled = True
        calls = 0

        async def suggest(self, candidate):
            self.calls += 1
            return {
                "result": "AI_SUGGESTED",
                "suggestion": {"nature": "MARKET_BUY"},
                "reasons": [],
                "audit": {},
            }

    db = Database.from_url(URL)
    try:
        with pytest.raises(Rollback):
            async with db.transaction() as tx:
                classifier = Classifier()
                client = SyntheticClient(unknown=True)
                ctx, ingestion, enrichment = await context(tx, client, classifier)
                filing = await detected_filing(tx, ingestion, client, True)
                result = await enrichment.enrich(
                    {
                        "filingId": filing["id"],
                        "rceptNo": client.receipt,
                        "detailType": "D002",
                        "suppressAlerts": True,
                    }
                )
                assert result["status"] == "PARTIAL"
                saved = await one(tx, "filings", "id=:id", {"id": filing["id"]})
                assert saved["activeParseRunId"] is None
                assert not await select(
                    tx, "insider_reports", "filing_id=:id", {"id": filing["id"]}
                )
                job = {"filingId": filing["id"], "parseRunId": result["parseRunId"]}
                review = await ctx.services["disclosure_ai"].review(job)
                assert review["classificationResult"] == "AI_SUGGESTED"
                assert classifier.calls == 1
                again = await ctx.services["disclosure_ai"].review(job)
                assert again["deduplicated"] is True and classifier.calls == 1
                run = await one(tx, "parse_runs", "id=:id", {"id": result["parseRunId"]})
                assert run["resultJson"]["projectionApplied"] is False
                assert run["resultJson"]["parsed"]["transactions"][0]["nature"] == "UNKNOWN"
                assert not await select(
                    tx, "insider_reports", "filing_id=:id", {"id": filing["id"]}
                )
                raise Rollback()
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_summary_failure_retains_inactive_audit_and_manual_crosscheck_gate():
    assert "/orsem_test?" in URL and "unix_socket=/tmp/" in URL
    db = Database.from_url(URL)
    try:
        with pytest.raises(Rollback):
            async with db.transaction() as tx:
                client = SyntheticClient()
                client.summary_fail = True
                _ctx, ingestion, enrichment = await context(
                    tx, client, SimpleNamespace(enabled=False)
                )
                filing = await detected_filing(tx, ingestion, client, True)
                job = {
                    "filingId": filing["id"],
                    "rceptNo": client.receipt,
                    "detailType": "D002",
                    "suppressAlerts": True,
                }
                result = await enrichment.enrich(job)
                assert result["status"] == "PARTIAL"
                run = await one(tx, "parse_runs", "id=:id", {"id": result["parseRunId"]})
                assert run["resultJson"]["crosscheck"]["status"] == "FAILED"
                assert run["resultJson"]["projectionApplied"] is False
                client.summary_fail = False
                assert (await enrichment.enrich(job))["parseRunId"] == result["parseRunId"]
                from orsem_worker.disclosures.primitives import OpenDartPayloadError

                with pytest.raises(OpenDartPayloadError) as error:
                    await DeferredProjection(_ctx, enrichment).apply(
                        {
                            "filingId": filing["id"],
                            "parseRunId": run["id"],
                            "requestedByAdminId": identifier(),
                        }
                    )
                assert error.value.code == "PARSE_CROSSCHECK_REQUIRED"
                assert not await select(
                    tx, "insider_reports", "filing_id=:id", {"id": filing["id"]}
                )
                raise Rollback()
    finally:
        await db.close()


@pytest.mark.parametrize(
    "kind,projection_table", [("D003", "proxy_solicitations"), ("D004", "tender_offers")]
)
async def test_narrative_domain_requires_exact_source_review_then_applies_once(
    kind, projection_table
):
    from orsem_worker.disclosures.primitives import OpenDartPayloadError

    assert "/orsem_test?" in URL and "unix_socket=/tmp/" in URL
    db = Database.from_url(URL)
    try:
        with pytest.raises(Rollback):
            async with db.transaction() as tx:
                client = SyntheticClient(kind)
                ctx, ingestion, enrichment = await context(
                    tx, client, SimpleNamespace(enabled=False)
                )
                filing = await detected_filing(tx, ingestion, client)
                outcome = await enrichment.enrich(
                    {
                        "filingId": filing["id"],
                        "rceptNo": client.receipt,
                        "detailType": kind,
                        "suppressAlerts": False,
                    }
                )
                assert outcome["status"] == "PARTIAL"
                assert not await one(tx, projection_table, "filing_id=:id", {"id": filing["id"]})
                run = await one(tx, "parse_runs", "id=:id", {"id": outcome["parseRunId"]})
                assert run["resultJson"]["projectionApplied"] is False
                admin = await one(tx, "admins", "singleton_key=1")
                if not admin:
                    admin = await insert(
                        tx,
                        "admins",
                        {
                            "singletonKey": 1,
                            "email": "synthetic-disclosure@example.invalid",
                            "passwordHash": "synthetic-invalid-hash",
                            "totpEnabled": False,
                            "isActive": True,
                            "failedLoginCount": 0,
                        },
                    )
                job = {
                    "filingId": filing["id"],
                    "parseRunId": run["id"],
                    "requestedByAdminId": admin["id"],
                }
                deferred = DeferredProjection(ctx, enrichment)
                with pytest.raises(OpenDartPayloadError) as missing_review:
                    await deferred.apply(job)
                assert missing_review.value.code == "PARSE_SOURCE_REVIEW_REQUIRED"
                source_review = {
                    "parseRunId": run["id"],
                    "rawSha256": "0" * 64,
                    "confirmedByAdminId": admin["id"],
                    "confirmedAt": utcnow()
                    .isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z"),
                }
                run["resultJson"]["sourceReview"] = source_review
                await save(tx, "parse_runs", run)
                with pytest.raises(OpenDartPayloadError) as wrong_source:
                    await deferred.apply(job)
                assert wrong_source.value.code == "PARSE_SOURCE_REVIEW_REQUIRED"
                source_review["rawSha256"] = run["rawSha256"]
                await save(tx, "parse_runs", run)
                result = await deferred.apply(job)
                assert result["projectionApplied"] is True
                projection = await one(tx, projection_table, "filing_id=:id", {"id": filing["id"]})
                assert projection["parseRunId"] == run["id"]
                assert await deferred.apply(job) == result
                projections = await select(
                    tx, projection_table, "filing_id=:id", {"id": filing["id"]}
                )
                assert [value["id"] for value in projections] == [projection["id"]]
                saved = await one(tx, "filings", "id=:id", {"id": filing["id"]})
                assert saved["activeParseRunId"] == run["id"]
                raise Rollback()
    finally:
        await db.close()
