"""Native bounded OpenDART client; credentials stay outside errors and logs."""

from __future__ import annotations

import asyncio
import json
import math
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any
from xml.parsers import expat
from zoneinfo import ZoneInfo

from ..core import as_instant, decode_json, utcnow
from .primitives import OpenDartApiError, OpenDartPayloadError, date_only
from .xml_archive import has_zip_magic, lexical_complexity, literal_entity_copy, read_archive

KST = ZoneInfo("Asia/Seoul")


def kst_date() -> str:
    return utcnow().astimezone(KST).date().isoformat()


def add_days(value: str, days: int) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Invalid date-only value.")
    if type(days) is not int:
        raise TypeError("Days must be an integer.")
    return (date.fromisoformat(value) + timedelta(days=days)).isoformat()


def next_midnight() -> datetime:
    now = utcnow().astimezone(KST)
    return datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), KST).astimezone(
        UTC
    )


class ConnectorDisabledError(RuntimeError):
    connector = "OPENDART"


class OpenDartHttpError(RuntimeError):
    def __init__(self, endpoint: str, status: int):
        super().__init__(f"OpenDART HTTP {status} at {endpoint}")
        self.endpoint, self.httpStatus = endpoint, status


def viewer_url(receipt: str) -> str:
    if not re.fullmatch(r"\d{14}", receipt):
        raise ValueError("Invalid OpenDART receipt number.")
    return f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={receipt}"


