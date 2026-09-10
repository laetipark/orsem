"""Atomic metadata relationships: preserve provenance and reviewed decisions."""

import re
import unicodedata
from datetime import timedelta, timezone
from urllib.parse import parse_qs, urlsplit

from orsem_worker.core import identifier, sha256, utcnow

from .common import decoded_row, instant, save_row
from .policy import allows_audience, approved, canonical_url, current_policy


def readable(source):
    policy = source.get("source_policy_json")
    return (
        source.get("source") != "NAVER"
        and approved(policy)
        and policy.get("rightsMode") == source.get("rights_mode")
        and (
            policy.get("policyVersion") != 2
            or allows_audience(policy, "ADMIN_UI")
            and current_policy(policy).get("rightsMode") == source.get("rights_mode")
        )
    )


def title_hash(title):
    normalized = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", title).lower()).strip()
    return sha256(normalized) if normalized else None


def publisher(source):
    metadata = source.get("raw_metadata_json") or {}
    explicit = metadata.get("sourceDomain", metadata.get("publisherDomain"))
    host = (
        explicit
        if isinstance(explicit, str)
        and re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", explicit, re.IGNORECASE)
        else urlsplit(source["url"]).hostname
    )
    return re.sub(r"^www\.", "", (host or "").lower()) or None


async def attach_article(tx, source, companies):
    source["normalized_title_hash"] = title_hash(source["title"])
    await save_row(
        tx,
        "source_items",
        {"id": source["id"], "normalized_title_hash": source["normalized_title_hash"]},
    )
    if source.get("news_article_id"):
        return
    url = canonical_url(source["url"])
    url_hash = sha256(url)
    article = await tx.fetch_one(
        "SELECT * FROM news_articles WHERE url_hash=:hash", {"hash": url_hash}
    )
    if (
        not article
        and companies
        and source["normalized_title_hash"]
        and source.get("published_at")
        and readable(source)
    ):
        candidates = await tx.fetch_all(
            "SELECT s.* FROM source_items s WHERE s.normalized_title_hash=:title AND s.published_at BETWEEN :after AND :before AND s.id<>:id AND s.news_article_id IS NOT NULL AND (s.company_id IN :companies OR EXISTS (SELECT 1 FROM news_source_companies n WHERE n.source_item_id=s.id AND n.company_id IN :companies)) ORDER BY s.first_observed_at,s.id LIMIT 25 FOR UPDATE",
            {
                "title": source["normalized_title_hash"],
                "after": instant(source["published_at"]) - timedelta(days=1),
                "before": instant(source["published_at"]) + timedelta(days=1),
                "id": source["id"],
                "companies": companies,
            },
        )
        for candidate in map(decoded_row, candidates):
            if (
                readable(candidate)
                and title_hash(candidate["title"]) == source["normalized_title_hash"]
                and publisher(candidate) == publisher(source)
                and publisher(source)
            ):
                article = await tx.fetch_one(
                    "SELECT * FROM news_articles WHERE id=:id", {"id": candidate["news_article_id"]}
                )
                if article:
                    break
    if not article:
        await tx.execute(
            "INSERT IGNORE INTO news_articles (id,canonical_url,url_hash,sort_at,first_observed_at,created_at,updated_at) VALUES (:id,:url,:hash,:sort,:observed,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",
            {
                "id": identifier(),
                "url": url,
                "hash": url_hash,
                "sort": source.get("published_at") or source["first_observed_at"],
                "observed": source["first_observed_at"],
            },
        )
        article = await tx.fetch_one(
            "SELECT * FROM news_articles WHERE url_hash=:hash", {"hash": url_hash}
        )
        if not article:
            raise RuntimeError("News article was not persisted.")
    source["news_article_id"] = article["id"]
    await save_row(tx, "source_items", {"id": source["id"], "news_article_id": article["id"]})


