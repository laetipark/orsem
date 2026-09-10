"""Reviewed source registry and conservative metadata relevance rules."""

import json
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import regex as re

from orsem_worker.core import json_text, sha256

REGISTRY = json.loads(Path(__file__).with_name("source_registry.json").read_text())
RSS_FEEDS = REGISTRY["NEWS_RSS_FEEDS"]
IR_PROFILES = REGISTRY["NEWS_IR_SOURCE_PROFILES"]
EXTERNAL_POLICIES = REGISTRY["NEWS_EXTERNAL_API_POLICIES"]
AMBIGUOUS_NAMES = {
    "apple",
    "meta",
    "target",
    "gap",
    "on",
    "arm",
    "block",
    "shell",
    "visa",
    "oracle",
    "amazon",
    "삼성",
    "현대",
    "기아",
}
NEWS_MATCHER_VERSION = 1


def registered_policies():
    return [
        *EXTERNAL_POLICIES.values(),
        *(p["policy"] for p in IR_PROFILES.values() if p.get("enabled")),
        *(p["policy"] for p in RSS_FEEDS.values() if p.get("enabled", True)),
    ]


def current_policy(policy):
    if not policy or policy.get("policyVersion") != 2:
        return policy
    return next(
        (p for p in registered_policies() if p.get("policyId") == policy.get("policyId")), None
    )


def approved(policy):
    if not policy:
        return False
    if policy.get("policyVersion") != 2:
        return policy.get("metadataStorageAllowed") is True and policy.get("displayAllowed") is True
    return bool(
        policy.get("policyId")
        and policy.get("rightsStatus") in ("APPROVED", "METADATA_ONLY")
        and policy.get("metadataStorageAllowed") is True
        and policy.get("displayAllowed") is True
        and policy.get("policyUrl", "").startswith("https://")
        and policy.get("checkedAt")
        and policy.get("fullTextStorageAllowed") is False
    )


def allows_audience(policy, audience="MEMBER_UI"):
    if not approved(policy):
        return False
    if policy.get("policyVersion") != 2:
        return True
    current = current_policy(policy)
    return (
        approved(current)
        and audience in policy.get("allowedAudiences", [])
        and audience in current.get("allowedAudiences", [])
    )


def summary_allowed(policy):
    if not policy:
        return False
    return (
        policy.get("summaryStorageAllowed") is True
        if policy.get("policyVersion") == 2
        else policy.get("metadataStorageAllowed") is True
        and policy.get("rightsMode") in ("OFFICIAL_PUBLIC_DATA", "PRIVATE_DISPLAY_ONLY")
    )


def translation_allowed(policy):
    return bool(
        policy
        and policy.get("aiAllowed") is True
        and (policy.get("policyVersion") != 2 or policy.get("translationAllowed") is True)
    )


def ir_profile(value):
    try:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or url.username
            or url.password
            or url.port not in (None, 443)
            or url.fragment
        ):
            return None
        canonical = urlunsplit((url.scheme, url.hostname, url.path or "/", url.query, ""))
        return next(
            (
                p
                for p in IR_PROFILES.values()
                if p["url"] == canonical and url.hostname in p["allowedHosts"]
            ),
            None,
        )
    except ValueError:
        return None


def canonical_url(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Invalid article URL")
    params = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if not re.match(r"^utm_|^(fbclid|gclid|mc_cid|mc_eid)$", k, re.I)
    ]
    netloc = parsed.hostname.lower()
    if ":" in netloc:
        netloc = f"[{netloc}]"
    if parsed.port and parsed.port != {"http": 80, "https": 443}[parsed.scheme]:
        netloc += f":{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path or "/", urlencode(params), ""))


V2_METADATA_FIELDS = {
    "discoveryProvider",
    "providerArticleId",
    "externalIdentityKind",
    "providerPublishedAt",
    "publishedTimestampMeaning",
    "firstObservedAt",
    "collectedAt",
    "providerSymbols",
    "sourceDomain",
    "publisherPolicyId",
    "publisherPolicySnapshot",
    "publisherId",
    "originalPublisherId",
    "providerPolicySnapshot",
    "publisherSourceKind",
    "independentVerification",
    "metadataOnly",
    "allowedAudiences",
    "rightsContext",
    "marketRegion",
    "attributionName",
    "providerFields",
    "feedUrl",
    "feedId",
    "originalGuid",
    "originalPublishedAt",
    "originalUpdatedAt",
    "providerUpdatedAt",
    "originalAuthor",
    "sourceProfileId",
    "categories",
    "contentPolicy",
    "rightsPolicyId",
    "originalTitle",
    "originalLink",
    "originalCategories",
    "publisher",
    "rightsPolicyUrl",
}


def without_content(value):
    if isinstance(value, list):
        return [without_content(v) for v in value]
    if not isinstance(value, dict):
        return value
    return {
        k: without_content(v)
        for k, v in value.items()
        if not re.fullmatch(
            r"body|content|html|full[_-]?text|article[_-]?body|images?|banner_image|highlights",
            k,
            re.I,
        )
    }


