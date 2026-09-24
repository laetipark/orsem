import {
  EventState,
  EvidenceGrade,
  type Company,
  type Event,
  type FilingSummary,
  type SourceItem,
} from '@orsem/contracts';

/** A collected disclosure remains readable before an analysis event is created. */
export function unclusteredDisclosure(
  filing: FilingSummary | null,
  source: SourceItem | null,
  company: Company | null,
): Event {
  if (!filing && !source) throw new Error('A disclosure is required.');
  const types = {
    D001: 'LARGE_HOLDER',
    D002: 'INSIDER_OWNERSHIP',
    D003: 'PROXY_SOLICITATION',
    D004: 'TENDER_OFFER',
    D005: 'TRADE_PLAN',
  } as const;
  return {
    id: (filing ?? source)!.id,
    canonicalEventType: filing ? types[filing.detailType] : 'OTHER',
    occurredAt: null,
    publishedAt: source?.publishedAt ?? null,
    firstObservedAt: (filing ?? source)!.firstObservedAt,
    processedAt: null,
    state: EventState.REVIEW_REQUIRED,
    evidenceGrade: EvidenceGrade.A,
    classificationResult: null,
    summary: filing ? `분석 대기 · ${filing.reportName}` : `SEC 공시 접수 · ${source!.title}`,
    company: filing?.company ?? company,
    filing,
    sourceItems: source ? [source] : [],
  };
}
