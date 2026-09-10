"""SEC ownership observations: source numeric strings and footnotes stay authoritative."""

from __future__ import annotations

import re
import time
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from xml.etree import ElementTree

from ..core import as_instant, sha256, utcnow
from .storage import insert, one, save, select
from .xml_archive import assert_safe_xml, lexical_complexity, literal_entity_copy

MAX_BYTES = 2 * 1024**2
KINDS = {
    "P": "OPEN_MARKET_OR_PRIVATE_PURCHASE",
    "S": "OPEN_MARKET_OR_PRIVATE_SALE",
    "A": "AWARD",
    "M": "OPTION_EXERCISE",
    "F": "TAX_OR_EXERCISE_PAYMENT",
    "G": "GIFT",
    "J": "OTHER",
    "C": "CONVERSION",
    "D": "DISPOSITION_TO_ISSUER",
}


def xml_object(node) -> dict | str:
    if not list(node) and not node.attrib:
        return node.text or ""
    result = {"@_" + key: value for key, value in node.attrib.items()}
    for child in node:
        item = xml_object(child)
        if child.tag in result:
            if not isinstance(result[child.tag], list):
                result[child.tag] = [result[child.tag]]
            result[child.tag].append(item)
        else:
            result[child.tag] = item
    text = (node.text or "") + "".join(child.tail or "" for child in node)
    if text:
        result["#text"] = text
    return result


def object_value(value):
    return value if isinstance(value, dict) else {}


def array(value):
    return value if isinstance(value, list) else [] if value is None else [value]


def text(value):
    if isinstance(value, str):
        return value or None
    row = object_value(value)
    return next(
        (row[key] for key in ("value", "#text") if isinstance(row.get(key), str) and row[key]), None
    )


def field(value, key):
    return text(object_value(value).get(key))


def flag(value):
    return True if value in ("1", "true") else False if value in ("0", "false") else None


def footnote_ids(value) -> list:
    if isinstance(value, list):
        return list(dict.fromkeys(key for item in value for key in footnote_ids(item)))
    result = []
    for key, child in object_value(value).items():
        result.extend(
            [item for v in array(child) if (item := field(v, "@_id"))]
            if key == "footnoteId"
            else footnote_ids(child)
        )
    return list(dict.fromkeys(result))


