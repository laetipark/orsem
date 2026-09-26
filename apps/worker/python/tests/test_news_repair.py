"""Targeted repair never alters source evidence or stronger company relationships."""

import json
from contextlib import asynccontextmanager
from copy import deepcopy

import pytest

from orsem_worker.admin_cli.common import AdminError
from orsem_worker.connectors.news_repair import (
    repair_news_company_links,
    repair_projection,
    rollback_news_company_links,
)
from orsem_worker.connectors.policy import CompanyMatcher, company_aliases

COMPANIES = [
    {
        "id": "new",
        "nameKo": "NEW",
        "nameEn": "Next Entertainment World",
        "ticker": "160550",
        "stockCode": "160550",
        "market": "KOSDAQ",
        "isListed": True,
    },
    {
        "id": "samsung",
        "nameKo": "삼성전자",
        "nameEn": "Samsung Electronics",
        "ticker": "005930",
        "stockCode": "005930",
        "market": "KOSPI",
        "isListed": True,
    },
]


def fixture():
    source = {
        "id": "source",
        "source": "IR",
        "title": "A new semiconductor plant opens",
        "company_id": "new",
        "raw_hash": "original-hash",
        "url": "https://example.com/news",
        "rights_mode": "PRIVATE_DISPLAY_ONLY",
        "source_policy_json": {"aiAllowed": False},
        "first_observed_at": "2026-09-01T00:00:00Z",
        "published_at": "2026-08-31T23:00:00Z",
        "raw_metadata_json": {
            "matchedCompanyIds": ["new"],
            "tickers": ["160550"],
            "companyMatchMethod": "UNAMBIGUOUS_METADATA_ALIAS_V2",
            "originalTitle": "A new semiconductor plant opens",
            "rawField": 42,
        },
    }
    news = {
        "id": "news",
        "source_item_id": "source",
        "company_id": "new",
        "description": None,
        "title": source["title"],
        "tickers_json": ["160550"],
    }
    links = [
        {
            "id": "alias",
            "source_item_id": "source",
            "company_id": "new",
            "matcher_version": 1,
            "match_method": "METADATA_ALIAS",
            "input_hash": "old",
        }
    ]
    return source, news, links


def project(source, news, links, **kwargs):
    return repair_projection(
        source,
        news,
        links,
        COMPANIES,
        {"new"},
        CompanyMatcher(company_aliases(COMPANIES)),
        **kwargs,
    )


def test_false_new_clears_only_automatic_projections_and_preserves_inputs():
    source, news, links = fixture()
    original = deepcopy((source, news, links))
    plan = project(source, news, links)
    assert plan["deleteRelationIds"] == ["alias"]
    assert plan["sourcePatch"]["company_id"] is None
    assert plan["newsPatch"]["company_id"] is None
    assert plan["newsPatch"]["tickers_json"] is None
    assert plan["sourcePatch"]["raw_metadata_json"]["matchedCompanyIds"] == []
    assert plan["sourcePatch"]["raw_metadata_json"]["rawField"] == 42
    assert set(plan["sourcePatch"]) == {"id", "company_id", "raw_metadata_json"}
    assert (source, news, links) == original


@pytest.mark.parametrize(
    "title",
    [
        "Next Entertainment World earnings",
        "NEW(160550) earnings",
        "$160550 earnings",
        "KRX:160550 earnings",
    ],
)
def test_real_evidence_survives_and_upgrades_matcher_version(title):
    source, news, links = fixture()
    source["title"] = title
    plan = project(source, news, links)
    assert plan["deleteRelationIds"] == []
    assert plan["relationPatches"][0]["matcher_version"] == 2
    assert "company_id" not in plan["sourcePatch"]


@pytest.mark.parametrize("method", ["MANUAL_REVIEW", "PROVIDER_SYMBOL", "REGISTERED_IR", "SEC_CIK"])
def test_non_metadata_relations_never_change(method):
    source, news, links = fixture()
    links[0]["match_method"] = method
    plan = project(source, news, links)
    assert plan["deleteRelationIds"] == plan["relationPatches"] == []
    assert "company_id" not in plan["sourcePatch"]


def test_registered_ir_retains_primary_and_other_metadata_relations():
    source, news, links = fixture()
    links.append({**links[0], "id": "ir", "company_id": "samsung", "match_method": "REGISTERED_IR"})
    plan = project(source, news, links)
    assert plan["sourcePatch"]["company_id"] == "samsung"
    assert plan["newsPatch"]["company_id"] == "samsung"
    assert plan["deleteRelationIds"] == ["alias"]
    assert plan["relationPatches"] == []


