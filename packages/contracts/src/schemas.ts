import type { GroupDisplayPrice } from './watchlist-groups';
import { z } from 'zod';
import { regionSchema } from './region';
import { NEWS_IR_SOURCE_PROFILES, NewsContentState, NewsSourceKind } from './news-sources';
import {
  AlertStatus,
  ClassificationReviewResult,
  ConnectorStatus,
  Direction,
  DisclosureDetailType,
  EventState,
  EventType,
  EvidenceGrade,
  EffectiveFilingState,
  FilingRelationType,
  Market,
  ParseStatus,
  RelationReviewDecision,
  RelationSource,
  ReviewTaskStatus,
  RightsMode,
  SubmissionKind,
  TransactionNature,
  WatchPriority,
} from './enums';

export const idSchema = z.string().min(1).max(64);
export const isoInstantSchema = z.string().datetime({ offset: true });
export const dateOnlySchema = z.iso.date();
export const integerStringSchema = z.string().regex(/^-?\d+$/);
export const decimalStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const nullableIntegerStringSchema = integerStringSchema.nullable();
export const nullableDecimalStringSchema = decimalStringSchema.nullable();
export const cursorSchema = z.string().min(1).max(2048);
export const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        !parsed.username &&
        !parsed.password
      );
    },
    { message: 'HTTP(S) URL without embedded credentials is required' },
  );

function isPrivateAddressLiteral(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return true;
  }
  const octets = host.split('.').map((part) => Number(part));
  if (
    octets.length === 4 &&
    octets.every(
      (octet, index) =>
        Number.isInteger(octet) &&
        octet >= 0 &&
        octet <= 255 &&
        String(octet) === host.split('.')[index],
    )
  ) {
    const [first = 0, second = 0] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  return (
    host === '::' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    /^fe[89ab]/.test(host) ||
    // WHATWG URL 파서는 점으로 표기한 IPv4 매핑 주소를 16진수 IPv6로
    // 정규화할 수 있습니다(예: ::ffff:7f00:1). IR 피드에 이런 주소를 사용할
    // 운영상 필요가 없으므로, 사설 주소 판별기를 두 형태에 맞춰 유지하지 않고
    // 매핑 주소 범위 전체를 거절합니다.
    host.startsWith('::ffff:') ||
    host.startsWith('ff')
  );
}

/**
 * 저장된 IR 피드는 worker가 가져오므로 API 경계에서 명백한 SSRF 대상을 거절합니다.
 * 공개 호스트 이름도 나중에 사설 주소로 바뀔 수 있으므로 worker는 연결 직전에
 * DNS를 다시 조회하고 사용할 주소를 고정해야 합니다.
 */
export const publicHttpsFeedUrlSchema = z
  .string()
  .url()
  .max(4000)
  .refine(
    (value) => {
      const parsed = new URL(value);
      return (
        parsed.protocol === 'https:' &&
        !parsed.username &&
        !parsed.password &&
        !isPrivateAddressLiteral(parsed.hostname)
      );
    },
    { message: 'A credential-free public HTTPS feed URL is required' },
  );

export const cursorQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  region: regionSchema,
});

export const pageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const companySchema = z.object({
  id: idSchema,
  market: z.enum(Market),
  corpCode: z.string().length(8).nullable(),
  stockCode: z.string().length(6).nullable(),
  ticker: z.string().max(32).nullable(),
  cik: z.string().length(10).nullable(),
  nameKo: z.string().min(1),
  nameEn: z.string().nullable(),
  isListed: z.boolean(),
  updatedAt: isoInstantSchema,
});
export type Company = z.infer<typeof companySchema>;

