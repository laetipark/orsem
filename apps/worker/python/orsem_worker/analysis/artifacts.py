"""Immutable official documents, confirmed corrections and frozen XLSX exports."""

from __future__ import annotations

import asyncio
import os
import re
import stat
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5

from ..core import Database, RuntimeContext, decode_json, json_text, sha256
from ..disclosures.sec import ownership_url, parse_ownership
from ..market.common import insert
from .access import AnalysisDenied
from .documents import VERSION, diff_document_tables, extract_document_tables, link_document_facts
from .exports import build_xlsx
from .sources import AnalysisWaiting, Sources

OFFICIAL = "OFFICIAL_PUBLIC_DATA"


def read_object(root, uri, expected, maximum=50 * 1024**2):
    parsed = urlsplit(uri or "")
    if (
        parsed.scheme != "file"
        or parsed.netloc
        or parsed.query
        or parsed.fragment
        or "%" in parsed.path
    ):
        raise ValueError("Invalid immutable object URI")
    path = Path(parsed.path)
    root = Path(root).resolve()
    if not path.is_absolute() or not path.resolve().is_relative_to(root) or path.is_symlink():
        raise ValueError("Immutable object outside storage")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            raise ValueError("Immutable object size invalid")
        data = stream.read(maximum + 1)
    if not expected or sha256(data) != expected or len(data) > maximum:
        raise ValueError("Immutable object checksum mismatch")
    return data


def primary_url(cik, accession, primary):
    if (
        not re.fullmatch(r"\d{1,10}", str(cik))
        or not int(cik)
        or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession or "")
        or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:htm|html|xml)", primary or "", re.IGNORECASE
        )
    ):
        raise ValueError("Invalid SEC primary document identity")
    return (
        f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{primary}"
    )


