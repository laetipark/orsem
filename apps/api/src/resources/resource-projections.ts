import {
  EventState,
  formatDisclosureSummary,
  RightsMode,
  isSupportedFilingType,
  type Company,
  type CompanySummaryView,
  type Event,
  type EventSummaryView,
  type FilingDetail,
  type FilingSummary,
  type SourceItem,
  type WatchlistItem,
} from '@orsem/contracts';
import {
  dateToIso,
  type CompanyEntity,
  type EventClusterEntity,
  type FilingEntity,
  type ParseRunEntity,
  type SourceItemEntity,
} from '@orsem/database';
import { kstDateFromInstant } from '../common/kst-date';
import { mapCompany } from './resource-mappers';

export type EventFilingFacts = FilingSummary & {
  transactions?: Array<
    Pick<FilingDetail['transactions'][number], 'nature' | 'direction' | 'eventDate'>
  >;
  largeHolding?: Pick<NonNullable<FilingDetail['largeHolding']>, 'changes'> | null;
  tradePlan?: Pick<NonNullable<FilingDetail['tradePlan']>, 'plannedStartDate'> | null;
};

export function mapCompanySummary(
  company: Company,
  priority: WatchlistItem['priority'] | undefined,
  lastEventAt: string | null,
): CompanySummaryView {
  return {
    id: company.id,
    nameKo: company.nameKo,
    nameEn: company.nameEn,
    stockCode: company.stockCode,
    ticker: company.ticker,
    market: company.market,
    sector: '미분류',
    priority: priority ?? null,
    isListed: company.isListed,
    isWatchlisted: priority !== undefined,
    lastEventAt,
  };
}

export function mapEventSummary(
  event: Event,
  filing: EventFilingFacts | null,
  priority: WatchlistItem['priority'] | undefined,
  secRow: SourceItemEntity | null,
): EventSummaryView {
  const transaction = filing?.transactions?.[0] ?? null;
  const holdingChange = filing?.largeHolding?.changes[0] ?? null;
  const company = event.company ?? filing?.company ?? null;
  const secSource = event.sourceItems.find((item) => item.source === 'SEC');
  const source = secSource ?? event.sourceItems[0] ?? null;
  const secFilingDate = secRow?.rawMetadataJson?.filingDate;
  const secForm = secRow?.rawMetadataJson?.form;
  const detailType: EventSummaryView['detailType'] =
    filing?.detailType ?? (secSource ? 'SEC' : 'NEWS');
  return {
    id: event.id,
    companyId: company?.id ?? 'unresolved',
    companyName: company?.nameKo ?? '회사 미확인',
    stockCode: company?.stockCode ?? null,
    ticker: company?.ticker ?? null,
    market: company?.market ?? 'OTHER',
    priority: priority ?? (filing || secSource ? 'P3' : 'P4'),
    detailType,
    title: filing?.reportName ?? source?.title ?? event.canonicalEventType,
    translation: !filing && detailType === 'NEWS' ? (source?.translation ?? null) : null,
    summary: event.summary,
    nature: transaction?.nature ?? (filing?.detailType === 'D005' ? 'UNKNOWN' : null),
    direction: transaction?.direction ?? holdingChange?.direction ?? 'UNKNOWN',
    eventAt: secSource
      ? null
      : (transaction?.eventDate ??
        holdingChange?.eventDate ??
        filing?.tradePlan?.plannedStartDate ??
        kstDateFromInstant(event.occurredAt) ??
        null),
    rceptDate:
      filing?.rceptDate ??
      (typeof secFilingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(secFilingDate)
        ? secFilingDate
        : null),
    publishedAt: event.publishedAt,
    firstObservedAt: event.firstObservedAt,
    processedAt: event.processedAt,
    submissionKind:
      filing?.submissionKind ??
      (typeof secForm === 'string' && secForm.endsWith('/A') ? 'CORRECTION' : 'INITIAL'),
    effectiveState: filing?.effectiveState ?? 'ACTIVE',
    evidenceGrade: event.evidenceGrade,
    classificationStatus: event.classificationResult ?? 'REVIEW_REQUIRED',
    sourceName: filing
      ? 'OpenDART'
      : (source?.sourceName ?? source?.source ?? '공식 소스 확인 대기'),
    rightsMode: filing
      ? RightsMode.OFFICIAL_PUBLIC_DATA
      : (source?.rightsMode ?? RightsMode.LINK_ONLY),
    officialUrl: filing?.officialUrl ?? source?.url ?? 'https://opendart.fss.or.kr/',
  };
}

export function mapFilingRecord(
  row: FilingEntity,
  company: CompanyEntity,
  parse: ParseRunEntity | null,
): FilingSummary {
  return {
    id: row.id,
    rceptNo: row.rceptNo,
    detailType: isSupportedFilingType(row.canonicalType) ? row.canonicalType : row.detailType,
    reportName: row.reportName,
    filerName: row.filerName,
    rceptDate: row.rceptDate,
    submissionKind: row.submissionKind,
    effectiveState: row.effectiveState,
    firstObservedAt: row.firstObservedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    processedAt: dateToIso(parse?.finishedAt),
    parseStatus: parse?.status ?? null,
    parserConfidence: parse?.confidence ? Number(parse.confidence) : null,
    company: mapCompany(company),
    officialUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(row.rceptNo)}`,
  };
}

export function mapEventFromRelations(
  row: EventClusterEntity,
  company: CompanyEntity | null,
  filingRow: FilingEntity | null,
  filing: FilingSummary | null,
  parse: ParseRunEntity | null,
  sourceItems: SourceItem[],
): Event {
  const canonicalEventTypes = {
    D001: 'LARGE_HOLDER',
    D002: 'INSIDER_OWNERSHIP',
    D003: 'PROXY_SOLICITATION',
    D004: 'TENDER_OFFER',
    D005: 'TRADE_PLAN',
  } as const;
  const requiresParseReview = Boolean(filingRow && !parse);
  return {
    id: row.id,
    canonicalEventType: filingRow
      ? isSupportedFilingType(filingRow.canonicalType)
        ? canonicalEventTypes[filingRow.canonicalType]
        : 'OTHER'
      : row.canonicalEventType,
    occurredAt: dateToIso(row.occurredAt),
    publishedAt: dateToIso(row.publishedAt),
    firstObservedAt: row.firstObservedAt.toISOString(),
    processedAt: dateToIso(row.processedAt),
    state:
      requiresParseReview &&
      row.state !== EventState.CANCELLED &&
      row.state !== EventState.SUPERSEDED
        ? EventState.REVIEW_REQUIRED
        : row.state,
    evidenceGrade: row.evidenceGrade,
    classificationResult: parse?.classificationResult ?? null,
    summary: requiresParseReview
      ? `원문 검증 대기 — ${filingRow!.reportName}`
      : (formatDisclosureSummary(
          parse?.resultJson?.parsed,
          company?.nameKo ?? filing?.company.nameKo,
        ) ?? row.summary),
    company: company ? mapCompany(company) : null,
    filing,
    sourceItems,
  };
}
