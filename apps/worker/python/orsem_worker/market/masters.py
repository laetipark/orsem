"""Security-master identity reconciliation: identities outrank reusable tickers."""

import json
import re
import unicodedata
from collections import defaultdict
from itertools import islice
from typing import Any
from urllib.parse import urlencode, urljoin, urlsplit

from orsem_worker.core import identifier, json_text, sha256, utcnow
from orsem_worker.storage import column

from .common import (
    OFFICIAL,
    PRIVATE,
    US_MARKETS,
    camel,
    checkpoint,
    day,
    http_request,
    in_params,
    insert,
    insert_many,
    instant,
    iso,
    named_lock,
    obj,
    read_checkpoint,
    update,
)
from .toss import display_name

ETF_MARKETS = ("KOSPI", "KOSDAQ", "KR_ETC")
ETF_ENDPOINT = "https://openapi.tossinvest.com/api/v1/stocks/all"
SEC_MASTER = "https://www.sec.gov/files/company_tickers_exchange.json"
DATABASE_CHUNK_SIZE = 500
ASSET_UPSERT_CHUNK_SIZE = 250


def _batches(values, size):
    iterator = iter(values)
    while batch := list(islice(iterator, size)):
        yield batch


async def _alpaca_select(tx, table, field, values, *, condition="", fields="*"):
    rows: list[dict[str, Any]] = []
    for batch in _batches(sorted(set(values)), DATABASE_CHUNK_SIZE):
        marks, params = in_params(batch)
        rows.extend(
            camel(row)
            for row in await tx.fetch_all(
                f"SELECT {fields} FROM `{table}` WHERE `{column(table, field)}` IN ({marks})"
                + condition,
                params,
            )
        )
    return rows


async def _alpaca_set_listed(tx, company_ids, listed):
    for batch in _batches(sorted(company_ids), DATABASE_CHUNK_SIZE):
        marks, params = in_params(batch)
        await tx.execute(
            f"UPDATE companies SET is_listed=:listed WHERE id IN ({marks})",
            {**params, "listed": listed},
        )


def etf_market(market):
    return "KRX" if market == "KR_ETC" else market


def validate_etf_universe(snapshots, previous=0):
    streams = set()
    symbols = set()
    isins = set()
    counts = {"active": 0, "delisted": 0}
    for snapshot in snapshots:
        stream = (snapshot["market"], snapshot["status"])
        if (
            snapshot["market"] not in ETF_MARKETS
            or snapshot["status"] not in ("ACTIVE", "DELISTED")
            or stream in streams
            or len(snapshot["rows"]) > 20000
        ):
            raise ValueError("ETF_MARKET_SNAPSHOT_INVALID")
        streams.add(stream)
        for stock in snapshot["rows"]:
            symbol = (snapshot["status"], stock.get("symbol"))
            if (
                stock.get("securityType") != "ETF"
                or not re.fullmatch(r"[0-9A-Z]{6}", stock.get("symbol", ""))
                or not re.fullmatch(r"KR[0-9A-Z]{9}[0-9]", stock.get("isinCode", ""))
                or not display_name(stock.get("name"))
                or symbol in symbols
                or stock["isinCode"] in isins
            ):
                raise ValueError("ETF_STOCK_IDENTITY_INVALID")
            symbols.add(symbol)
            isins.add(stock["isinCode"])
            counts[snapshot["status"].lower()] += 1
    if not counts["active"] or previous > 0 and counts["active"] < previous * 0.8:
        raise ValueError("ETF_ACTIVE_SNAPSHOT_SHRANK")
    return counts