export const watchlistItemSchema = z.object({
  id: idSchema,
  company: companySchema,
  priority: z.enum(WatchPriority),
  realtimeAlerts: z.boolean(),
  digestAlerts: z.boolean(),
  notes: z.string().nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type WatchlistItem = z.infer<typeof watchlistItemSchema>;

export const createWatchlistItemSchema = z.object({
  companyId: idSchema,
  priority: z.enum(WatchPriority).default(WatchPriority.P2),
  realtimeAlerts: z.boolean().default(true),
  digestAlerts: z.boolean().default(false),
  notes: z.string().trim().max(1000).nullable().optional(),
  /** 대시보드에서 사용하는 단수형 필드 이름과의 호환성을 유지합니다. */
  note: z.string().trim().max(1000).nullable().optional(),
});
export const updateWatchlistItemSchema = createWatchlistItemSchema
  .omit({ companyId: true })
  .partial();

export const transactionSchema = z.object({
  id: idSchema,
  eventDate: dateOnlySchema.nullable(),
  securityTypeRaw: z.string(),
  methodRaw: z.string(),
  nature: z.enum(TransactionNature),
  direction: z.enum(Direction),
  quantity: nullableDecimalStringSchema,
  unitPrice: nullableDecimalStringSchema,
  amount: nullableDecimalStringSchema,
  currency: z.literal('KRW').nullable(),
  sharesAfter: nullableDecimalStringSchema,
  parserConfidence: z.number().min(0).max(1),
});
export type InsiderTransaction = z.infer<typeof transactionSchema>;

export const filingSummarySchema = z.object({
  id: idSchema,
  rceptNo: z.string().min(8).max(32),
  detailType: z.enum(DisclosureDetailType),
  reportName: z.string(),
  filerName: z.string(),
  rceptDate: dateOnlySchema,
  submissionKind: z.enum(SubmissionKind),
  effectiveState: z.enum(EffectiveFilingState),
  firstObservedAt: isoInstantSchema,
  lastSeenAt: isoInstantSchema,
  processedAt: isoInstantSchema.nullable(),
  parseStatus: z.enum(ParseStatus).nullable(),
  parserConfidence: z.number().min(0).max(1).nullable(),
  company: companySchema,
  officialUrl: httpUrlSchema,
});
export type FilingSummary = z.infer<typeof filingSummarySchema>;

export const reportReasonKindSchema = z.enum([
  'HOLDINGS_CHANGE',
  'CONTRACT_CHANGE',
  'REPORTING_STATUS_CHANGE',
  'UNKNOWN',
]);
export const proxySolicitationSchema = z.object({
  solicitorName: z.string().nullable(),
  targetCompanyName: z.string().nullable(),
  relationshipRaw: z.string().nullable(),
  meetingDate: dateOnlySchema.nullable(),
  meetingTimeRaw: z.string().nullable(),
  meetingAt: isoInstantSchema.nullable(),
  meetingLocation: z.string().nullable(),
  solicitationStartDate: dateOnlySchema.nullable(),
  solicitationEndDate: dateOnlySchema.nullable(),
  purposeRaw: z.string().nullable(),
  electronicVoting: z.boolean().nullable(),
  agendas: z.array(z.object({ ordinal: z.number().int().nonnegative(), title: z.string() })),
});
export type ProxySolicitation = z.infer<typeof proxySolicitationSchema>;
export const tenderOfferSecuritySchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  securityTypeRaw: z.string(),
  unitPrice: nullableDecimalStringSchema,
  currency: z.string().nullable(),
  minQuantity: nullableDecimalStringSchema,
  maxQuantity: nullableDecimalStringSchema,
  heldQuantity: nullableDecimalStringSchema,
  expectedHoldingsMin: nullableDecimalStringSchema,
  expectedHoldingsMax: nullableDecimalStringSchema,
  offeredQuantity: nullableDecimalStringSchema,
  acquiredQuantity: nullableDecimalStringSchema,
  actualAmount: nullableDecimalStringSchema,
});
export const tenderOfferSchema = z.object({
  documentKind: z.enum(['REPORT', 'EXPLANATION', 'RESULT', 'OTHER']),
  offerorName: z.string().nullable(),
  targetCompanyName: z.string().nullable(),
  purposeRaw: z.string().nullable(),
  conditionsRaw: z.string().nullable(),
  subscriptionStartDate: dateOnlySchema.nullable(),
  subscriptionEndDate: dateOnlySchema.nullable(),
  settlementDate: dateOnlySchema.nullable(),
  securities: z.array(tenderOfferSecuritySchema),
});
export type TenderOffer = z.infer<typeof tenderOfferSchema>;
export const largeHoldingSchema = z.object({
  reporterName: z.string(),
  reportReasonRaw: z.string().nullable(),
  holdingPurposeRaw: z.string().nullable(),
  reportReasonKind: reportReasonKindSchema,
  sharesBefore: nullableDecimalStringSchema,
  sharesAfter: nullableDecimalStringSchema,
  ownershipRateBefore: nullableDecimalStringSchema,
  ownershipRateAfter: nullableDecimalStringSchema,
  changes: z.array(
    z.object({
      id: idSchema,
      eventDate: dateOnlySchema.nullable(),
      methodRaw: z.string().nullable(),
      direction: z.enum(Direction),
      shareChange: nullableDecimalStringSchema,
    }),
  ),
});
export type LargeHolding = z.infer<typeof largeHoldingSchema>;

export const filingDetailSchema = filingSummarySchema.extend({
  proxySolicitation: proxySolicitationSchema.nullable().optional(),
  tenderOffer: tenderOfferSchema.nullable().optional(),
  largeHolding: largeHoldingSchema.nullable().optional(),
  parserVersion: z.string().nullable(),
  rm: z.string().nullable(),
  reporter: z
    .object({
      name: z.string(),
      relationship: z.string().nullable(),
      position: z.string().nullable(),
      isRegisteredExecutive: z.boolean().nullable(),
      isMajorShareholder: z.boolean().nullable(),
      ownershipBefore: nullableDecimalStringSchema,
      ownershipAfter: nullableDecimalStringSchema,
      ownershipChange: nullableDecimalStringSchema,
      ownershipRateAfter: nullableDecimalStringSchema,
    })
    .nullable(),
  transactions: z.array(transactionSchema),
  tradePlan: z
    .object({
      plannedStartDate: dateOnlySchema.nullable(),
      plannedEndDate: dateOnlySchema.nullable(),
      plannedQuantity: nullableDecimalStringSchema,
      plannedAmount: nullableDecimalStringSchema,
      methodRaw: z.string().nullable(),
      planStatus: z.string(),
    })
    .nullable(),
  parserWarnings: z.array(z.string()),
  relations: z.array(
    z.object({
      id: idSchema,
      relationType: z.enum(FilingRelationType),
      relatedRceptNo: z.string(),
      confidence: z.number().min(0).max(1),
      source: z.enum(RelationSource),
      reviewRequired: z.boolean(),
      reviewDecision: z.enum(RelationReviewDecision),
    }),
  ),
});
export type FilingDetail = z.infer<typeof filingDetailSchema>;

