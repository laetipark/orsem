export const DisclosureDetailType = {
  D001: 'D001',
  D002: 'D002',
  D005: 'D005',
} as const;
export type DisclosureDetailType = (typeof DisclosureDetailType)[keyof typeof DisclosureDetailType];
export const DartDetailType = DisclosureDetailType;
export type DartDetailType = DisclosureDetailType;

export const SubmissionKind = {
  INITIAL: 'INITIAL',
  CORRECTION: 'CORRECTION',
  ATTACHMENT_CORRECTION: 'ATTACHMENT_CORRECTION',
  WITHDRAWAL: 'WITHDRAWAL',
  UNKNOWN: 'UNKNOWN',
} as const;
export type SubmissionKind = (typeof SubmissionKind)[keyof typeof SubmissionKind];

export const EffectiveFilingState = {
  ACTIVE: 'ACTIVE',
  SUPERSEDED: 'SUPERSEDED',
  WITHDRAWN: 'WITHDRAWN',
  CANCELLED: 'CANCELLED',
} as const;
export type EffectiveFilingState = (typeof EffectiveFilingState)[keyof typeof EffectiveFilingState];

/** @deprecated SubmissionKind와 EffectiveFilingState를 각각 사용하세요. */
export const FilingState = { ...SubmissionKind, ...EffectiveFilingState } as const;
/** @deprecated SubmissionKind와 EffectiveFilingState를 각각 사용하세요. */
export type FilingState = (typeof FilingState)[keyof typeof FilingState];

export const FilingRelationType = {
  CORRECTS: 'CORRECTS',
  CANCELS: 'CANCELS',
  WITHDRAWS: 'WITHDRAWS',
  SUPERSEDES: 'SUPERSEDES',
  FULFILLS_PLAN: 'FULFILLS_PLAN',
  EXECUTION_CANDIDATE: 'EXECUTION_CANDIDATE',
  RELATED: 'RELATED',
} as const;
export type FilingRelationType = (typeof FilingRelationType)[keyof typeof FilingRelationType];

export const RelationSource = {
  EXPLICIT: 'EXPLICIT',
  HEURISTIC: 'HEURISTIC',
  MANUAL: 'MANUAL',
} as const;
export type RelationSource = (typeof RelationSource)[keyof typeof RelationSource];

export const RelationReviewDecision = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type RelationReviewDecision =
  (typeof RelationReviewDecision)[keyof typeof RelationReviewDecision];

export const ParseStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;
export type ParseStatus = (typeof ParseStatus)[keyof typeof ParseStatus];

export const TransactionNature = {
  MARKET_BUY: 'MARKET_BUY',
  MARKET_SELL: 'MARKET_SELL',
  BLOCK_BUY: 'BLOCK_BUY',
  BLOCK_SELL: 'BLOCK_SELL',
  GIFT_IN: 'GIFT_IN',
  GIFT_OUT: 'GIFT_OUT',
  OPTION_EXERCISE: 'OPTION_EXERCISE',
  RSU_RSA: 'RSU_RSA',
  CONVERSION: 'CONVERSION',
  STOCK_SPLIT_MERGER: 'STOCK_SPLIT_MERGER',
  TRUST_TRANSFER: 'TRUST_TRANSFER',
  INHERITANCE: 'INHERITANCE',
  OTHER: 'OTHER',
  UNKNOWN: 'UNKNOWN',
} as const;
export type TransactionNature = (typeof TransactionNature)[keyof typeof TransactionNature];