def plan_etf_master(snapshots, companies, identities):
    by_symbol = defaultdict(list)
    for company in companies:
        if company.get("stockCode"):
            by_symbol[company["stockCode"]].append(company)
    identity_by_company = {r["companyId"]: r for r in identities}
    active = set()
    delisted = {}
    actions = []
    conflicts = missing = 0
    same_name = lambda a, b: (
        re.sub(r"\s", "", unicodedata.normalize("NFKC", a))
        == re.sub(r"\s", "", unicodedata.normalize("NFKC", b))
    )
    for snapshot in snapshots:
        for stock in snapshot["rows"]:
            key = (stock["symbol"], stock["isinCode"])
            if snapshot["status"] == "DELISTED":
                delisted[key] = (stock, snapshot["market"])
                continue
            active.add(key)
            candidates = by_symbol[stock["symbol"]]
            company = candidates[0] if candidates else None
            identity = identity_by_company.get(company["id"]) if company else None
            if (
                len(candidates) > 1
                or company
                and (
                    company.get("corpCode")
                    or company.get("cik")
                    or company.get("ticker")
                    or company["market"] not in (etf_market(snapshot["market"]), "KRX")
                    or identity
                    and (
                        identity["isinCode"] != stock["isinCode"]
                        or identity["symbol"] != stock["symbol"]
                        or identity["market"] != snapshot["market"]
                    )
                    or not identity
                    and not same_name(company["nameKo"], stock["name"])
                )
            ):
                conflicts += 1
                continue
            managed = not company or bool(identity and identity.get("managedCompany"))
            patch = (
                {"nameKo": display_name(stock["name"]), "isListed": True}
                if not company
                else {
                    "isListed": True,
                    **(
                        {"nameKo": display_name(stock["name"])}
                        if company["nameKo"] == (identity or {}).get("appliedNameKo")
                        else {}
                    ),
                }
                if managed
                else {}
            )
            actions.append(
                {
                    "kind": "CREATE" if not company else "REFRESH" if managed else "OBSERVE",
                    "stock": stock,
                    "market": snapshot["market"],
                    "company": company,
                    "patch": patch,
                    "managedCompany": managed,
                }
            )
    for identity in identities:
        if (
            not identity.get("managedCompany")
            or (identity["symbol"], identity["isinCode"]) in active
        ):
            continue
        company = next((c for c in companies if c["id"] == identity["companyId"]), None)
        if not company or not company.get("isListed"):
            continue
        confirmed = delisted.get((identity["symbol"], identity["isinCode"]))
        if (
            not confirmed
            or confirmed[1] != identity["market"]
            or company.get("stockCode") != identity["symbol"]
            or company["market"] != etf_market(identity["market"])
            or company.get("corpCode")
            or company.get("cik")
            or company.get("ticker")
        ):
            missing += 1
            continue
        actions.append(
            {
                "kind": "DELIST",
                "stock": confirmed[0],
                "market": confirmed[1],
                "company": company,
                "patch": {"isListed": False},
                "managedCompany": True,
            }
        )
    return {"actions": actions, "conflicts": conflicts, "missingRetained": missing}