export const filingQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  detailType: z.enum(DisclosureDetailType).optional(),
  submissionKind: z.enum(SubmissionKind).optional(),
  effectiveState: z.enum(EffectiveFilingState).optional(),
  parseStatus: z.enum(ParseStatus).optional(),
  nature: z.enum(TransactionNature).optional(),
  direction: z.enum(Direction).optional(),
  priority: z.enum(WatchPriority).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

// AZURE remains a valid stored-result provenance; new translations use LOCAL only.
export const newsTranslationSchema = z.object({
  language: z.literal('ko'),
  title: z.string().trim().min(1),
  description: z.string().nullable(),
  translatedAt: isoInstantSchema,
  provider: z.enum(['LOCAL', 'AZURE']),
  editedAt: isoInstantSchema.optional(),
  model: z.string().trim().min(1),
});
export type NewsTranslation = z.infer<typeof newsTranslationSchema>;

const newsContentTextSchema = z.string().trim().min(1).max(20_000);
export const newsContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PARAGRAPH'), text: newsContentTextSchema }),
  z.object({
    type: z.literal('HEADING'),
    level: z.number().int().min(2).max(6),
    text: newsContentTextSchema,
  }),
  z.object({
    type: z.literal('LIST'),
    ordered: z.boolean(),
    items: z.array(newsContentTextSchema).min(1).max(200),
  }),
  z.object({ type: z.literal('QUOTE'), text: newsContentTextSchema }),
]);
export type NewsContentBlock = z.infer<typeof newsContentBlockSchema>;

const newsContentLanguageSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/u)
  .max(35);
export const newsContentOriginalSchema = z.object({
  language: newsContentLanguageSchema,
  blocks: z.array(newsContentBlockSchema).min(1).max(2_000),
  fetchedAt: isoInstantSchema,
});
export type NewsContentOriginal = z.infer<typeof newsContentOriginalSchema>;

export const newsContentTranslationSchema = z.object({
  language: z.literal('ko'),
  blocks: z.array(newsContentBlockSchema).min(1).max(2_000),
  translatedAt: isoInstantSchema,
  provider: z.enum(['LOCAL', 'AZURE']),
  format: z.literal('MARKDOWN').optional(),
  editedAt: isoInstantSchema.optional(),
  model: z.string().trim().min(1),
});
export type NewsContentTranslation = z.infer<typeof newsContentTranslationSchema>;

export const newsArticleContentDetailSchema = z.object({
  sourceItemId: idSchema,
  original: newsContentOriginalSchema,
  translation: newsContentTranslationSchema.nullable(),
});
export type NewsArticleContentDetail = z.infer<typeof newsArticleContentDetailSchema>;

export const newsTranslationEditInputSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    title: z.string().trim().min(1).max(2_000),
    description: z.string().trim().max(20_000).nullable(),
    markdown: z.string().trim().min(1).max(100_000),
  })
  .strict();
export type NewsTranslationEditInput = z.infer<typeof newsTranslationEditInputSchema>;
export const newsTranslationEditSchema = z.object({
  sourceItemId: idSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  original: z.object({
    title: z.string(),
    description: z.string().nullable(),
    language: z.string(),
    markdown: z.string(),
  }),
  translation: z.object({
    title: z.string(),
    description: z.string().nullable(),
    markdown: z.string(),
  }),
  editedAt: isoInstantSchema.nullable(),
  editedByAdminId: idSchema.nullable(),
});
export type NewsTranslationEdit = z.infer<typeof newsTranslationEditSchema>;

export const sourceItemSchema = z.object({
  id: idSchema,
  displayMode: z.enum(['INTERNAL_CONTENT', 'EXTERNAL_LINK']).optional(),
  relatedCompanies: z
    .array(
      companySchema.pick({
        id: true,
        market: true,
        stockCode: true,
        ticker: true,
        nameKo: true,
        nameEn: true,
      }),
    )
    .optional(),
  articleId: idSchema.nullable().optional(),
  sourceKind: z.enum(NewsSourceKind).optional(),
  sourceCount: z.number().int().positive().optional(),
  contentState: z.enum(NewsContentState),
  contentSourceId: idSchema.nullable(),
  contentLanguage: newsContentLanguageSchema.nullable(),
  translated: z.boolean(),
  publisherId: z.string().nullable().optional(),
  marketRegion: z.enum(['kr', 'us', 'global', 'unknown']).optional(),
  sources: z
    .array(
      z.object({
        id: idSchema,
        source: z.string(),
        sourceName: z.string().nullable(),
        url: httpUrlSchema,
      }),
    )
    .optional(),
  source: z.string(),
  externalId: z.string().nullable(),
  url: httpUrlSchema,
  title: z.string(),
  description: z.string().nullable().optional(),
  translation: newsTranslationSchema.nullable().optional(),
  sourceName: z.string().nullable(),
  author: z.string().nullable(),
  publishedAt: isoInstantSchema.nullable(),
  firstObservedAt: isoInstantSchema,
  processedAt: isoInstantSchema.nullable(),
  rightsMode: z.enum(RightsMode),
  provenanceUrl: httpUrlSchema.nullable(),
  tickers: z.array(z.string()),
  tags: z.array(z.string()),
});
export type SourceItem = z.infer<typeof sourceItemSchema>;