async def replace_relevance(tx, source_id, evidence, matches):
    input_hash = sha256(unicodedata.normalize("NFKC", evidence))
    previous = {
        row["company_id"]: row
        for row in await tx.fetch_all(
            "SELECT * FROM news_source_companies WHERE source_item_id=:id", {"id": source_id}
        )
    }
    unique = dict(matches)
    for company_id, row in previous.items():
        if company_id not in unique and row["match_method"] != "MANUAL_REVIEW":
            await tx.execute("DELETE FROM news_source_companies WHERE id=:id", {"id": row["id"]})
    for company_id, method in unique.items():
        row = previous.get(company_id)
        if row and (
            row["match_method"] == "MANUAL_REVIEW"
            or row["input_hash"] == input_hash
            and row["matcher_version"] == 1
            and row["match_method"] == method
        ):
            continue
        values = {
            "id": row["id"] if row else identifier(),
            "source_item_id": source_id,
            "company_id": company_id,
            "input_hash": input_hash,
            "matcher_version": 1,
            "match_method": method,
        }
        await save_row(tx, "news_source_companies", values, new=row is None)


async def sec_events(tx, source, companies):
    metadata = source.get("raw_metadata_json") or {}
    accession, cik, form, filing_date = (
        source.get("external_id"),
        metadata.get("cik"),
        metadata.get("form"),
        metadata.get("filingDate"),
    )
    url = urlsplit(source["url"])
    if (
        source["source"] != "SEC"
        or source["rights_mode"] != "OFFICIAL_PUBLIC_DATA"
        or url.scheme != "https"
        or url.hostname not in ("www.sec.gov", "sec.gov")
        or url.username
        or url.password
        or url.port
        or not url.path.startswith("/Archives/")
    ):
        return
    if (
        not isinstance(accession, str)
        or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession)
        or not isinstance(cik, str)
        or not re.fullmatch(r"\d{10}", cik)
        or not isinstance(form, str)
        or not form.strip()
        or not isinstance(filing_date, str)
        or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", filing_date)
    ):
        return
    from orsem_worker.core import json_text

    for company in companies:
        if str(company.get("cik") or "").zfill(10) != cik or company["market"] not in (
            "NASDAQ",
            "NYSE",
            "AMEX",
        ):
            continue
        dedupe = f"SEC:{source['id']}:{company['id']}"
        event = await tx.fetch_one(
            "SELECT id FROM event_clusters WHERE dedupe_key=:dedupe", {"dedupe": dedupe}
        )
        if not event:
            metadata_event = {
                "source": "SEC",
                "sourceItemId": source["id"],
                "observationKind": "FILING_RECEIPT",
                "cik": cik,
                "form": form,
                "filingDate": filing_date,
                "accessionNumber": accession,
            }
            if isinstance(metadata.get("reportDate"), str):
                metadata_event["reportDate"] = metadata["reportDate"]
            await tx.execute(
                "INSERT IGNORE INTO event_clusters (id,dedupe_key,canonical_event_type,company_id,occurred_at,published_at,first_observed_at,processed_at,state,evidence_grade,summary,metadata_json,created_at,updated_at) VALUES (:id,:dedupe,'OTHER',:company,NULL,:published,:observed,:now,'OPEN','A',:summary,:metadata,:now,:now)",
                {
                    "id": identifier(),
                    "dedupe": dedupe,
                    "company": company["id"],
                    "published": source.get("published_at"),
                    "observed": source["first_observed_at"],
                    "now": utcnow(),
                    "summary": f"SEC {form} 공시 접수 · {filing_date}",
                    "metadata": json_text(metadata_event),
                },
            )
            event = await tx.fetch_one(
                "SELECT id FROM event_clusters WHERE dedupe_key=:dedupe", {"dedupe": dedupe}
            )
            if not event:
                raise RuntimeError("SEC filing event was not persisted.")
        await tx.execute(
            "INSERT IGNORE INTO event_cluster_items (id,event_cluster_id,item_type,item_id,is_primary,provenance_json,created_at,updated_at) VALUES (:id,:event,'SOURCE_ITEM',:source,1,:provenance,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",
            {
                "id": identifier(),
                "event": event["id"],
                "source": source["id"],
                "provenance": json_text(
                    {"source": "SEC", "cik": cik, "accessionNumber": accession}
                ),
            },
        )


