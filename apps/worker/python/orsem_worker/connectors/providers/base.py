"""Shared provider validation, status, symbols, and access approval checks."""

from __future__ import annotations

import re

from orsem_worker.core import utcnow

from ..common import instant, iso

US_MARKETS = {"NASDAQ", "NYSE", "AMEX"}


def bounded(value, limit, *, nullable=False):
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError("Invalid provider metadata string.")
    return value


def zoned(value):
    value = bounded(value, 256)
    if not re.search(r"(?:Z|[+-]\d\d:\d\d)$", value):
        raise ValueError("Provider publication timestamp lacks an offset.")
    result = instant(value)
    if result is None:
        raise ValueError("Invalid provider timestamp.")
    return iso(result)


def array(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError("Invalid provider metadata list.")
    return value


class Adapter:
    rightsMode = "STORE_METADATA_ONLY"

    def __init__(self, ctx, name):
        self.ctx, self.name = ctx, name
        self.discoveryMetadata = {}
        self.discoveryWasTruncated = False
        self.discoveryFailureCount = 0

    def configured(self):
        return False

    def health(self):
        enabled = self.configured()
        return {
            "connector": self.name,
            "status": "DEGRADED" if enabled else "UNCONFIGURED",
            "message": f"Configured; awaiting {self.name} discovery results."
            if enabled
            else f"{self.name} disabled, credentials missing, or rights require review.",
            "checkedAt": utcnow(),
            "rightsMode": self.rightsMode,
            "metadata": {"configured": enabled, "healthSource": self.name + "_INGESTION"},
        }


def news_symbols(scope, provider):
    result = []
    for company in scope:
        ticker, market = company.get("ticker"), company.get("market")
        if (
            market in US_MARKETS
            and isinstance(ticker, str)
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.\-]{0,31}", ticker)
        ):
            result.append(ticker)
        elif (
            provider == "MARKETAUX"
            and market in ("KOSPI", "KOSDAQ")
            and re.fullmatch(r"\d{6}", company.get("stock_code") or "")
        ):
            result.append(company["stock_code"] + (".KS" if market == "KOSPI" else ".KQ"))
    return list(dict.fromkeys(result))


def valid_access(approval):
    return bool(
        approval
        and approval.get("entitlementConfirmed") is True
        and instant(approval.get("freeAccessVerifiedUntil"))
        and instant(approval["freeAccessVerifiedUntil"]) > utcnow()
    )
