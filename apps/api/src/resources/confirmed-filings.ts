import {
  classifyFilingDocumentKind,
  classifyOpenDartFiling,
  disclosureSignal,
  formatDisclosureSummary,
  hasParseTypeInvariant,
  type Company,
  type DisclosureSignal,
} from '@orsem/contracts';
import { hasConfirmedSourceReview } from '@orsem/database';
import type { DataSource } from 'typeorm';

type Json = Record<string, unknown>;
export type FilingFeedCompany = Pick<
  Company,
  'id' | 'nameKo' | 'nameEn' | 'stockCode' | 'ticker' | 'market'
>;

export interface ConfirmedFiling {
  id: string;
  source: 'OPENDART' | 'SEC';
  externalId: string;
  title: string;
  summaryTitle: string;
  signal: DisclosureSignal;
  eventDate: string | null;
  filingDate: string | null;
  publishedAt: string | null;
  firstObservedAt: string | null;
  url: string;
  relatedCompanies: FilingFeedCompany[];
}

export interface ConfirmedFilingRow {
  id: string;
  companyId: string | null;
  externalId: string;
  title: string;
  filingDate: string;
  firstObservedAt: string | Date;
  publishedAt?: string | Date | null;
  eventId: string;
  eventState: string;
  eventType: string;
  eventMetadata: unknown;
  pendingReview: number | string;
  pendingRelation?: number | string;
  sourceDetailType?: string | null;
  canonicalType?: string | null;
  classificationStatus?: string;
  submissionKind?: string;
  effectiveState?: string;
  activeParseRunId?: string | null;
  parseRunId?: string;
  parseFilingId?: string;
  parseStatus?: string;
  validationStatus?: string;
  classificationResult?: string;
  inputType?: string | null;
  extractorType?: string | null;
  resultType?: string | null;
  rawSha256?: string;
  parseResult?: unknown;
  sourceMetadata?: unknown;
  url?: string;
}