def parse_ownership(xml: str, provenance: dict) -> dict:
    started = time.monotonic()
    if len(xml.encode()) > MAX_BYTES:
        raise ValueError("SEC ownership XML size limit")
    assert_safe_xml(xml, "SEC ownership")
    lexical_complexity(xml, max_depth=32, max_nodes=30000)
    protected_xml, literal_entities, marker = literal_entity_copy(xml)
    try:
        root = ElementTree.fromstring(protected_xml)
    except ElementTree.ParseError:
        raise ValueError("Malformed SEC ownership XML") from None
    if marker:
        pattern = re.compile(re.escape(marker) + r"[0-9a-f]+" + re.escape(marker))
        for node in root.iter():
            if node.text:
                node.text = pattern.sub(lambda match: literal_entities[match[0]], node.text)
            if node.tail:
                node.tail = pattern.sub(lambda match: literal_entities[match[0]], node.tail)
            for key, value in node.attrib.items():
                node.attrib[key] = pattern.sub(lambda match: literal_entities[match[0]], value)
    doc = object_value(xml_object(root)) if root.tag == "ownershipDocument" else {}
    document_type = (field(doc, "documentType") or "").strip()
    if not re.fullmatch(r"[345](?:/A)?", document_type):
        raise ValueError("Unsupported SEC ownership document type")
    issuer = object_value(doc.get("issuer"))
    cik = (field(issuer, "issuerCik") or "").strip().zfill(10)
    if cik != provenance["expectedCik"] or not re.fullmatch(r"\d{10}", cik) or cik == "0000000000":
        raise ValueError("SEC ownership issuer mismatch")
    if not re.fullmatch(r"\d{10}-\d{2}-\d{6}", provenance["accessionNumber"]):
        raise ValueError("Invalid ownership accession")
    transactions: list[dict[str, Any]] = []
    holdings: list[dict[str, Any]] = []
    for table_name, prefix, derivative in (
        ("nonDerivativeTable", "nonDerivative", False),
        ("derivativeTable", "derivative", True),
    ):
        table = object_value(doc.get(table_name))
        for value in array(table.get(prefix + "Transaction")):
            row = object_value(value)
            amounts = object_value(row.get("transactionAmounts"))
            code = field(row.get("transactionCoding"), "transactionCode")
            transactions.append(
                {
                    "rowIndex": len(transactions),
                    "derivative": derivative,
                    "securityTitle": field(row, "securityTitle"),
                    "transactionDate": field(row, "transactionDate"),
                    "transactionCode": code,
                    "acquiredDisposedCode": field(amounts, "transactionAcquiredDisposedCode"),
                    "transactionShares": field(amounts, "transactionShares"),
                    "transactionPrice": field(amounts, "transactionPricePerShare"),
                    "sharesOwnedAfter": field(
                        row.get("postTransactionAmounts"), "sharesOwnedFollowingTransaction"
                    ),
                    "directIndirectOwnership": field(
                        row.get("ownershipNature"), "directOrIndirectOwnership"
                    ),
                    "derivedTransactionKind": KINDS.get(code, "UNKNOWN"),
                    "footnoteReferences": footnote_ids(row),
                    "rawFields": row,
                }
            )
        for value in array(table.get(prefix + "Holding")):
            holdings.append(
                {
                    "derivative": derivative,
                    "rawFields": object_value(value),
                    "footnoteReferences": footnote_ids(value),
                }
            )
    owners = []
    for value in array(doc.get("reportingOwner")):
        row = object_value(value)
        relationship = object_value(row.get("reportingOwnerRelationship"))
        owners.append(
            {
                "cik": field(row.get("reportingOwnerId"), "rptOwnerCik"),
                "name": field(row.get("reportingOwnerId"), "rptOwnerName"),
                **{
                    name: flag(field(relationship, name))
                    for name in ("isDirector", "isOfficer", "isTenPercentOwner", "isOther")
                },
                "officerTitle": field(relationship, "officerTitle"),
                "rawFields": row,
            }
        )
    footnotes = [
        {"id": field(value, "@_id"), "text": text(value)}
        for value in array(object_value(doc.get("footnotes")).get("footnote"))
    ]
    ids = {note["id"] for note in footnotes}
    if time.monotonic() - started > 1:
        raise ValueError("SEC ownership parse time budget exceeded")
    return {
        "parserVersion": "sec-ownership-v1",
        "rawSha256": sha256(xml),
        "provenance": provenance,
        "documentType": document_type,
        "amendment": document_type.endswith("/A"),
        "reportPeriod": field(doc, "periodOfReport"),
        "issuer": {
            "cik": cik,
            "name": field(issuer, "issuerName"),
            "ticker": field(issuer, "issuerTradingSymbol"),
        },
        "reportingOwners": owners,
        "transactions": transactions,
        "holdings": holdings,
        "footnotes": footnotes,
        "unresolvedFootnoteReferences": [note for note in footnote_ids(doc) if note not in ids],
    }


def ownership_url(source: dict) -> str:
    cik = str((source.get("rawMetadataJson") or {}).get("cik", ""))
    accession = source.get("externalId") or ""
    if not re.fullmatch(r"\d{10}", cik) or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession):
        raise ValueError("Invalid SEC ownership identifiers")
    raw = source["url"]
    if re.search(r"[\\%]", raw):
        raise ValueError("Encoded or backslash SEC ownership URL")
    url = urlsplit(raw)
    prefix = f"/Archives/edgar/data/{cik.lstrip('0')}/{accession.replace('-', '')}/"
    if (
        url.scheme != "https"
        or url.hostname != "www.sec.gov"
        or url.port
        or url.username
        or url.password
        or url.query
        or url.fragment
        or not url.path.startswith(prefix)
    ):
        raise ValueError("Unsafe SEC ownership URL")
    path = re.sub(r"^xslF345X\d+/", "", url.path[len(prefix) :])
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.xml", path, re.IGNORECASE):
        raise ValueError("SEC primary document is not a safe ownership XML")
    return urlunsplit(("https", "www.sec.gov", prefix + path, "", ""))


