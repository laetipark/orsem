"""Wire constants shared with the TypeScript API (values remain stable)."""

from enum import StrEnum


class DisclosureDetailType(StrEnum):
    D001 = "D001"
    D002 = "D002"
    D003 = "D003"
    D004 = "D004"
    D005 = "D005"


class SubmissionKind(StrEnum):
    INITIAL = "INITIAL"
    CORRECTION = "CORRECTION"
    ATTACHMENT_CORRECTION = "ATTACHMENT_CORRECTION"
    WITHDRAWAL = "WITHDRAWAL"
    UNKNOWN = "UNKNOWN"


class EffectiveFilingState(StrEnum):
    ACTIVE = "ACTIVE"
    SUPERSEDED = "SUPERSEDED"
    WITHDRAWN = "WITHDRAWN"
    CANCELLED = "CANCELLED"


class FilingRelationType(StrEnum):
    CORRECTS = "CORRECTS"
    CANCELS = "CANCELS"
    WITHDRAWS = "WITHDRAWS"
    SUPERSEDES = "SUPERSEDES"
    FULFILLS_PLAN = "FULFILLS_PLAN"
    EXECUTION_CANDIDATE = "EXECUTION_CANDIDATE"
    RELATED = "RELATED"


class RelationSource(StrEnum):
    EXPLICIT = "EXPLICIT"
    HEURISTIC = "HEURISTIC"
    MANUAL = "MANUAL"


class RelationReviewDecision(StrEnum):
    PENDING = "PENDING"
    CONFIRMED = "CONFIRMED"
    REJECTED = "REJECTED"
    UNKNOWN = "UNKNOWN"


class ParseStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


class TransactionNature(StrEnum):
    MARKET_BUY = "MARKET_BUY"
    MARKET_SELL = "MARKET_SELL"
    BLOCK_BUY = "BLOCK_BUY"
    BLOCK_SELL = "BLOCK_SELL"
    OFF_MARKET_BUY = "OFF_MARKET_BUY"
    OFF_MARKET_SELL = "OFF_MARKET_SELL"
    AFTER_HOURS_BUY = "AFTER_HOURS_BUY"
    AFTER_HOURS_SELL = "AFTER_HOURS_SELL"
    STOCK_COMPENSATION = "STOCK_COMPENSATION"
    NEW_SHARE_SUBSCRIPTION = "NEW_SHARE_SUBSCRIPTION"
    SECURITIES_SUBSCRIPTION = "SECURITIES_SUBSCRIPTION"
    STOCK_LENDING = "STOCK_LENDING"
    REPORTING_STATUS_CHANGE = "REPORTING_STATUS_CHANGE"
    RIGHTS_CHANGE = "RIGHTS_CHANGE"
    STOCK_DIVIDEND = "STOCK_DIVIDEND"
    CAPITAL_REDUCTION = "CAPITAL_REDUCTION"
    GIFT_CANCELLATION = "GIFT_CANCELLATION"
    TENDER_OFFER_APPLICATION = "TENDER_OFFER_APPLICATION"
    GIFT_IN = "GIFT_IN"
    GIFT_OUT = "GIFT_OUT"
    OPTION_EXERCISE = "OPTION_EXERCISE"
    RSU_RSA = "RSU_RSA"
    CONVERSION = "CONVERSION"
    STOCK_SPLIT_MERGER = "STOCK_SPLIT_MERGER"
    TRUST_TRANSFER = "TRUST_TRANSFER"
    INHERITANCE = "INHERITANCE"
    OTHER = "OTHER"
    UNKNOWN = "UNKNOWN"


class Direction(StrEnum):
    INCREASE = "INCREASE"
    DECREASE = "DECREASE"
    NEUTRAL = "NEUTRAL"
    UNKNOWN = "UNKNOWN"


class RightsMode(StrEnum):
    OFFICIAL_PUBLIC_DATA = "OFFICIAL_PUBLIC_DATA"
    PRIVATE_DISPLAY_ONLY = "PRIVATE_DISPLAY_ONLY"
    STORE_METADATA_ONLY = "STORE_METADATA_ONLY"
    LINK_ONLY = "LINK_ONLY"
    NO_REDISTRIBUTION = "NO_REDISTRIBUTION"


