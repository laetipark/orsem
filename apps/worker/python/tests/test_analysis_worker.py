from __future__ import annotations

import copy
import io
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from openpyxl import load_workbook

from orsem_worker.analysis import register
from orsem_worker.analysis.access import AnalysisDenied
from orsem_worker.analysis.artifacts import primary_url, read_object
from orsem_worker.analysis.exports import build_xlsx
from orsem_worker.analysis.facts import decimal_value, normalize_dart, normalize_sec
from orsem_worker.analysis.service import Analysis, periods_for
from orsem_worker.analysis.sources import AnalysisWaiting, Sources
from orsem_worker.core import utcnow
from orsem_worker.raw_documents import RawDocumentStore


def dart_row(**kw):
    return {
        "rcept_no": "20240516000001",
        "bsns_year": "2024",
        "reprt_code": "11013",
        "fs_div": "CFS",
        "sj_div": "IS",
        "account_id": "ifrs-full_Revenue",
        "account_nm": "매출",
        "thstrm_amount": "9,007,199,254,740,993",
        "thstrm_add_amount": "9,007,199,254,740,993",
        "currency": "KRW",
        **kw,
    }


def dart(rows, dates=None, code="11013"):
    return normalize_dart(
        {"list": rows},
        company_id="company",
        year=2024,
        report_code=code,
        scope="CFS",
        date_evidence=dates,
    )


def test_decimal_never_passes_float_or_zero_missing():
    assert decimal_value("9,007,199,254,740,993.1200") == "9007199254740993.12"
    assert decimal_value("(1,230.50)") == "-1230.5"
    assert decimal_value("0") == "0"
    for missing in (True, None, "-", "NaN", "1,00", "1e20"):
        assert decimal_value(missing) is None


def test_dart_requires_official_same_receipt_dates_and_retains_source():
    row = dart_row()
    assert all(f["status"] == "UNSUPPORTED" for f in dart([row]))
    wrong = {**row, "rcept_no": "20240517000001", "thstrm_dt": "2024.01.01 ~ 2024.03.31"}
    assert all(f["periodEnd"] is None for f in dart([row], [wrong]))
    facts = dart([row], [{**row, "thstrm_dt": "2024.01.01 ~ 2024.03.31"}])
    assert {f["basis"] for f in facts} == {"YTD", "SINGLE_QUARTER"}
    assert all(f["status"] == "AVAILABLE" and f["valueText"] == "9007199254740993" for f in facts)
    assert facts[0]["factJson"]["sourceRowJson"] == row


def test_dart_non_december_period_is_source_driven_and_no_cf_guess():
    row = dart_row(reprt_code="11012")
    dates = [{**row, "thstrm_dt": "2023.10.01 ~ 2024.03.31"}]
    facts = dart([row], dates, "11012")
    assert facts[0]["periodStart"] == "2023-10-01"
    assert facts[1]["periodStart"] == "2024-01-01"
    cf = dart_row(
        account_id="ifrs-full_CashFlowsFromUsedInOperatingActivities",
        sj_div="CF",
        reprt_code="11012",
    )
    assert dart([cf], dates, "11012")[0]["status"] == "UNSUPPORTED"
    assert len(dart([cf], dates, "11012")) == 1


def test_dart_duplicate_conflicting_and_scope_mismatch():
    row = dart_row(thstrm_dt="2024.01.01 ~ 2024.03.31")
    facts = dart([row, {**row, "thstrm_amount": "2", "thstrm_add_amount": "2"}])
    assert all(f["status"] == "AMBIGUOUS" for f in facts)
    with pytest.raises(ValueError, match="context mismatch"):
        dart([{**row, "fs_div": "OFS"}])


def test_dart_missing_annual_quarter_is_not_derived():
    row = dart_row(reprt_code="11011", thstrm_dt="2023.01.01 ~ 2023.12.31")
    facts = dart([row], code="11011")
    assert [f["basis"] for f in facts] == ["ANNUAL"]


