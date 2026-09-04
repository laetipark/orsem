import type {
  TransactionNature,
  ProxySolicitation,
  TenderOffer,
  LargeHolding,
} from '@orsem/contracts';
export type Region = 'all' | 'kr' | 'us';
export type NewsSourceKind =
  | 'OFFICIAL_DISCLOSURE'
  | 'OFFICIAL_RELEASE'
  | 'COMPANY_IR'
  | 'PRESS_RELEASE'
  | 'INDEPENDENT_MEDIA'
  | 'UNKNOWN';
export type DisclosureType = 'D001' | 'D002' | 'D003' | 'D004' | 'D005' | 'NEWS' | 'SEC';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type Direction = 'INCREASE' | 'DECREASE' | 'NEUTRAL' | 'UNKNOWN';
export type { TransactionNature } from '@orsem/contracts';
export type RightsMode =
  | 'OFFICIAL_PUBLIC_DATA'
  | 'PRIVATE_DISPLAY_ONLY'
  | 'STORE_METADATA_ONLY'
  | 'LINK_ONLY'
  | 'NO_REDISTRIBUTION';
export type SubmissionKind =
  'INITIAL' | 'CORRECTION' | 'ATTACHMENT_CORRECTION' | 'WITHDRAWAL' | 'UNKNOWN';
export type EffectiveState = 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED' | 'WITHDRAWN';
export type EvidenceGrade = 'A' | 'B' | 'C' | 'UNVERIFIED';
export type ClassificationStatus =
  'RULE_CONFIRMED' | 'AI_CONFIRMED' | 'AI_SUGGESTED' | 'REVIEW_REQUIRED';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface NaverNewsSearchItem {
  title: string;
  originallink: string;
  link: string;
  description: string;
  pubDate: string;
}

export interface NaverNewsSearchResult {
  provider: 'NAVER';
  lastBuildDate: string;
  total: number;
  start: number;
  display: number;
  items: NaverNewsSearchItem[];
}

export interface NewsTranslation {
  language: 'ko';
  title: string;
  description: string | null;
  translatedAt: string;
  provider: 'LOCAL';
  model: string;
}

export interface SourceItem {
  id: string;
  articleId?: string | null;
  sourceCount?: number;
  sourceKind?: NewsSourceKind;
  publisherId?: string | null;
  marketRegion?: 'kr' | 'us' | 'global' | 'unknown' | null;
  sources?: Array<{ id: string; source: string; sourceName: string | null; url: string }>;
  source: string;
  externalId: string | null;
  url: string;
  title: string;
  description?: string | null;
  translation?: NewsTranslation | null;
  sourceName: string | null;
  author: string | null;
  publishedAt: string | null;
  firstObservedAt: string;
  processedAt: string | null;
  rightsMode: RightsMode;
  provenanceUrl: string | null;
  tickers: string[];
  tags: string[];
}

export interface SearchItem {
  id: string;
  type: 'COMPANY' | 'NEWS' | 'FILING';
  title: string;
  subtitle: string;
  url: string;
  external: boolean;
  companyId: string | null;
  source: string | null;
  rightsMode: RightsMode | null;
  publishedAt: string | null;
  rceptDate: string | null;
  firstObservedAt: string | null;
  translation?: NewsTranslation | null;
}

export interface SearchResults {
  query: string;
  companies: SearchItem[];
  news: SearchItem[];
  filings: SearchItem[];
  hasMore: { companies: boolean; news: boolean; filings: boolean };
}

export interface SourceEvidence {
  id: string;
  source: string;
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string | null;
  firstObservedAt: string;
  grade: EvidenceGrade;
  rightsMode: RightsMode;
  isOfficial: boolean;
  excerpt?: string;
  description?: string | null;
  translation?: NewsTranslation | null;
}

export interface Transaction {
  id: string;
  eventDate: string | null;
  securityTypeRaw: string;
  methodRaw: string;
  nature: TransactionNature;
  direction: Direction;
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
  currency: 'KRW' | 'USD' | null;
  sharesAfter: string | null;
  parserConfidence: number;
}

export interface EventSummary {
  id: string;
  companyId: string;
  companyName: string;
  stockCode: string | null;
  ticker?: string | null;
  market: string;
  priority: Priority;
  detailType: DisclosureType;
  title: string;
  summary: string;
  nature: TransactionNature | null;
  direction: Direction;
  eventAt: string | null;
  rceptDate: string | null;
  publishedAt: string | null;
  firstObservedAt: string;
  submissionKind: SubmissionKind;
  effectiveState: EffectiveState;
  evidenceGrade: EvidenceGrade;
  classificationStatus: ClassificationStatus;
  sourceName: string;
  rightsMode: RightsMode;
  officialUrl: string;
  translation?: NewsTranslation | null;
}