class EvidenceGrade(StrEnum):
    A = "A"
    B = "B"
    C = "C"
    UNVERIFIED = "UNVERIFIED"


class EventType(StrEnum):
    INSIDER_OWNERSHIP = "INSIDER_OWNERSHIP"
    LARGE_HOLDER = "LARGE_HOLDER"
    TRADE_PLAN = "TRADE_PLAN"
    PROXY_SOLICITATION = "PROXY_SOLICITATION"
    TENDER_OFFER = "TENDER_OFFER"
    NEWS = "NEWS"
    CORRECTION = "CORRECTION"
    OTHER = "OTHER"


class EventState(StrEnum):
    OPEN = "OPEN"
    VERIFIED = "VERIFIED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    SUPERSEDED = "SUPERSEDED"
    CANCELLED = "CANCELLED"


class AlertStatus(StrEnum):
    PENDING = "PENDING"
    SENDING = "SENDING"
    SENT = "SENT"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class ClassificationReviewResult(StrEnum):
    RULE_CONFIRMED = "RULE_CONFIRMED"
    AI_CONFIRMED = "AI_CONFIRMED"
    AI_SUGGESTED = "AI_SUGGESTED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"


class ReviewTaskStatus(StrEnum):
    OPEN = "OPEN"
    RESOLVED = "RESOLVED"
    DISMISSED = "DISMISSED"
    SUPERSEDED = "SUPERSEDED"


class ConnectorStatus(StrEnum):
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    DISABLED = "DISABLED"
    UNCONFIGURED = "UNCONFIGURED"
    FAILED = "FAILED"


class ProcessingStatus(StrEnum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class WatchPriority(StrEnum):
    P1 = "P1"
    P2 = "P2"
    P3 = "P3"
    P4 = "P4"


class Market(StrEnum):
    KRX = "KRX"
    KOSPI = "KOSPI"
    KOSDAQ = "KOSDAQ"
    KONEX = "KONEX"
    NASDAQ = "NASDAQ"
    NYSE = "NYSE"
    AMEX = "AMEX"
    OTHER = "OTHER"


class DeliveryChannel(StrEnum):
    TELEGRAM = "TELEGRAM"
    DISCORD = "DISCORD"
    MESSENGERBOTR = "MESSENGERBOTR"
    WEB = "WEB"


class WorkerQueueName(StrEnum):
    POLL = "orsem-poll"
    FILING = "orsem-filing"
    AI_REVIEW = "orsem-ai-review"
    NEWS_TRANSLATION = "orsem-news-translation"
    OUTBOX = "orsem-outbox"
    CONNECTOR_HEALTH = "orsem-connector-health"
    MARKET_DATA = "orsem-market-data"
    MARKET_NEWS = "orsem-market-news"


class WorkerJobName(StrEnum):
    PROCESS_ANALYSIS_JOB = "process-analysis-job"
    POLL_OPENDART = "poll-opendart"
    BACKFILL_OPENDART = "backfill-opendart"
    SYNC_CORP_CODES = "sync-opendart-corp-codes"
    ENRICH_FILING = "enrich-filing"
    APPLY_PARSE_PROJECTION = "apply-parse-projection"
    REVIEW_PARSE_WITH_AI = "review-parse-with-ai"
    TRANSLATE_NEWS_BATCH = "translate-news-batch"
    DISPATCH_OUTBOX = "dispatch-processing-outbox"
    CHECK_CONNECTORS = "check-connectors"
    DISCOVER_LINKS = "discover-news-links"
    SYNC_SEC_CIK = "sync-sec-cik"
    SYNC_ALPACA_ASSETS = "sync-alpaca-assets"
    INGEST_TOSS_CANDLES = "ingest-toss-candles"
    SYNC_TOSS_STOCKS = "sync-toss-stocks"


QueueName = WorkerQueueName
JobName = WorkerJobName
DISCLOSURE_TYPES = ("D001", "D002", "D003", "D004", "D005")