def sec_facts(**changes):
    row = {
        "start": "2023-10-01",
        "end": "2024-03-31",
        "filed": "2024-05-01",
        "fy": 2024,
        "fp": "Q2",
        "form": "10-Q",
        "accn": "0000000001-24-000001",
        "val": 123,
        **changes,
    }
    payload = {"cik": 1, "facts": {"us-gaap": {"Revenues": {"units": {"USD": [row]}}}}}
    context = {row["accn"]: {"reportDate": "2024-03-31", "form": "10-Q"}}
    return payload, context


def test_sec_comparative_context_not_filing_fy_and_scope_unproven():
    payload, contexts = sec_facts()
    args = {"cik": "0000000001", "company_id": "company", "years": {2024}}
    assert normalize_sec(payload, **args) == []
    facts = normalize_sec(payload, filing_contexts=contexts, **args)
    assert facts[0]["basis"] == "YTD"
    assert facts[0]["factJson"]["scope"] == "UNKNOWN"
    assert facts[0]["status"] == "AMBIGUOUS"
    payload["facts"]["us-gaap"]["Revenues"]["units"]["USD"][0]["end"] = "2023-03-31"
    assert normalize_sec(payload, filing_contexts=contexts, **args) == []


def test_sec_changed_fiscal_year_duration_is_ambiguous():
    payload, contexts = sec_facts(start="2023-01-01")
    contexts[next(iter(contexts))]["consolidated"] = True
    facts = normalize_sec(
        payload, filing_contexts=contexts, cik="0000000001", company_id="company", years={2024}
    )
    assert facts[0]["status"] == "AMBIGUOUS"
    assert facts[0]["factJson"]["durationValid"] is False


def test_sec_parent_equity_and_parent_net_income_do_not_map_total():
    payload, contexts = sec_facts()
    definition = payload["facts"]["us-gaap"].pop("Revenues")
    payload["facts"]["us-gaap"].update(StockholdersEquity=definition, NetIncomeLoss=definition)
    assert (
        normalize_sec(
            payload, filing_contexts=contexts, cik="0000000001", company_id="company", years={2024}
        )
        == []
    )


def test_xlsx_formula_literal_exact_precision_and_controls():
    raw = build_xlsx(
        {
            "원문값": [
                ['=HYPERLINK("https://example.test")', "9007199254740993.12345", "(123)", "a\x00b"]
            ]
        }
    )
    book = load_workbook(io.BytesIO(raw), data_only=False)
    row = next(iter(book["원문값"].rows))
    assert all(cell.data_type == "s" for cell in row)
    assert [cell.value for cell in row] == [
        '=HYPERLINK("https://example.test")',
        "9007199254740993.12345",
        "(123)",
        "ab",
    ]


def test_raw_artifacts_hash_path_and_extension(tmp_path):
    store = RawDocumentStore(SimpleNamespace(rawDocumentDir=str(tmp_path)))
    for ext in ("json", "xml", "zip", "html", "xlsx"):
        raw = store._put(b"fixture", ext)
        assert read_object(tmp_path, raw["objectUri"], raw["sha256"]) == b"fixture"
    with pytest.raises(ValueError, match="checksum"):
        read_object(tmp_path, raw["objectUri"], "0" * 64)
    with pytest.raises(ValueError, match="outside"):
        read_object(tmp_path / "other", raw["objectUri"], raw["sha256"])
    with pytest.raises(ValueError, match="extension"):
        store._put(b"fixture", "exe")


def test_primary_urls_never_allow_untrusted_paths():
    assert primary_url("1", "0000000001-24-000001", "filing.htm").endswith(
        "/000000000124000001/filing.htm"
    )
    for path in ("../filing.htm", "a%2f.htm", "https://evil.test/a.htm", "a.htm?x=1", "a\\.htm"):
        with pytest.raises(ValueError):
            primary_url("1", "0000000001-24-000001", path)