class OpenDartClient:
    def __init__(self, ctx):
        self.ctx = ctx
        self.rate_limited_until = None

    @property
    def enabled(self) -> bool:
        return bool(self.ctx.config.openDartApiKey)

    def configured_key(self) -> str:
        if not self.enabled:
            raise ConnectorDisabledError("OPENDART_API_KEY가 없어 커넥터가 비활성화되었습니다.")
        if self.rate_limited_until and self.rate_limited_until > utcnow():
            raise OpenDartApiError(
                "020", f"요청 제한으로 {self.rate_limited_until.isoformat()}까지 중단됨"
            )
        return self.ctx.config.openDartApiKey

    async def fetch(self, endpoint: str, params: dict, max_bytes: int) -> bytes:
        key = self.configured_key()
        gate = getattr(self.ctx, "services", {}).get("analysis_dart_gate")
        if gate is not None:
            await gate.before_request()
        params = {"crtfc_key": key, **params}
        try:
            async with self.ctx.http.stream(
                "GET",
                f"https://opendart.fss.or.kr/api/{endpoint}",
                params=params,
                headers={"Accept": "application/json, application/zip, application/xml"},
                timeout=self.ctx.config.httpTimeoutMs / 1000,
            ) as response:
                if not 200 <= response.status_code < 300:
                    raise OpenDartHttpError(endpoint, response.status_code)
                chunks, total = [], 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise OpenDartPayloadError(
                            "OpenDART response is too large.", "RESPONSE_TOO_LARGE"
                        )
                    chunks.append(chunk)
                return b"".join(chunks)
        except (OpenDartHttpError, OpenDartPayloadError):
            raise
        except Exception:  # noqa: BLE001 - redact URLs containing provider credentials
            raise OpenDartHttpError(endpoint, 0) from None

    async def request_json(self, endpoint: str, params: dict) -> dict:
        try:
            value = json.loads(
                (await self.fetch(endpoint, params, 10 * 1024**2)).decode("utf-8", errors="strict")
            )
        except (ValueError, UnicodeError):
            raise OpenDartPayloadError("Invalid OpenDART JSON response.", "INVALID_JSON") from None
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("status"), str)
            or not isinstance(value.get("message"), str)
        ):
            raise OpenDartPayloadError("Invalid OpenDART response envelope.", "INVALID_ENVELOPE")
        return value

    def handle_envelope(self, raw: dict, operation: str) -> bool:
        status = raw["status"]
        if status == "013":
            return True
        if status == "000":
            return False
        if status == "020":
            self.rate_limited_until = next_midnight()
        message = (
            raw["message"].replace(self.ctx.config.openDartApiKey, "[REDACTED]")
            if self.ctx.config.openDartApiKey
            else raw["message"]
        )
        raise OpenDartApiError(status, message, operation)

    async def request_archive(self, endpoint: str, params: dict, operation: str) -> bytes:
        value = await self.fetch(endpoint, params, 50 * 1024**2)
        if not has_zip_magic(value):
            try:
                read_archive(value, operation=operation)
            except OpenDartApiError as error:
                if error.status == "020":
                    self.rate_limited_until = next_midnight()
                message = (
                    error.apiMessage.replace(self.ctx.config.openDartApiKey, "[REDACTED]")
                    if self.ctx.config.openDartApiKey
                    else error.apiMessage
                )
                raise OpenDartApiError(error.status, message, operation) from None
        return value

    async def list_disclosures(
        self, detail_type: str, start_date: str, end_date: str, page: int
    ) -> dict:
        add_days(start_date, 0)
        add_days(end_date, 0)
        raw = await self.request_json(
            "list.json",
            {
                "bgn_de": start_date.replace("-", ""),
                "end_de": end_date.replace("-", ""),
                "pblntf_detail_ty": detail_type,
                "last_reprt_at": "N",
                "sort": "date",
                "sort_mth": "desc",
                "page_no": str(page),
                "page_count": "100",
            },
        )
        if self.handle_envelope(raw, "LIST"):
            return {"items": [], "page": page, "totalPages": 0, "totalCount": 0}

        def pagination(field: str, default: int, minimum: int) -> int:
            value = raw.get(field, default)
            try:
                number = float(value if value is not None and value != "" else 0)
            except (TypeError, ValueError):
                raise ValueError("Invalid OpenDART pagination.") from None
            if not math.isfinite(number) or not number.is_integer() or number < minimum:
                raise ValueError("Invalid OpenDART pagination.")
            return int(number)

        if "page_count" in raw:
            pagination("page_count", 100, 1)
        source_items = raw.get("list", [])
        if not isinstance(source_items, list):
            raise TypeError("Invalid OpenDART list.")
        items = []
        for source in source_items:
            item = self.validate_item(source, "LIST")
            receipt_date = date_only(item["rcept_dt"])
            if not receipt_date:
                raise ValueError("Invalid OpenDART calendar date.")
            items.append({**item, "rcept_dt_raw": item["rcept_dt"], "rcept_dt": receipt_date})
        result: dict[str, Any] = {
            "items": items,
            "page": pagination("page_no", page, 1),
            "totalPages": pagination("total_page", 1, 0),
            "totalCount": pagination("total_count", len(items), 0),
        }
        if result["page"] < 1 or result["totalPages"] < 0 or result["totalCount"] < 0:
            raise ValueError("Invalid OpenDART pagination.")
        return result

    def validate_item(self, raw: dict, kind: str) -> dict:
        if not isinstance(raw, dict):
            raise TypeError("Invalid OpenDART item.")
        required = ["corp_code", "corp_name"] + (
            ["modify_date"] if kind == "CORP_CODE" else ["rcept_no", "rcept_dt"]
        )
        optional = (
            ["stock_code", "corp_eng_name"]
            if kind == "CORP_CODE"
            else ["stock_code", "corp_cls", "rm"]
            if kind == "LIST"
            else [
                "repror",
                "isu_exctv_rgist_at",
                "isu_exctv_ofcps",
                "isu_main_shrholdr",
                "sp_stock_lmp_cnt",
                "sp_stock_lmp_irds_cnt",
                "sp_stock_lmp_rate",
                "sp_stock_lmp_irds_rate",
            ]
            if kind == "D002"
            else [
                "report_tp",
                "repror",
                "stkqy",
                "stkqy_irds",
                "stkrt",
                "stkrt_irds",
                "ctr_stkqy",
                "ctr_stkrt",
                "report_resn",
            ]
        )
        if kind == "LIST":
            required.extend(["report_nm", "flr_nm"])
        if any(not isinstance(raw.get(field), str) for field in required):
            raise ValueError("Invalid OpenDART required field.")
        result = {field: raw[field] for field in required}
        for field in optional:
            value = raw.get(field, "")
            if value is None:
                value = ""
            if not isinstance(value, str):
                raise TypeError("Invalid OpenDART optional field.")
            result[field] = value
        patterns = {
            "corp_code": r"\d{8}",
            "rcept_no": r"\d{14}",
            "stock_code": r"(?:|[0-9A-Z]{6})",
            "modify_date": r"\d{8}",
        }
        if kind == "LIST":
            patterns["rcept_dt"] = r"\d{8}"
        if any(
            field in result and not re.fullmatch(pattern, result[field])
            for field, pattern in patterns.items()
        ):
            raise ValueError("Invalid OpenDART source identifier.")
        return result

    async def fetch_document(self, receipt: str) -> bytes:
        viewer_url(receipt)
        return await self.request_archive("document.xml", {"rcept_no": receipt}, "DOCUMENT")

    async def fetch_corp_codes(self) -> list:
        archive = read_archive(
            await self.request_archive("corpCode.xml", {}, "CORP_CODE"), operation="CORP_CODE"
        )
        items: list[dict[str, Any]] = []
        budget: dict[str, int] = {}
        for candidate in archive["xmlCandidates"]:
            lexical_complexity(candidate["xml"], budget, max_depth=64, max_nodes=2000000)
            await self.read_corp_candidate(candidate["xml"], items)
        return items

    async def read_corp_candidate(self, xml: str, items: list[dict[str, Any]]) -> None:
        """Retain one corporation at a time and let queue locks renew between chunks."""
        protected, literals, marker = literal_entity_copy(xml)
        pattern = (
            re.compile(re.escape(marker) + r"[0-9a-f]+" + re.escape(marker)) if marker else None
        )
        parser = expat.ParserCreate()
        stack: list[str] = []
        fields: dict[str, Any] | None = None
        field_text: list[str] = []
        list_depth = 0
        invalid_field = False

        def start(tag: str, attributes: dict) -> None:
            nonlocal fields, list_depth, field_text, invalid_field
            stack.append(tag)
            if tag == "list" and (len(stack) == 1 or len(stack) == 2 and stack[0] == "result"):
                fields, list_depth = {}, len(stack)
            elif fields is not None:
                if len(stack) == list_depth + 1:
                    field_text, invalid_field = [], bool(attributes)
                elif len(stack) > list_depth + 1:
                    invalid_field = True

        def end(tag: str) -> None:
            nonlocal fields
            if fields is not None:
                if len(stack) == list_depth + 1:
                    raw = "".join(field_text).strip()
                    if pattern:
                        raw = pattern.sub(lambda match: literals[match[0]], raw)
                    value: Any = {} if invalid_field else raw
                    fields[tag] = [fields[tag], value] if tag in fields else value
                elif len(stack) == list_depth:
                    if len(items) >= 250000:
                        raise OpenDartPayloadError(
                            "OpenDART corpCode 항목이 안전 한도를 초과했습니다.",
                            "CORP_CODE_ITEM_LIMIT",
                        )
                    items.append(self.validate_item(fields, "CORP_CODE"))
                    fields = None
            stack.pop()

        def raw(value: str) -> None:
            if fields is not None and len(stack) == list_depth + 1:
                field_text.append(value)

        parser.StartElementHandler, parser.EndElementHandler = start, end
        parser.DefaultHandler = raw
        parser.StartCdataSectionHandler = lambda: None
        parser.EndCdataSectionHandler = lambda: None
        parser.CommentHandler = lambda _: None
        parser.XmlDeclHandler = lambda *_: None
        try:
            for offset in range(0, len(protected), 65536):
                parser.Parse(protected[offset : offset + 65536], False)
                await asyncio.sleep(0)
            parser.Parse("", True)
        except expat.ExpatError:
            raise OpenDartPayloadError("Invalid OpenDART corpCode XML.", "INVALID_XML") from None

    async def request_summary(self, endpoint: str, corp_code: str, kind: str) -> list:
        if not re.fullmatch(r"\d{8}", corp_code):
            raise ValueError("Invalid OpenDART corporation code.")
        raw = await self.request_json(endpoint, {"corp_code": corp_code})
        return (
            []
            if self.handle_envelope(raw, "SUMMARY")
            else [self.validate_item(row, kind) for row in raw.get("list", [])]
        )

    async def fetch_ele_stock(self, corp_code: str) -> list:
        return await self.request_summary("elestock.json", corp_code, "D002")

    async def fetch_major_stock(self, corp_code: str) -> list:
        return await self.request_summary("majorstock.json", corp_code, "D001")

    async def company_information(self, corp_code: str, year: int, report_code: str) -> dict:
        if (
            not re.fullmatch(r"\d{8}", corp_code)
            or type(year) is not int
            or year < 2015
            or report_code not in ("11011", "11012", "11013", "11014")
        ):
            raise ValueError("Invalid company report request.")

        async def read(endpoint, params):
            raw = await self.request_json(endpoint, params)
            return None if self.handle_envelope(raw, "SUMMARY") else raw

        params = {"corp_code": corp_code, "bsns_year": str(year), "reprt_code": report_code}
        profile = await read("company.json", {"corp_code": corp_code})
        financials, statement = (
            await read("fnlttSinglAcntAll.json", {**params, "fs_div": "CFS"}),
            "CFS",
        )
        if not financials:
            financials, statement = (
                await read("fnlttSinglAcntAll.json", {**params, "fs_div": "OFS"}),
                "OFS",
            )
        return {
            "profile": profile,
            "financials": financials,
            "dividends": await read("alotMatter.json", params),
            "shares": await read("stockTotqySttus.json", params),
            "statement": statement,
        }

    async def paused_until(self) -> datetime | None:
        row = await self.ctx.db.fetch_one(
            "SELECT metadata_json FROM source_checkpoints WHERE connector='OPENDART' AND stream='GLOBAL_RATE_LIMIT'"
        )
        value = decode_json(row["metadata_json"], {}).get("pausedUntil") if row else None
        try:
            until = as_instant(value) if value else None
        except (ValueError, TypeError):
            return None
        return until if until and until > utcnow() else None