def official_identifiers(texts):
    text = "\n".join(value[:8192] for value in texts[:32])
    dart, sec, urls = (
        set(re.findall(r"\b\d{14}\b", text)),
        set(re.findall(r"\b\d{10}-\d{2}-\d{6}\b", text)),
        set(),
    )
    for match in re.findall(r"""https?://[^\s<>"']+""", text):
        try:
            raw = match.rstrip("),.;")
            url = urlsplit(raw)
            if url.username or url.password:
                continue
            if url.hostname == "dart.fss.or.kr":
                receipt = parse_qs(url.query).get("rcpNo", [""])[0]
                if re.fullmatch(r"\d{14}", receipt):
                    dart.add(receipt)
            if url.hostname in ("www.sec.gov", "sec.gov"):
                sec.update(
                    "-".join(groups)
                    for groups in re.findall(r"\b(\d{10})(\d{2})(\d{6})\b", url.path)
                )
            urls.add(canonical_url(raw))
        except ValueError:
            continue
    return {"dart": list(dart), "sec": list(sec), "urls": list(urls)}


def build_official_references(
    source, companies, texts, filings, officials, links=None, previous=None
):
    if not source.get("raw_hash") or not readable(source):
        return {"officialReferences": [], "officialVerification": "UNVERIFIED"}
    ids, references, links = official_identifiers(texts), [], links or {}
    published = instant(source.get("published_at"))
    source_date = published.astimezone(timezone(timedelta(hours=9))).date() if published else None
    for filing in filings:
        if filing["source"] not in ("SEC", "OPENDART"):
            continue
        explicit = filing["rcept_no"] in ids["dart" if filing["source"] == "OPENDART" else "sec"]
        date = instant(str(filing["rcept_date"]))
        if not explicit and not (
            filing["company_id"] in companies
            and source_date
            and date
            and abs((source_date - date.date()).days) <= 3
        ):
            continue
        references.append(
            {
                "kind": "FILING",
                "id": filing["id"],
                "matchMethod": "EXPLICIT_ID" if explicit else "COMPANY_TIME",
                "status": "RELATED",
                "sourceHash": source["raw_hash"],
            }
        )
    for official in officials:
        if official["id"] == source["id"]:
            continue
        allowed = (
            (
                official["rights_mode"] == "OFFICIAL_PUBLIC_DATA"
                and (not official.get("source_policy_json") or readable(official))
            )
            if official["source"] in ("SEC", "OPENDART")
            else readable(official)
            and official.get("source_kind")
            in ("COMPANY_IR", "OFFICIAL_RELEASE", "OFFICIAL_DISCLOSURE")
        )
        if not allowed:
            continue
        try:
            explicit_url = canonical_url(official["url"]) in ids["urls"]
        except ValueError:
            explicit_url = False
        explicit_id = official["source"] == "SEC" and official.get("external_id") in ids["sec"]
        related = [
            official.get("company_id"),
            *links.get(official["id"], []),
            *(official.get("raw_metadata_json") or {}).get("companyIds", []),
        ]
        shared = any(id in companies for id in related)
        when = instant(official.get("published_at"))
        if (
            not explicit_url
            and not explicit_id
            and not (shared and published and when and abs(when - published) <= timedelta(days=3))
        ):
            continue
        references.append(
            {
                "kind": "SOURCE_ITEM",
                "id": official["id"],
                "matchMethod": "EXPLICIT_URL"
                if explicit_url
                else "EXPLICIT_ID"
                if explicit_id
                else "COMPANY_TIME",
                "status": "RELATED",
                "sourceHash": source["raw_hash"],
                "targetHash": official.get("raw_hash"),
            }
        )
    for reference in references:
        for decision in previous or []:
            if (
                isinstance(decision, dict)
                and all(
                    decision.get(k) == reference.get(k)
                    for k in ("kind", "id", "sourceHash", "targetHash")
                )
                and decision.get("status") in ("CONFIRMED", "REJECTED")
            ):
                reference.update(decision)
                break
    references.sort(
        key=lambda r: (
            r["status"] not in ("CONFIRMED", "REJECTED"),
            r["matchMethod"] == "COMPANY_TIME",
            r["id"],
        )
    )
    references = list({f"{r['kind']}:{r['id']}": r for r in references}.values())[:10]
    status = (
        "CONFIRMED"
        if any(r["status"] == "CONFIRMED" for r in references)
        else "LINKED"
        if any(r["status"] == "RELATED" and r["matchMethod"] != "COMPANY_TIME" for r in references)
        else "UNVERIFIED"
    )
    return {"officialReferences": references, "officialVerification": status}