class FakeDB:
    def __init__(self):
        self.calls = []
        self.active = True
        self.group = {"owner_key": "ADMIN:owner", "room_id": None}
        self.members = [{"company_id": "company"}]

    async def fetch_one(self, sql, values=None):
        self.calls.append((sql, values))
        if "FROM admins" in sql:
            return {"id": "owner"} if self.active else None
        if "FROM watchlist_groups" in sql:
            return self.group
        return None

    async def fetch_all(self, sql, values=None):
        self.calls.append((sql, values))
        return self.members


@pytest.mark.asyncio
async def test_group_snapshot_revocation_never_expands():
    db = FakeDB()
    analysis = Analysis(SimpleNamespace(db=db))
    selection = {"companyIds": ["company"], "groupId": "group"}
    await analysis.assert_access("ADMIN:owner", selection, ["company"])
    db.members.append({"company_id": "extra"})
    await analysis.assert_access("ADMIN:owner", selection, ["company"])
    db.members = [{"company_id": "extra"}]
    with pytest.raises(AnalysisDenied):
        await analysis.assert_access("ADMIN:owner", selection, ["company"])
    db.active = False
    with pytest.raises(AnalysisDenied):
        await analysis.assert_access("ADMIN:owner", {"companyIds": ["company"]}, ["company"])


@pytest.mark.asyncio
async def test_feature_disabled_registers_no_producer():
    ctx = SimpleNamespace(services={}, config=SimpleNamespace(analysisEnabled=False))
    handlers = await register(ctx)
    assert list(handlers) == ["process-analysis-job"]
    assert "analysis_dart_gate" not in ctx.services
    assert await handlers["process-analysis-job"]({"jobId": str(uuid4())}) == {"status": "DISABLED"}


class JobDB:
    @asynccontextmanager
    async def transaction(self):
        yield self


class JobAnalysis(Analysis):
    def __init__(self, error=None, job=None):
        super().__init__(SimpleNamespace(config=SimpleNamespace(analysisEnabled=True), db=JobDB()))
        self.job = job or {
            "id": str(uuid4()),
            "kind": "RUN",
            "entityId": str(uuid4()),
            "status": "PENDING",
            "attempts": 0,
            "availableAt": utcnow(),
            "payloadJson": {},
        }
        self.error, self.writes, self.executions = error, [], 0

    async def row(self, table, identity, db=None, lock=False):
        return copy.deepcopy(self.job)

    async def patch(self, table, identity, values, db=None):
        self.writes.append((table, values))
        if table == "analysis_jobs":
            self.job.update(values)

    async def run(self, identity, payload):
        self.executions += 1
        if self.error:
            raise self.error
        return {"status": "COMPLETE"}


@pytest.mark.asyncio
async def test_durable_job_claim_idempotence_and_wait_retry():
    analysis = JobAnalysis()
    assert await analysis.process({"jobId": analysis.job["id"]}) == {"status": "COMPLETE"}
    assert await analysis.process({"jobId": analysis.job["id"]}) == {"status": "SKIPPED"}
    assert analysis.executions == 1
    waiting = JobAnalysis(AnalysisWaiting("대기"))
    assert await waiting.process({"jobId": waiting.job["id"]}) == {"status": "WAITING"}
    assert waiting.job["status"] == "RETRY"
    assert waiting.job["leaseUntil"] is None
    assert waiting.job["attempts"] == 1
    assert await waiting.process({"jobId": waiting.job["id"]}) == {"status": "WAITING"}
    assert waiting.executions == 1


@pytest.mark.asyncio
async def test_active_lease_and_permission_denial_fail_closed():
    analysis = JobAnalysis()
    analysis.job.update(status="RUNNING", leaseUntil=utcnow() + timedelta(minutes=2))
    assert await analysis.process({"jobId": analysis.job["id"]}) == {"status": "LEASED"}
    denied = JobAnalysis(AnalysisDenied("private permission"))
    assert await denied.process({"jobId": denied.job["id"]}) == {"status": "FAILED"}
    assert denied.job["status"] == "FAILED"
    assert "private permission" not in denied.job["lastError"]


@pytest.mark.asyncio
async def test_source_request_budget_stops_before_network():
    sources = Sources(SimpleNamespace(), maximum=1)
    sources.reserve()
    with pytest.raises(AnalysisWaiting):
        sources.reserve()


