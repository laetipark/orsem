"""Explicit, bounded repair of selected automatic company links; never ingestion."""

import json
import unicodedata
from copy import deepcopy
from pathlib import Path
from typing import Any

from orsem_worker.admin_cli.common import (
    AdminError,
    encode,
    prepare_output,
    read_private,
    write_private,
)
from orsem_worker.core import identifier, sha256, utcnow
from orsem_worker.market.common import camel

from .common import decoded_row, instant, save_row
from .policy import NEWS_MATCHER_VERSION, CompanyMatcher, company_aliases, ir_profile


def strings(value):
    return {v for v in value if isinstance(v, str)} if isinstance(value, list) else set()


def reference_companies(row, links=()):
    metadata = (row or {}).get("raw_metadata_json") or {}
    return {
        v
        for v in [
            (row or {}).get("company_id"),
            *(r["company_id"] for r in links),
            *strings(metadata.get("companyIds")),
            *strings(metadata.get("manualCompanyIds")),
        ]
        if isinstance(v, str)
    }


async def snapshot_source(tx, source_id, *, lock=False):
    suffix = " FOR UPDATE" if lock else ""
    return {
        "sourceItem": decoded_row(
            await tx.fetch_one(
                "SELECT * FROM source_items WHERE id=:id" + suffix, {"id": source_id}
            )
        ),
        "newsItem": decoded_row(
            await tx.fetch_one(
                "SELECT * FROM news_items WHERE source_item_id=:id" + suffix, {"id": source_id}
            )
        ),
        "relations": sorted(
            await tx.fetch_all(
                "SELECT * FROM news_source_companies WHERE source_item_id=:id" + suffix,
                {"id": source_id},
            ),
            key=lambda row: row["id"],
        ),
    }


