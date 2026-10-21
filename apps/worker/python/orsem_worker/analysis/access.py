"""Saved analysis access is rechecked before every new acquisition or refresh."""

from __future__ import annotations

import re
from datetime import timedelta
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from ..core import (
    Database,
    RuntimeContext,
    as_instant,
    decode_json,
    identifier,
    json_text,
    sha256,
    utcnow,
)
from ..market.common import camel, checkpoint, insert, read_checkpoint
from .sources import Sources


class AnalysisDenied(ValueError):
    pass


class AccessMixin:
    ctx: RuntimeContext

    if TYPE_CHECKING:

        async def row(
            self, table: str, identity: str, db: Database | None = None, lock: bool = False
        ) -> Any: ...
        async def patch(
            self, table: str, identity: str, values: dict[str, Any], db: Database | None = None
        ) -> None: ...

    async def observe_regular_reports(self, company_ids, sources):
        """Metadata observations only: no trade parser, projections or alerts."""
        if not self.ctx.services["opendart"].enabled:
            return
        companies = await self.ctx.db.fetch_all(
            "SELECT id,corp_code FROM companies WHERE id IN :ids AND corp_code IS NOT NULL",
            {"ids": company_ids},
        )
        for company in companies:
            corp = company["corp_code"]
            if not re.fullmatch(r"\d{8}", corp or ""):
                continue
            previous = await read_checkpoint(self.ctx.db, "ANALYSIS_OPENDART", corp)
            now = utcnow()
            if previous.get("lastSuccessAt") and now - as_instant(
                previous["lastSuccessAt"]
            ) < timedelta(hours=1):
                continue
            lock = self.ctx.config.redisPrefix + "analysis:regular:" + corp
            if not await self.ctx.redis.set(lock, "1", nx=True, ex=300):
                continue
            end = now.astimezone(ZoneInfo("Asia/Seoul")).date()
            start = end - timedelta(days=90)
            if previous.get("lastSuccessDate"):
                from datetime import date

                start = min(end, date.fromisoformat(str(previous["lastSuccessDate"]))) - timedelta(
                    days=7
                )
                end = min(end, start + timedelta(days=90))
            for domain in ("A001", "A002", "A003"):
                for page in range(1, 6):
                    content, envelope = await sources.dart(
                        "list.json",
                        {
                            "corp_code": corp,
                            "bgn_de": start.strftime("%Y%m%d"),
                            "end_de": end.strftime("%Y%m%d"),
                            "pblntf_detail_ty": domain,
                            "last_reprt_at": "N",
                            "sort": "date",
                            "sort_mth": "desc",
                            "page_no": str(page),
                            "page_count": "100",
                        },
                    )
                    if not envelope:
                        break
                    raw = await self.ctx.services["raw_documents"].put(content, extension="json")
                    for item in envelope.get("list", []):
                        receipt, published = item.get("rcept_no"), item.get("rcept_dt")
                        if (
                            item.get("corp_code") != corp
                            or not re.fullmatch(r"\d{14}", receipt or "")
                            or not re.fullmatch(r"\d{8}", published or "")
                        ):
                            raise ValueError("Regular report observation identity mismatch")
                        day = f"{published[:4]}-{published[4:6]}-{published[6:]}"
                        source_id = str(uuid5(NAMESPACE_URL, "analysis:opendart:" + receipt))
                        url = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + receipt
                        await self.ctx.db.execute(
                            "INSERT INTO source_items (id,source,external_id,company_id,url,title,source_name,first_observed_at,rights_mode,raw_object_uri,raw_metadata_json,source_kind) VALUES (:id,'OPENDART',:receipt,:company,:url,:title,'OpenDART',:now,'OFFICIAL_PUBLIC_DATA',:raw,:metadata,'FILING') ON DUPLICATE KEY UPDATE id=id",
                            {
                                "id": source_id,
                                "receipt": receipt,
                                "company": company["id"],
                                "url": url,
                                "title": str(item.get("report_nm", ""))[:2000],
                                "now": now,
                                "raw": raw["objectUri"],
                                "metadata": json_text(
                                    {
                                        "analysisRegularReport": True,
                                        "isRegularFinancial": True,
                                        "detailType": domain,
                                        "publicationDate": day,
                                        "eventDate": day,
                                        "rawSha256": raw["sha256"],
                                        "rawList": item,
                                    }
                                ),
                            },
                        )
                    if int(envelope.get("total_page", 1)) <= page:
                        break
                    if page == 5:
                        raise ValueError("Regular report observation pagination limit")
            await checkpoint(
                self.ctx.db,
                "ANALYSIS_OPENDART",
                corp,
                {"domains": ["A001", "A002", "A003"]},
                at=now,
                date=end,
            )

    async def actor_active(self, key, db=None):
        db = db or self.ctx.db
        kind, _, identity = key.partition(":")
        if kind == "ADMIN":
            return bool(
                await db.fetch_one(
                    "SELECT id FROM admins WHERE id=:id AND is_active=1", {"id": identity}
                )
            )
        if kind == "MEMBER":
            return bool(
                await db.fetch_one(
                    "SELECT id FROM members WHERE id=:id AND role='VIEWER' AND status='APPROVED'",
                    {"id": identity},
                )
            )
        return False

    async def assert_access(self, owner, selection, ids, db=None):
        db = db or self.ctx.db
        if not await self.actor_active(owner, db):
            raise AnalysisDenied("Analysis actor unavailable")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or len(set(ids)) != len(ids):
            raise AnalysisDenied("Invalid company snapshot")
        if set(selection.get("companyIds", [])) != set(ids):
            raise AnalysisDenied("Company snapshot mismatch")
        group_id = selection.get("groupId")
        if not group_id:
            return
        if group_id == "operational":
            members = await db.fetch_all("SELECT company_id FROM market_leader_watchlist")
        else:
            group = await db.fetch_one(
                "SELECT owner_key,room_id FROM watchlist_groups WHERE id=:id", {"id": group_id}
            )
            if not group:
                raise AnalysisDenied("Analysis group unavailable")
            if group["room_id"]:
                room = await db.fetch_one(
                    "SELECT owner_key FROM watchlist_rooms WHERE id=:id", {"id": group["room_id"]}
                )
                member = await db.fetch_one(
                    "SELECT room_id FROM watchlist_room_members WHERE room_id=:room AND actor_key=:actor",
                    {"room": group["room_id"], "actor": owner},
                )
                if not room or not member or not await self.actor_active(room["owner_key"], db):
                    raise AnalysisDenied("Analysis room access revoked")
            elif group["owner_key"] != owner:
                raise AnalysisDenied("Analysis group access revoked")
            members = await db.fetch_all(
                "SELECT company_id FROM watchlist_group_items WHERE group_id=:id", {"id": group_id}
            )
        if not set(ids).issubset({row["company_id"] for row in members}):
            raise AnalysisDenied("Analysis group companies changed")

    async def auto_refresh(self):
        from .service import periods_for

        if not getattr(self.ctx.config, "analysisEnabled", False):
            return
        rows = await self.ctx.db.fetch_all(
            "SELECT * FROM analysis_saved_queries WHERE auto_refresh=1 AND id>:after ORDER BY id LIMIT 100",
            {"after": getattr(self, "_auto_cursor", "")},
        )
        self._auto_cursor = rows[-1]["id"] if len(rows) == 100 else ""
        sources = Sources(self.ctx, maximum=60)
        for raw in rows:
            query = camel(raw)
            selection = decode_json(query["selectionJson"], {})
            ids = selection.get("companyIds", [])
            try:
                await self.assert_access(query["ownerKey"], selection, ids)
            except AnalysisDenied:
                # Explicit pause; never keep using the stored group membership.
                await self.patch("analysis_saved_queries", query["id"], {"autoRefresh": False})
                continue
            periods = periods_for(selection)
            await self.observe_regular_reports(ids, sources)
            # New raw ingestion observations, including unsynchronized financial
            # filings, wake collection. Publication windows include corrections.
            earliest = f"{min(p['year'] for p in periods)}-01-01"
            observed = await self.ctx.db.fetch_all(
                "SELECT id,first_observed_at FROM filings WHERE company_id IN :ids AND rcept_date>=:earliest UNION ALL SELECT id,first_observed_at FROM source_items WHERE company_id IN :ids AND (source='SEC' OR (source='OPENDART' AND JSON_EXTRACT(raw_metadata_json,'$.analysisRegularReport')=true)) AND COALESCE(published_at,first_observed_at)>=:earliest ORDER BY first_observed_at DESC,id DESC LIMIT 1000",
                {"ids": ids, "earliest": earliest},
            )
            trigger = sha256(json_text({"periods": periods, "observations": observed}))
            if trigger == query.get("lastTriggerKey"):
                continue
            async with self.ctx.db.transaction() as tx:
                current = await self.row("analysis_saved_queries", query["id"], tx, True)
                if (
                    not current
                    or not current["autoRefresh"]
                    or current.get("lastTriggerKey") == trigger
                ):
                    continue
                # One pending refresh at a time; leave trigger unconsumed until
                # prior work finishes so arrivals during a run are not lost.
                active = await tx.fetch_one(
                    "SELECT id FROM analysis_runs WHERE saved_query_id=:id AND status IN ('QUEUED','RUNNING','WAITING') LIMIT 1",
                    {"id": query["id"]},
                )
                if active:
                    continue
                await self.assert_access(query["ownerKey"], selection, ids, tx)
                parent = await tx.fetch_one(
                    "SELECT id FROM analysis_runs WHERE saved_query_id=:id ORDER BY created_at DESC,id DESC LIMIT 1",
                    {"id": query["id"]},
                )
                run_id = str(uuid5(NAMESPACE_URL, "analysis-auto:" + query["id"] + ":" + trigger))
                # Force current source collection on auto refresh while retaining
                # the frozen company snapshot and user version policy.
                await insert(
                    tx,
                    "analysis_runs",
                    {
                        "id": run_id,
                        "ownerKey": query["ownerKey"],
                        "savedQueryId": query["id"],
                        "parentRunId": parent["id"] if parent else None,
                        "status": "QUEUED",
                        "selectionJson": selection,
                        "companyIdsJson": ids,
                        "progressJson": {"completed": 0, "total": len(ids) * len(periods)},
                    },
                )
                await insert(
                    tx,
                    "analysis_jobs",
                    {
                        "id": identifier(),
                        "kind": "RUN",
                        "entityId": run_id,
                        "status": "PENDING",
                        "attempts": 0,
                        "availableAt": utcnow(),
                        "payloadJson": {"runId": run_id, "refresh": True},
                    },
                )
                await self.patch(
                    "analysis_saved_queries", query["id"], {"lastTriggerKey": trigger}, tx
                )