def test_rolling_quarter_crosses_year_without_current_unfinished_period():
    from datetime import date

    assert periods_for({"rolling": {"kind": "QUARTER", "count": 2}}, date(2025, 1, 1)) == [
        {"year": 2024, "reportCode": "11014"},
        {"year": 2024, "reportCode": "11011"},
    ]


@pytest.mark.asyncio
async def test_sql_helpers_allow_hash_columns_and_reject_identifier_injection():
    from orsem_worker.market.common import insert, insert_many, update

    class DB:
        def __init__(self):
            self.calls = []

        async def execute(self, sql, values):
            self.calls.append((sql, values))

    db = DB()
    await insert(db, "analysis_reports", {"id": "id", "rawSha256": "a" * 64})
    await insert_many(db, "analysis_reports", [{"id": "id", "rawSha256": "a" * 64}])
    await update(db, "analysis_reports", "id", {"rawSha256": "b" * 64})
    assert len(db.calls) == 3
    assert all("raw_sha256" in sql for sql, _ in db.calls)
    with pytest.raises(AssertionError):
        await insert(db, "analysis_reports; DROP TABLE admins", {"id": "id"})
    with pytest.raises(AssertionError):
        await update(db, "analysis_reports", "id", {"bad` = 1": "x"})


@pytest.mark.asyncio
async def test_observed_mapping_dictionary_is_idempotent_and_rejection_is_respected():
    class DB:
        def __init__(self):
            self.rows, self.writes = [], []

        async def fetch_all(self, sql, params):
            return self.rows

        async def fetch_one(self, sql, params):
            return self.rows[0] if self.rows else None

        async def execute(self, sql, params):
            self.writes.append((sql, params))

    db = DB()
    analysis = Analysis(SimpleNamespace(db=db))
    row = dart_row(thstrm_dt="2024.01.01 ~ 2024.03.31")
    mapped = await analysis.mappings(dart([row]), "OPENDART")
    assert len(db.writes) == 1  # YTD and quarter share an observed account mapping.
    assert db.writes[0][1]["status"] == "CONFIRMED"
    assert db.writes[0][1]["createdBy"].startswith("SYSTEM:")
    assert all(":" in f["factJson"]["mappingVersion"] for f in mapped)
    db.rows = [
        {
            "id": "rejected",
            "source": "OPENDART",
            "account_id": row["account_id"],
            "scope": "CFS",
            "status": "REJECTED",
            "version": 2,
        }
    ]
    rejected = await analysis.mappings(dart([row]), "OPENDART")
    assert all(f["status"] == "AMBIGUOUS" for f in rejected)
    assert len(db.writes) == 1


@pytest.mark.asyncio
async def test_history_export_checks_actor_but_not_current_group():
    class AccessAnalysis(Analysis):
        async def row(self, table, identity, db=None, lock=False):
            return {
                "ownerKey": "ADMIN:owner",
                "selectionJson": {"groupId": "removed"},
                "companyIdsJson": ["company"],
            }

        async def actor_active(self, owner, db=None):
            return True

        async def assert_access(self, *args):
            raise AnalysisDenied("revoked")

    analysis = AccessAnalysis(SimpleNamespace())
    assert (await analysis.artifact_run({"runId": "run"}, acquire=False))[
        "ownerKey"
    ] == "ADMIN:owner"
    with pytest.raises(AnalysisDenied):
        await analysis.artifact_run({"runId": "run"})