export const newsDetailSchema = sourceItemSchema.extend({
  content: newsArticleContentDetailSchema.nullable(),
});
export type NewsDetail = z.infer<typeof newsDetailSchema>;

const samsungGlobalFeedUrl = NEWS_IR_SOURCE_PROFILES['samsung-global'].url;

export const irSourceSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  url: z.literal(samsungGlobalFeedUrl),
  sourceType: z.literal('RSS'),
  rightsMode: z.literal(RightsMode.PRIVATE_DISPLAY_ONLY),
  isActive: z.boolean(),
  lastCheckedAt: isoInstantSchema.nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type IrSource = z.infer<typeof irSourceSchema>;

export const createIrSourceSchema = z.object({
  companyId: idSchema,
  url: z.literal(samsungGlobalFeedUrl),
  sourceType: z.literal('RSS').default('RSS'),
  rightsMode: z.literal(RightsMode.PRIVATE_DISPLAY_ONLY).default(RightsMode.PRIVATE_DISPLAY_ONLY),
  isActive: z.boolean().default(true),
});
export const updateIrSourceSchema = createIrSourceSchema.omit({ companyId: true }).partial();

export const eventSchema = z.object({
  id: idSchema,
  canonicalEventType: z.enum(EventType),
  occurredAt: isoInstantSchema.nullable(),
  publishedAt: isoInstantSchema.nullable(),
  firstObservedAt: isoInstantSchema,
  processedAt: isoInstantSchema.nullable(),
  state: z.enum(EventState),
  evidenceGrade: z.enum(EvidenceGrade),
  classificationResult: z.enum(ClassificationReviewResult).nullable(),
  summary: z.string(),
  company: companySchema.nullable(),
  filing: filingSummarySchema.nullable(),
  sourceItems: z.array(sourceItemSchema),
});
export type Event = z.infer<typeof eventSchema>;

export const disclosureViewTypeSchema = z.enum([
  'D001',
  'D002',
  'D003',
  'D004',
  'D005',
  'NEWS',
  'SEC',
]);

export const eventSummaryViewSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  companyName: z.string(),
  stockCode: z.string().length(6).nullable(),
  ticker: z.string().nullable().optional(),
  market: z.string(),
  priority: z.enum(WatchPriority),
  detailType: disclosureViewTypeSchema,
  title: z.string(),
  translation: newsTranslationSchema.nullable().optional(),
  summary: z.string(),
  nature: z.enum(TransactionNature).nullable(),
  direction: z.enum(Direction),
  eventAt: dateOnlySchema.nullable(),
  rceptDate: dateOnlySchema.nullable(),
  publishedAt: isoInstantSchema.nullable(),
  firstObservedAt: isoInstantSchema,
  processedAt: isoInstantSchema.nullable(),
  submissionKind: z.enum(SubmissionKind),
  effectiveState: z.enum(EffectiveFilingState),
  evidenceGrade: z.enum(EvidenceGrade),
  classificationStatus: z.enum(ClassificationReviewResult),
  sourceName: z.string(),
  rightsMode: z.enum(RightsMode),
  officialUrl: httpUrlSchema,
});
export type EventSummaryView = z.infer<typeof eventSummaryViewSchema>;

export const sourceEvidenceSchema = z.object({
  id: idSchema,
  source: z.string(),
  sourceName: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  translation: newsTranslationSchema.nullable().optional(),
  url: httpUrlSchema,
  publishedAt: isoInstantSchema.nullable(),
  firstObservedAt: isoInstantSchema,
  grade: z.enum(EvidenceGrade),
  rightsMode: z.enum(RightsMode),
  isOfficial: z.boolean(),
  excerpt: z.string().optional(),
});

