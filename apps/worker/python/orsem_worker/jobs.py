"""Validate the stable JSON job contract before any provider or database action."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

DetailType = Literal["D001", "D002", "D003", "D004", "D005"]


def _uuid(value: str) -> str:
    if not re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", value, re.IGNORECASE
    ):
        raise ValueError("Invalid UUID.")
    UUID(value)
    return value


Uuid = Annotated[str, AfterValidator(_uuid)]
DateOnly = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]


class Payload(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore")

    @model_validator(mode="before")
    @classmethod
    def no_explicit_null(cls, value):
        if isinstance(value, dict) and any(
            item is None for key, item in value.items() if key in cls.model_fields
        ):
            raise ValueError("Optional job fields must be omitted rather than null.")
        return value


class Poll(Payload):
    detailType: DetailType
    startDate: DateOnly | None = None
    endDate: DateOnly | None = None
    suppressAlerts: bool = False
    reason: Literal["SCHEDULED", "BACKFILL", "RECOVERY"] = "SCHEDULED"


class Enrich(Payload):
    filingId: Uuid
    rceptNo: str = Field(pattern=r"^\d{14}$")
    detailType: DetailType
    suppressAlerts: bool = False
    documentRetryAttempt: int = Field(default=0, ge=0, le=3)


class ApplyProjection(Payload):
    filingId: Uuid
    parseRunId: Uuid
    requestedByAdminId: Uuid
    crosscheckOnly: bool | None = None


class Review(Payload):
    filingId: Uuid
    parseRunId: Uuid


class Discovery(Payload):
    connectors: list[
        Literal[
            "NAVER",
            "SEC",
            "IR",
            "NEWS_RSS",
            "GDELT",
            "ALPACA_NEWS",
            "MARKETAUX",
            "ALPHAVANTAGE",
            "FINNHUB",
        ]
    ] = Field(min_length=1, max_length=3)
    priorities: list[Literal["P1", "P2", "P3"]] = Field(default_factory=list, max_length=3)
    companyIds: list[Uuid] = Field(default_factory=list, max_length=100)
    reason: Literal["SCHEDULED", "DISCLOSURE_TRIGGER", "BACKFILL"]
    suppressAlerts: bool | None = None
    triggerFilingId: Uuid | None = None

    @model_validator(mode="after")
    def valid_scope(self):
        if any(
            len(values) != len(set(values))
            for values in (self.connectors, self.priorities, self.companyIds)
        ):
            raise ValueError("Discovery fields must not contain duplicates.")
        if self.reason == "BACKFILL":
            if (
                self.connectors != ["SEC"]
                or self.priorities
                or not self.companyIds
                or self.suppressAlerts is not True
                or self.triggerFilingId
            ):
                raise ValueError("SEC backfill requires explicit companies and suppressed alerts.")
        elif self.reason == "DISCLOSURE_TRIGGER":
            if (
                self.connectors != ["NAVER"]
                or self.priorities != ["P3"]
                or len(self.companyIds) != 1
                or not self.triggerFilingId
            ):
                raise ValueError("Invalid disclosure-triggered discovery scope.")
        else:
            if self.companyIds or self.triggerFilingId:
                raise ValueError("Scheduled discovery cannot carry explicit IDs.")
            signature = ",".join(sorted(self.connectors)) + ":" + ",".join(sorted(self.priorities))
            if signature not in {
                "NAVER:P1",
                "NAVER:P2",
                "SEC:P1,P2",
                "IR:",
                "NEWS_RSS:",
                "GDELT:",
                "ALPACA_NEWS:",
                "MARKETAUX:",
                "ALPHAVANTAGE:",
                "FINNHUB:",
            }:
                raise ValueError("Discovery does not match an approved source cadence.")
        return self


class SyncCik(Payload):
    companyIds: list[Uuid] | None = Field(default=None, min_length=1, max_length=10000)


class TossCandles(Payload):
    interval: Literal["1d", "1m"]
    companyIds: list[Uuid] | None = Field(default=None, min_length=1, max_length=100)
    reason: Literal["SCHEDULED", "MANUAL", "VIEW"] | None = None
    before: str | None = None
    lookbackDays: int | None = Field(default=None, ge=1, le=366)
    maxPages: int | None = Field(default=None, ge=1, le=6)

    @model_validator(mode="after")
    def valid_before(self):
        if self.before is not None:
            parsed = datetime.fromisoformat(self.before)
            if parsed.tzinfo is None:
                raise ValueError("before requires an explicit timezone.")
        return self


class TossStocks(Payload):
    model_config = ConfigDict(strict=True, extra="forbid")
    companyIds: list[Uuid] | None = Field(default=None, min_length=1, max_length=100)
    reason: Literal["SCHEDULED", "MANUAL"] = "MANUAL"


class AlpacaAssets(Payload):
    model_config = ConfigDict(strict=True, extra="forbid")
    reason: Literal["SCHEDULED", "MANUAL"]


MODELS: dict[str, type[Payload]] = {
    "poll-opendart": Poll,
    "backfill-opendart": Poll,
    "enrich-filing": Enrich,
    "apply-parse-projection": ApplyProjection,
    "review-parse-with-ai": Review,
    "discover-news-links": Discovery,
    "sync-sec-cik": SyncCik,
    "ingest-toss-candles": TossCandles,
    "sync-toss-stocks": TossStocks,
    "sync-alpaca-assets": AlpacaAssets,
}


def validate_job(name: str, payload: Any) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Job payload must be an object.")  # noqa: TRY004 - invalid job contract
    model = MODELS.get(name)
    return model.model_validate(payload).model_dump(exclude_none=True) if model else dict(payload)