@pytest.mark.asyncio
async def test_sec_primary_inline_proof_promotes_only_exact_unsegmented_context(
    tmp_path, monkeypatch
):
    from test_analysis_documents import HTML

    import orsem_worker.analysis.service as service_module

    async def direct(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(service_module.asyncio, "to_thread", direct)
    accession = "0000001234-25-000001"
    payload = {
        "cik": 1234,
        "facts": {
            "us-gaap": {
                "Assets": {
                    "units": {
                        "USD": [
                            {
                                "val": 1234000,
                                "end": "2025-09-30",
                                "filed": "2025-11-01",
                                "fy": 2025,
                                "fp": "FY",
                                "form": "10-K",
                                "accn": accession,
                            }
                        ]
                    }
                }
            }
        },
    }

    class Source:
        async def sec(self, url, xml=False):
            if "companyfacts" in url:
                return b'{"fixture":"companyfacts"}', payload
            if "submissions" in url:
                return b'{"fixture":"submissions"}', {
                    "filings": {
                        "recent": {
                            "accessionNumber": [accession],
                            "reportDate": ["2025-09-30"],
                            "form": ["10-K"],
                            "primaryDocument": ["original.htm"],
                        }
                    }
                }
            return HTML, None

    class Raw:
        async def put(self, content, extension="zip"):
            return RawDocumentStore(SimpleNamespace(rawDocumentDir=str(tmp_path)))._put(
                content, extension
            )

    class Collect(Analysis):
        async def mappings(self, facts, source):
            return facts

        async def save_reports(self, company, source, content, facts, metadata=None):
            self.saved = (facts, metadata)

    analysis = Collect(SimpleNamespace(services={"raw_documents": Raw()}))
    await analysis.collect_sec(
        {"id": "company", "cik": "0000001234"}, [{"year": 2025, "reportCode": "11011"}], Source()
    )
    fact = analysis.saved[0][0]
    assert fact["status"] == "AVAILABLE"
    assert fact["factJson"]["scope"] == "CFS"
    assert fact["factJson"]["documentEvidence"]["matched"] is True
    assert len(analysis.saved[1]["responses"]) == 2
    assert len(analysis.saved[1]["documents"]) == 1
    assert all("created" not in stored for stored in analysis.saved[1]["responses"])


@pytest.mark.asyncio
async def test_waiting_sec_preserves_domestic_results_and_retry_checkpoint():
    from orsem_worker.connectors.sec_access import SecAccessCooldownError

    period = {"year": 2024, "reportCode": "11011"}
    report = {
        "id": "report",
        "companyId": "domestic",
        "reportYear": 2024,
        "reportCode": "11011",
        "firstObservedAt": utcnow(),
    }
    fact = {
        "id": "fact",
        "companyId": "domestic",
        "reportId": "report",
        "metric": "assets",
        "accountId": "ifrs-full_Assets",
        "reportYear": 2024,
        "reportCode": "11011",
        "periodStart": None,
        "periodEnd": "2024-12-31",
        "basis": "INSTANT",
        "scope": "CFS",
        "currency": "KRW",
        "unit": "KRW",
        "value": "100",
        "status": "AVAILABLE",
        "evidence": {"filingId": "20250331000001"},
    }

    class DB(JobDB):
        async def fetch_all(self, sql, params):
            if "FROM companies" in sql:
                return [
                    {"id": "foreign", "cik": "0000000001"},
                    {"id": "domestic", "corp_code": "12345678"},
                ]
            return [{"fact_json": fact}]

    class Run(Analysis):
        def __init__(self):
            super().__init__(
                SimpleNamespace(db=DB(), config=SimpleNamespace(analysisDocumentsEnabled=True))
            )
            self.snapshot = {
                "id": "run",
                "ownerKey": "ADMIN:owner",
                "status": "QUEUED",
                "selectionJson": {
                    "companyIds": ["foreign", "domestic"],
                    "periods": [period],
                    "metrics": ["assets"],
                    "basis": "ANNUAL",
                    "scope": "CFS",
                },
                "companyIdsJson": ["foreign", "domestic"],
                "progressJson": {},
            }
            self.dart_calls = 0

        async def assert_access(self, *args):
            pass

        async def row(self, *args):
            return copy.deepcopy(self.snapshot)

        async def patch(self, table, identity, values, db=None):
            if table == "analysis_runs":
                self.snapshot.update(copy.deepcopy(values))

        async def report_rows(self, company_id, *args):
            return [report] if company_id == "domestic" and self.dart_calls else []

        async def collect_dart(self, *args):
            self.dart_calls += 1

        async def collect_sec(self, *args):
            raise SecAccessCooldownError(utcnow() + timedelta(hours=1), 403)

        async def save_validation(self, *args):
            pass

    analysis = Run()
    for _ in range(2):
        with pytest.raises(AnalysisWaiting):
            await analysis.run("run", {})
        assert analysis.snapshot["status"] == "WAITING"
        assert [f["id"] for f in analysis.snapshot["resultJson"]["facts"]] == ["fact"]
        assert any(
            i["companyId"] == "foreign" and i["code"] == "WAITING"
            for i in analysis.snapshot["resultJson"]["issues"]
        )
    assert analysis.dart_calls == 1


def test_cf_requires_unique_same_filing_period_label_and_ytd_duration():
    row = dart_row(
        reprt_code="11012",
        sj_div="CF",
        account_id="ifrs-full_CashFlowsFromUsedInOperatingActivities",
        thstrm_nm="제10기 반기",
    )
    evidence = [{**row, "sj_div": "IS", "thstrm_dt": "2024.01.01 ~ 2024.06.30"}]
    facts = dart([row], evidence, "11012")
    assert facts[0]["status"] == "AVAILABLE"
    assert facts[0]["factJson"]["dateBasis"] == "SAME_FILING_YTD"
    assert facts[0]["factJson"]["dateEvidence"] == evidence
    evidence[0]["thstrm_nm"] = "다른 기간"
    assert dart([row], evidence, "11012")[0]["status"] == "UNSUPPORTED"


@pytest.mark.asyncio
async def test_phase_two_preserves_notes_and_document_job_is_idempotent(tmp_path, monkeypatch):
    from test_analysis_documents import HTML

    import orsem_worker.analysis.artifacts as artifact_module

    async def direct(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(artifact_module.asyncio, "to_thread", direct)
    store = RawDocumentStore(SimpleNamespace(rawDocumentDir=str(tmp_path)))
    raw = store._put(HTML, "html")

    class Raw:
        async def put(self, content, extension="zip"):
            return store._put(content, extension)

    class DB(JobDB):
        def __init__(self):
            self.writes = []

        async def execute(self, sql, values):
            self.writes.append((sql, values))

    class Documents(Analysis):
        def __init__(self):
            self.db = DB()
            super().__init__(
                SimpleNamespace(
                    db=self.db,
                    config=SimpleNamespace(
                        analysisDocumentsEnabled=True,
                        analysisNotesEnabled=False,
                        rawDocumentDir=str(tmp_path),
                    ),
                    services={"raw_documents": Raw()},
                )
            )
            self.doc = {
                "id": "document",
                "status": "QUEUED",
                "sourceUrl": "https://dart.fss.or.kr/fixture",
                "mediaType": "text/html",
                "rawUri": raw["objectUri"],
                "rawSha256": raw["sha256"],
            }
            self.attached = []

        async def artifact_run(self, payload):
            return {"id": "run", "resultJson": {"facts": []}}

        async def row(self, *args):
            return copy.deepcopy(self.doc)

        async def document_source(self, *args):
            return "OPENDART", "company", "20250101000001", {}

        async def patch(self, table, identity, values, db=None):
            self.doc.update(values)

        async def attach(self, run_id, key, identity):
            self.attached.append((key, identity))

        async def validate(self, *args):
            pass

    analysis = Documents()
    assert await analysis.document("document", {"runId": "run"}) == {"status": "COMPLETE"}
    count = len(analysis.db.writes)
    assert count >= 2
    assert any("Our debt matures" in value["body"] for _, value in analysis.db.writes)
    assert analysis.doc["rawSha256"] == raw["sha256"]
    assert await analysis.document("document", {"runId": "run"}) == {"status": "COMPLETE"}
    assert len(analysis.db.writes) == count


@pytest.mark.asyncio
async def test_diff_explicit_review_requires_same_company_and_preserves_provenance():
    review = {
        "status": "CONFIRMED",
        "reviewedBy": "ADMIN:" + str(uuid4()),
        "reviewedAt": "2026-10-10T00:00:00Z",
        "sourceUrl": "https://www.sec.gov/Archives/fixture",
        "note": "Same issuer confirmed from original footnote",
    }

    class DB:
        async def fetch_all(self, *args):
            return []

    class Diffs(Analysis):
        def __init__(self):
            super().__init__(
                SimpleNamespace(config=SimpleNamespace(analysisDocumentsEnabled=True), db=DB())
            )
            self.record = {
                "id": "diff",
                "beforeDocumentId": "before",
                "afterDocumentId": "after",
                "reviewJson": review,
            }
            self.other_company = False

        async def artifact_run(self, payload):
            return {"id": "run"}

        async def row(self, table, identity, *args):
            return (
                self.record
                if table == "analysis_diffs"
                else {"id": identity, "status": "COMPLETE", "tablesJson": []}
            )

        async def document_source(self, doc, run):
            return (
                "SEC",
                "other" if self.other_company and doc["id"] == "after" else "company",
                "filing",
                {},
            )

        async def confirmed_relation(self, *args):
            return False

        async def patch(self, table, identity, values, db=None):
            self.record.update(values)

        async def attach(self, *args):
            pass

    analysis = Diffs()
    assert await analysis.diff("diff", {"runId": "run"}) == {"status": "COMPLETE"}
    assert analysis.record["confirmed"] is True
    assert analysis.record["reviewJson"] == review
    analysis.other_company = True
    with pytest.raises(AnalysisDenied):
        await analysis.diff("diff", {"runId": "run"})


def test_sec_first_quarter_has_official_ytd_and_single_quarter_views():
    payload, contexts = sec_facts(start="2024-01-01", fp="Q1")
    facts = normalize_sec(
        payload, filing_contexts=contexts, cik="0000000001", company_id="company", years={2024}
    )
    assert {f["basis"] for f in facts} == {"YTD", "SINGLE_QUARTER"}
    assert {f["valueText"] for f in facts} == {"123"}


@pytest.mark.asyncio
async def test_regular_report_observer_is_bounded_metadata_only_and_preserves_source_dates(
    tmp_path,
):
    import json

    class DB:
        def __init__(self):
            self.writes = []

        async def fetch_all(self, sql, params=None):
            assert params["ids"] == ["company"]
            return [{"id": "company", "corp_code": "12345678"}]

        async def fetch_one(self, sql, params=None):
            return None

        async def execute(self, sql, params):
            self.writes.append((sql, params))

    class Redis:
        async def set(self, key, value, **kwargs):
            assert kwargs == {"nx": True, "ex": 300}
            return True

    class Raw:
        async def put(self, content, extension="zip"):
            return RawDocumentStore(SimpleNamespace(rawDocumentDir=str(tmp_path)))._put(
                content, extension
            )

    class Source:
        def __init__(self):
            self.calls = []

        async def dart(self, endpoint, params):
            self.calls.append((endpoint, params))
            number = params["pblntf_detail_ty"][-1]
            item = {
                "corp_code": "12345678",
                "rcept_no": "2026101000000" + number,
                "rcept_dt": "20261010",
                "report_nm": "합성 정기공시",
            }
            return json.dumps(item).encode(), {"list": [item], "total_page": 1}

    db, source = DB(), Source()
    analysis = Analysis(
        SimpleNamespace(
            db=db,
            redis=Redis(),
            config=SimpleNamespace(redisPrefix="isolated:"),
            services={"opendart": SimpleNamespace(enabled=True), "raw_documents": Raw()},
        )
    )
    await analysis.observe_regular_reports(["company"], source)
    assert [p["pblntf_detail_ty"] for _, p in source.calls] == ["A001", "A002", "A003"]
    rows = [values for sql, values in db.writes if "INSERT INTO source_items" in sql]
    assert len(rows) == 3
    assert all(json.loads(row["metadata"])["publicationDate"] == "2026-10-10" for row in rows)
    assert all(json.loads(row["metadata"])["analysisRegularReport"] is True for row in rows)
    assert all("alerts" not in sql and "job_outbox" not in sql for sql, _ in db.writes)