class EtfMaster:
    def __init__(self, ctx, toss):
        self.ctx, self.toss = ctx, toss
        self.stopped = False

    async def sync(self, options=None):
        options = options or {}
        empty = lambda status: {
            "status": status,
            **{
                k: 0
                for k in (
                    "activeEtfs",
                    "delistedEtfs",
                    "created",
                    "refreshed",
                    "observed",
                    "delisted",
                    "conflicts",
                    "missingRetained",
                )
            },
        }
        if self.stopped or not self.toss.enabled:
            return empty("DISABLED")
        async with named_lock(self.ctx, "orsem-toss-kr-etf-master") as tx:
            if tx is None:
                return empty("BUSY")
            old = await read_checkpoint(tx, "TOSS", "KR_ETF_MASTER")
            old_meta = obj(old.get("metadataJson"))
            checked = utcnow()
            age = (
                (checked - instant(old["lastSuccessAt"])).total_seconds()
                if old.get("lastSuccessAt")
                else -1
            )
            if not options.get("force") and 0 <= age < 86400:
                return {**empty("CACHED"), "activeEtfs": int(old_meta.get("activeEtfs", 0))}
            snapshots = []
            for status in ("ACTIVE", "DELISTED"):
                for market in ETF_MARKETS:
                    snapshots.append(
                        {
                            "market": market,
                            "status": status,
                            "rows": await self.toss.stocks_all(market, status, "ETF"),
                        }
                    )
            counts = validate_etf_universe(snapshots, int(old_meta.get("activeEtfs", 0)))
            now = utcnow()
            raw = [
                {"market": r["market"], "status": r["status"], "rawPayload": r["rows"]}
                for r in snapshots
            ]
            digest = sha256(json_text(raw))
            companies = [
                camel(r)
                for r in await tx.fetch_all(
                    "SELECT * FROM companies WHERE stock_code IS NOT NULL ORDER BY id FOR UPDATE"
                )
            ]
            stored = [
                camel(r)
                for r in await tx.fetch_all(
                    "SELECT * FROM source_checkpoints WHERE connector='TOSS' AND stream LIKE 'KR_ETF_IDENTITY:%' FOR UPDATE"
                )
            ]
            identities = [
                m
                for r in stored
                if (m := obj(r.get("metadataJson"))).get("version") == 1
                and all(isinstance(m.get(k), str) for k in ("companyId", "symbol", "isinCode"))
                and m.get("market") in ETF_MARKETS
                and type(m.get("managedCompany")) is bool
            ]
            plan = plan_etf_master(snapshots, companies, identities)
            result = {
                "status": "DRY_RUN" if options.get("dryRun") else "UPDATED",
                "activeEtfs": counts["active"],
                "delistedEtfs": counts["delisted"],
                "conflicts": plan["conflicts"],
                "missingRetained": plan["missingRetained"],
                **{
                    k: sum(a["kind"] == kind for a in plan["actions"])
                    for k, kind in [
                        ("created", "CREATE"),
                        ("refreshed", "REFRESH"),
                        ("observed", "OBSERVE"),
                        ("delisted", "DELIST"),
                    ]
                },
            }
            if options.get("dryRun"):
                return result
            old_by_company = {
                obj(r.get("metadataJson")).get("companyId"): obj(r.get("metadataJson"))
                for r in stored
            }
            for action in plan["actions"]:
                company = action["company"]
                stock = action["stock"]
                company_id = company["id"] if company else identifier()
                metadata = old_by_company.get(company_id, {})
                if not company:
                    await insert(
                        tx,
                        "companies",
                        {
                            "id": company_id,
                            "market": etf_market(action["market"]),
                            "corpCode": None,
                            "stockCode": stock["symbol"],
                            "ticker": None,
                            "cik": None,
                            "nameKo": action["patch"]["nameKo"],
                            "nameEn": None,
                            "isListed": True,
                            "sourceUpdatedDate": None,
                        },
                    )
                else:
                    await update(tx, "companies", company_id, action["patch"])
                status = "DELISTED" if action["kind"] == "DELIST" else "ACTIVE"
                await checkpoint(
                    tx,
                    "TOSS",
                    "KR_ETF_IDENTITY:" + company_id,
                    {
                        "version": 1,
                        "source": "TOSS",
                        "rightsMode": PRIVATE,
                        "provenanceUrl": ETF_ENDPOINT
                        + "?"
                        + urlencode(
                            {"market": action["market"], "status": status, "securityType": "ETF"}
                        ),
                        "companyId": company_id,
                        "symbol": stock["symbol"],
                        "isinCode": stock["isinCode"],
                        "market": action["market"],
                        "securityType": "ETF",
                        "status": status,
                        "managedCompany": action["managedCompany"],
                        "appliedNameKo": action["patch"].get(
                            "nameKo", metadata.get("appliedNameKo")
                        ),
                        "originalCompanyNames": metadata.get(
                            "originalCompanyNames",
                            {
                                "nameKo": company.get("nameKo") if company else None,
                                "nameEn": company.get("nameEn") if company else None,
                            },
                        ),
                        "firstObservedAt": metadata.get("firstObservedAt", iso(now)),
                        "observedAt": iso(now),
                        "snapshotHash": digest,
                        "rawPayload": stock,
                    },
                    now,
                    day(now),
                )
            await checkpoint(
                tx,
                "TOSS",
                "KR_ETF_MASTER",
                {
                    "version": 1,
                    "source": "TOSS",
                    "rightsMode": PRIVATE,
                    "provenanceUrl": ETF_ENDPOINT,
                    "documentationUrl": "https://developers.tossinvest.com/docs",
                    "coverage": "TOSS_TRADABLE_KOREAN_ETF_UNIVERSE",
                    "completeMarketResponse": True,
                    "firstObservedAt": old_meta.get("firstObservedAt", iso(now)),
                    "observedAt": iso(now),
                    "snapshotHash": digest,
                    **result,
                    "rawSnapshot": raw,
                },
                now,
                day(now),
            )
            return result

    async def close(self):
        self.stopped = True


def alpaca_market(asset):
    return (
        asset["exchange"]
        if asset.get("assetClass") == "us_equity"
        and asset.get("status") == "active"
        and asset.get("tradable") is True
        and asset.get("exchange") in US_MARKETS
        and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", asset.get("symbol", "").strip().upper())
        else None
    )


def validate_alpaca_size(previous, count):
    if type(previous) is not int or previous < 0 or type(count) is not int or count <= 0:
        raise ValueError("Invalid or empty Alpaca asset-master count.")
    if previous >= 100 and count < previous * 0.8:
        raise ValueError(
            f"Alpaca asset-master snapshot shrank unexpectedly ({previous} to {count})."
        )