async def refresh_official_references(tx, source, companies, description):
    texts = [source["title"], source["url"], description or ""]
    ids, filings, officials = official_identifiers(texts), [], []
    if ids["dart"]:
        filings += await tx.fetch_all(
            "SELECT * FROM filings WHERE source='OPENDART' AND rcept_no IN :ids LIMIT 10",
            {"ids": ids["dart"]},
        )
    if ids["sec"]:
        officials += await tx.fetch_all(
            "SELECT * FROM source_items WHERE source='SEC' AND external_id IN :ids LIMIT 10",
            {"ids": ids["sec"]},
        )
    if ids["urls"]:
        officials += await tx.fetch_all(
            "SELECT * FROM source_items WHERE url IN :ids LIMIT 10", {"ids": ids["urls"]}
        )
    when = instant(source.get("published_at"))
    if companies and when:
        after, before = when - timedelta(days=3), when + timedelta(days=3)
        filings += await tx.fetch_all(
            "SELECT * FROM filings WHERE source='OPENDART' AND company_id IN :ids AND rcept_date BETWEEN :after AND :before ORDER BY rcept_date DESC,id LIMIT 10",
            {
                "ids": companies,
                "after": after.astimezone(timezone(timedelta(hours=9))).date(),
                "before": before.astimezone(timezone(timedelta(hours=9))).date(),
            },
        )
        officials += await tx.fetch_all(
            "SELECT s.* FROM source_items s WHERE (s.source IN ('SEC','OPENDART') OR s.source_kind IN ('COMPANY_IR','OFFICIAL_RELEASE','OFFICIAL_DISCLOSURE')) AND s.published_at BETWEEN :after AND :before AND (s.company_id IN :ids OR EXISTS (SELECT 1 FROM news_source_companies n WHERE n.source_item_id=s.id AND n.company_id IN :ids)) ORDER BY s.published_at DESC,s.id LIMIT 10",
            {"ids": companies, "after": after, "before": before},
        )
    previous = (source.get("raw_metadata_json") or {}).get("officialReferences", [])
    reviewed = [
        r
        for r in previous
        if isinstance(r, dict)
        and r.get("sourceHash") == source.get("raw_hash")
        and r.get("status") in ("CONFIRMED", "REJECTED")
        and isinstance(r.get("id"), str)
    ][:10]
    for kind, table, destination in (
        ("FILING", "filings", filings),
        ("SOURCE_ITEM", "source_items", officials),
    ):
        targets = [r["id"] for r in reviewed if r.get("kind") == kind]
        if targets:
            destination += await tx.fetch_all(
                f"SELECT * FROM {table} WHERE id IN :ids", {"ids": targets}
            )
    official_ids = list({r["id"] for r in officials})
    links: dict[str, list[str]] = {}
    if official_ids and companies:
        for link in await tx.fetch_all(
            "SELECT source_item_id,company_id FROM news_source_companies WHERE source_item_id IN :sources AND company_id IN :companies",
            {"sources": official_ids, "companies": companies},
        ):
            links.setdefault(link["source_item_id"], []).append(link["company_id"])
    source["raw_metadata_json"].update(
        build_official_references(
            source, companies, texts, filings, list(map(decoded_row, officials)), links, previous
        )
    )
    await save_row(
        tx, "source_items", {"id": source["id"], "raw_metadata_json": source["raw_metadata_json"]}
    )