UNFINISHED = "source='SEC' AND JSON_UNQUOTE(JSON_EXTRACT(raw_metadata_json,'$.form')) IN ('3','4','5','3/A','4/A','5/A') AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_metadata_json,'$.ownershipStatus')),'') <> 'COMPLETED'"


class SecOwnershipService:
    def __init__(self, ctx):
        self.ctx = ctx

    async def ingest_pending(self, limit: int = 3) -> dict:
        if not 1 <= limit <= 100:
            raise ValueError("Invalid ownership batch limit")
        now = utcnow().isoformat(timespec="milliseconds").replace("+00:00", "Z")
        pending = await select(
            self.ctx.db,
            "source_items",
            UNFINISHED
            + " AND (JSON_EXTRACT(raw_metadata_json,'$.ownershipRetryAt') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(raw_metadata_json,'$.ownershipRetryAt')) <= :now)",
            {"now": now},
            f"ORDER BY first_observed_at ASC LIMIT {limit}",
        )
        completed = failed = attempted = skipped = unknown_attempts = 0
        http_status = None
        for source in pending:
            request_attempted: bool | None = False
            http_status = None
            try:
                url = ownership_url(source)
                attempted += 1
                request_attempted = True
                response = await self.ctx.services["sec_http"].request(
                    url,
                    headers={
                        "User-Agent": self.ctx.config.secUserAgent,
                        "Accept": "application/xml,text/xml",
                    },
                    timeout_ms=self.ctx.config.httpTimeoutMs,
                    max_bytes=MAX_BYTES,
                )
                http_status = response.status_code
                if not response.is_success:
                    raise ValueError(f"SEC ownership HTTP {http_status}")
                content = response.content
                if len(content) > MAX_BYTES:
                    raise ValueError("SEC ownership response size limit")
                metadata = source.get("rawMetadataJson") or {}
                ownership = parse_ownership(
                    content.decode("utf-8-sig", errors="strict"),
                    {
                        "accessionNumber": source["externalId"],
                        "expectedCik": str(metadata["cik"]),
                        "filingDate": metadata.get("filingDate")
                        if isinstance(metadata.get("filingDate"), str)
                        else None,
                        "acceptanceDateTime": metadata.get("acceptanceDateTime")
                        if isinstance(metadata.get("acceptanceDateTime"), str)
                        else None,
                        "sourceUrl": url,
                    },
                )
                ownership["rawSha256"] = sha256(content)
                if ownership["documentType"] != str(metadata.get("form")):
                    raise ValueError("SEC ownership form mismatch")
                async with self.ctx.db.transaction() as tx:
                    current = await one(
                        tx, "source_items", "id=:id", {"id": source["id"]}, lock=True
                    )
                    if current is None:
                        raise ValueError("SEC receipt missing")
                    if (current.get("rawMetadataJson") or {}).get("ownershipStatus") == "COMPLETED":
                        continue
                    current["rawMetadataJson"] = {
                        **(current.get("rawMetadataJson") or {}),
                        "secOwnership": ownership,
                        "ownershipStatus": "COMPLETED",
                        "ownershipRetryAt": None,
                        "ownershipProcessedAt": utcnow()
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z"),
                        "ownershipError": None,
                        "ownershipHttpStatus": http_status,
                        "ownershipRequestAttempted": True,
                    }
                    await save(tx, "source_items", current)
                    companies = await select(
                        tx,
                        "companies",
                        "cik=:cik OR cik=:short",
                        {
                            "cik": ownership["issuer"]["cik"],
                            "short": ownership["issuer"]["cik"].lstrip("0"),
                        },
                    )
                    key = "SEC_OWNERSHIP:" + ownership["provenance"]["accessionNumber"]
                    await insert(
                        tx,
                        "event_clusters",
                        {
                            "dedupeKey": key,
                            "canonicalEventType": "OTHER",
                            "companyId": companies[0]["id"] if len(companies) == 1 else None,
                            "occurredAt": None,
                            "publishedAt": source.get("publishedAt"),
                            "firstObservedAt": source["firstObservedAt"],
                            "processedAt": utcnow(),
                            "state": "OPEN",
                            "evidenceGrade": "A",
                            "summary": f"SEC Form {ownership['documentType']} 내부자 지분 관측 · 거래 {len(ownership['transactions'])}건",
                            "metadataJson": {
                                "source": "SEC",
                                "observationKind": "SEC_INSIDER_TRANSACTION",
                                "sourceItemId": source["id"],
                                "accessionNumber": source["externalId"],
                                "relatedCompanyIds": [company["id"] for company in companies],
                                "ownership": ownership,
                            },
                        },
                        ignore=True,
                    )
                    event = await one(tx, "event_clusters", "dedupe_key=:key", {"key": key})
                    if not event:
                        raise ValueError("SEC ownership event persistence failed")
                    await insert(
                        tx,
                        "event_cluster_items",
                        {
                            "eventClusterId": event["id"],
                            "itemType": "SOURCE_ITEM",
                            "itemId": source["id"],
                            "isPrimary": True,
                            "provenanceJson": {
                                "source": "SEC",
                                "sourceUrl": url,
                                "rawSha256": ownership["rawSha256"],
                            },
                        },
                        ignore=True,
                    )
                completed += 1
            except Exception as error:  # noqa: BLE001 - persist per-document failure and continue batch
                failed += 1
                access_waiting = type(error).__name__ == "SecAccessCooldownError"
                if access_waiting and not getattr(error, "requestAttempted", True):
                    attempted -= 1
                    skipped += 1
                    request_attempted = False
                if type(error).__name__ == "SecAccessPolicyError":
                    attempted -= 1
                    unknown_attempts += 1
                    request_attempted = None
                if access_waiting:
                    http_status = getattr(error, "providerStatus", None)
                retry_at = utcnow() + timedelta(hours=1)
                provider_retry_at = getattr(error, "retryAt", None)
                if access_waiting and provider_retry_at:
                    retry_at = max(retry_at, as_instant(provider_retry_at))
                async with self.ctx.db.transaction() as tx:
                    current = await one(
                        tx, "source_items", "id=:id", {"id": source["id"]}, lock=True
                    )
                    if (
                        current
                        and (current.get("rawMetadataJson") or {}).get("ownershipStatus")
                        != "COMPLETED"
                    ):
                        current["rawMetadataJson"] = {
                            **(current.get("rawMetadataJson") or {}),
                            "ownershipStatus": "WAITING" if access_waiting else "FAILED",
                            "ownershipRetryAt": retry_at.isoformat(timespec="milliseconds").replace(
                                "+00:00", "Z"
                            ),
                            "ownershipError": "XML_FETCH_OR_VALIDATION_FAILED",
                            "ownershipHttpStatus": http_status,
                            "ownershipRequestAttempted": request_attempted,
                        }
                        await save(tx, "source_items", current)
                break
        remaining = int(
            (
                await self.ctx.db.fetch_one(
                    f"SELECT COUNT(*) AS n FROM source_items WHERE {UNFINISHED}"
                )
            )["n"]
        )
        waiting = int(
            (
                await self.ctx.db.fetch_one(
                    f"SELECT COUNT(*) AS n FROM source_items WHERE {UNFINISHED} AND JSON_UNQUOTE(JSON_EXTRACT(raw_metadata_json,'$.ownershipRetryAt')) > :now",
                    {"now": utcnow().isoformat(timespec="milliseconds").replace("+00:00", "Z")},
                )
            )["n"]
        )
        return {
            "ownershipAttempted": attempted,
            "ownershipCompleted": completed,
            "ownershipFailed": failed,
            "ownershipSkipped": skipped,
            "ownershipUnknownAttempts": unknown_attempts,
            "ownershipHttpStatus": http_status,
            "ownershipPending": remaining,
            "ownershipWaiting": waiting,
            "ownershipIncomplete": remaining > 0,
            "ownershipStatus": ("COMPLETED" if completed else "NO_PENDING")
            if remaining == 0
            else "RETRY_WAITING"
            if remaining == waiting
            else "PENDING",
        }
