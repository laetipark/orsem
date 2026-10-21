"""Durable, separately versioned disclosure analysis jobs; no alert side effects."""

from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from datetime import timedelta
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from ..connectors.sec_access import SecAccessCooldownError, SecAccessPolicyError
from ..constants import QueueName
from ..core import as_instant, db_time, decode_json, json_text, sha256, utcnow
from ..disclosures.client import OpenDartHttpError
from ..disclosures.primitives import OpenDartApiError
from ..market.common import camel, insert, iso, update
from .access import AccessMixin, AnalysisDenied
from .artifacts import ArtifactMixin, primary_url
from .documents import extract_document_tables
from .facts import REPORTS, VERSION, fact_identity, normalize_dart, normalize_sec, valid_date
from .sources import AnalysisWaiting, Sources

METRICS = {
    "revenue",
    "operatingIncome",
    "netIncome",
    "assets",
    "liabilities",
    "equity",
    "operatingCashFlow",
}
METRIC_LABELS = {
    "revenue": "매출",
    "operatingIncome": "영업이익",
    "netIncome": "당기순이익",
    "assets": "자산",
    "liabilities": "부채",
    "equity": "자본",
    "operatingCashFlow": "영업활동 현금흐름",
}
KINDS = {"RUN", "EXPORT", "DOCUMENT", "DIFF", "VALIDATE", "OWNERSHIP"}
OFFICIAL = "OFFICIAL_PUBLIC_DATA"


def stable(value):
    return str(uuid5(NAMESPACE_URL, value))


def decoded(row):
    result = camel(row)
    for name in list(result):
        if name.endswith("Json"):
            result[name] = decode_json(result[name], None)
    return result