export const eventDetailViewSchema = eventSummaryViewSchema.extend({
  proxySolicitation: proxySolicitationSchema.nullable().optional(),
  tenderOffer: tenderOfferSchema.nullable().optional(),
  largeHolding: largeHoldingSchema.nullable().optional(),
  tradePlan: filingDetailSchema.shape.tradePlan,
  filerName: z.string(),
  reporterName: z.string().nullable(),
  relationship: z.string().nullable(),
  position: z.string().nullable(),
  ownershipBefore: nullableDecimalStringSchema,
  ownershipAfter: nullableDecimalStringSchema,
  ownershipChange: nullableDecimalStringSchema,
  ownershipRateAfter: nullableDecimalStringSchema,
  parserVersion: z.string().nullable(),
  transactions: z.array(transactionSchema),
  evidence: z.array(sourceEvidenceSchema),
  lineage: z.array(
    z.object({
      id: idSchema,
      label: z.string(),
      submissionKind: z.enum(SubmissionKind),
      effectiveState: z.enum(EffectiveFilingState),
      rceptDate: dateOnlySchema.nullable(),
      publishedAt: isoInstantSchema.nullable(),
    }),
  ),
  limitations: z.array(z.string()),
});
export type EventDetailView = z.infer<typeof eventDetailViewSchema>;

export const companySummaryViewSchema = z.object({
  id: idSchema,
  nameKo: z.string(),
  nameEn: z.string().nullable(),
  stockCode: z.string().length(6).nullable(),
  ticker: z.string().nullable(),
  market: z.string(),
  sector: z.string(),
  priority: z.enum(WatchPriority).nullable(),
  isListed: z.boolean(),
  isWatchlisted: z.boolean(),
  lastEventAt: isoInstantSchema.nullable(),
});
export type CompanySummaryView = z.infer<typeof companySummaryViewSchema>;

export const companyDetailViewSchema = companySummaryViewSchema.extend({
  corpCode: z.string().length(8).nullable(),
  cik: z.string().length(10).nullable(),
  thesis: z.string().nullable(),
  tags: z.array(z.string()),
  recentEvents: z.array(eventSummaryViewSchema),
  provenance: z.array(sourceEvidenceSchema),
});
export type CompanyDetailView = z.infer<typeof companyDetailViewSchema>;

export const marketDataProviderSchema = z.literal('toss');
export const candleSourceSchema = z.enum(['TOSS_KR', 'TOSS_US']);
export type CandleSource = z.infer<typeof candleSourceSchema>;
export const priceIntervalSchema = z.enum(['1d', '1m']);
export const companyTimelineQuerySchema = z.object({
  range: z.enum(['1M', '3M', '1Y']).default('3M'),
  interval: priceIntervalSchema.default('1d'),
  source: marketDataProviderSchema.optional(),
});
export const priceTimeSchema = z.union([dateOnlySchema, isoInstantSchema]);

export const companyTimelineSchema = z
  .object({
    companyId: idSchema,
    currency: z.enum(['KRW', 'USD']),
    provider: marketDataProviderSchema,
    interval: priceIntervalSchema,
    status: z.enum(['READY', 'NOT_CONFIGURED', 'PENDING']),
    prices: z.array(
      z.object({
        time: priceTimeSchema,
        sessionDate: dateOnlySchema,
        observedAt: isoInstantSchema.nullable(),
        open: z.number(),
        high: z.number(),
        low: z.number(),
        close: z.number(),
        volume: z.number(),
        source: candleSourceSchema,
        rightsMode: z.enum(RightsMode),
      }),
    ),
    priceSources: z.array(
      z.object({
        source: candleSourceSchema,
        sourceName: z.string().min(1),
        rightsMode: z.enum(RightsMode),
        feed: z.string().nullable(),
        adjustment: z.string().nullable(),
        attribution: z.string().min(1),
        limitation: z.string().min(1),
      }),
    ),
    markers: z.array(
      z.object({
        time: dateOnlySchema,
        kind: z.enum(['TRADE', 'FILING', 'NEWS']),
        eventId: idSchema,
        label: z.string(),
        detailType: disclosureViewTypeSchema,
        returnWindows: z.object({
          pre1d: z.number().nullable(),
          post1d: z.number().nullable(),
          post5d: z.number().nullable(),
          post20d: z.number().nullable(),
        }),
      }),
    ),
    returns: z.object({
      oneDay: z.number().nullable(),
      oneMonth: z.number().nullable(),
      sinceLatestEvent: z.number().nullable(),
      benchmarkOneMonth: z.number().nullable(),
    }),
    latestCloseAt: priceTimeSchema.nullable(),
  })
  .superRefine((timeline, context) => {
    const timeSchema = timeline.interval === '1d' ? dateOnlySchema : isoInstantSchema;
    timeline.prices.forEach((point, index) => {
      if (!timeSchema.safeParse(point.time).success) {
        context.addIssue({
          code: 'custom',
          path: ['prices', index, 'time'],
          message: 'Time must match the selected interval',
        });
      }
    });
    if (timeline.latestCloseAt && !timeSchema.safeParse(timeline.latestCloseAt).success) {
      context.addIssue({
        code: 'custom',
        path: ['latestCloseAt'],
        message: 'Time must match the selected interval',
      });
    }
  });
export type CompanyTimeline = z.infer<typeof companyTimelineSchema>;