def candidate_metadata(candidate, policy):
    metadata = candidate.get("metadata", {})
    return (
        {k: without_content(v) for k, v in metadata.items() if k in V2_METADATA_FIELDS}
        if policy.get("policyVersion") == 2
        else dict(metadata)
    )


def candidate_summary(candidate, policy):
    if not summary_allowed(policy) or not summary_allowed(current_policy(policy)):
        return None
    text = candidate.get("summary") or candidate.get("metadata", {}).get("description")
    return text[:16000] if isinstance(text, str) else None


def stable(value):
    if isinstance(value, list):
        return [stable(v) for v in value]
    if not isinstance(value, dict):
        return value
    return {
        k: stable(value[k])
        for k in sorted(value, key=lambda x: (x.lower(), x))
        if k not in ("firstObservedAt", "observedAt", "collectedAt", "checkedAt")
    }


def candidate_hash(candidate, metadata, summary):
    values = {
        k: candidate.get(k)
        for k in (
            "externalId",
            "title",
            "url",
            "publishedAt",
            "updatedAt",
            "sourceName",
            "tickers",
            "tags",
            "rightsMode",
        )
    }
    return sha256(json_text(stable({**values, "metadata": metadata, "summary": summary})))


def company_aliases(companies, extras=()):
    aliases = []
    for c in companies:
        for name in (c.get("nameKo"), c.get("nameEn")):
            if not name:
                continue
            short = re.sub(r"^(?:\(주\)|주식회사)\s*", "", unicodedata.normalize("NFKC", name))
            short = re.sub(
                r"(?:,?\s+(?:incorporated|corporation|limited|company|corp|inc|ltd|plc|co)\.?)+$",
                "",
                short,
                flags=re.I,
            ).strip()
            aliases += [
                {"companyId": c["id"], "alias": a, "aliasType": "COMPANY_NAME"}
                for a in dict.fromkeys((name, short))
                if len(a) >= 2
            ]
        aliases += [
            {"companyId": c["id"], "alias": a, "aliasType": "SYMBOL"}
            for a in (c.get("ticker"), c.get("stockCode"))
            if a
        ]
    return aliases + list(extras)


class PreparedAlias(NamedTuple):
    company_id: str
    alias: str
    folded: str
    symbol: bool
    korean: bool
    explicit_symbol: bool


def matcher_fold(value: str) -> str:
    # Match the deployed TypeScript candidate filter; the original expressions
    # below still decide case-sensitive symbols and Korean mixed-script names.
    return value.lower().replace("ς", "σ")


@lru_cache(maxsize=512)
def alias_expression(alias: str, symbol: bool, korean: bool, explicit_symbol: bool):
    """Compile only title candidates, with a process-wide bounded cache."""
    escaped = re.escape(alias)
    if symbol:
        paren = "" if explicit_symbol else r"\(|"
        pattern = rf"(?:\$|{paren}(?:NASDAQ|NYSE|AMEX|KRX)\s*:\s*){escaped}(?=$|[^\p{{L}}\p{{N}}])"
    elif korean:
        pattern = rf"(?<![\p{{L}}\p{{N}}]){escaped}(?![가-힣A-Za-z0-9])|(?<![\p{{L}}\p{{N}}]){escaped}(?=(?:은|는|이|가|의|와|과|도|를|에|에서|으로)(?:\s|[,.:!?]|$))"
    else:
        pattern = rf"(?<![\p{{L}}\p{{N}}]){escaped}(?![\p{{L}}\p{{N}}])"
    return re.compile(pattern, 0 if symbol or korean else re.I)