def periods_for(selection, today=None):
    fixed = selection.get("periods")
    if fixed:
        periods = fixed
    else:
        today = today or utcnow().date()
        rolling = selection.get("rolling", {})
        count = rolling.get("count", 5)
        if type(count) is not int or not 1 <= count <= 20:
            raise ValueError("Invalid rolling period count")
        if rolling.get("kind") == "ANNUAL":
            periods = [
                {"year": today.year - offset - 1, "reportCode": "11011"} for offset in range(count)
            ]
        elif rolling.get("kind") == "QUARTER":
            last = today.year * 4 + (today.month - 1) // 3 - 1
            codes = ("11013", "11012", "11014", "11011")
            periods = [
                {"year": (last - n) // 4, "reportCode": codes[(last - n) % 4]} for n in range(count)
            ]
        else:
            raise ValueError("Missing analysis periods")
    if not 1 <= len(periods) <= 20 or any(
        type(p.get("year")) is not int
        or not 2015 <= p["year"] <= 2100
        or p.get("reportCode") not in REPORTS
        for p in periods
    ):
        raise ValueError("Invalid analysis periods")
    return sorted(periods, key=lambda p: (p["year"], REPORTS[p["reportCode"]]))


class Analysis(AccessMixin, ArtifactMixin):
    def __init__(self, ctx):
        self.ctx = ctx

    async def row(self, table, identity, db=None, lock=False):
        result = await (db or self.ctx.db).fetch_one(
            f"SELECT * FROM {table} WHERE id=:id" + (" FOR UPDATE" if lock else ""),
            {"id": identity},
        )
        return decoded(result) if result else None

    async def patch(self, table, identity, values, db=None):
        await update(db or self.ctx.db, table, identity, {**values, "updatedAt": utcnow()})

    async def dispatch(self):
        if not getattr(self.ctx.config, "analysisEnabled", False):
            return
        rows = await self.ctx.db.fetch_all(
            "SELECT id,attempts FROM analysis_jobs WHERE status IN ('PENDING','RETRY','RUNNING') AND available_at<=:now AND (lease_until IS NULL OR lease_until<:now) ORDER BY available_at,id LIMIT 20",
            {"now": db_time()},
        )
        for row in rows:
            await self.ctx.enqueue(
                QueueName.FILING,
                "process-analysis-job",
                {"jobId": row["id"]},
                {
                    "jobId": f"analysis-{row['id']}-{row['attempts']}",
                    "attempts": 1,
                    "removeOnComplete": True,
                    "removeOnFail": True,
                },
            )

    async def process(self, payload):
        UUID(payload["jobId"])
        if not getattr(self.ctx.config, "analysisEnabled", False):
            return {"status": "DISABLED"}
        async with self.ctx.db.transaction() as tx:
            job = await self.row("analysis_jobs", payload["jobId"], tx, True)
            if not job or job["status"] not in ("PENDING", "RETRY", "RUNNING"):
                return {"status": "SKIPPED"}
            if job["kind"] not in KINDS:
                raise ValueError("Invalid analysis job kind")
            if job.get("leaseUntil") and as_instant(job["leaseUntil"]) > utcnow():
                return {"status": "LEASED"}
            if as_instant(job["availableAt"]) > utcnow():
                return {"status": "WAITING"}
            await self.patch(
                "analysis_jobs",
                job["id"],
                {
                    "status": "RUNNING",
                    "attempts": job["attempts"] + 1,
                    "leaseUntil": utcnow() + timedelta(minutes=5),
                },
                tx,
            )

        async def heartbeat():
            while True:
                await asyncio.sleep(30)
                renewed = await self.ctx.db.execute(
                    "UPDATE analysis_jobs SET lease_until=:until WHERE id=:id AND status='RUNNING' AND attempts=:attempt",
                    {
                        "until": db_time(utcnow() + timedelta(minutes=5)),
                        "id": job["id"],
                        "attempt": job["attempts"] + 1,
                    },
                )
                if renewed != 1:
                    raise RuntimeError("Analysis lease lost")

        beat = asyncio.create_task(heartbeat())
        work = None
        try:
            handlers = {
                "RUN": self.run,
                "EXPORT": self.export,
                "DOCUMENT": self.document,
                "OWNERSHIP": self.document,
                "DIFF": self.diff,
                "VALIDATE": self.validate,
            }
            work = asyncio.create_task(
                handlers[job["kind"]](job["entityId"], job.get("payloadJson") or {})
            )
            done, _ = await asyncio.wait((work, beat), return_when=asyncio.FIRST_COMPLETED)
            if beat in done:
                work.cancel()
                await asyncio.gather(work, return_exceptions=True)
                await beat
            result = await work
            await self.patch(
                "analysis_jobs",
                job["id"],
                {"status": "COMPLETE", "leaseUntil": None, "lastError": None},
            )
            return result
        except Exception as error:  # noqa: BLE001 - durable retries redact provider and credential-bearing URLs
            retry = getattr(error, "retryAt", None)
            if isinstance(error, AnalysisWaiting) or type(error).__name__ in (
                "SecAccessCooldownError",
                "SecAccessPolicyError",
            ):
                retry = retry or utcnow() + timedelta(minutes=15)
                message = (
                    str(error)
                    if isinstance(error, AnalysisWaiting)
                    else "SEC 공통 접근 상태를 기다립니다."
                )
                state = "WAITING"
            else:
                retry = (
                    utcnow() + timedelta(minutes=min(60, 2 ** min(job["attempts"], 6)))
                    if job["attempts"] < 5 and not isinstance(error, AnalysisDenied)
                    else None
                )
                message = "자료 처리 실패: " + type(error).__name__
                state = "WAITING" if retry else "FAILED"
            await self.patch(
                "analysis_jobs",
                job["id"],
                {
                    "status": "RETRY" if retry else "FAILED",
                    "availableAt": retry or utcnow(),
                    "leaseUntil": None,
                    "lastError": message,
                },
            )
            table = {
                "RUN": "analysis_runs",
                "EXPORT": "analysis_exports",
                "DOCUMENT": "analysis_documents",
                "OWNERSHIP": "analysis_documents",
                "DIFF": "analysis_diffs",
            }.get(job["kind"])
            if table:
                patch: dict[str, Any] = {"status": state, "errorMessage": message}
                if table == "analysis_runs":
                    patch["nextAttemptAt"] = retry
                await self.patch(table, job["entityId"], patch)
            return {"status": state}
        finally:
            beat.cancel()
            if work and not work.done():
                work.cancel()
            await asyncio.gather(*([beat, work] if work else [beat]), return_exceptions=True)

    async def report_rows(self, company_id, period, source, scope):
        rows = await self.ctx.db.fetch_all(
            "SELECT * FROM analysis_reports WHERE company_id=:company AND source=:source AND report_year=:year AND report_code=:code AND scope=:scope ORDER BY first_observed_at,id",
            {
                "company": company_id,
                "source": source,
                "year": period["year"],
                "code": period["reportCode"],
                "scope": scope,
            },
        )
        return [decoded(row) for row in rows]

    async def save_reports(self, company, source, content, facts, metadata=None):
        raw = await self.ctx.services["raw_documents"].put(content, extension="json")
        groups = defaultdict(list)
        for fact in facts:
            meta = fact["factJson"]
            if meta.get("reportCode") not in REPORTS:
                continue
            groups[
                (meta["filingId"], meta["reportYear"], meta["reportCode"], meta["scope"])
            ].append(fact)
        for (filing, year, code, scope), group in groups.items():
            mapped_version = (
                VERSION
                + ":"
                + sha256(
                    json_text(sorted({f["factJson"].get("mappingVersion", VERSION) for f in group}))
                )[:16]
            )
            rid = stable(
                "analysis-report:"
                + json_text(
                    [
                        company["id"],
                        source,
                        filing,
                        year,
                        code,
                        scope,
                        raw["sha256"],
                        mapped_version,
                    ]
                )
            )
            first = group[0]["factJson"]
            observed = utcnow()
            publication = first.get("publicationDate") or (
                valid_date(f"{filing[:4]}-{filing[4:6]}-{filing[6:8]}")
                if source == "OPENDART"
                else None
            )
            evidence = {
                "reportId": rid,
                "source": source,
                "filingId": filing,
                "sourceUrl": first["sourceUrl"],
                "observedAt": iso(observed),
                "publicationDate": publication,
                "rightsMode": OFFICIAL,
                "rawSha256": raw["sha256"],
                "parserVersion": VERSION,
            }
            async with self.ctx.db.transaction() as tx:
                if await self.row("analysis_reports", rid, tx):
                    continue
                await insert(
                    tx,
                    "analysis_reports",
                    {
                        "id": rid,
                        "companyId": company["id"],
                        "source": source,
                        "filingId": filing,
                        "reportYear": year,
                        "reportCode": code,
                        "scope": scope,
                        "periodStart": min(
                            (f["periodStart"] for f in group if f["periodStart"]), default=None
                        ),
                        "periodEnd": max(
                            (f["periodEnd"] for f in group if f["periodEnd"]), default=None
                        ),
                        "publicationDate": publication,
                        "firstObservedAt": observed,
                        "sourceUrl": first["sourceUrl"],
                        "rightsMode": OFFICIAL,
                        "rawUri": raw["objectUri"],
                        "rawSha256": raw["sha256"],
                        "normalizerVersion": mapped_version,
                        "metadataJson": metadata or {},
                    },
                )
                for fact in group:
                    if fact["metric"] not in METRICS:
                        continue
                    fid = stable(rid + ":" + fact_identity(fact))
                    meta = fact["factJson"]
                    rendered = {
                        "id": fid,
                        "companyId": company["id"],
                        "companyName": company.get("nameKo"),
                        "reportId": rid,
                        "metric": fact["metric"],
                        "accountId": fact["accountId"],
                        "accountName": meta.get("accountName") or fact["accountId"],
                        "accountDetail": meta.get("accountDetail"),
                        "periodStart": fact["periodStart"],
                        "periodEnd": fact["periodEnd"],
                        "reportYear": year,
                        "reportCode": code,
                        "basis": fact["basis"],
                        "scope": scope,
                        "value": fact["valueText"],
                        "rawValue": None if meta.get("rawValue") is None else str(meta["rawValue"]),
                        "currency": fact["currency"],
                        "unit": fact["unit"] or "UNKNOWN",
                        "scale": 1,
                        "status": fact["status"],
                        "taxonomy": fact["accountId"].split("_")[0].split(":")[0],
                        "mappingVersion": meta.get("mappingVersion", VERSION),
                        "precision": meta.get("precision"),
                        "reason": "기간·범위 또는 계정 대응을 확인해야 합니다."
                        if fact["status"] in ("UNSUPPORTED", "AMBIGUOUS")
                        else None,
                        "evidence": {
                            **evidence,
                            "row": meta.get("sourceRow"),
                            "sourceField": meta.get("sourceField"),
                            **meta.get("documentEvidence", {}),
                        },
                    }
                    await insert(
                        tx,
                        "analysis_facts",
                        {
                            "id": fid,
                            "reportId": rid,
                            "metric": fact["metric"],
                            "accountId": fact["accountId"],
                            "periodStart": fact["periodStart"],
                            "periodEnd": fact["periodEnd"],
                            "basis": fact["basis"],
                            "currency": fact["currency"],
                            "unit": fact["unit"] or "UNKNOWN",
                            "valueText": fact["valueText"],
                            "status": fact["status"],
                            "factJson": rendered,
                        },
                    )

    async def mappings(self, facts, source):
        rows = await self.ctx.db.fetch_all(
            "SELECT * FROM analysis_mappings WHERE source=:source ORDER BY version DESC,created_at DESC",
            {"source": source},
        )
        seen, confirmed, latest = set(), {}, {}
        for raw in rows:
            row = decoded(raw)
            key = (row["accountId"], row["scope"])
            if key not in seen:
                latest[key] = row
            if key not in seen and row["status"] == "CONFIRMED":
                confirmed[key] = row
            seen.add(key)
        for fact in facts:
            key = (fact["accountId"], fact["factJson"]["scope"])
            if key not in seen and fact["metric"] in METRICS:
                mapping_id = stable(
                    "analysis-builtin:" + json_text([source, *key, fact["metric"], VERSION])
                )
                builtin = {
                    "id": mapping_id,
                    "source": source,
                    "taxonomy": re.split(r"[:_]", fact["accountId"], maxsplit=1)[0],
                    "accountId": key[0],
                    "metric": fact["metric"],
                    "scope": key[1],
                    "status": "CONFIRMED",
                    "version": 1,
                    "sourceUrl": fact["factJson"]["sourceUrl"],
                    "detailsJson": {
                        "rationale": "공식 표준 계정의 정의를 사용한 대응",
                        "normalizerVersion": VERSION,
                        "observedFilingId": fact["factJson"]["filingId"],
                    },
                    "createdBy": "SYSTEM:" + VERSION,
                }
                # Only observed source tags are recorded, with stable identity.
                # Concurrent observation cannot alter an existing human decision.
                await self.ctx.db.execute(
                    "INSERT INTO analysis_mappings (id,source,taxonomy,account_id,metric,scope,status,version,source_url,details_json,created_by) VALUES (:id,:source,:taxonomy,:accountId,:metric,:scope,:status,:version,:sourceUrl,:detailsJson,:createdBy) ON DUPLICATE KEY UPDATE id=id",
                    {**builtin, "detailsJson": json_text(builtin["detailsJson"])},
                )
                seen.add(key)
                observed = await self.ctx.db.fetch_one(
                    "SELECT * FROM analysis_mappings WHERE source=:source AND account_id=:account AND scope=:scope ORDER BY version DESC,created_at DESC LIMIT 1",
                    {"source": source, "account": key[0], "scope": key[1]},
                )
                authoritative = decoded(observed) if observed else builtin
                latest[key] = authoritative
                if authoritative["status"] == "CONFIRMED":
                    confirmed[key] = authoritative
            mapping = confirmed.get(key)
            if mapping:
                fact["metric"] = mapping["metric"]
                fact["factJson"]["mappingVersion"] = mapping["id"] + ":" + str(mapping["version"])
            elif key in latest:
                fact["status"] = "AMBIGUOUS"
                fact["factJson"]["mappingVersion"] = (
                    latest[key]["id"] + ":" + str(latest[key]["version"])
                )
                fact["factJson"]["mappingStatus"] = latest[key]["status"]
        return facts

    async def collect_dart(self, company, period, scope, sources):
        params = {
            "corp_code": company["corpCode"],
            "bsns_year": str(period["year"]),
            "reprt_code": period["reportCode"],
        }
        content, payload = await sources.dart("fnlttSinglAcntAll.json", {**params, "fs_div": scope})
        if not payload:
            return False
        dates_content, dates_payload = await sources.dart("fnlttSinglAcnt.json", params)
        raw = await self.ctx.services["raw_documents"].put(content, extension="json")
        dates_raw = await self.ctx.services["raw_documents"].put(dates_content, extension="json")
        bundle = {
            "financials": payload,
            "dateEvidence": dates_payload,
            "responses": [
                {
                    "endpoint": "fnlttSinglAcntAll.json",
                    "parameters": {**params, "fs_div": scope},
                    **{k: v for k, v in raw.items() if k != "created"},
                },
                {
                    "endpoint": "fnlttSinglAcnt.json",
                    "parameters": params,
                    **{k: v for k, v in dates_raw.items() if k != "created"},
                },
            ],
        }
        facts = normalize_dart(
            payload,
            company_id=company["id"],
            year=period["year"],
            report_code=period["reportCode"],
            scope=scope,
            date_evidence=(dates_payload or {}).get("list", []),
        )
        facts = await self.mappings(facts, "OPENDART")
        await self.save_reports(
            company,
            "OPENDART",
            json_text(bundle).encode(),
            facts,
            {"responses": bundle["responses"]},
        )
        return bool(facts)

    async def collect_sec(self, company, periods, sources):
        cik = str(company["cik"]).zfill(10)
        if not re.fullmatch(r"\d{10}", cik) or int(cik) == 0:
            raise ValueError("Invalid SEC issuer identity")
        content, payload = await sources.sec(
            f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
        )
        index_content, index = await sources.sec(f"https://data.sec.gov/submissions/CIK{cik}.json")
        source_responses = [("companyfacts", content), ("submissions", index_content)]
        rows = [index.get("filings", {}).get("recent", {})]
        minimum = min(p["year"] for p in periods)
        maximum = max(p["year"] for p in periods) + 2
        for file in index.get("filings", {}).get("files", [])[:20]:
            name = file.get("name", "")
            if not re.fullmatch(r"CIK" + cik + r"-submissions-\d+\.json", name):
                continue
            start, end = str(file.get("filingFrom", "")), str(file.get("filingTo", ""))
            if (
                valid_date(start)
                and valid_date(end)
                and int(end[:4]) >= minimum
                and int(start[:4]) <= maximum
            ):
                raw_content, archive = await sources.sec("https://data.sec.gov/submissions/" + name)
                rows.append(archive)
                source_responses.append((name, raw_content))
        contexts = {}
        for row in rows:
            for i, accession in enumerate(row.get("accessionNumber", [])):
                context = {
                    key: values[i]
                    for key, values in row.items()
                    if isinstance(values, list) and i < len(values)
                }
                contexts[accession] = context
        responses = []
        for label, response in source_responses:
            stored = await self.ctx.services["raw_documents"].put(response, extension="json")
            responses.append({"name": label, **{k: v for k, v in stored.items() if k != "created"}})
        facts = normalize_sec(
            payload,
            cik=cik,
            company_id=company["id"],
            years={p["year"] for p in periods},
            filing_contexts=contexts,
        )
        wanted = {(p["year"], p["reportCode"]) for p in periods}
        latest: dict[tuple[int, str], tuple[str, str]] = {}
        for fact in facts:
            meta = fact["factJson"]
            key = (meta["reportYear"], meta["reportCode"])
            candidate = (meta["publicationDate"], meta["filingId"])
            if key in wanted and candidate > latest.get(key, ("", "")):
                latest[key] = candidate
        facts = [
            f
            for f in facts
            if (f["factJson"]["publicationDate"], f["factJson"]["filingId"])
            == latest.get((f["factJson"]["reportYear"], f["factJson"]["reportCode"]))
        ]
        documents: list[dict[str, Any]] = []
        for accession in sorted(
            {f["factJson"]["filingId"] for f in facts if f["metric"] in METRICS}
        ):
            context = contexts[accession]
            primary = context.get("primaryDocument")
            if not primary:
                continue
            url = primary_url(cik, accession, primary)
            document_content, _ = await sources.sec(url, xml=True)
            media = "application/xml" if primary.lower().endswith(".xml") else "text/html"
            raw = await self.ctx.services["raw_documents"].put(
                document_content, extension="xml" if media == "application/xml" else "html"
            )
            document = {
                "filingId": accession,
                "sourceUrl": url,
                "mediaType": media,
                **{k: v for k, v in raw.items() if k != "created"},
            }
            documents.append(document)
            extracted = await asyncio.to_thread(
                extract_document_tables, document_content, media_type=media
            )
            for fact in facts:
                if fact["factJson"]["filingId"] != accession:
                    continue
                matches = [
                    item
                    for item in extracted["inlineFacts"]
                    if item.get("consolidated")
                    and not item.get("dimensions")
                    and str(item.get("entityId", "")).zfill(10) == cik
                    and all(
                        item.get(k) == fact.get(k)
                        for k in ("accountId", "periodStart", "periodEnd", "currency")
                    )
                    and item.get("value") == fact["valueText"]
                ]
                if len(matches) == 1 and fact["factJson"].get("durationValid"):
                    proof = matches[0]
                    fact["factJson"]["scope"] = "CFS"
                    fact["status"] = "AVAILABLE"
                    fact["factJson"]["precision"] = proof.get("precision")
                    fact["factJson"]["documentEvidence"] = {
                        "tableId": proof["tableId"],
                        "row": proof["row"],
                        "column": proof["column"],
                        "matched": True,
                    }
        manifest = {"responses": responses, "documents": documents}
        facts = await self.mappings(facts, "SEC")
        await self.save_reports(company, "SEC", json_text(manifest).encode(), facts, manifest)

    async def run(self, run_id, payload):
        from .validation import compare_facts, validate_facts

        run = await self.row("analysis_runs", run_id)
        if not run:
            raise ValueError("Analysis run missing")
        if run["status"] in ("COMPLETE", "PARTIAL"):
            return {"status": run["status"]}
        await self.assert_access(run["ownerKey"], run["selectionJson"], run["companyIdsJson"])
        selection, ids = run["selectionJson"], run["companyIdsJson"]
        periods = periods_for(selection)
        if not isinstance(ids, list) or not 1 <= len(ids) <= 20:
            raise ValueError("Invalid analysis company scope")
        companies = [
            decoded(row)
            for row in await self.ctx.db.fetch_all(
                "SELECT * FROM companies WHERE id IN :ids", {"ids": ids}
            )
        ]
        if len(companies) != len(ids):
            raise ValueError("Analysis company unavailable")
        selected, issues, completed = [], [], 0
        collected = set((run.get("progressJson") or {}).get("collected", []))
        issues.extend((run.get("progressJson") or {}).get("collectionIssues", []))
        blocked: dict[str, AnalysisWaiting] = {}
        waiting: list[AnalysisWaiting] = []
        total = len(ids) * len(periods)
        sources = Sources(self.ctx)
        await self.patch(
            "analysis_runs",
            run_id,
            {
                "status": "RUNNING",
                "errorMessage": None,
                "nextAttemptAt": None,
                "progressJson": {
                    "completed": len(collected),
                    "total": total,
                    "collected": sorted(collected),
                },
            },
        )
        for company in companies:
            source = (
                "OPENDART" if company.get("corpCode") else "SEC" if company.get("cik") else None
            )
            sec_loaded = False
            for period in periods:
                period_waiting = False
                if not source:
                    issues.append(
                        {
                            "companyId": company["id"],
                            "period": period,
                            "code": "UNSUPPORTED",
                            "message": "공식 회사 식별자를 확인할 수 없습니다.",
                            "retryable": False,
                        }
                    )
                    completed += 1
                    continue
                if source == "SEC" and selection.get("scope") == "OFS":
                    issues.append(
                        {
                            "companyId": company["id"],
                            "period": period,
                            "code": "UNSUPPORTED",
                            "message": "SEC 별도 재무제표는 확인되지 않았습니다.",
                            "retryable": False,
                        }
                    )
                    completed += 1
                    continue
                if source == "SEC" and not getattr(
                    self.ctx.config, "analysisDocumentsEnabled", False
                ):
                    issues.append(
                        {
                            "companyId": company["id"],
                            "period": period,
                            "code": "UNSUPPORTED",
                            "message": "SEC 분석은 원문 분석 기능이 활성화되면 사용할 수 있습니다.",
                            "retryable": False,
                        }
                    )
                    completed += 1
                    continue
                scope = selection.get("scope", "CFS")
                reports = await self.report_rows(company["id"], period, source, scope)
                if not reports and source == "SEC":
                    reports = await self.report_rows(company["id"], period, source, "UNKNOWN")
                policy = selection.get("versionPolicy", "LATEST_OBSERVED")
                checkpoint = company["id"] + ":" + str(period["year"]) + ":" + period["reportCode"]
                should_collect = (
                    checkpoint not in collected
                    and policy != "SPECIFIC"
                    and (not reports or policy != "FIRST_OBSERVED")
                )
                if should_collect:
                    try:
                        if source in blocked:
                            raise blocked[source]
                        if source == "OPENDART":
                            await self.collect_dart(company, period, scope, sources)
                        elif not sec_loaded:
                            await self.collect_sec(company, periods, sources)
                            sec_loaded = True
                    except (AnalysisWaiting, SecAccessCooldownError, SecAccessPolicyError) as error:
                        wait = (
                            error
                            if isinstance(error, AnalysisWaiting)
                            else AnalysisWaiting(
                                "SEC 공통 접근 상태를 기다립니다.", getattr(error, "retryAt", None)
                            )
                        )
                        blocked[source] = wait
                        waiting.append(wait)
                        period_waiting = True
                        issues.append(
                            {
                                "companyId": company["id"],
                                "period": period,
                                "code": "WAITING",
                                "message": str(wait),
                                "retryable": True,
                            }
                        )
                    except (ValueError, OpenDartHttpError, OpenDartApiError):
                        issues.append(
                            {
                                "companyId": company["id"],
                                "period": period,
                                "code": "SOURCE_ERROR",
                                "message": "해당 기업·기간의 공식 자료를 처리하지 못했습니다. 다른 결과는 보존됩니다.",
                                "retryable": True,
                            }
                        )
                    reports = await self.report_rows(company["id"], period, source, scope)
                    if not reports and source == "SEC":
                        reports = await self.report_rows(company["id"], period, source, "UNKNOWN")
                if policy == "SPECIFIC":
                    reports = [r for r in reports if r["id"] in selection.get("reportIds", [])]
                elif reports:
                    reports = [reports[0] if policy == "FIRST_OBSERVED" else reports[-1]]
                if not reports and not period_waiting:
                    issues.append(
                        {
                            "companyId": company["id"],
                            "period": period,
                            "code": "NO_DATA",
                            "message": "선택 기간의 공식 제출본이 없습니다.",
                            "retryable": False,
                        }
                    )
                selected.extend(reports)
                completed += 1
                if not period_waiting:
                    collected.add(checkpoint)
                await self.patch(
                    "analysis_runs",
                    run_id,
                    {
                        "progressJson": {
                            "completed": completed,
                            "total": total,
                            "collected": sorted(collected),
                            "collectionIssues": [
                                item for item in issues if item["code"] == "SOURCE_ERROR"
                            ],
                        }
                    },
                )
        report_ids = list(dict.fromkeys(r["id"] for r in selected))
        rows = (
            await self.ctx.db.fetch_all(
                "SELECT fact_json FROM analysis_facts WHERE report_id IN :ids ORDER BY report_id,metric,id",
                {"ids": report_ids},
            )
            if report_ids
            else []
        )
        facts = [decode_json(r["fact_json"], {}) for r in rows]
        basis = selection.get("basis", "ANNUAL")
        facts = [
            f
            for f in facts
            if f.get("metric") in selection.get("metrics", METRICS)
            and f.get("basis") in (basis, "INSTANT")
        ]
        for report in selected:
            for metric in selection.get("metrics", METRICS):
                if not any(f["reportId"] == report["id"] and f["metric"] == metric for f in facts):
                    issues.append(
                        {
                            "companyId": report["companyId"],
                            "period": {
                                "year": report["reportYear"],
                                "reportCode": report["reportCode"],
                            },
                            "code": "NO_DATA",
                            "message": f"{METRIC_LABELS.get(metric, metric)}: 선택한 누적/단독 기준의 공식 수치가 없습니다.",
                            "retryable": False,
                        }
                    )
        facts = compare_facts(facts)
        validations = validate_facts(facts)
        result = {
            "facts": facts,
            "issues": issues,
            "reportIds": report_ids,
            "documentIds": [],
            "diffIds": [],
            "validations": validations,
            "mappingVersion": VERSION,
        }
        status = (
            "WAITING"
            if waiting
            else (
                "PARTIAL"
                if issues or any(f["status"] != "AVAILABLE" for f in facts)
                else "COMPLETE"
            )
        )
        async with self.ctx.db.transaction() as tx:
            current = await self.row("analysis_runs", run_id, tx, True)
            for key in ("documentIds", "diffIds"):
                result[key] = (current.get("resultJson") or {}).get(key, [])
            await self.patch(
                "analysis_runs",
                run_id,
                {
                    "status": status,
                    "resultJson": result,
                    "progressJson": {
                        "completed": len(collected) if waiting else total,
                        "total": total,
                        "collected": sorted(collected),
                        "collectionIssues": [
                            item for item in issues if item["code"] == "SOURCE_ERROR"
                        ],
                    },
                    "completedAt": None if waiting else utcnow(),
                    "nextAttemptAt": min(item.retryAt for item in waiting) if waiting else None,
                },
                tx,
            )
        await self.save_validation(run_id, validations)
        if waiting:
            raise AnalysisWaiting(
                "완료된 결과를 보존했습니다. 남은 공식 자료를 기다립니다.",
                min(item.retryAt for item in waiting),
            )
        return {"status": status, "facts": len(facts)}

    async def save_validation(self, run_id, findings):
        await insert(
            self.ctx.db,
            "analysis_validations",
            {
                "id": stable(run_id + ":validation-v1"),
                "runId": run_id,
                "ruleVersion": "analysis-validation-v1",
                "resultsJson": findings,
            },
            update=["resultsJson"],
        )

    async def validate(self, run_id, payload):
        from .documents import link_document_facts
        from .validation import validate_facts

        run = await self.row("analysis_runs", run_id)
        if not run:
            raise ValueError("Analysis run missing")
        result = run.get("resultJson") or {}
        findings = validate_facts(result.get("facts", []))
        for document_id in result.get("documentIds", []):
            document = await self.row("analysis_documents", document_id)
            if document and document["status"] in ("COMPLETE", "PARTIAL"):
                facts = [
                    fact
                    for fact in result.get("facts", [])
                    if fact.get("reportId") == document.get("reportId")
                ]
                findings.extend(link_document_facts(document.get("tablesJson") or [], facts))
        await self.save_validation(run_id, findings)
        async with self.ctx.db.transaction() as tx:
            current = await self.row("analysis_runs", run_id, tx, True)
            snapshot = current.get("resultJson") or result
            snapshot["validations"] = findings
            await self.patch("analysis_runs", run_id, {"resultJson": snapshot}, tx)
        return {"status": "COMPLETE"}