def repair_projection(
    source, news, relations, companies, target_ids, matcher, registered=(), reference_targets=None
):
    """Return narrow patches and before/after evidence without changing input rows."""
    source, news = deepcopy(source), deepcopy(news)
    metadata = deepcopy(source.get("raw_metadata_json") or {})
    evidence = "\n".join(
        value
        for value in (
            source.get("title"),
            (news or {}).get("description") or metadata.get("description"),
        )
        if isinstance(value, str)
    )
    matches = set(matcher(evidence)) & target_ids
    selected = [
        r
        for r in relations
        if r["company_id"] in target_ids
        and r["match_method"] == "METADATA_ALIAS"
        and r["matcher_version"] < NEWS_MATCHER_VERSION
    ]
    # Stronger provenance is never demoted because a name disappears from a title.
    manual = strings(metadata.get("manualCompanyIds"))
    provider = {
        r["companyId"]
        for r in metadata.get("resolvedEntities", [])
        if isinstance(r, dict) and isinstance(r.get("companyId"), str)
    }
    registered = set(registered) | {
        r["company_id"] for r in relations if r["match_method"] == "REGISTERED_IR"
    }
    protected = (
        manual
        | provider
        | registered
        | {
            r["company_id"]
            for r in relations
            if r["match_method"] != "METADATA_ALIAS" or r["matcher_version"] >= NEWS_MATCHER_VERSION
        }
    )
    invalid = target_ids - matches - protected
    delete = [r["id"] for r in selected if r["company_id"] in invalid]
    kept = {r["company_id"] for r in relations if r["id"] not in delete} | protected | matches
    for row in (source, news or {}):
        if row.get("company_id") and row["company_id"] not in invalid:
            kept.add(row["company_id"])
    previous_primary = source.get("company_id") or (news or {}).get("company_id")
    primary = (
        next(iter(registered))
        if len(registered) == 1
        else previous_primary
        if previous_primary in kept
        else next(iter(protected))
        if len(protected) == 1
        else None
    )
    patches = []
    input_hash = sha256(unicodedata.normalize("NFKC", evidence))
    for relation in selected:
        if relation["id"] in delete:
            continue
        company_id = relation["company_id"]
        method = (
            "MANUAL_REVIEW"
            if company_id in manual
            else "REGISTERED_IR"
            if company_id in registered
            else "PROVIDER_SYMBOL"
            if company_id in provider
            else "METADATA_ALIAS"
        )
        patches.append(
            {
                "id": relation["id"],
                "matcher_version": NEWS_MATCHER_VERSION,
                "match_method": method,
                "input_hash": source.get("raw_hash") or input_hash
                if method == "MANUAL_REVIEW"
                else input_hash,
            }
        )
    old_ids = {r["company_id"] for r in relations}
    for company_id in sorted(matches - old_ids):
        patches.append(
            {
                "id": identifier(),
                "source_item_id": source["id"],
                "company_id": company_id,
                "match_method": "METADATA_ALIAS",
                "matcher_version": NEWS_MATCHER_VERSION,
                "input_hash": input_hash,
            }
        )
    removed = (
        {r["company_id"] for r in selected if r["id"] in delete}
        | {r.get("company_id") for r in (source, news or {}) if r.get("company_id") in invalid}
        | (strings(metadata.get("matchedCompanyIds")) & invalid)
    )
    symbols = lambda ids: {
        v for c in companies if c["id"] in ids for v in (c.get("ticker"), c.get("stockCode")) if v
    }
    removed_symbols = symbols(removed) - symbols(kept)
    for key in ("matchedCompanyIds", "companyIds"):
        if key in metadata:
            metadata[key] = sorted(
                strings(metadata[key]) - (target_ids if key == "matchedCompanyIds" else invalid)
                | (matches if key == "matchedCompanyIds" else set())
            )
    if "companyMatchMethod" in metadata and not metadata.get("matchedCompanyIds"):
        metadata["companyMatchMethod"] = None
    if "tickers" in metadata:
        metadata["tickers"] = sorted(strings(metadata["tickers"]) - removed_symbols)
    references = metadata.get("officialReferences")
    removed_references = []
    if isinstance(references, list):
        remaining = []
        for ref in references:
            target = (
                (reference_targets or {}).get((ref.get("kind"), ref.get("id")))
                if isinstance(ref, dict)
                else None
            )
            invalidated = (
                isinstance(ref, dict)
                and ref.get("status") == "RELATED"
                and ref.get("matchMethod") == "COMPANY_TIME"
                and ref.get("sourceHash") == source.get("raw_hash")
                and not ref.get("reviewedAt")
                and not ref.get("reviewedByAdminId")
                and target is not None
                and bool(target & removed)
                and not target & kept
            )
            if invalidated:
                removed_references.append(ref)
            else:
                remaining.append(ref)
        if removed_references:
            metadata["officialReferences"] = remaining
            metadata["officialVerification"] = (
                "CONFIRMED"
                if any(isinstance(r, dict) and r.get("status") == "CONFIRMED" for r in remaining)
                else "LINKED"
                if any(
                    isinstance(r, dict)
                    and r.get("status") == "RELATED"
                    and r.get("matchMethod") != "COMPANY_TIME"
                    for r in remaining
                )
                else "UNVERIFIED"
            )
    source_patch = {"id": source["id"]}
    if source.get("company_id") != primary:
        source_patch["company_id"] = primary
    if metadata != (source.get("raw_metadata_json") or {}):
        source_patch["raw_metadata_json"] = metadata
    news_patch = {"id": news["id"]} if news else None
    if news and news_patch is not None:
        if news.get("company_id") != primary:
            news_patch["company_id"] = primary
        tickers = sorted(strings(news.get("tickers_json")) - removed_symbols) or None
        if tickers != news.get("tickers_json"):
            news_patch["tickers_json"] = tickers
    return {
        "sourceItemId": source["id"],
        "deleteRelationIds": delete,
        "relationPatches": patches,
        "sourcePatch": source_patch,
        "newsPatch": news_patch,
        "removedCompanyIds": sorted(removed),
        "removedReferenceCount": len(removed_references),
    }