def parse_alpaca_assets(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 100000:
        raise ValueError("Invalid Alpaca asset-master snapshot")
    result = []
    for row in raw:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("id"), str)
            or not re.fullmatch(
                r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", row["id"], re.IGNORECASE
            )
            or any(
                not isinstance(row.get(k), str)
                or not 1 <= len(row[k]) <= (2000 if k == "name" else 32)
                for k in ("class", "exchange", "symbol", "name", "status")
            )
            or any(
                type(row.get(k)) is not bool
                for k in ("tradable", "marginable", "shortable", "easy_to_borrow", "fractionable")
            )
        ):
            raise ValueError("Invalid Alpaca asset contract")
        attributes = row.get("attributes")
        if attributes is not None and (
            not isinstance(attributes, list)
            or len(attributes) > 100
            or any(not isinstance(v, str) or len(v) > 128 for v in attributes)
        ):
            raise ValueError("Invalid Alpaca attributes")
        margin = row.get("maintenance_margin_requirement")
        if margin is not None and (
            isinstance(margin, bool) or not isinstance(margin, (str, int, float))
        ):
            raise ValueError("Invalid Alpaca margin requirement")
        result.append(
            {
                "providerAssetId": row["id"],
                "assetClass": row["class"],
                "exchange": row["exchange"],
                "symbol": row["symbol"].strip().upper(),
                "name": row["name"].strip(),
                "status": row["status"],
                "tradable": row["tradable"],
                "marginable": row["marginable"],
                "shortable": row["shortable"],
                "easyToBorrow": row["easy_to_borrow"],
                "fractionable": row["fractionable"],
                "maintenanceMarginRequirement": str(margin) if margin is not None else None,
                "attributes": attributes,
                "raw": row,
            }
        )
    if len({a["providerAssetId"] for a in result}) != len(result):
        raise ValueError("Alpaca asset-master snapshot contains a duplicate provider asset ID.")
    return result