export const Direction = {
  INCREASE: 'INCREASE',
  DECREASE: 'DECREASE',
  NEUTRAL: 'NEUTRAL',
  UNKNOWN: 'UNKNOWN',
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export const RightsMode = {
  OFFICIAL_PUBLIC_DATA: 'OFFICIAL_PUBLIC_DATA',
  PRIVATE_DISPLAY_ONLY: 'PRIVATE_DISPLAY_ONLY',
  STORE_METADATA_ONLY: 'STORE_METADATA_ONLY',
  LINK_ONLY: 'LINK_ONLY',
  NO_REDISTRIBUTION: 'NO_REDISTRIBUTION',
} as const;
export type RightsMode = (typeof RightsMode)[keyof typeof RightsMode];
/** @deprecated RightsMode를 사용하세요. */
export const RightsStatus = RightsMode;
/** @deprecated RightsMode를 사용하세요. */
export type RightsStatus = RightsMode;

export const EvidenceGrade = {
  A: 'A',
  B: 'B',
  C: 'C',
  UNVERIFIED: 'UNVERIFIED',
} as const;
export type EvidenceGrade = (typeof EvidenceGrade)[keyof typeof EvidenceGrade];

export const EventType = {
  INSIDER_OWNERSHIP: 'INSIDER_OWNERSHIP',
  LARGE_HOLDER: 'LARGE_HOLDER',
  TRADE_PLAN: 'TRADE_PLAN',
  NEWS: 'NEWS',
  CORRECTION: 'CORRECTION',
  OTHER: 'OTHER',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const EventState = {
  OPEN: 'OPEN',
  VERIFIED: 'VERIFIED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  SUPERSEDED: 'SUPERSEDED',
  CANCELLED: 'CANCELLED',
} as const;
export type EventState = (typeof EventState)[keyof typeof EventState];

export const AlertStatus = {
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type AlertStatus = (typeof AlertStatus)[keyof typeof AlertStatus];

export const ClassificationReviewResult = {
  RULE_CONFIRMED: 'RULE_CONFIRMED',
  AI_CONFIRMED: 'AI_CONFIRMED',
  AI_SUGGESTED: 'AI_SUGGESTED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
} as const;
export type ClassificationReviewResult =
  (typeof ClassificationReviewResult)[keyof typeof ClassificationReviewResult];

export const ReviewTaskStatus = {
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
  SUPERSEDED: 'SUPERSEDED',
} as const;
export type ReviewTaskStatus = (typeof ReviewTaskStatus)[keyof typeof ReviewTaskStatus];
/** @deprecated ReviewTaskStatus를 사용하세요. */
export const ReviewStatus = ReviewTaskStatus;
/** @deprecated ReviewTaskStatus를 사용하세요. */
export type ReviewStatus = ReviewTaskStatus;

export const ConnectorStatus = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  DISABLED: 'DISABLED',
  UNCONFIGURED: 'UNCONFIGURED',
  FAILED: 'FAILED',
} as const;
export type ConnectorStatus = (typeof ConnectorStatus)[keyof typeof ConnectorStatus];

export const ProcessingStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type ProcessingStatus = (typeof ProcessingStatus)[keyof typeof ProcessingStatus];

export const WatchPriority = {
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
} as const;
export type WatchPriority = (typeof WatchPriority)[keyof typeof WatchPriority];

export const Market = {
  KRX: 'KRX',
  KOSPI: 'KOSPI',
  KOSDAQ: 'KOSDAQ',
  KONEX: 'KONEX',
  NASDAQ: 'NASDAQ',
  NYSE: 'NYSE',
  AMEX: 'AMEX',
  OTHER: 'OTHER',
} as const;
export type Market = (typeof Market)[keyof typeof Market];

export const DeliveryChannel = {
  TELEGRAM: 'TELEGRAM',
  DISCORD: 'DISCORD',
  MESSENGERBOTR: 'MESSENGERBOTR',
  WEB: 'WEB',
} as const;
export type DeliveryChannel = (typeof DeliveryChannel)[keyof typeof DeliveryChannel];

export const WorkerQueueName = {
  POLL: 'orsem-poll',
  FILING: 'orsem-filing',
  AI_REVIEW: 'orsem-ai-review',
  NEWS_TRANSLATION: 'orsem-news-translation',
  OUTBOX: 'orsem-outbox',
  CONNECTOR_HEALTH: 'orsem-connector-health',
  MARKET_DATA: 'orsem-market-data',
} as const;
export type WorkerQueueName = (typeof WorkerQueueName)[keyof typeof WorkerQueueName];

export const WorkerJobName = {
  POLL_OPENDART: 'poll-opendart',
  BACKFILL_OPENDART: 'backfill-opendart',
  SYNC_CORP_CODES: 'sync-opendart-corp-codes',
  ENRICH_FILING: 'enrich-filing',
  APPLY_PARSE_PROJECTION: 'apply-parse-projection',
  REVIEW_PARSE_WITH_AI: 'review-parse-with-ai',
  TRANSLATE_NEWS_BATCH: 'translate-news-batch',
  DISPATCH_OUTBOX: 'dispatch-processing-outbox',
  CHECK_CONNECTORS: 'check-connectors',
  DISCOVER_LINKS: 'discover-news-links',
  SYNC_SEC_CIK: 'sync-sec-cik',
  SYNC_ALPACA_ASSETS: 'sync-alpaca-assets',
  INGEST_TOSS_CANDLES: 'ingest-toss-candles',
  SYNC_TOSS_STOCKS: 'sync-toss-stocks',
} as const;
export type WorkerJobName = (typeof WorkerJobName)[keyof typeof WorkerJobName];