export interface EventDetail extends EventSummary {
  tradePlan?: {
    plannedStartDate: string | null;
    plannedEndDate: string | null;
    plannedQuantity: string | null;
    plannedAmount: string | null;
    methodRaw: string | null;
    planStatus: 'PLANNED' | 'PARTIALLY_EXECUTED' | 'EXECUTED' | 'CANCELLED';
  } | null;
  proxySolicitation?: ProxySolicitation | null;
  tenderOffer?: TenderOffer | null;
  largeHolding?: LargeHolding | null;
  filerName: string;
  reporterName: string | null;
  relationship: string | null;
  position: string | null;
  ownershipBefore: string | null;
  ownershipAfter: string | null;
  ownershipChange: string | null;
  ownershipRateAfter: string | null;
  parserVersion: string | null;
  transactions: Transaction[];
  evidence: SourceEvidence[];
  lineage: Array<{
    id: string;
    label: string;
    submissionKind: SubmissionKind;
    effectiveState: EffectiveState;
    rceptDate: string | null;
    publishedAt: string | null;
  }>;
  limitations: string[];
}

export interface SourceFreshness {
  id: string;
  name: string;
  category: 'OFFICIAL' | 'NEWS' | 'MARKET';
  status: 'HEALTHY' | 'DEGRADED' | 'DISABLED' | 'UNCONFIGURED' | 'FAILED';
  lastSuccessAt: string | null;
  lagSeconds: number | null;
  rightsMode: RightsMode;
  message: string | null;
}

export interface DashboardData {
  asOf: string;
  todayCounts: Record<'D001' | 'D002' | 'D005', number> & Partial<Record<'D003' | 'D004', number>>;
  priorities: {
    P1: EventSummary[];
    P2: EventSummary[];
  };
  reviewPending: number;
  parserFailures: number;
  integrity?: ParseIntegrityMetrics;
  alertFailures: number;
  sources: SourceFreshness[];
  recentlyVerified: EventSummary[];
}

export interface ParseIntegrityMetrics {
  asOf: string;
  totalParseRuns: number;
  failedParseRuns: number;
  openReviewRows: number;
  currentReviewSubjects: number;
  currentUnrecoveredFilings: number;
  currentFailedFilings: number;
  staleOpenParseReviews: number;
  supersededReviews: number;
  documentUnavailableReviews: number;
  relationReviews: number;
  currentTypeMismatches: number;
  futureCreatedRows: number;
}

export interface CompanySummary {
  id: string;
  nameKo: string;
  nameEn: string | null;
  stockCode: string | null;
  ticker: string | null;
  market: string;
  sector: string;
  priority: Priority | null;
  isListed: boolean;
  isWatchlisted: boolean;
  lastEventAt: string | null;
}

export interface CompanyDetail extends CompanySummary {
  corpCode: string | null;
  cik: string | null;
  thesis: string | null;
  tags: string[];
  recentEvents: EventSummary[];
  provenance: SourceEvidence[];
}

export interface PricePoint {
  time: string;
  sessionDate?: string;
  observedAt?: string | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
  rightsMode: RightsMode;
}

export interface PriceSource {
  source: string;
  sourceName: string;
  rightsMode: RightsMode;
  feed: string | null;
  adjustment: string | null;
  attribution: string;
  limitation: string;
}

export interface TimelineMarker {
  time: string;
  kind: 'TRADE' | 'FILING' | 'NEWS';
  eventId: string;
  label: string;
  detailType: DisclosureType;
  returnWindows: {
    pre1d: number | null;
    post1d: number | null;
    post5d: number | null;
    post20d: number | null;
  };
}

export interface CompanyTimeline {
  companyId: string;
  provider?: 'toss';
  interval?: '1d' | '1m';
  status?: 'READY' | 'NOT_CONFIGURED' | 'PENDING';
  currency: 'KRW' | 'USD';
  prices: PricePoint[];
  priceSources: PriceSource[];
  markers: TimelineMarker[];
  returns: {
    oneDay: number | null;
    oneMonth: number | null;
    sinceLatestEvent: number | null;
    benchmarkOneMonth: number | null;
  };
  latestCloseAt: string | null;
}

export interface CompanyLivePrice {
  companyId: string;
  provider: 'toss';
  status: 'NOT_CONFIGURED' | 'WAITING' | 'LIVE' | 'STALE' | 'UNAVAILABLE';
  quote: {
    symbol: string;
    source: string;
    currency: 'KRW' | 'USD';
    price: string;
    providerAt: string;
    observedAt: string;
    rightsMode: RightsMode;
    lossy: true;
  } | null;
  asOf: string;
}

export interface WatchlistItem extends CompanySummary {
  addedAt: string;
  note: string | null;
  realtimeAlerts: boolean;
  digestAlerts: boolean;
}