class ArtifactMixin:
    ctx: RuntimeContext

    if TYPE_CHECKING:

        async def row(
            self, table: str, identity: str, db: Database | None = None, lock: bool = False
        ) -> Any: ...
        async def patch(
            self, table: str, identity: str, values: dict[str, Any], db: Database | None = None
        ) -> None: ...
        async def assert_access(
            self, owner: str, selection: dict[str, Any], ids: list[str], db: Database | None = None
        ) -> None: ...
        async def actor_active(self, key: str, db: Database | None = None) -> bool: ...
        async def validate(self, run_id: str, payload: dict[str, Any]) -> Any: ...

    async def artifact_run(self, payload, *, acquire=True):
        run = await self.row("analysis_runs", payload.get("runId"))
        if not run or payload.get("ownerKey", run["ownerKey"]) != run["ownerKey"]:
            raise AnalysisDenied("Analysis run owner mismatch")
        if acquire:
            await self.assert_access(run["ownerKey"], run["selectionJson"], run["companyIdsJson"])
        elif not await self.actor_active(run["ownerKey"]):
            raise AnalysisDenied("Analysis actor unavailable")
        return run

    async def attach(self, run_id, key, identity):
        async with self.ctx.db.transaction() as tx:
            run = await self.row("analysis_runs", run_id, tx, True)
            result = run.get("resultJson") or {
                "facts": [],
                "issues": [],
                "reportIds": [],
                "documentIds": [],
                "diffIds": [],
                "validations": [],
                "mappingVersion": "analysis-financial-v1",
            }
            result[key] = list(dict.fromkeys([*result.get(key, []), identity]))
            await self.patch("analysis_runs", run_id, {"resultJson": result}, tx)

    async def document_source(self, document, run):
        if document["rightsMode"] != OFFICIAL:
            raise AnalysisDenied("Document rights prohibit extraction")
        if document.get("reportId"):
            report = await self.row("analysis_reports", document["reportId"])
            if (
                not report
                or report["companyId"] not in run["companyIdsJson"]
                or report["rightsMode"] != OFFICIAL
            ):
                raise AnalysisDenied("Document report out of scope")
            return report["source"], report["companyId"], report["filingId"], report
        if document.get("filingId"):
            filing = await self.row("filings", document["filingId"])
            if not filing or filing["companyId"] not in run["companyIdsJson"]:
                raise AnalysisDenied("Document filing out of scope")
            return "OPENDART", filing["companyId"], filing["rceptNo"], filing
        if document.get("sourceItemId"):
            source = await self.row("source_items", document["sourceItemId"])
            if (
                not source
                or source["companyId"] not in run["companyIdsJson"]
                or source["source"] != "SEC"
                or source["rightsMode"] != OFFICIAL
            ):
                raise AnalysisDenied("Document source out of scope")
            return "SEC", source["companyId"], source["externalId"], source
        raise ValueError("Document source missing")

    async def document(self, document_id, payload):
        if not getattr(self.ctx.config, "analysisDocumentsEnabled", False):
            raise AnalysisDenied("Document analysis disabled")
        run = await self.artifact_run(payload)
        document = await self.row("analysis_documents", document_id)
        if not document:
            raise ValueError("Document missing")
        source, company_id, filing_id, parent = await self.document_source(document, run)
        if document["status"] in ("COMPLETE", "PARTIAL"):
            await self.attach(run["id"], "documentIds", document_id)
            return {"status": document["status"]}
        await self.patch(
            "analysis_documents", document_id, {"status": "RUNNING", "errorMessage": None}
        )
        sources = Sources(self.ctx)
        metadata = parent.get("rawMetadataJson") or parent.get("metadataJson") or {}
        content = None
        media = document.get("mediaType")
        ownership = None
        if (
            document.get("rawUri")
            and document.get("rawSha256")
            and media
            in (
                "application/zip",
                "application/xml",
                "text/xml",
                "text/html",
                "application/xhtml+xml",
            )
        ):
            content = await asyncio.to_thread(
                read_object,
                self.ctx.config.rawDocumentDir,
                document["rawUri"],
                document["rawSha256"],
            )
        if content is None and source == "OPENDART":
            if not re.fullmatch(r"\d{14}", filing_id):
                raise ValueError("Invalid DART receipt")
            content, _ = await sources.dart("document.xml", {"rcept_no": filing_id}, archive=True)
            media = "application/zip"
        elif content is None:
            company = await self.row("companies", company_id)
            if metadata.get("form") in ("3", "4", "5", "3/A", "4/A", "5/A"):
                url = ownership_url(parent)
                media = "application/xml"
            else:
                stored = next(
                    (
                        item
                        for item in metadata.get("documents", [])
                        if item.get("filingId") == filing_id
                    ),
                    None,
                )
                if stored:
                    content = await asyncio.to_thread(
                        read_object,
                        self.ctx.config.rawDocumentDir,
                        stored["objectUri"],
                        stored["sha256"],
                    )
                    media = stored["mediaType"]
                    url = stored["sourceUrl"]
                else:
                    url = primary_url(
                        str(company["cik"]), filing_id, metadata.get("primaryDocument")
                    )
                    media = "application/xml" if url.lower().endswith(".xml") else "text/html"
            if content is None:
                content, _ = await sources.sec(url, xml=True)
        if source == "SEC" and metadata.get("form") in ("3", "4", "5", "3/A", "4/A", "5/A"):
            company = await self.row("companies", company_id)
            parsed = parse_ownership(
                content.decode("utf-8-sig"),
                {
                    "expectedCik": str(company["cik"]).zfill(10),
                    "accessionNumber": filing_id,
                    "sourceUrl": document["sourceUrl"],
                    "filingDate": metadata.get("filingDate"),
                },
            )
            if parsed["documentType"] != metadata["form"]:
                raise ValueError("SEC form mismatch")
            ownership = {
                **parsed,
                "form": parsed["documentType"],
                "footnotes": {note["id"]: note["text"] for note in parsed["footnotes"]},
            }
            extracted: dict[str, Any] = {"tables": [], "notes": []}
        else:
            extracted = await asyncio.to_thread(extract_document_tables, content, media_type=media)
            facts = (run.get("resultJson") or {}).get("facts", [])
            related = [fact for fact in facts if fact.get("reportId") == document.get("reportId")]
            link_document_facts(extracted["tables"], related)
        extension = (
            "zip" if media == "application/zip" else "html" if media == "text/html" else "xml"
        )
        raw = await self.ctx.services["raw_documents"].put(content, extension=extension)
        async with self.ctx.db.transaction() as tx:
            current = await self.row("analysis_documents", document_id, tx, True)
            if current["status"] not in ("COMPLETE", "PARTIAL"):
                # Phase 2 stores complete derived source metadata; phase 3 gates
                # reading/searching/bookmarking/exporting these notes.
                for note in extracted.get("notes", []):
                    await insert(
                        tx,
                        "analysis_notes",
                        {
                            "id": str(uuid5(NAMESPACE_URL, document_id + ":" + note["key"])),
                            "documentId": document_id,
                            "noteKey": note["key"],
                            "title": note["title"][:500],
                            "body": note["text"],
                            "tableIdsJson": note["tableIds"],
                            "sourceUrl": document["sourceUrl"],
                        },
                    )
                await self.patch(
                    "analysis_documents",
                    document_id,
                    {
                        "status": "COMPLETE",
                        "rawUri": raw["objectUri"],
                        "rawSha256": raw["sha256"],
                        "mediaType": media,
                        "parserVersion": VERSION,
                        "tablesJson": extracted["tables"],
                        "ownershipJson": ownership,
                        "errorMessage": None,
                    },
                    tx,
                )
        await self.attach(run["id"], "documentIds", document_id)
        await self.validate(run["id"], {})
        return {"status": "COMPLETE"}

    async def confirmed_relation(self, before, after):
        async def filing_id(doc):
            if doc.get("filingId"):
                return doc["filingId"]
            if doc.get("reportId"):
                report = await self.row("analysis_reports", doc["reportId"])
                if report and report["source"] == "OPENDART":
                    row = await self.ctx.db.fetch_one(
                        "SELECT id FROM filings WHERE rcept_no=:receipt",
                        {"receipt": report["filingId"]},
                    )
                    return row["id"] if row else None
            return None

        old, new = await filing_id(before), await filing_id(after)
        if not old or not new:
            return False
        relation = await self.ctx.db.fetch_one(
            "SELECT id FROM filing_relations WHERE from_filing_id=:new AND to_filing_id=:old AND relation_type IN ('CORRECTS','SUPERSEDES') AND (review_decision='CONFIRMED' OR (source='EXPLICIT' AND review_required=0 AND review_decision<>'REJECTED'))",
            {"new": new, "old": old},
        )
        return bool(relation)

    async def diff(self, diff_id, payload):
        if not getattr(self.ctx.config, "analysisDocumentsEnabled", False):
            raise AnalysisDenied("Document analysis disabled")
        run = await self.artifact_run(payload)
        diff = await self.row("analysis_diffs", diff_id)
        if not diff:
            raise ValueError("Difference missing")
        before = await self.row("analysis_documents", diff["beforeDocumentId"])
        after = await self.row("analysis_documents", diff["afterDocumentId"])
        _, before_company, _, _ = await self.document_source(before, run)
        _, after_company, _, _ = await self.document_source(after, run)
        if before_company != after_company:
            raise AnalysisDenied("Difference companies do not match")
        if before["status"] not in ("COMPLETE", "PARTIAL") or after["status"] not in (
            "COMPLETE",
            "PARTIAL",
        ):
            raise AnalysisWaiting("비교할 원문 처리를 기다립니다.")
        review = diff.get("reviewJson") or {}
        reviewed = (
            review.get("status") == "CONFIRMED"
            and bool(re.fullmatch(r"ADMIN:[0-9a-fA-F-]{36}", str(review.get("reviewedBy", ""))))
            and bool(review.get("reviewedAt"))
            and isinstance(review.get("sourceUrl"), str)
            and review["sourceUrl"].startswith("https://")
            and isinstance(review.get("note"), str)
            and bool(review["note"].strip())
        )
        confirmed = bool(reviewed or await self.confirmed_relation(before, after))

        async def document_notes(identity):
            rows = await self.ctx.db.fetch_all(
                "SELECT note_key,title,body,table_ids_json FROM analysis_notes WHERE document_id=:id ORDER BY note_key",
                {"id": identity},
            )
            return [
                {
                    "key": row["note_key"],
                    "title": row["title"],
                    "text": row["body"],
                    "tableIds": decode_json(row["table_ids_json"], []),
                }
                for row in rows
            ]

        result = diff_document_tables(
            {"tables": before["tablesJson"] or [], "notes": await document_notes(before["id"])},
            {"tables": after["tablesJson"] or [], "notes": await document_notes(after["id"])},
            confirmed=confirmed,
        )
        await self.patch(
            "analysis_diffs",
            diff_id,
            {
                "status": result["status"],
                "confirmed": confirmed,
                "resultJson": result,
                "errorMessage": None,
            },
        )
        if confirmed and result["differences"]:
            # Old anchors retain their immutable source. A new version requires
            # explicit relinking instead of moving someone's bookmark silently.
            await self.ctx.db.execute(
                "UPDATE analysis_bookmarks SET needs_relink=1 WHERE document_id=:id",
                {"id": before["id"]},
            )
        await self.attach(run["id"], "diffIds", diff_id)
        return {"status": result["status"]}

    async def export(self, export_id, payload):
        export = await self.row("analysis_exports", export_id)
        if not export:
            raise ValueError("Export missing")
        run = await self.artifact_run(
            {"runId": export["runId"], "ownerKey": export["ownerKey"]}, acquire=False
        )
        if export["status"] == "COMPLETE":
            return {"status": "COMPLETE"}
        snapshot = export["selectionJson"]
        result, request = snapshot.get("runSnapshot"), snapshot.get("request", {})
        if not isinstance(result, dict):
            raise TypeError("Frozen export snapshot missing")
        if (
            len(request.get("documentIds", [])) > 20
            or len(request.get("diffIds", [])) > 20
            or len(request.get("tableIds", [])) > 100
        ):
            raise ValueError("Export selection exceeds limits")
        facts = result.get("facts", [])
        sheets = {
            "조회 조건": [
                ["실행", run["id"]],
                ["조건", json_text(run["selectionJson"])],
                ["대응 버전", result.get("mappingVersion")],
            ],
            "재무 비교": [
                [
                    "기업",
                    "지표",
                    "시작",
                    "종료",
                    "기준",
                    "연결·별도",
                    "통화",
                    "단위",
                    "값(정확한 문자열)",
                    "상태",
                    "접수번호",
                    "출처",
                    "관찰 시각",
                    "원본 SHA256",
                    "계정",
                    "행",
                    "필드",
                ]
            ],
            "누락·확인": [["기업", "기간", "상태", "설명"]],
            "출처": [["종류", "ID", "URL", "SHA256", "처리 버전"]],
        }
        sheets["조회 조건"].append(["내보내기 생성 시각(UTC)", str(export.get("createdAt", ""))])
        sheets["원문값"] = [
            [
                "수치 ID",
                "기업",
                "계정",
                "원문값",
                "정규화 값",
                "통화",
                "단위",
                "배율",
                "관찰 시각",
                "출처",
                "원본 SHA256",
            ]
        ]
        verified_reports = set()
        for fact in facts:
            ev = fact["evidence"]
            if ev["rightsMode"] != OFFICIAL or fact["companyId"] not in run["companyIdsJson"]:
                raise AnalysisDenied("Export evidence rights mismatch")
            report = await self.row("analysis_reports", fact["reportId"])
            if (
                not report
                or report["rightsMode"] != OFFICIAL
                or report["rawSha256"] != ev["rawSha256"]
            ):
                raise AnalysisDenied("Export report changed")
            if report["id"] not in verified_reports:
                await asyncio.to_thread(
                    read_object,
                    self.ctx.config.rawDocumentDir,
                    report["rawUri"],
                    report["rawSha256"],
                )
                verified_reports.add(report["id"])
                sheets["출처"].append(
                    [
                        "재무 제출본",
                        report["id"],
                        report["sourceUrl"],
                        report["rawSha256"],
                        report["normalizerVersion"],
                    ]
                )
            sheets["재무 비교"].append(
                [
                    fact.get("companyName", fact["companyId"]),
                    fact["metric"],
                    fact["periodStart"],
                    fact["periodEnd"],
                    fact["basis"],
                    fact["scope"],
                    fact["currency"],
                    fact["unit"],
                    fact["value"],
                    fact["status"],
                    ev["filingId"],
                    ev["sourceUrl"],
                    ev["observedAt"],
                    ev["rawSha256"],
                    fact["accountId"],
                    ev.get("row"),
                    ev.get("sourceField"),
                ]
            )
            sheets["원문값"].append(
                [
                    fact["id"],
                    fact["companyId"],
                    fact["accountId"],
                    fact.get("rawValue"),
                    fact["value"],
                    fact["currency"],
                    fact["unit"],
                    fact.get("scale"),
                    ev["observedAt"],
                    ev["sourceUrl"],
                    ev["rawSha256"],
                ]
            )
        for issue in result.get("issues", []):
            sheets["누락·확인"].append(
                [
                    issue["companyId"],
                    json_text(issue.get("period")),
                    issue["code"],
                    issue["message"],
                ]
            )
        if request.get("includeValidation", True):
            sheets["검증"] = [["규칙", "결과", "설명", "수식", "수치", "허용 오차", "버전"]] + [
                [
                    v["rule"],
                    v["status"],
                    v["message"],
                    v["formula"],
                    json_text(v["values"]),
                    v["tolerance"],
                    v["ruleVersion"],
                ]
                for v in result.get("validations", [])
            ]
        table_filter = set(request.get("tableIds", []))
        found_tables = set()
        for document_id in request.get("documentIds", []):
            if document_id not in result.get("documentIds", []):
                raise AnalysisDenied("Export document outside frozen selection")
            document = await self.row("analysis_documents", document_id)
            await self.document_source(document, run)
            if document["status"] not in ("COMPLETE", "PARTIAL"):
                raise AnalysisWaiting("내보낼 문서 처리를 기다립니다.")
            await asyncio.to_thread(
                read_object,
                self.ctx.config.rawDocumentDir,
                document["rawUri"],
                document["rawSha256"],
            )
            sheets["출처"].append(
                [
                    "문서",
                    document_id,
                    document["sourceUrl"],
                    document["rawSha256"],
                    document["parserVersion"],
                ]
            )
            for table in document.get("tablesJson") or []:
                if table_filter and table["id"] not in table_filter:
                    continue
                found_tables.add(table["id"])
                name = "표_" + str(len(found_tables))
                rows = [
                    ["문서", document_id],
                    ["표", table["id"]],
                    ["제목", table["title"]],
                    ["출처", document["sourceUrl"]],
                    ["행", "열", "내용", "행 병합", "열 병합", "수치"],
                ]
                rows.extend(
                    [
                        [
                            c["row"],
                            c["column"],
                            c["text"],
                            c.get("rowSpan", 1),
                            c.get("colSpan", 1),
                            c.get("value"),
                        ]
                        for c in table["cells"]
                    ]
                )
                sheets[name] = rows
            if request.get("includeNotes"):
                if not getattr(self.ctx.config, "analysisNotesEnabled", False):
                    raise AnalysisDenied("Notes disabled")
                note_rows = await self.ctx.db.fetch_all(
                    "SELECT note_key,title,body,table_ids_json,source_url FROM analysis_notes WHERE document_id=:id ORDER BY note_key",
                    {"id": document_id},
                )
                sheets.setdefault("주석", [["문서", "키", "제목", "내용", "표", "출처"]]).extend(
                    [
                        [
                            document_id,
                            row["note_key"],
                            row["title"],
                            row["body"],
                            json_text(decode_json(row["table_ids_json"], [])),
                            row["source_url"],
                        ]
                        for row in note_rows
                    ]
                )
            if request.get("includeOwnership") and document.get("ownershipJson"):
                own = document["ownershipJson"]
                sheets.setdefault("SEC 소유", [["문서", "양식", "구분", "원본 필드"]])
                for key in ("issuer", "reportingOwners", "transactions", "holdings", "footnotes"):
                    value = own.get(key)
                    for item in value if isinstance(value, list) else [value]:
                        sheets["SEC 소유"].append([document_id, own["form"], key, json_text(item)])
        if table_filter - found_tables:
            raise ValueError("Selected export table missing")
        if request.get("diffIds"):
            sheets["정정 비교"] = [
                [
                    "비교",
                    "종류",
                    "항목",
                    "이전",
                    "이후",
                    "차이",
                    "%",
                    "이전 표",
                    "이후 표",
                    "이전 주석",
                    "이후 주석",
                    "행",
                    "열",
                ]
            ]
            sheets["정정 관계 근거"] = [
                ["비교", "확정 방식", "검토자", "검토 시각", "출처", "설명"]
            ]
        for diff_id in request.get("diffIds", []):
            if diff_id not in result.get("diffIds", []):
                raise AnalysisDenied("Export difference outside frozen selection")
            diff = await self.row("analysis_diffs", diff_id)
            if diff["status"] not in ("COMPLETE", "PARTIAL") or not diff["confirmed"]:
                raise AnalysisWaiting("확정된 정정 비교 결과를 기다립니다.")
            for document_id in (diff["beforeDocumentId"], diff["afterDocumentId"]):
                document = await self.row("analysis_documents", document_id)
                await self.document_source(document, run)
                await asyncio.to_thread(
                    read_object,
                    self.ctx.config.rawDocumentDir,
                    document["rawUri"],
                    document["rawSha256"],
                )
            review = diff.get("reviewJson") or {}
            sheets["정정 관계 근거"].append(
                [
                    diff_id,
                    "관리자 명시 검토" if review.get("status") == "CONFIRMED" else "공식 공시 관계",
                    review.get("reviewedBy"),
                    review.get("reviewedAt"),
                    review.get("sourceUrl"),
                    review.get("note"),
                ]
            )
            for change in (diff.get("resultJson") or {}).get("differences", []):
                sheets["정정 비교"].append(
                    [
                        diff_id,
                        change["kind"],
                        change["label"],
                        change["before"],
                        change["after"],
                        change.get("difference"),
                        change.get("percent"),
                        change.get("beforeTableId"),
                        change.get("afterTableId"),
                        change.get("beforeNoteKey"),
                        change.get("afterNoteKey"),
                        change.get("row"),
                        change.get("column"),
                    ]
                )
        content = await asyncio.to_thread(build_xlsx, sheets)
        raw = await self.ctx.services["raw_documents"].put(content, extension="xlsx")
        await self.patch(
            "analysis_exports",
            export_id,
            {
                "status": "COMPLETE",
                "objectUri": raw["objectUri"],
                "sha256": raw["sha256"],
                "errorMessage": None,
            },
        )
        return {"status": "COMPLETE"}