@pytest.mark.parametrize("kind", ["manual", "provider"])
def test_stronger_metadata_provenance_preserved_but_false_alias_marker_removed(kind):
    source, news, links = fixture()
    if kind == "manual":
        source["raw_metadata_json"]["manualCompanyIds"] = ["new"]
        method = "MANUAL_REVIEW"
    else:
        source["raw_metadata_json"]["resolvedEntities"] = [
            {"symbol": "160550.KQ", "companyId": "new", "canonicalId": "KR:160550"}
        ]
        method = "PROVIDER_SYMBOL"
    plan = project(source, news, links)
    assert plan["deleteRelationIds"] == []
    assert plan["relationPatches"][0]["match_method"] == method
    assert "company_id" not in plan["sourcePatch"]
    assert plan["sourcePatch"]["raw_metadata_json"]["matchedCompanyIds"] == []
    assert plan["sourcePatch"]["raw_metadata_json"]["tickers"] == ["160550"]


def test_direct_primary_without_relation_is_repaired():
    source, news, _ = fixture()
    plan = project(source, news, [])
    assert plan["sourcePatch"]["company_id"] is None
    assert plan["newsPatch"]["company_id"] is None
    assert plan["deleteRelationIds"] == []


def test_unrelated_legacy_alias_is_not_promoted_to_primary():
    source, news, links = fixture()
    source["company_id"] = news["company_id"] = None
    links.append({**links[0], "id": "legacy", "company_id": "samsung"})
    plan = project(source, news, links)
    assert plan["deleteRelationIds"] == ["alias"]
    assert "company_id" not in plan["sourcePatch"]
    assert "company_id" not in plan["newsPatch"]


def test_only_invalidated_unreviewed_company_time_reference_is_removed():
    source, news, links = fixture()
    base = {
        "kind": "FILING",
        "sourceHash": "original-hash",
        "status": "RELATED",
        "matchMethod": "COMPANY_TIME",
    }
    refs = [
        {**base, "id": "invalid"},
        {**base, "id": "reviewed", "status": "CONFIRMED", "reviewedAt": "2026-09-01"},
        {**base, "id": "rejected", "status": "REJECTED"},
        {**base, "id": "explicit", "matchMethod": "EXPLICIT_ID"},
        {**base, "id": "missing"},
        {**base, "id": "old-hash", "sourceHash": "other"},
        {**base, "id": "related-other"},
    ]
    source["raw_metadata_json"]["officialReferences"] = refs
    source["raw_metadata_json"]["officialVerification"] = "CONFIRMED"
    targets = {("FILING", ref["id"]): {"new"} for ref in refs if ref["id"] != "missing"}
    targets[("FILING", "related-other")] = {"samsung"}
    plan = project(source, news, links, reference_targets=targets)
    metadata = plan["sourcePatch"]["raw_metadata_json"]
    assert metadata["officialReferences"] == refs[1:]
    assert metadata["officialVerification"] == "CONFIRMED"
    assert plan["removedReferenceCount"] == 1


class MemoryDb:
    def __init__(self):
        source, news, links = fixture()
        self.tables = {
            "source_items": [source],
            "news_items": [news],
            "news_source_companies": links,
        }
        self.writes = []
        self.fail = False

    async def fetch_all(self, sql, params=None):
        params = params or {}
        if "FROM companies" in sql:
            return [
                {
                    "id": c["id"],
                    "name_ko": c["nameKo"],
                    "name_en": c["nameEn"],
                    "stock_code": c["stockCode"],
                    "ticker": c["ticker"],
                    "market": c["market"],
                    "is_listed": 1,
                }
                for c in COMPANIES
            ]
        if "FROM company_aliases" in sql or "FROM ir_sources" in sql:
            return []
        if sql.startswith("SELECT DISTINCT s.id"):
            return [
                {"id": s["id"]}
                for s in self.tables["source_items"]
                if s.get("company_id") in params["ids"]
                or any(
                    r["company_id"] in params["ids"]
                    and r["match_method"] == "METADATA_ALIAS"
                    and r["matcher_version"] < params["version"]
                    for r in self.tables["news_source_companies"]
                )
            ]
        for table, rows in self.tables.items():
            if f"FROM {table} " in sql:
                key = "source_item_id" if "WHERE source_item_id=" in sql else "id"
                return deepcopy([r for r in rows if r[key] == params["id"]])
        raise AssertionError(sql)

    async def fetch_one(self, sql, params=None):
        return next(iter(await self.fetch_all(sql, params)), None)

    async def execute(self, sql, params):
        if self.fail and sql.startswith("UPDATE"):
            raise RuntimeError("synthetic write failure")
        self.writes.append((sql, deepcopy(params)))
        if sql.startswith("DELETE"):
            self.tables["news_source_companies"] = [
                r for r in self.tables["news_source_companies"] if r["id"] != params["id"]
            ]
        else:
            table = sql.split("`")[1]
            if sql.startswith("INSERT"):
                row = {}
                self.tables[table].append(row)
            else:
                row = next(r for r in self.tables[table] if r["id"] == params["id"])
            row.update(
                {
                    k: json.loads(v) if k.endswith("_json") and isinstance(v, str) else v
                    for k, v in params.items()
                }
            )
        return 1

    @asynccontextmanager
    async def transaction(self):
        before = deepcopy(self.tables)
        try:
            yield self
        except BaseException:
            self.tables = before
            raise