class AlpacaMaster:
    def __init__(self, ctx):
        self.ctx = ctx

    async def fetch(self):
        cfg = self.ctx.config
        if not cfg.alpacaApiKey or not cfg.alpacaApiSecret:
            raise ValueError("ALPACA_API_KEY or ALPACA_API_SECRET missing")
        url = urljoin(cfg.alpacaTradingBaseUrl + "/", "/v2/assets")
        if urlsplit(url).scheme != "https" or urlsplit(url).hostname not in (
            "api.alpaca.markets",
            "paper-api.alpaca.markets",
        ):
            raise ValueError("Invalid Alpaca trading origin")
        status, _, body = await http_request(
            self.ctx,
            "GET",
            url,
            limit=32 * 1024 * 1024,
            params={"status": "active", "asset_class": "us_equity"},
            headers={
                "Accept": "application/json",
                "APCA-API-KEY-ID": cfg.alpacaApiKey,
                "APCA-API-SECRET-KEY": cfg.alpacaApiSecret,
            },
        )
        if not 200 <= status < 300:
            raise RuntimeError(f"Alpaca asset-master request failed with HTTP {status}.")
        return parse_alpaca_assets(json.loads(body)), url + "?status=active&asset_class=us_equity"

    async def sync(self):
        now = utcnow()
        run = await insert(
            self.ctx.db,
            "ingestion_runs",
            {
                "connector": "ALPACA",
                "stream": "ASSET_MASTER",
                "status": "PROCESSING",
                "itemsSeen": "0",
                "itemsCreated": "0",
                "startedAt": now,
                "finishedAt": None,
                "errorMessage": None,
            },
        )
        try:
            assets, url = await self.fetch()
            by_symbol = defaultdict(list)
            for asset in assets:
                if market := alpaca_market(asset):
                    by_symbol[asset["symbol"]].append((asset, market))
            ambiguous = sum(len(v) > 1 for v in by_symbol.values())
            eligible = [v[0] for v in by_symbol.values() if len(v) == 1]
            async with named_lock(self.ctx, "orsem:market-data:alpaca", 30) as tx:
                if tx is None:
                    raise RuntimeError("Timed out acquiring the ALPACA ingestion lock.")
                fields = "provider_asset_id,company_id,exchange,symbol"
                current = [
                    camel(r)
                    for r in await tx.fetch_all(
                        f"SELECT {fields} FROM alpaca_assets WHERE is_current=1"
                    )
                ]
                validate_alpaca_size(len(current), len(assets))
                prior = await _alpaca_select(
                    tx,
                    "alpaca_assets",
                    "providerAssetId",
                    (asset["providerAssetId"] for asset in assets),
                    fields=fields,
                )
                existing = {r["providerAssetId"]: r for r in prior}
                symbols = {asset["symbol"] for asset, _market in eligible}
                historical = defaultdict(list)
                for row in await _alpaca_select(
                    tx,
                    "alpaca_assets",
                    "symbol",
                    symbols,
                    condition=" AND exchange IN ('NASDAQ','NYSE','AMEX')",
                    fields=fields,
                ):
                    historical[(row["exchange"], row["symbol"])].append(row)
                companies = await _alpaca_select(
                    tx,
                    "companies",
                    "ticker",
                    symbols,
                    condition=" AND market IN ('NASDAQ','NYSE','AMEX')",
                )
                stable = await _alpaca_select(
                    tx,
                    "companies",
                    "id",
                    (r["companyId"] for r in prior if r["companyId"]),
                )
                by_id = {c["id"]: c for c in stable}
                company_by_symbol = defaultdict(list)
                for company in companies:
                    if company.get("ticker"):
                        company_by_symbol[company["ticker"]].append(company)
                mapped = {}
                claimed = set()
                bootstrap = []
                for asset, market in eligible:
                    previous = existing.get(asset["providerAssetId"], {})
                    stable = by_id.get(previous.get("companyId"))
                    if stable:
                        if (
                            stable["market"] != market
                            or stable["ticker"] != asset["symbol"]
                            or stable["id"] in claimed
                        ):
                            ambiguous += 1
                            continue
                        mapped[asset["providerAssetId"]] = stable
                        claimed.add(stable["id"])
                        continue
                    owners = company_by_symbol[asset["symbol"]]
                    reused = any(
                        r["providerAssetId"] != asset["providerAssetId"] and r["companyId"]
                        for r in historical[(market, asset["symbol"])]
                    )
                    if (
                        reused
                        or len(owners) > 1
                        or owners
                        and (owners[0]["market"] != market or owners[0]["id"] in claimed)
                    ):
                        ambiguous += 1
                        continue
                    bootstrap.append((asset, market))
                    if owners:
                        claimed.add(owners[0]["id"])
                prior_keys = {(c["market"], c["ticker"]) for c in companies}
                company_rows = (
                    {
                        "id": identifier(),
                        "market": market,
                        "corpCode": None,
                        "stockCode": None,
                        "ticker": asset["symbol"],
                        "cik": None,
                        "nameKo": (asset["name"].strip() or asset["symbol"])[:255],
                        "nameEn": (asset["name"].strip() or asset["symbol"])[:255],
                        "isListed": True,
                        "sourceUpdatedDate": None,
                    }
                    for asset, market in bootstrap
                )
                await insert_many(
                    tx,
                    "companies",
                    company_rows,
                    ["isListed"],
                    chunk_size=DATABASE_CHUNK_SIZE,
                )
                synchronized = defaultdict(list)
                for company in await _alpaca_select(
                    tx,
                    "companies",
                    "ticker",
                    (asset["symbol"] for asset, _market in bootstrap),
                    condition=" AND market IN ('NASDAQ','NYSE','AMEX') AND is_listed=1",
                ):
                    synchronized[company["ticker"]].append(company)
                for asset, market in bootstrap:
                    matches = synchronized[asset["symbol"]]
                    if len(matches) == 1 and matches[0]["market"] == market:
                        mapped[asset["providerAssetId"]] = matches[0]
                created = sum(
                    (market, asset["symbol"]) not in prior_keys for asset, market in bootstrap
                )
                mapped_ids = {c["id"] for c in mapped.values()}
                previous_ids = {r["companyId"] for r in current if r["companyId"]}
                await _alpaca_set_listed(tx, mapped_ids, True)
                await _alpaca_set_listed(tx, previous_ids - mapped_ids, False)
                await tx.execute("UPDATE alpaca_assets SET is_current=0 WHERE is_current=1")

                def asset_rows():
                    for asset in assets:
                        yield {
                            **{k: v for k, v in asset.items() if k not in ("attributes", "raw")},
                            "companyId": mapped.get(asset["providerAssetId"], {}).get("id"),
                            "maintenanceMarginRequirement": asset["maintenanceMarginRequirement"][
                                :64
                            ]
                            if asset["maintenanceMarginRequirement"]
                            else None,
                            "attributesJson": asset["attributes"],
                            "rawJson": asset["raw"],
                            "rightsMode": PRIVATE,
                            "provenanceUrl": url,
                            "firstObservedAt": now,
                            "lastObservedAt": now,
                            "isCurrent": True,
                        }

                await insert_many(
                    tx,
                    "alpaca_assets",
                    asset_rows(),
                    [
                        "companyId",
                        "assetClass",
                        "exchange",
                        "symbol",
                        "name",
                        "status",
                        "tradable",
                        "marginable",
                        "shortable",
                        "easyToBorrow",
                        "fractionable",
                        "maintenanceMarginRequirement",
                        "attributesJson",
                        "rawJson",
                        "rightsMode",
                        "provenanceUrl",
                        "lastObservedAt",
                        "isCurrent",
                    ],
                    chunk_size=ASSET_UPSERT_CHUNK_SIZE,
                )
                new_assets = sum(a["providerAssetId"] not in existing for a in assets)
                result = {
                    "connector": "ALPACA",
                    "stream": "ASSET_MASTER",
                    "observedAt": iso(now),
                    "itemsSeen": len(assets),
                    "assetsCreated": new_assets,
                    "assetsUpdated": len(assets) - new_assets,
                    "eligibleAssets": len(mapped),
                    "companiesCreated": created,
                    "companiesAvailable": len(mapped),
                    "ambiguousSymbols": ambiguous,
                }
                await update(
                    tx,
                    "ingestion_runs",
                    run,
                    {
                        "status": "COMPLETED",
                        "itemsSeen": str(len(assets)),
                        "itemsCreated": str(new_assets),
                        "finishedAt": utcnow(),
                        "errorMessage": None,
                    },
                )
                await checkpoint(
                    tx,
                    "ALPACA",
                    "ASSET_MASTER",
                    {
                        "rightsMode": PRIVATE,
                        "provenanceUrl": url,
                        **{
                            k: v
                            for k, v in result.items()
                            if k not in ("connector", "stream", "observedAt")
                        },
                        "markets": list(US_MARKETS),
                        "filters": {
                            "assetClass": "us_equity",
                            "status": "active",
                            "tradable": True,
                        },
                    },
                    utcnow(),
                    day(now),
                )
                return result
        except Exception as error:
            message = str(error)
            for secret in (self.ctx.config.alpacaApiKey, self.ctx.config.alpacaApiSecret):
                if secret:
                    message = message.replace(secret, "[REDACTED]")
            await update(
                self.ctx.db,
                "ingestion_runs",
                run,
                {"status": "FAILED", "finishedAt": utcnow(), "errorMessage": message[:4000]},
            )
            raise