async def repair_news_company_links(db, company_ids, output_dir, *, apply=False, max_sources=1000):
    """Dry-run by default; applying requires private external before-images and one transaction."""
    target_ids = set(company_ids)
    if not target_ids or len(target_ids) > 100 or not 1 <= max_sources <= 10000:
        raise AdminError("INVALID_NEWS_REPAIR_SCOPE")
    directory = prepare_output(output_dir, empty=True)
    companies = [
        camel(c)
        for c in await db.fetch_all(
            "SELECT id,name_ko,name_en,ticker,stock_code,market,is_listed FROM companies"
        )
    ]
    if not target_ids <= {c["id"] for c in companies}:
        raise AdminError("NEWS_REPAIR_COMPANY_NOT_FOUND")
    aliases = [camel(a) for a in await db.fetch_all("SELECT * FROM company_aliases")]
    # Extra symbol aliases also retain their owner's market.
    markets = {c["id"]: c.get("market") for c in companies}
    for alias in aliases:
        alias["market"] = markets.get(alias["companyId"])
    matcher = CompanyMatcher(company_aliases(companies, aliases))
    snapshots = await db.fetch_all(
        "SELECT DISTINCT s.id FROM source_items s LEFT JOIN news_items n ON n.source_item_id=s.id "
        "WHERE s.source NOT IN ('SEC','OPENDART','NAVER') AND (s.company_id IN :ids "
        "OR n.company_id IN :ids OR EXISTS (SELECT 1 FROM news_source_companies r "
        "WHERE r.source_item_id=s.id AND r.company_id IN :ids AND r.match_method='METADATA_ALIAS' "
        "AND r.matcher_version<:version)) ORDER BY s.id LIMIT :limit",
        {"ids": sorted(target_ids), "version": NEWS_MATCHER_VERSION, "limit": max_sources + 1},
    )
    if len(snapshots) > max_sources:
        raise AdminError("NEWS_REPAIR_SOURCE_LIMIT")
    summary: dict[str, Any] = {
        "mode": "APPLY" if apply else "DRY_RUN",
        "matcherVersion": NEWS_MATCHER_VERSION,
        "companyIds": sorted(target_ids),
        "scanned": len(snapshots),
        "changed": 0,
        "removedRelations": 0,
        "removedReferences": 0,
        "applied": False,
    }
    plans, backups = [], []
    async with db.transaction() as tx:
        for snapshot in snapshots:
            suffix = " FOR UPDATE" if apply else ""
            source = decoded_row(
                await tx.fetch_one(
                    "SELECT * FROM source_items WHERE id=:id" + suffix, {"id": snapshot["id"]}
                )
            )
            if not source:
                continue
            news = decoded_row(
                await tx.fetch_one(
                    "SELECT * FROM news_items WHERE source_item_id=:id" + suffix,
                    {"id": source["id"]},
                )
            )
            relations = await tx.fetch_all(
                "SELECT * FROM news_source_companies WHERE source_item_id=:id" + suffix,
                {"id": source["id"]},
            )
            metadata = source.get("raw_metadata_json") or {}
            feed = metadata.get("feedUrl")
            registered = (
                {
                    r["company_id"]
                    for r in await tx.fetch_all(
                        "SELECT company_id FROM ir_sources WHERE is_active=1 AND url=:url",
                        {"url": feed},
                    )
                }
                if feed
                else set()
            )
            profile = ir_profile(feed) if feed else None
            if profile and profile.get("enabled"):
                ids = {
                    c["id"]
                    for c in companies
                    if c.get("isListed")
                    and c.get("market") in ("NASDAQ", "NYSE", "AMEX")
                    and c.get("ticker") in profile.get("companySymbols", [])
                }
                if len(ids) == 1:
                    registered |= ids
            references = {}
            for ref in metadata.get("officialReferences", []):
                if (
                    not isinstance(ref, dict)
                    or ref.get("matchMethod") != "COMPANY_TIME"
                    or ref.get("status") != "RELATED"
                ):
                    continue
                if ref.get("kind") == "FILING":
                    target = await tx.fetch_one(
                        "SELECT company_id FROM filings WHERE id=:id", {"id": ref.get("id")}
                    )
                    if target:
                        references[("FILING", ref.get("id"))] = {target["company_id"]}
                elif ref.get("kind") == "SOURCE_ITEM":
                    target = decoded_row(
                        await tx.fetch_one(
                            "SELECT * FROM source_items WHERE id=:id", {"id": ref.get("id")}
                        )
                    )
                    if target:
                        links = await tx.fetch_all(
                            "SELECT company_id FROM news_source_companies WHERE source_item_id=:id",
                            {"id": target["id"]},
                        )
                        references[("SOURCE_ITEM", target["id"])] = reference_companies(
                            target, links
                        )
            plan = repair_projection(
                source, news, relations, companies, target_ids, matcher, registered, references
            )
            changed = bool(
                plan["deleteRelationIds"]
                or plan["relationPatches"]
                or len(plan["sourcePatch"]) > 1
                or len(plan["newsPatch"] or {}) > 1
            )
            if changed:
                plans.append(plan)
                backups.append({"sourceItem": source, "newsItem": news, "relations": relations})
                summary["changed"] += 1
                summary["removedRelations"] += len(plan["deleteRelationIds"])
                summary["removedReferences"] += plan["removedReferenceCount"]
        backup = write_private(
            directory, "before.json", {"createdAt": utcnow(), "rows": backups}, exclusive=True
        )
        write_private(
            directory,
            "plan.json",
            {"summary": summary, "backup": backup, "changes": plans},
            exclusive=True,
        )
        if apply:
            for plan in plans:
                for relation_id in plan["deleteRelationIds"]:
                    await tx.execute(
                        "DELETE FROM news_source_companies WHERE id=:id AND match_method='METADATA_ALIAS' AND matcher_version<:version",
                        {"id": relation_id, "version": NEWS_MATCHER_VERSION},
                    )
                for patch in plan["relationPatches"]:
                    await save_row(
                        tx, "news_source_companies", patch, new="source_item_id" in patch
                    )
                if len(plan["sourcePatch"]) > 1:
                    await save_row(tx, "source_items", plan["sourcePatch"])
                if len(plan["newsPatch"] or {}) > 1:
                    await save_row(tx, "news_items", plan["newsPatch"])
            after = [await snapshot_source(tx, plan["sourceItemId"]) for plan in plans]
            summary["afterSnapshot"] = write_private(
                directory, "after.json", {"rows": after}, exclusive=True
            )
    summary["applied"] = apply
    write_private(directory, "report.json", summary, exclusive=True)
    return summary