async def test_dry_run_apply_backup_and_idempotent_second_run(tmp_path):
    db = MemoryDb()
    original = deepcopy(db.tables)
    dry = await repair_news_company_links(db, ["new"], tmp_path / "dry")
    assert dry["changed"] == dry["removedRelations"] == 1
    assert dry["applied"] is False and db.writes == [] and db.tables == original
    applied = await repair_news_company_links(db, ["new"], tmp_path / "apply", apply=True)
    assert applied["applied"] is True
    backup_file = tmp_path / "apply/before.json"
    assert backup_file.stat().st_mode & 0o077 == 0
    backup = json.loads(backup_file.read_text())
    assert backup["rows"][0]["sourceItem"] == original["source_items"][0]
    source = db.tables["source_items"][0]
    for key in (
        "title",
        "url",
        "raw_hash",
        "rights_mode",
        "source_policy_json",
        "published_at",
        "first_observed_at",
    ):
        assert source[key] == original["source_items"][0][key]
    again = await repair_news_company_links(db, ["new"], tmp_path / "again", apply=True)
    assert again["scanned"] == again["changed"] == 0


async def test_apply_rolls_back_all_projections_and_keeps_before_image(tmp_path):
    db = MemoryDb()
    original = deepcopy(db.tables)
    db.fail = True
    with pytest.raises(RuntimeError, match="synthetic"):
        await repair_news_company_links(db, ["new"], tmp_path, apply=True)
    assert db.tables == original
    assert (tmp_path / "before.json").exists()
    assert not (tmp_path / "report.json").exists()


async def test_unknown_scope_rejected_without_mutation(tmp_path):
    db = MemoryDb()
    with pytest.raises(AdminError, match="NEWS_REPAIR_COMPANY_NOT_FOUND"):
        await repair_news_company_links(db, ["missing"], tmp_path)
    assert db.writes == []


async def test_guarded_rollback_restores_projections_and_relations(tmp_path):
    db = MemoryDb()
    original = deepcopy(db.tables)
    await repair_news_company_links(db, ["new"], tmp_path / "repair", apply=True)
    count = len(db.writes)
    dry = await rollback_news_company_links(db, tmp_path / "repair", tmp_path / "rollback-dry")
    assert dry["applied"] is False and len(db.writes) == count
    result = await rollback_news_company_links(
        db, tmp_path / "repair", tmp_path / "rollback", apply=True
    )
    assert result["applied"] is True
    for table, rows in original.items():
        restored = db.tables[table]
        assert [
            {k: v for k, v in row.items() if k not in ("created_at", "updated_at")}
            for row in restored
        ] == rows


async def test_rollback_refuses_any_concurrent_evidence_or_projection_change(tmp_path):
    db = MemoryDb()
    await repair_news_company_links(db, ["new"], tmp_path / "repair", apply=True)
    db.tables["source_items"][0]["raw_hash"] = "new-observation"
    count = len(db.writes)
    with pytest.raises(AdminError, match="NEWS_REPAIR_AFTER_IMAGE_CHANGED"):
        await rollback_news_company_links(
            db, tmp_path / "repair", tmp_path / "rollback", apply=True
        )
    assert len(db.writes) == count


async def test_rollback_requires_matching_private_backup_hash(tmp_path):
    db = MemoryDb()
    await repair_news_company_links(db, ["new"], tmp_path / "repair", apply=True)
    (tmp_path / "repair/before.json").write_text('{"rows":[]}')
    count = len(db.writes)
    with pytest.raises(AdminError, match="NEWS_REPAIR_BACKUP_HASH_MISMATCH"):
        await rollback_news_company_links(
            db, tmp_path / "repair", tmp_path / "rollback", apply=True
        )
    assert len(db.writes) == count