export interface ReviewItem {
  id: string;
  eventId: string;
  companyName: string;
  detailType: DisclosureType;
  canonicalType?: string | null;
  classificationStatus?: string | null;
  officialUrl?: string | null;
  staged?: boolean;
  sourceReviewRequired?: boolean;
  sourceReviewConfirmed?: boolean;
  sourceReviewConfirmedAt?: string | null;
  validationStatus?: string | null;
  crosscheckStatus?: string | null;
  crosscheckReady?: boolean;
  candidateRowCount?: number;
  candidateEvidence?: string[];
  candidateWarnings?: string[];
  crosscheckEvidence?: unknown;
  reason: string;
  methodRaw: string | null;
  extractedText: string | null;
  proposedNature: TransactionNature;
  parserConfidence: number;
  createdAt: string;
  status: 'OPEN' | 'RESOLVED' | 'DISMISSED' | 'SUPERSEDED';
  planExecutionCandidates?: PlanExecutionCandidate[];
}

export interface PlanExecutionCandidate {
  matchId: string;
  transactionId: string;
  planItemId: string;
  eventDate: string | null;
  actualQuantity: string | null;
  plannedQuantity: string | null;
  actualMethodRaw: string;
  plannedMethodRaw: string | null;
  confidence: number;
  matchedFields: string[];
}

export interface ReviewResolution {
  id: string;
  status: 'OPEN' | 'RESOLVED';
  resolution: 'CONFIRMED' | 'UNKNOWN' | 'DUPLICATE' | 'CORRECTION_LINKED';
  note: string | null;
  resolvedAt: string | null;
  queued?: boolean;
}

export interface OperationRun {
  id: string;
  source: string;
  job: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  startedAt: string;
  finishedAt: string | null;
  processed: number;
  failed: number;
  message: string | null;
}

export interface QueueMetric {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  oldestWaitingAt: string | null;
}

export interface Session {
  authenticated: boolean;
  canAccess: boolean;
  csrfToken: string;
  user: {
    id: string;
    email: string | null;
    totpEnabled: boolean;
    displayName: string | null;
    provider: 'LOCAL' | 'KAKAO';
    role: 'ADMIN' | 'VIEWER';
    status: 'APPROVED' | 'PENDING' | 'REJECTED';
  } | null;
  setupRequired: boolean;
}

export interface KakaoConfig {
  enabled: boolean;
  startUrl: string | null;
}

export interface Member {
  id: string;
  displayName: string | null;
  provider: 'KAKAO';
  role: 'VIEWER';
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  reviewedAt: string | null;
}

export interface WatchlistQuote {
  companyId: string;
  status: CompanyLivePrice['status'];
  quote: CompanyLivePrice['quote'];
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  referenceDate: string | null;
}

export interface MarketInstrument {
  id: string;
  name: string;
  region: 'kr' | 'us' | 'global';
  category: 'INDEX' | 'FX' | 'BOND' | 'METAL' | 'ENERGY' | 'CRYPTO';
  currency: 'KRW' | 'USD' | null;
  unit: string;
  provider: string;
  symbol: string;
  sourceUrl: string;
  attribution: string;
  rightsMode: RightsMode;
  displayKind: 'NATIVE' | 'WIDGET';
  widgetSymbol: string | null;
  historyKind: 'close' | 'daily_average' | 'yield' | 'observed';
  description: string;
}
export interface MarketQuote extends MarketInstrument {
  status: 'AVAILABLE' | 'STALE' | 'NOT_CONFIGURED' | 'WAITING' | 'UNAVAILABLE' | 'EMBEDDED';
  value: string | null;
  change: string | null;
  changePercent: string | null;
  changeUnit: 'percent' | 'bp';
  changeLabel: string;
  valueDate: string | null;
  providerAt: string | null;
  observedAt: string | null;
  referenceValue: string | null;
  referenceDate: string | null;
  convertedValue: string | null;
  conversionRate: string | null;
  conversionAt: string | null;
  message: string | null;
}
export interface MarketHistory {
  asOf: string;
  instrument: MarketInstrument;
  range: '1m' | '3m' | '1y';
  points: Array<{ date: string; value: string }>;
  historyKind: MarketInstrument['historyKind'];
  status: string;
  message: string | null;
  sourceUrl: string;
}

export type NotificationTopic = 'FILINGS' | 'ANALYSIS' | 'CORRECTIONS' | 'NEWS' | 'OPERATIONS';
export interface NotificationPreferences {
  filingTypes?: Array<Exclude<DisclosureType, 'NEWS' | 'SEC'>>;
  enabled: boolean;
  topics: NotificationTopic[];
  watchlistOnly: boolean;
}
export interface NotificationSettings extends NotificationPreferences {
  pushConfigured: boolean;
  publicKey: string | null;
  subscriptions: Array<{ id: string; deviceName: string; createdAt: string; lastSeenAt: string }>;
}
export interface BrowserSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
  deviceName: string;
}