export const livePriceQuoteSchema = z.object({
  symbol: z.string().min(1).max(32),
  source: z.enum(['TOSS_KR', 'TOSS_KR_INTEGRATED', 'TOSS_US']),
  currency: z.enum(['KRW', 'USD']),
  price: decimalStringSchema.refine(
    (value) => Number.isFinite(Number(value)) && Number(value) >= 0,
    'Price must be finite and non-negative',
  ),
  providerAt: isoInstantSchema,
  observedAt: isoInstantSchema,
  rightsMode: z.enum(RightsMode),
  lossy: z.literal(true),
});
export const livePriceSnapshotSchema = livePriceQuoteSchema.extend({ companyId: idSchema });
export const fallbackCloseSchema = z.object({
  price: decimalStringSchema.refine(
    (value) => Number.isFinite(Number(value)) && Number(value) > 0,
    'Closing price must be finite and positive',
  ),
  currency: z.literal('KRW'),
  sessionDate: dateOnlySchema,
  source: z.literal('TOSS_KR'),
});
export const companyLivePriceSchema = z.object({
  companyId: idSchema,
  provider: z.literal('toss'),
  status: z.enum(['NOT_CONFIGURED', 'WAITING', 'LIVE', 'STALE', 'UNAVAILABLE']),
  quote: livePriceQuoteSchema.nullable(),
  fallbackClose: fallbackCloseSchema.nullable().optional(),
  asOf: isoInstantSchema,
});
export type CompanyLivePrice = z.infer<typeof companyLivePriceSchema> & {
  displayPrice?: GroupDisplayPrice;
};
export type LivePriceQuote = z.infer<typeof livePriceQuoteSchema>;

export const watchlistQuotesQuerySchema = z.object({
  ids: z
    .string()
    .max(3699)
    .transform((value) => value.split(','))
    .pipe(z.array(z.uuid()).min(1).max(100)),
});
export const watchlistQuotesSchema = z.object({
  asOf: isoInstantSchema,
  items: z.array(
    z.object({
      companyId: idSchema,
      status: companyLivePriceSchema.shape.status,
      quote: livePriceQuoteSchema.nullable(),
      fallbackClose: fallbackCloseSchema.nullable().optional(),
      previousClose: z.number().finite().positive().nullable(),
      change: z.number().finite().nullable(),
      changePercent: z.number().finite().nullable(),
      referenceDate: dateOnlySchema.nullable(),
    }),
  ),
});
export type WatchlistQuotes = z.infer<typeof watchlistQuotesSchema>;

export const watchlistViewSchema = companySummaryViewSchema.extend({
  addedAt: isoInstantSchema,
  note: z.string().nullable(),
  realtimeAlerts: z.boolean(),
  digestAlerts: z.boolean(),
});
export type WatchlistView = z.infer<typeof watchlistViewSchema>;

export const eventQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  companyId: idSchema.optional(),
  detailType: disclosureViewTypeSchema.optional(),
  classificationStatus: z.enum(ClassificationReviewResult).optional(),
  type: z.enum(EventType).optional(),
  state: z.enum(EventState).optional(),
  evidenceGrade: z.enum(EvidenceGrade).optional(),
  priority: z.enum(WatchPriority).optional(),
});

export const reviewSchema = z.object({
  id: idSchema,
  subjectType: z.string(),
  subjectId: idSchema,
  reason: z.string(),
  status: z.enum(ReviewTaskStatus),
  classificationResult: z.enum(ClassificationReviewResult).nullable(),
  resolution: z.string().nullable(),
  createdAt: isoInstantSchema,
  resolvedAt: isoInstantSchema.nullable(),
});
export type Review = z.infer<typeof reviewSchema>;

export const updateReviewSchema = z.object({
  status: z.enum(ReviewTaskStatus),
  resolution: z.string().trim().max(4000).nullable().optional(),
});

export const resolveReviewSchema = z.object({
  resolution: z.enum(['CONFIRMED', 'UNKNOWN', 'DUPLICATE', 'CORRECTION_LINKED']),
  note: z.string().trim().max(4000).nullable().optional(),
  planExecutionMatchId: idSchema.optional(),
});

export const reviewViewSchema = z.object({
  id: idSchema,
  eventId: idSchema,
  companyName: z.string(),
  detailType: disclosureViewTypeSchema,
  canonicalType: z.string().nullable().optional(),
  classificationStatus: z.string().nullable().optional(),
  officialUrl: z.string().url().nullable().optional(),
  staged: z.boolean().optional(),
  validationStatus: z.string().nullable().optional(),
  crosscheckStatus: z.string().nullable().optional(),
  crosscheckReady: z.boolean().optional(),
  candidateRowCount: z.number().int().nonnegative().optional(),
  candidateEvidence: z.array(z.string()).optional(),
  candidateWarnings: z.array(z.string()).optional(),
  crosscheckEvidence: z.unknown().optional(),
  reason: z.string(),
  methodRaw: z.string().nullable(),
  extractedText: z.string().nullable(),
  proposedNature: z.enum(TransactionNature),
  parserConfidence: z.number().min(0).max(1),
  createdAt: isoInstantSchema,
  status: z.enum(ReviewTaskStatus),
  relationType: z.enum(FilingRelationType).nullable().optional(),
  fromRceptNo: z.string().nullable().optional(),
  toRceptNo: z.string().nullable().optional(),
  planExecutionCandidates: z
    .array(
      z.object({
        matchId: idSchema,
        transactionId: idSchema,
        planItemId: idSchema,
        eventDate: dateOnlySchema.nullable(),
        actualQuantity: nullableDecimalStringSchema,
        plannedQuantity: nullableDecimalStringSchema,
        actualMethodRaw: z.string(),
        plannedMethodRaw: z.string().nullable(),
        confidence: z.number().min(0).max(1),
        matchedFields: z.array(z.string()),
      }),
    )
    .optional(),
});
export type ReviewView = z.infer<typeof reviewViewSchema>;