def normalized_cik(value):
    return (
        value.zfill(10)
        if isinstance(value, str) and re.fullmatch(r"\d{1,10}", value) and int(value) > 0
        else None
    )


def parse_sec_snapshot(text, last_modified=None, acquisition=None):
    if len(text.encode("utf8")) > 10 * 1024 * 1024:
        raise ValueError("SEC ticker-master snapshot exceeded its size limit.")
    raw = json.loads(text)
    fields = raw.get("fields")
    data = raw.get("data")
    if (
        not isinstance(fields, list)
        or not 4 <= len(fields) <= 32
        or len(set(fields)) != len(fields)
        or not all(isinstance(f, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", f) for f in fields)
        or not {"cik", "name", "ticker", "exchange"} <= set(fields)
        or not isinstance(data, list)
        or not 1 <= len(data) <= 100000
    ):
        raise ValueError("Invalid ticker-master columns or snapshot.")
    rows = []
    for index, values in enumerate(data):
        if not isinstance(values, list) or len(values) != len(fields):
            raise ValueError("Invalid ticker-master row.")
        row = dict(zip(fields, values))
        cik = normalized_cik(str(row["cik"])) if type(row["cik"]) in (str, int) else None
        if (
            not cik
            or not isinstance(row["name"], str)
            or not 1 <= len(row["name"]) <= 2000
            or not isinstance(row["ticker"], str)
            or not 1 <= len(row["ticker"]) <= 32
            or row["exchange"] is not None
            and (not isinstance(row["exchange"], str) or len(row["exchange"]) > 64)
        ):
            raise ValueError("Invalid ticker-master identity.")
        rows.append(
            {
                "cik": cik,
                "ticker": row["ticker"].strip().upper(),
                "exchange": (row["exchange"] or "").strip() or None,
                "rowIndex": index,
                "raw": row,
            }
        )
    return {
        "provenanceUrl": SEC_MASTER,
        "sha256": sha256(text),
        "sourceLastModified": last_modified,
        "acquisition": acquisition
        or {"method": "DIRECT_HTTP", "sha256Basis": "HTTP_RESPONSE_TEXT"},
        "raw": raw,
        "rows": rows,
    }


def parse_sec_search_cache(cache):
    expected = {
        "formatVersion": 1,
        "provenanceUrl": SEC_MASTER,
        "method": "SEARCH_CACHE_EXTRACT",
        "sourceLastModified": None,
        "cacheAge": "UNKNOWN",
        "coverage": "SELECTED_ROWS_ONLY",
        "liveIssuerValidation": "NOT_COMPLETED",
        "fields": ["cik", "name", "ticker", "exchange"],
    }
    if (
        not isinstance(cache, dict)
        or set(cache) != set(expected) | {"extractedAt", "data"}
        or any(cache.get(k) != v for k, v in expected.items())
    ):
        raise ValueError("Invalid SEC search-cache provenance contract.")
    instant(cache["extractedAt"])
    return parse_sec_snapshot(
        json_text({"fields": cache["fields"], "data": cache["data"]}),
        None,
        {
            "method": cache["method"],
            "sha256Basis": "EXTRACTED_JSON",
            **{
                k: cache[k] for k in ("extractedAt", "cacheAge", "coverage", "liveIssuerValidation")
            },
        },
    )


class SecTickerIndex:
    def __init__(self, rows):
        self.exact = defaultdict(list)
        self.aliases = defaultdict(list)
        for row in rows:
            exchange = (row.get("exchange") or "").strip().upper()
            market = "AMEX" if exchange == "NYSE AMERICAN" else exchange
            if market not in US_MARKETS:
                continue
            self.exact[(market, row["ticker"])].append(row)
            self.aliases[(market, row["ticker"].replace(".", "-"))].append(row)

    def match(self, company):
        ticker = (company.get("ticker") or "").strip().upper()
        empty = lambda status: {"status": status, "rule": None, "cik": None, "rows": []}
        if (
            not company.get("isListed")
            or company.get("market") not in US_MARKETS
            or not re.fullmatch(r"[A-Z0-9][A-Z0-9.-]{0,31}", ticker)
        ):
            return empty("NOT_ELIGIBLE")
        exact = self.exact[(company["market"], ticker)]
        rows = exact or self.aliases[(company["market"], ticker.replace(".", "-"))]
        if not rows:
            return empty("UNMATCHED")
        rule = "EXACT_TICKER_EXCHANGE" if exact else "DOT_HYPHEN_TICKER_EXCHANGE"
        matched = len({r["cik"] for r in rows}) == 1
        return {
            "status": "MATCHED" if matched else "AMBIGUOUS",
            "rule": rule,
            "cik": rows[0]["cik"] if matched else None,
            "rows": rows,
        }


class SecCikMaster:
    def __init__(self, ctx):
        self.ctx = ctx

    async def fetch(self):
        agent = self.ctx.config.secUserAgent
        if not agent or len(agent) > 255 or re.search(r"[\r\n]", agent):
            raise ValueError("A valid SEC_USER_AGENT is required for SEC ticker-master requests.")
        response = await self.ctx.services["sec_http"].request(
            SEC_MASTER,
            headers={"Accept": "application/json", "User-Agent": agent},
            timeout_ms=self.ctx.config.httpTimeoutMs,
            max_bytes=10 * 1024 * 1024,
        )
        if not response.is_success:
            raise RuntimeError(
                f"SEC ticker-master request failed with HTTP {response.status_code}."
            )
        return parse_sec_snapshot(response.text, response.headers.get("last-modified"))

    async def sync(self, payload=None, observed_at=None, cache=None):
        payload = payload or {}
        now = observed_at or utcnow()
        ids = payload.get("companyIds")
        if ids is not None:
            from uuid import UUID

            if not isinstance(ids, list) or len(ids) > 10000:
                raise ValueError("Invalid SEC CIK mapping company scope")
            for value in ids:
                UUID(value)
            ids = list(dict.fromkeys(ids))
        result: dict[str, Any] = {
            "connector": "SEC_EDGAR",
            "stream": "CIK_MAPPING",
            "companiesRequested": len(ids or []),
            "sourceRows": 0,
            **{
                k: 0
                for k in (
                    "linked",
                    "alreadyLinked",
                    "conflicts",
                    "ambiguous",
                    "unmatched",
                    "notEligible",
                )
            },
        }
        if cache is None and not self.ctx.config.secUserAgent:
            return {**result, "disabled": True}
        if ids == []:
            return result
        marks, params = in_params(ids or [])
        companies = [
            camel(r)
            for r in await self.ctx.db.fetch_all(
                "SELECT * FROM companies WHERE market IN ('NASDAQ','NYSE','AMEX') AND is_listed=1"
                + (f" AND id IN ({marks})" if ids is not None else "")
                + " ORDER BY market,ticker,id",
                params,
            )
        ]
        if len(companies) > 20000:
            raise ValueError("SEC mapping scope exceeds 20000 companies.")
        result["companiesRequested"] = len(ids) if ids is not None else len(companies)
        result["notEligible"] = len(ids) - len(companies) if ids is not None else 0
        if not companies:
            return result
        snapshot = parse_sec_search_cache(cache) if cache is not None else await self.fetch()
        index = SecTickerIndex(snapshot["rows"])
        result["sourceRows"] = len(snapshot["rows"])
        if cache is not None and (
            not ids or any(index.match(c)["status"] != "MATCHED" for c in companies)
        ):
            raise ValueError(
                "SEC cache snapshot does not unambiguously cover the requested companies."
            )
        stream = "CIK_TICKER_MASTER" if cache is None else "CIK_SEARCH_CACHE:" + snapshot["sha256"]
        old = await read_checkpoint(self.ctx.db, "SEC_EDGAR", stream)
        await checkpoint(
            self.ctx.db,
            "SEC_EDGAR",
            stream,
            {
                "version": 1,
                "source": "SEC_EDGAR",
                "rightsMode": OFFICIAL,
                "provenanceUrl": snapshot["provenanceUrl"],
                "sha256": snapshot["sha256"],
                "acquisition": snapshot["acquisition"],
                "sourceLastModified": snapshot["sourceLastModified"],
                "sourceRows": len(snapshot["rows"]),
                "rawPayload": snapshot["raw"],
                "firstObservedAt": obj(old.get("metadataJson")).get("firstObservedAt", iso(now)),
                "observedAt": iso(now),
            },
            now,
            day(now),
        )
        for candidate in companies:
            async with self.ctx.db.transaction() as tx:
                company = camel(
                    await tx.fetch_one(
                        "SELECT * FROM companies WHERE id=:id FOR UPDATE", {"id": candidate["id"]}
                    )
                )
                if not company:
                    result["notEligible"] += 1
                    continue
                match = index.match(company)
                old = await read_checkpoint(tx, "SEC_EDGAR", "CIK_MAPPING:" + company["id"], True)
                metadata = obj(old.get("metadataJson"))
                if match["status"] != "MATCHED":
                    outcome = {
                        "NOT_ELIGIBLE": "notEligible",
                        "UNMATCHED": "unmatched",
                        "AMBIGUOUS": "ambiguous",
                    }[match["status"]]
                elif (
                    company.get("cik") is not None
                    and normalized_cik(company["cik"]) != match["cik"]
                    or metadata.get("appliedCik") is not None
                    and normalized_cik(metadata["appliedCik"]) != match["cik"]
                ):
                    outcome = "conflicts"
                elif company.get("cik") is not None:
                    outcome = "alreadyLinked"
                else:
                    await update(tx, "companies", company["id"], {"cik": match["cik"]})
                    outcome = "linked"
                await checkpoint(
                    tx,
                    "SEC_EDGAR",
                    "CIK_MAPPING:" + company["id"],
                    {
                        "version": 1,
                        "source": "SEC_EDGAR",
                        "rightsMode": OFFICIAL,
                        "provenanceUrl": SEC_MASTER,
                        "sourceSnapshotSha256": snapshot["sha256"],
                        "acquisition": snapshot["acquisition"],
                        "sourceLastModified": snapshot["sourceLastModified"],
                        "companyId": company["id"],
                        "ticker": company["ticker"],
                        "market": company["market"],
                        "outcome": outcome,
                        "matchRule": match["rule"],
                        "candidateCik": match["cik"],
                        "originalCik": metadata.get("originalCik", company.get("cik")),
                        "appliedCik": match["cik"]
                        if outcome in ("linked", "alreadyLinked")
                        else metadata.get("appliedCik"),
                        "rawPayload": [
                            {"rowIndex": r["rowIndex"], **r["raw"]} for r in match["rows"][:20]
                        ],
                        "candidateRows": len(match["rows"]),
                        "candidateRowsTruncated": len(match["rows"]) > 20,
                        "firstObservedAt": metadata.get("firstObservedAt", iso(now)),
                        "observedAt": iso(now),
                    },
                    now,
                    day(now),
                )
                result[outcome] += 1
        return result