class CompanyMatcher:
    def __init__(self, aliases):
        # A single owner or None (ambiguous) is enough; a set per alias costs
        # tens of MB for the complete company master.
        owners: dict[tuple[bool, str], str | None] = {}
        for item in aliases:
            alias = unicodedata.normalize("NFKC", item["alias"]).strip()
            symbol = bool(re.search("TICKER|SYMBOL|STOCK_CODE", item["aliasType"], re.I))
            key = (symbol, alias.lower())
            if key not in owners:
                owners[key] = item["companyId"]
            elif owners[key] != item["companyId"]:
                owners[key] = None
        self.index: dict[str, list[PreparedAlias]] = {}
        self.widths: set[int] = set()
        seen = set()
        for item in aliases:
            alias = unicodedata.normalize("NFKC", item["alias"]).strip()
            symbol = bool(re.search("TICKER|SYMBOL|STOCK_CODE", item["aliasType"], re.I))
            if (
                len(alias) < (1 if symbol else 2)
                or len(alias) > 255
                or owners[(symbol, alias.lower())] is None
                or (symbol, alias) in seen
            ):
                continue
            seen.add((symbol, alias))
            korean = bool(re.search("[가-힣]", alias))
            if not symbol and (alias.lower() in AMBIGUOUS_NAMES or not korean and len(alias) < 3):
                continue
            folded = matcher_fold(alias)
            width = min(6, len(folded))
            self.index.setdefault(folded[:width], []).append(
                PreparedAlias(
                    item["companyId"],
                    alias,
                    folded,
                    symbol,
                    korean,
                    item["aliasType"] == "EXPLICIT_SYMBOL",
                )
            )
            self.widths.add(width)

    def __call__(self, title):
        text = unicodedata.normalize("NFKC", title)
        folded = matcher_fold(text)
        candidates: set[PreparedAlias] = set()
        for offset in range(len(folded)):
            for width in self.widths:
                if offset + width > len(folded):
                    continue
                for item in self.index.get(folded[offset : offset + width], ()):
                    if folded.startswith(item.folded, offset):
                        candidates.add(item)
        hits = [
            (item.company_id, item.symbol, m.start(), m.end())
            for item in candidates
            for m in alias_expression(
                item.alias, item.symbol, item.korean, item.explicit_symbol
            ).finditer(text)
        ]
        return sorted(
            {
                id
                for id, symbol, start, end in hits
                if not any(
                    oid != id
                    and not symbol
                    and not osymbol
                    and a <= start
                    and b >= end
                    and b - a > end - start
                    for oid, osymbol, a, b in hits
                )
            }
        )


def resolve_provider_entities(symbols, companies):
    us = {"NASDAQ", "NYSE", "AMEX"}
    kr = {"KOSPI", "KOSDAQ", "KRX"}
    exchanges = {
        "NASDAQGS": "NASDAQ",
        "NASDAQGM": "NASDAQ",
        "NASDAQCM": "NASDAQ",
        "XNAS": "NASDAQ",
        "XNYS": "NYSE",
        "XASE": "AMEX",
        "NYSE AMERICAN": "AMEX",
        **{m: m for m in us | kr},
    }
    result: dict[str, Any] = {"companyIds": [], "resolved": [], "unresolved": []}
    seen = set()
    for item in symbols:
        key = json_text([item.get("symbol"), item.get("country"), item.get("exchange")])
        if key in seen:
            continue
        seen.add(key)
        symbol = str(item.get("symbol", "")).strip().upper()
        reason = None
        country_text = str(item.get("country") or "").strip().upper()
        country = {"US": "US", "USA": "US", "KR": "KR", "KOR": "KR"}.get(country_text)
        exchange_text = str(item.get("exchange") or "").strip().upper()
        exchange = exchanges.get(exchange_text)
        if not symbol or len(symbol) > 64 or re.search(r"\s", symbol):
            reason = "INVALID_SYMBOL"
        elif country_text and not country or exchange_text and not exchange:
            reason = "UNSUPPORTED_MARKET"
        prefix = re.fullmatch(r"(US|KR):(.+)", symbol)
        local = prefix[2] if prefix else symbol
        suffix = re.fullmatch(r"(\d{6})\.(KS|KQ)", local)
        suffix_market = {"KS": "KOSPI", "KQ": "KOSDAQ"}.get(suffix[2]) if suffix else None
        countries = {
            c
            for c in (
                country,
                ("US" if exchange in us else "KR") if exchange else None,
                prefix[1] if prefix else None,
                "KR" if suffix else None,
            )
            if c
        }
        if (
            len(countries) > 1
            or suffix_market
            and exchange
            and exchange not in ("KRX", suffix_market)
        ):
            reason = "CONFLICTING_MARKET"
        region = next(iter(countries), "US")
        matches = []
        canonical = None
        if not reason and region == "KR":
            stock = suffix[1] if suffix else local
            market = suffix_market or (exchange if exchange != "KRX" else None)
            if not re.fullmatch(r"\d{6}", stock):
                reason = "INVALID_SYMBOL"
            else:
                candidates = [
                    c
                    for c in companies
                    if c.get("isListed") and c.get("market") in kr and c.get("stockCode") == stock
                ]
                matches = [c for c in candidates if not market or c["market"] == market]
                if market and not matches and not any(c["market"] != "KRX" for c in candidates):
                    matches = candidates
                canonical = f"KR:{stock}"
        elif not reason:
            if len(local) > 32 or not re.fullmatch(r"[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*", local):
                reason = "INVALID_SYMBOL"
            else:
                matches = [
                    c
                    for c in companies
                    if c.get("isListed")
                    and c.get("market") in us
                    and (not exchange or c["market"] == exchange)
                    and (c.get("ticker") or "").upper() == local
                ]
                canonical = f"US:{local}"
        if not reason and len({c["id"] for c in matches}) != 1:
            reason = "AMBIGUOUS" if matches else "NOT_FOUND"
        if reason:
            result["unresolved"].append({**item, "reason": reason})
        else:
            result["resolved"].append(
                {"symbol": item["symbol"], "canonicalId": canonical, "companyId": matches[0]["id"]}
            )
    result["companyIds"] = sorted({v["companyId"] for v in result["resolved"]})
    return result