export const reviewResolutionSchema = z.object({
  id: idSchema,
  status: z.enum([ReviewTaskStatus.OPEN, ReviewTaskStatus.RESOLVED]),
  resolution: resolveReviewSchema.shape.resolution,
  note: z.string().nullable(),
  resolvedAt: isoInstantSchema.nullable(),
  queued: z.boolean().optional(),
});

export const connectorHealthSchema = z.object({
  connector: z.string(),
  status: z.enum(ConnectorStatus),
  message: z.string().nullable(),
  lastSuccessAt: isoInstantSchema.nullable(),
  lastFailureAt: isoInstantSchema.nullable(),
  checkedAt: isoInstantSchema,
  httpStatus: z.number().int().min(0).max(599).nullable().optional(),
  requestAttempted: z.boolean().nullable().optional(),
  lastAttemptAt: isoInstantSchema.nullable().optional(),
  nextRetryAt: isoInstantSchema.nullable().optional(),
});
export type ConnectorHealth = z.infer<typeof connectorHealthSchema>;

export const sourceFreshnessSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string(),
  category: z.enum(['OFFICIAL', 'NEWS', 'MARKET']),
  status: z.enum(ConnectorStatus),
  lastSuccessAt: isoInstantSchema.nullable(),
  lagSeconds: z.number().int().nonnegative().nullable(),
  rightsMode: z.enum(RightsMode),
  message: z.string(),
  checkedAt: isoInstantSchema.optional(),
  httpStatus: z.number().int().min(0).max(599).nullable().optional(),
  requestAttempted: z.boolean().nullable().optional(),
  lastAttemptAt: isoInstantSchema.nullable().optional(),
  nextRetryAt: isoInstantSchema.nullable().optional(),
});
export type SourceFreshness = z.infer<typeof sourceFreshnessSchema>;

export const dashboardViewSchema = z.object({
  asOf: isoInstantSchema,
  todayCounts: z.object({
    D001: z.number().int().nonnegative(),
    D002: z.number().int().nonnegative(),
    D003: z.number().int().nonnegative().default(0),
    D004: z.number().int().nonnegative().default(0),
    D005: z.number().int().nonnegative(),
  }),
  totalCounts: z
    .object({
      D001: z.number().int().nonnegative(),
      D002: z.number().int().nonnegative(),
      D003: z.number().int().nonnegative(),
      D004: z.number().int().nonnegative(),
      D005: z.number().int().nonnegative(),
    })
    .optional(),
  priorities: z.object({
    P1: z.array(eventSummaryViewSchema),
    P2: z.array(eventSummaryViewSchema),
  }),
  reviewPending: z.number().int().nonnegative(),
  parserFailures: z.number().int().nonnegative(),
  integrity: z
    .object({
      asOf: isoInstantSchema,
      totalParseRuns: z.number().int().nonnegative(),
      failedParseRuns: z.number().int().nonnegative(),
      openReviewRows: z.number().int().nonnegative(),
      currentReviewSubjects: z.number().int().nonnegative(),
      currentUnrecoveredFilings: z.number().int().nonnegative(),
      currentFailedFilings: z.number().int().nonnegative(),
      staleOpenParseReviews: z.number().int().nonnegative(),
      supersededReviews: z.number().int().nonnegative(),
      documentUnavailableReviews: z.number().int().nonnegative(),
      relationReviews: z.number().int().nonnegative(),
      currentTypeMismatches: z.number().int().nonnegative(),
      futureCreatedRows: z.number().int().nonnegative(),
    })
    .optional(),
  alertFailures: z.number().int().nonnegative(),
  sources: z.array(sourceFreshnessSchema),
  recentlyVerified: z.array(eventSummaryViewSchema),
});
export type DashboardView = z.infer<typeof dashboardViewSchema>;

export const operationRunSchema = z.object({
  id: idSchema,
  source: z.string(),
  job: z.string(),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED']),
  startedAt: isoInstantSchema,
  finishedAt: isoInstantSchema.nullable(),
  processed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  message: z.string().nullable(),
});

export const queueMetricSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  waiting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  oldestWaitingAt: isoInstantSchema.nullable(),
});