function record(value: unknown): Json {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function dateOnly(value: unknown): string | null {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function instant(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function eventDate(parsed: Json): string | null {
  const rows = parsed.detailType === 'D002' ? parsed.transactions : parsed.changes;
  return (
    records(rows)
      .flatMap((row) => (dateOnly(row.eventDate) ? [String(row.eventDate)] : []))
      .sort()[0] ?? null
  );
}

/** Recheck the persisted projection before showing a filing as confirmed. */
export function confirmedDartSummary(row: ConfirmedFilingRow): {
  summaryTitle: string;
  signal: DisclosureSignal;
  eventDate: string | null;
} | null {
  const result = record(row.parseResult);
  const parsed = record(result.parsed);
  const event = record(row.eventMetadata);
  const crosscheck = record(result.crosscheck);
  const kind = row.canonicalType;
  const classification = classifyOpenDartFiling({
    reportName: row.title,
    sourceDetailType: row.sourceDetailType,
    manualCanonicalType: row.classificationStatus === 'MANUAL_OVERRIDE' ? kind : null,
  });
  const eventTypes: Record<string, string> = {
    D001: 'LARGE_HOLDER',
    D002: 'INSIDER_OWNERSHIP',
    D003: 'PROXY_SOLICITATION',
    D004: 'TENDER_OFFER',
  };
  if (
    !kind ||
    !Object.hasOwn(eventTypes, kind) ||
    !/^\d{14}$/u.test(row.externalId) ||
    row.eventState !== 'VERIFIED' ||
    (row.eventType !== eventTypes[kind] && row.eventType !== 'CORRECTION') ||
    row.effectiveState !== 'ACTIVE' ||
    !['INITIAL', 'CORRECTION', 'ATTACHMENT_CORRECTION'].includes(row.submissionKind ?? '') ||
    Number(row.pendingReview) !== 0 ||
    Number(row.pendingRelation) !== 0 ||
    row.parseStatus !== 'SUCCEEDED' ||
    row.validationStatus !== 'PASSED' ||
    !['RULE_CONFIRMED', 'AI_CONFIRMED'].includes(row.classificationResult ?? '') ||
    !row.parseRunId ||
    row.activeParseRunId !== row.parseRunId ||
    row.parseFilingId !== row.id ||
    event.parseRunId !== row.parseRunId ||
    result.projectionApplied !== true ||
    record(result.staging).mode === 'OFFLINE_INACTIVE' ||
    row.resultType !== parsed.detailType ||
    classification.canonicalType !== kind ||
    !['CONFIRMED', 'MANUAL_OVERRIDE'].includes(classification.classificationStatus) ||
    !hasParseTypeInvariant({
      canonicalType: kind,
      classificationStatus: row.classificationStatus,
      inputType: row.inputType,
      extractorType: row.extractorType,
      resultType: row.resultType,
    })
  )
    return null;

  if (kind === 'D001' || kind === 'D002') {
    if (
      crosscheck.status !== 'OK' ||
      !records(crosscheck.exactReceiptMatches).some((item) => item.rcept_no === row.externalId)
    )
      return null;
  } else if (
    crosscheck.status !== 'NOT_APPLICABLE' ||
    crosscheck.reason !== `NO_SUMMARY_API_FOR_${kind}` ||
    record(parsed.source).archiveSha256 !== row.rawSha256 ||
    !hasConfirmedSourceReview({
      id: row.parseRunId,
      rawSha256: row.rawSha256 ?? '',
      resultJson: result,
    }) ||
    (kind === 'D004' && parsed.documentKind !== classifyFilingDocumentKind(row.title))
  )
    return null;

  // A transaction plan or an announced tender is not an executed transaction.
  if (kind === 'D004' && parsed.documentKind !== 'RESULT') return null;
  const summaryTitle = formatDisclosureSummary(parsed);
  return summaryTitle
    ? { summaryTitle, signal: disclosureSignal(parsed), eventDate: eventDate(parsed) }
    : null;
}

function confirmedSecSummary(row: ConfirmedFilingRow) {
  const metadata = record(row.sourceMetadata);
  const event = record(row.eventMetadata);
  const ownership = record(metadata.secOwnership);
  const eventOwnership = record(event.ownership);
  const provenance = record(ownership.provenance);
  if (
    row.eventState !== 'VERIFIED' ||
    Number(row.pendingReview) !== 0 ||
    metadata.ownershipStatus !== 'COMPLETED' ||
    event.observationKind !== 'SEC_INSIDER_TRANSACTION' ||
    event.sourceItemId !== row.id ||
    event.accessionNumber !== row.externalId ||
    provenance.accessionNumber !== row.externalId ||
    !/^\d{10}-\d{2}-\d{6}$/u.test(row.externalId) ||
    !/^https:\/\/(?:www\.)?sec\.gov\//iu.test(row.url ?? '') ||
    !/^[a-f0-9]{64}$/iu.test(String(ownership.rawSha256 ?? '')) ||
    ownership.rawSha256 !== eventOwnership.rawSha256 ||
    record(ownership.issuer).cik !== metadata.cik ||
    ownership.documentType !== metadata.form ||
    !Array.isArray(ownership.unresolvedFootnoteReferences) ||
    ownership.unresolvedFootnoteReferences.length > 0
  )
    return null;

  // SEC P/S explicitly includes private transactions; do not relabel them as market trades.
  const trades = records(ownership.transactions);
  const signals = trades.map((trade): DisclosureSignal => {
    const amount = String(trade.transactionShares ?? '');
    if (!/^\d+(?:\.\d+)?$/u.test(amount) || !/[1-9]/u.test(amount)) return 'NONE';
    if (trade.transactionCode === 'P' && trade.acquiredDisposedCode === 'A') return 'BUY';
    if (trade.transactionCode === 'S' && trade.acquiredDisposedCode === 'D') return 'SELL';
    return 'NONE';
  });
  const buy = signals.includes('BUY');
  const sell = signals.includes('SELL');
  const signal: DisclosureSignal = buy && sell ? 'MIXED' : buy ? 'BUY' : sell ? 'SELL' : 'NONE';
  const label = {
    BUY: '[매수신호]',
    SELL: '[매도신호]',
    MIXED: '[매수신호] [매도신호]',
    NONE: '[지분 공시]',
  }[signal];
  const owners = records(ownership.reportingOwners)
    .map((owner) =>
      [owner.name, owner.officerTitle]
        .filter((part) => typeof part === 'string' && part.trim())
        .join(' '),
    )
    .filter(Boolean)
    .join(' · ');
  const detail = trades.slice(0, 3).map((trade, index) => {
    const direction = signals[index];
    if (direction !== 'BUY' && direction !== 'SELL') return '기타 지분 변동';
    const [whole, fractional] = String(trade.transactionShares).split('.');
    const amount = [whole!.replace(/\B(?=(\d{3})+(?!\d))/gu, ','), fractional]
      .filter((part) => part !== undefined)
      .join('.');
    return `${direction === 'BUY' ? '+' : '-'}${amount}${trade.derivative === true ? '개' : '주'} ${direction === 'BUY' ? '시장·장외매수' : '시장·장외매도'}`;
  });
  if (trades.length > 3) detail.push(`외 ${trades.length - 3}건`);
  return {
    summaryTitle: [label, owners, detail.join(' · ') || row.title].filter(Boolean).join(' '),
    signal,
    eventDate:
      trades
        .flatMap((trade) =>
          dateOnly(trade.transactionDate) ? [String(trade.transactionDate)] : [],
        )
        .sort()[0] ?? null,
  };
}

const dartPendingReview = `EXISTS (SELECT 1 FROM reviews review WHERE review.status='OPEN'
  AND (review.subject_id=f.id OR review.subject_id=e.id OR review.parse_run_id=p.id))`;
const dartPendingRelation = `EXISTS (SELECT 1 FROM filing_relations relation
  WHERE (relation.from_filing_id=f.id OR relation.to_filing_id=f.id)
  AND relation.relation_type IN ('CORRECTS','SUPERSEDES','CANCELS','WITHDRAWS')
  AND relation.review_decision NOT IN ('CONFIRMED','REJECTED'))`;
const secPendingReview = `EXISTS (SELECT 1 FROM reviews review WHERE review.status='OPEN'
  AND (review.subject_id=s.id OR review.subject_id=e.id))`;

/** Read-only feed projection. Raw filings and source items remain available in their own views. */
export async function confirmedFilingsForCompanies(
  source: DataSource,
  companies: FilingFeedCompany[],
) {
  const ids = [...new Set(companies.map((company) => company.id))];
  const mine = ids.map(() => '?').join(',');
  if (!ids.length) return [];
  const queries = [
    {
      source: 'OPENDART' as const,
      sql: `SELECT f.id, f.company_id companyId, f.rcept_no externalId, f.report_name title,
        f.rcept_date filingDate, f.first_observed_at firstObservedAt,
        f.source_detail_type sourceDetailType, f.canonical_type canonicalType,
        f.classification_status classificationStatus, f.submission_kind submissionKind,
        f.effective_state effectiveState, f.active_parse_run_id activeParseRunId,
        p.id parseRunId, p.filing_id parseFilingId, p.status parseStatus,
        p.validation_status validationStatus, p.classification_result classificationResult,
        p.input_type inputType, p.extractor_type extractorType, p.result_type resultType,
        p.raw_sha256 rawSha256, p.result_json parseResult,
        e.id eventId, e.state eventState, e.canonical_event_type eventType,
        e.metadata_json eventMetadata, e.published_at publishedAt,
        ${dartPendingReview} pendingReview, ${dartPendingRelation} pendingRelation
      FROM filings f JOIN parse_runs p ON p.id=f.active_parse_run_id AND p.filing_id=f.id
      JOIN event_cluster_items item ON item.item_id=f.id AND item.item_type='FILING'
      JOIN event_clusters e ON e.id=item.event_cluster_id
      WHERE f.source='OPENDART' AND f.company_id IN (${mine})
        AND f.effective_state='ACTIVE' AND f.submission_kind IN ('INITIAL','CORRECTION','ATTACHMENT_CORRECTION')
        AND f.canonical_type IN ('D001','D002','D003','D004')
        AND e.state='VERIFIED' AND p.status='SUCCEEDED' AND p.validation_status='PASSED'
        AND p.classification_result IN ('RULE_CONFIRMED','AI_CONFIRMED')
        AND NOT ${dartPendingReview} AND NOT ${dartPendingRelation}`,
      params: ids,
      sort: 'f.rcept_date',
      id: 'f.id',
      summarize: confirmedDartSummary,
    },
    {
      source: 'SEC' as const,
      sql: `SELECT s.id, s.company_id companyId, s.external_id externalId, s.title, s.url,
        JSON_UNQUOTE(JSON_EXTRACT(s.raw_metadata_json, '$.filingDate')) filingDate,
        s.published_at publishedAt, s.first_observed_at firstObservedAt,
        s.raw_metadata_json sourceMetadata, e.id eventId, e.state eventState,
        e.canonical_event_type eventType, e.metadata_json eventMetadata,
        ${secPendingReview} pendingReview
      FROM source_items s
      JOIN event_cluster_items item ON item.item_id=s.id AND item.item_type='SOURCE_ITEM'
      JOIN event_clusters e ON e.id=item.event_cluster_id
      WHERE s.source='SEC' AND s.rights_mode='OFFICIAL_PUBLIC_DATA' AND e.state='VERIFIED'
        AND JSON_UNQUOTE(JSON_EXTRACT(s.raw_metadata_json, '$.ownershipStatus'))='COMPLETED'
        AND (s.company_id IN (${mine}) OR EXISTS
          (SELECT 1 FROM news_source_companies r WHERE r.source_item_id=s.id AND r.company_id IN (${mine})))
        AND NOT ${secPendingReview}`,
      params: [...ids, ...ids],
      sort: "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(s.raw_metadata_json, '$.filingDate')), DATE(s.published_at), DATE(s.first_observed_at))",
      id: 's.id',
      summarize: confirmedSecSummary,
    },
  ];
  const batches = await Promise.all(
    queries.map(async (query) => {
      const items: Array<{
        row: ConfirmedFilingRow;
        summary: NonNullable<ReturnType<typeof query.summarize>>;
      }> = [];
      let offset = 0;
      // Continue past ineligible legacy records so they cannot hide older confirmed filings.
      while (items.length < 8) {
        const rows: ConfirmedFilingRow[] = await source.query(
          `${query.sql} ORDER BY ${query.sort} DESC, ${query.id} DESC, e.id DESC LIMIT 32 OFFSET ?`,
          [...query.params, offset],
        );
        for (const row of rows) {
          const summary = query.summarize(row);
          if (summary && !items.some((item) => item.row.externalId === row.externalId))
            items.push({ row, summary });
          if (items.length === 8) break;
        }
        if (rows.length < 32) break;
        offset += rows.length;
      }
      return { source: query.source, items };
    }),
  );
  const secIds = batches.find((batch) => batch.source === 'SEC')!.items.map(({ row }) => row.id);
  const relations: Array<{ sourceId: string; companyId: string }> = secIds.length
    ? await source.query(
        `SELECT source_item_id sourceId, company_id companyId FROM news_source_companies WHERE source_item_id IN (${secIds.map(() => '?').join(',')})`,
        secIds,
      )
    : [];
  return batches
    .flatMap((batch): ConfirmedFiling[] =>
      batch.items.map(({ row, summary }) => ({
        id: `${batch.source}:${row.id}`,
        source: batch.source,
        externalId: row.externalId,
        title: row.title,
        ...summary,
        filingDate: dateOnly(row.filingDate),
        publishedAt: instant(row.publishedAt),
        firstObservedAt: instant(row.firstObservedAt),
        url: `/events/${encodeURIComponent(row.eventId)}`,
        relatedCompanies: companies.filter(
          (company) =>
            company.id === row.companyId ||
            (batch.source === 'SEC' &&
              relations.some(
                (relation) => relation.sourceId === row.id && relation.companyId === company.id,
              )),
        ),
      })),
    )
    .sort(
      (a, b) =>
        (b.filingDate ?? b.publishedAt ?? b.firstObservedAt ?? '').localeCompare(
          a.filingDate ?? a.publishedAt ?? a.firstObservedAt ?? '',
        ) || b.id.localeCompare(a.id),
    )
    .slice(0, 8);
}