async def rollback_news_company_links(db, repair_dir, output_dir, *, apply=False):
    """Restore only our projections if every current row still equals the captured after-image."""
    repair_dir = Path(repair_dir).resolve()
    report = json.loads(read_private(repair_dir / "report.json"))
    plan = json.loads(read_private(repair_dir / "plan.json"))
    if report.get("applied") is not True or report.get("mode") != "APPLY":
        raise AdminError("NEWS_REPAIR_NOT_APPLIED")
    before_bytes = read_private(repair_dir / "before.json")
    after_bytes = read_private(repair_dir / "after.json")
    if sha256(before_bytes) != plan.get("backup", {}).get("sha256") or sha256(
        after_bytes
    ) != report.get("afterSnapshot", {}).get("sha256"):
        raise AdminError("NEWS_REPAIR_BACKUP_HASH_MISMATCH")
    before = json.loads(before_bytes)["rows"]
    after = json.loads(after_bytes)["rows"]
    before_by = {row["sourceItem"]["id"]: row for row in before}
    after_by = {row["sourceItem"]["id"]: row for row in after}
    if set(before_by) != set(after_by):
        raise AdminError("NEWS_REPAIR_BACKUP_SCOPE_MISMATCH")
    directory = prepare_output(output_dir, empty=True)
    summary = {
        "mode": "ROLLBACK_APPLY" if apply else "ROLLBACK_DRY_RUN",
        "scanned": len(after),
        "applied": False,
    }
    async with db.transaction() as tx:
        current = []
        for source_id in sorted(after_by):
            snapshot = await snapshot_source(tx, source_id, lock=apply)
            if json.loads(encode(snapshot)) != after_by[source_id]:
                raise AdminError("NEWS_REPAIR_AFTER_IMAGE_CHANGED", {"sourceItemId": source_id})
            current.append(snapshot)
        write_private(directory, "before.json", {"rows": current}, exclusive=True)
        if apply:
            for source_id, original in before_by.items():
                expected = after_by[source_id]
                for table, key, columns in (
                    ("source_items", "sourceItem", ("company_id", "raw_metadata_json")),
                    ("news_items", "newsItem", ("company_id", "tickers_json")),
                ):
                    old, new = original[key], expected[key]
                    if not old:
                        continue
                    values = {
                        column: old.get(column)
                        for column in columns
                        if old.get(column) != new.get(column)
                    }
                    if values:
                        await save_row(tx, table, {"id": old["id"], **values})
                old_relations = {row["id"]: row for row in original["relations"]}
                new_relations = {row["id"]: row for row in expected["relations"]}
                for relation_id in new_relations.keys() - old_relations.keys():
                    await tx.execute(
                        "DELETE FROM news_source_companies WHERE id=:id AND match_method='METADATA_ALIAS' AND matcher_version=:version",
                        {"id": relation_id, "version": NEWS_MATCHER_VERSION},
                    )
                for relation_id, old in old_relations.items():
                    if old == new_relations.get(relation_id):
                        continue
                    values = {
                        k: instant(v) if k in ("created_at", "updated_at") else v
                        for k, v in old.items()
                    }
                    await save_row(
                        tx, "news_source_companies", values, new=relation_id not in new_relations
                    )
    summary["applied"] = apply
    write_private(directory, "report.json", summary, exclusive=True)
    return summary