export const backfillRequestSchema = z
  .object({
    detailTypes: z
      .array(z.enum(DisclosureDetailType))
      .min(1)
      .max(5)
      .default(Object.values(DisclosureDetailType)),
    startDate: dateOnlySchema,
    endDate: dateOnlySchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.detailTypes).size !== value.detailTypes.length) {
      context.addIssue({
        code: 'custom',
        path: ['detailTypes'],
        message: 'detailTypes must not contain duplicates',
      });
    }
    if (value.startDate > value.endDate) {
      context.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'endDate must be on or after startDate',
      });
    }
    const days =
      (Date.parse(`${value.endDate}T00:00:00Z`) - Date.parse(`${value.startDate}T00:00:00Z`)) /
      86_400_000;
    if (days > 3_660) {
      context.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'A single backfill request cannot exceed ten years',
      });
    }
  });
export type BackfillRequest = z.infer<typeof backfillRequestSchema>;

export const dashboardSchema = z.object({
  generatedAt: isoInstantSchema,
  counts: z.object({
    filingsToday: z.number().int().nonnegative(),
    d001Today: z.number().int().nonnegative(),
    d002Today: z.number().int().nonnegative(),
    d003Today: z.number().int().nonnegative().default(0),
    d004Today: z.number().int().nonnegative().default(0),
    d005Today: z.number().int().nonnegative(),
    reviewRequired: z.number().int().nonnegative(),
    failedJobs: z.number().int().nonnegative(),
    watchedCompanies: z.number().int().nonnegative(),
  }),
  recentEvents: z.array(eventSchema),
  connectors: z.array(connectorHealthSchema),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(256),
  totpCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  recoveryCode: z.string().min(8).max(64).optional(),
});

export const sessionSchema = z.object({
  authenticated: z.boolean(),
  canAccess: z.boolean(),
  csrfToken: z.string(),
  user: z
    .object({
      id: idSchema,
      email: z.string().email().nullable(),
      displayName: z.string().nullable(),
      provider: z.enum(['LOCAL', 'KAKAO']),
      role: z.enum(['ADMIN', 'VIEWER']),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
      totpEnabled: z.boolean(),
    })
    .nullable(),
  setupRequired: z.boolean(),
});

export const memberStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export const memberViewSchema = z.object({
  id: idSchema,
  provider: z.literal('KAKAO'),
  role: z.literal('VIEWER'),
  status: memberStatusSchema,
  displayName: z.string().max(80).nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
  lastLoginAt: isoInstantSchema.nullable(),
  reviewedAt: isoInstantSchema.nullable(),
});
export type MemberView = z.infer<typeof memberViewSchema>;
export const memberReviewSchema = z.object({ status: z.enum(['APPROVED', 'REJECTED']) }).strict();

export const totpConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(10).max(256),
  newPassword: z.string().min(14).max(256),
});

export const botRecentQuerySchema = cursorQuerySchema.extend({
  priority: z.enum(WatchPriority).optional(),
});
export const botCompanyQuerySchema = z.object({ q: z.string().trim().min(1).max(120) });

export const pairingClaimSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  deviceId: z.string().min(3).max(128),
  room: z.string().min(1).max(255),
  authorHash: z.string().min(8).max(255),
  packageName: z.string().min(1).max(255),
  botVersion: z.string().min(1).max(64),
});
export const deviceHeartbeatSchema = z.object({
  deviceId: z.string().min(3).max(128),
  botVersion: z.string().max(64).optional(),
  appVersion: z.string().max(64).optional(),
  room: z.string().max(255).nullable().optional(),
  observedAt: isoInstantSchema.optional(),
  capabilities: z.array(z.string().max(64)).max(32).default([]),
});
export const deviceCommandSchema = z.object({
  deviceId: z.string().min(3).max(128),
  command: z.string().min(1).max(128),
  query: z
    .string()
    .max(4000)
    .nullable()
    .optional()
    .transform((value) => value ?? ''),
});
export const deliveryPullSchema = z.object({
  deviceId: z.string().min(3).max(128),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  leaseSeconds: z.coerce.number().int().min(10).max(300).default(60),
});
export const deliveryAckSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(2000).nullable().optional(),
  externalMessageId: z.string().max(255).nullable().optional(),
});

export const pairedDeviceSchema = z.object({
  deviceId: z.string(),
  deviceToken: z.string(),
  pairedAt: isoInstantSchema,
});

export const leasedBotDeliverySchema = z.object({
  deliveryId: idSchema,
  alertId: idSchema,
  operation: z.enum(['SEND', 'EDIT', 'FOLLOW_UP']),
  stage: z.enum(['DETECTED', 'ENRICHED', 'DIGEST']),
  content: z.string().min(1).max(4000),
  externalMessageId: z.string().nullable().optional(),
});

export const leasedBotDeliveriesSchema = z.object({
  items: z.array(leasedBotDeliverySchema),
  leaseSeconds: z.number().int().positive(),
});

export const botDeliverySchema = z.object({
  id: idSchema,
  channel: z.string(),
  destination: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoInstantSchema,
  attempts: z.number().int().nonnegative(),
});

export const alertSchema = z.object({
  id: idSchema,
  channel: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(AlertStatus),
  sentAt: isoInstantSchema.nullable(),
  errorMessage: z.string().nullable(),
});

export function pagedSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    // 최초 API 전환 전에 생성된 클라이언트와의 호환성을 위해 유지합니다.
    pageInfo: pageInfoSchema.optional(),
  });
}
