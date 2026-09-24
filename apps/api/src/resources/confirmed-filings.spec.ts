import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataSource } from 'typeorm';
import {
  confirmedDartSummary,
  confirmedFilingsForCompanies,
  type ConfirmedFilingRow,
  type FilingFeedCompany,
} from './confirmed-filings';

const buy = {
  nature: 'MARKET_BUY',
  direction: 'INCREASE',
  quantity: '1000',
  methodRaw: '장내매수',
  eventDate: '2026-09-03',
};
const parsed = {
  detailType: 'D002',
  reporterName: '홍길동',
  positionRaw: '대표이사',
  transactions: [buy],
};
const result = {
  projectionApplied: true,
  parsed,
  crosscheck: { status: 'OK', exactReceiptMatches: [{ rcept_no: '20260905000001' }] },
};
const company: FilingFeedCompany = {
  id: 'mine',
  nameKo: '내 기업',
  nameEn: null,
  stockCode: '005930',
  ticker: null,
  market: 'KOSPI',
};
function filing(changes: Partial<ConfirmedFilingRow> = {}): ConfirmedFilingRow {
  return {
    id: 'filing',
    companyId: company.id,
    externalId: '20260905000001',
    title: '임원ㆍ주요주주특정증권등소유상황보고서',
    filingDate: '2026-09-05',
    firstObservedAt: '2026-09-06T00:00:00Z',
    publishedAt: null,
    sourceDetailType: 'D002',
    canonicalType: 'D002',
    classificationStatus: 'CONFIRMED',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    activeParseRunId: 'parse',
    parseRunId: 'parse',
    parseFilingId: 'filing',
    parseStatus: 'SUCCEEDED',
    validationStatus: 'PASSED',
    classificationResult: 'RULE_CONFIRMED',
    inputType: 'D002',
    extractorType: 'D002',
    resultType: 'D002',
    rawSha256: 'a'.repeat(64),
    parseResult: structuredClone(result),
    eventId: 'event',
    eventState: 'VERIFIED',
    eventType: 'INSIDER_OWNERSHIP',
    eventMetadata: { parseRunId: 'parse' },
    pendingReview: 0,
    pendingRelation: 0,
    ...changes,
  };
}

test('confirmed feed renders exact buy/sell facts, original title, linked stock and event detail', async () => {
  const row = filing();
  const sell = filing({
    id: 'sell',
    parseFilingId: 'sell',
    externalId: '20260905000002',
    eventId: 'sell-event',
    filingDate: '2026-09-06',
    parseResult: {
      ...result,
      parsed: {
        ...parsed,
        transactions: [
          {
            ...buy,
            nature: 'MARKET_SELL',
            direction: 'DECREASE',
            quantity: '-250',
            methodRaw: '장내매도',
          },
        ],
      },
      crosscheck: { status: 'OK', exactReceiptMatches: [{ rcept_no: '20260905000002' }] },
    },
  });
  const before = structuredClone([row, sell]);
  const source = {
    query: async (sql: string) => (sql.includes('FROM filings f') ? [sell, row, row] : []),
  } as unknown as DataSource;
  const items = await confirmedFilingsForCompanies(source, [company]);
  assert.deepEqual(
    items.map((item) => item.signal),
    ['SELL', 'BUY'],
  );
  assert.equal(items[0]!.summaryTitle, '[매도신호] 홍길동 대표이사 -250주 장내매도');
  assert.equal(items[1]!.summaryTitle, '[매수신호] 홍길동 대표이사 +1,000주 장내매수');
  assert.equal(items[1]!.title, row.title);
  assert.equal(items[1]!.url, '/events/event');
  assert.deepEqual(items[1]!.relatedCompanies, [company]);
  assert.equal(items[1]!.eventDate, '2026-09-03');
  assert.equal(items[1]!.filingDate, '2026-09-05');
  assert.equal(items[1]!.publishedAt, null);
  assert.equal(items[1]!.firstObservedAt, '2026-09-06T00:00:00.000Z');
  assert.deepEqual([row, sell], before);
});

for (const [label, changes] of Object.entries({
  'no active parse': { activeParseRunId: null },
  'shadow parse': { activeParseRunId: 'new-run' },
  'other filing parse': { parseFilingId: 'other-filing' },
  'stale event': { eventMetadata: { parseRunId: 'old-run' } },
  'cancelled event': { eventState: 'CANCELLED' },
  'open event': { eventState: 'OPEN' },
  'pending event': { eventState: 'REVIEW_REQUIRED' },
  'partial parse': { parseStatus: 'PARTIAL' },
  'failed parse': { parseStatus: 'FAILED' },
  'unvalidated parse': { validationStatus: 'REVIEW_REQUIRED' },
  'suggested classification': { classificationResult: 'AI_SUGGESTED' },
  'unknown classification': { classificationStatus: 'UNKNOWN' },
  'wrong event type': { eventType: 'TRADE_PLAN' },
  'wrong extractor': { extractorType: 'D005' },
  'wrong result': { resultType: 'D001' },
  'superseded filing': { effectiveState: 'SUPERSEDED' },
  'cancelled filing': { effectiveState: 'CANCELLED' },
  'withdrawn filing': { effectiveState: 'WITHDRAWN' },
  'withdrawal document': { submissionKind: 'WITHDRAWAL' },
  'open review': { pendingReview: 1 },
  'pending correction': { pendingRelation: 1 },
  'unprojected parse': { parseResult: { ...result, projectionApplied: false } },
  'offline staging': { parseResult: { ...result, staging: { mode: 'OFFLINE_INACTIVE' } } },
  'missing source verification': { parseResult: { ...result, crosscheck: null } },
  'wrong source receipt': {
    parseResult: {
      ...result,
      crosscheck: { status: 'OK', exactReceiptMatches: [{ rcept_no: 'another' }] },
    },
  },
  'stale title classification': { title: '임원ㆍ주요주주특정증권등거래계획보고서' },
  'future plan': {
    canonicalType: 'D005',
    inputType: 'D005',
    extractorType: 'D005',
    resultType: 'D005',
    parseResult: { ...result, parsed: { ...parsed, detailType: 'D005' } },
  },
}) as Array<[string, Partial<ConfirmedFilingRow>]>) {
  test(`confirmed feed excludes ${label}`, () => {
    assert.equal(confirmedDartSummary(filing(changes)), null);
  });
}

test('effective verified corrections remain visible and metadata strings are decoded', () => {
  const summary = confirmedDartSummary(
    filing({
      submissionKind: 'CORRECTION',
      title: '[기재정정]임원ㆍ주요주주특정증권등소유상황보고서',
      eventType: 'CORRECTION',
      parseResult: JSON.stringify(result),
      eventMetadata: JSON.stringify({ parseRunId: 'parse' }),
      pendingReview: '0',
      pendingRelation: '0',
    }),
  );
  assert.equal(summary?.signal, 'BUY');
});

test('confirmed large holdings retain their own domain instead of inferring a purchase', () => {
  const summary = confirmedDartSummary(
    filing({
      title: '주식등의대량보유상황보고서',
      sourceDetailType: 'D001',
      canonicalType: 'D001',
      inputType: 'D001',
      extractorType: 'D001',
      resultType: 'D001',
      eventType: 'LARGE_HOLDER',
      parseResult: {
        ...result,
        parsed: {
          detailType: 'D001',
          reporterName: '홍길동',
          reportReasonRaw: '담보계약 변경',
          changes: [{ direction: 'INCREASE', quantity: '1000', eventDate: '2026-09-03' }],
        },
      },
    }),
  );
  assert.equal(summary?.signal, 'NONE');
  assert.equal(summary?.summaryTitle, '[대량보유 공시] 홍길동 담보계약 변경');
  assert.equal(summary?.eventDate, '2026-09-03');
});

test('source-reviewed disclosures require proof bound to their immutable parse and source', () => {
  const sourceReview = {
    parseRunId: 'parse',
    rawSha256: 'a'.repeat(64),
    confirmedByAdminId: '00000000-0000-4000-8000-000000000001',
    confirmedAt: '2020-01-01T00:00:00.000Z',
  };
  for (const kind of ['D003', 'D004']) {
    const row = filing({
      title: kind === 'D003' ? '의결권대리행사권유참고서류' : '공개매수결과보고서',
      sourceDetailType: kind,
      canonicalType: kind,
      inputType: kind,
      extractorType: kind,
      resultType: kind,
      eventType: kind === 'D003' ? 'PROXY_SOLICITATION' : 'TENDER_OFFER',
      parseResult: {
        projectionApplied: true,
        sourceReview,
        crosscheck: { status: 'NOT_APPLICABLE', reason: `NO_SUMMARY_API_FOR_${kind}` },
        parsed: {
          detailType: kind,
          documentKind: 'RESULT',
          source: { archiveSha256: 'a'.repeat(64) },
        },
      },
    });
    assert.equal(confirmedDartSummary(row)?.signal, 'NONE');
    const current = row.parseResult as Record<string, unknown>;
    assert.equal(
      confirmedDartSummary({ ...row, parseResult: { ...current, sourceReview: null } }),
      null,
    );
    assert.equal(
      confirmedDartSummary({
        ...row,
        parseResult: { ...current, sourceReview: { ...sourceReview, parseRunId: 'old-parse' } },
      }),
      null,
    );
    assert.equal(confirmedDartSummary({ ...row, rawSha256: 'b'.repeat(64) }), null);
    if (kind === 'D004') {
      assert.equal(
        confirmedDartSummary({
          ...row,
          title: '공개매수신고서',
          parseResult: {
            ...current,
            parsed: {
              detailType: kind,
              documentKind: 'REPORT',
              source: { archiveSha256: 'a'.repeat(64) },
            },
          },
        }),
        null,
      );
    }
  }
});

test('verified historical observations remain visible even when notification delivery is muted', () => {
  assert.equal(
    confirmedDartSummary(
      filing({
        eventMetadata: { parseRunId: 'parse', suppressAlerts: true },
        parseResult: { ...result, suppressAlerts: true },
      }),
    )?.signal,
    'BUY',
  );
});

test('ownership increases and gifts never become buy signals; mixed trades keep both directions', () => {
  for (const transaction of [
    { ...buy, nature: 'GIFT', methodRaw: '수증' },
    { ...buy, nature: 'UNKNOWN' },
    { ...buy, direction: 'DECREASE' },
    { ...buy, quantity: '-1000' },
  ]) {
    const summary = confirmedDartSummary(
      filing({ parseResult: { ...result, parsed: { ...parsed, transactions: [transaction] } } }),
    );
    assert.equal(summary?.signal, 'NONE');
    assert.doesNotMatch(summary!.summaryTitle, /매수신호|매도신호/u);
  }
  const mixed = confirmedDartSummary(
    filing({
      parseResult: {
        ...result,
        parsed: {
          ...parsed,
          transactions: [
            buy,
            {
              ...buy,
              nature: 'MARKET_SELL',
              direction: 'DECREASE',
              quantity: '-200',
              methodRaw: '장내매도',
            },
          ],
        },
      },
    }),
  );
  assert.equal(mixed?.signal, 'MIXED');
  assert.match(mixed!.summaryTitle, /^\[매수신호\] \[매도신호\]/u);
});

test('legacy invalid rows cannot starve older confirmed filings', async () => {
  const offsets: unknown[] = [];
  const source = {
    query: async (sql: string, params: unknown[]) => {
      if (!sql.includes('FROM filings f')) return [];
      const offset = params.at(-1);
      offsets.push(offset);
      return offset === 0
        ? Array.from({ length: 32 }, (_, i) =>
            filing({ id: `pending-${i}`, eventState: 'REVIEW_REQUIRED' }),
          )
        : [filing()];
    },
  } as unknown as DataSource;
  const items = await confirmedFilingsForCompanies(source, [company]);
  assert.equal(items.length, 1);
  assert.deepEqual(offsets, [0, 32]);
});

test('SEC receipt metadata and unverified ownership are excluded; verified XML retains multi-class scope', async () => {
  const ownership = {
    rawSha256: 'b'.repeat(64),
    documentType: '4',
    issuer: { cik: '0000000001' },
    provenance: { accessionNumber: '0000000001-26-000001' },
    unresolvedFootnoteReferences: [],
    reportingOwners: [{ name: 'Jane Doe', officerTitle: 'CEO' }],
    transactions: [
      {
        transactionCode: 'P',
        acquiredDisposedCode: 'A',
        transactionShares: '1000',
        transactionDate: '2026-09-02',
        derivative: false,
      },
    ],
  };
  const row: ConfirmedFilingRow = {
    id: 'sec',
    companyId: null,
    externalId: '0000000001-26-000001',
    title: 'SEC Form 4',
    filingDate: '2026-09-05',
    firstObservedAt: '2026-09-06T00:00:00Z',
    url: 'https://www.sec.gov/Archives/edgar/data/1/receipt.xml',
    eventId: 'sec-event',
    eventState: 'VERIFIED',
    eventType: 'OTHER',
    pendingReview: 0,
    eventMetadata: {
      observationKind: 'SEC_INSIDER_TRANSACTION',
      sourceItemId: 'sec',
      accessionNumber: '0000000001-26-000001',
      ownership,
    },
    sourceMetadata: {
      ownershipStatus: 'COMPLETED',
      secOwnership: ownership,
      cik: '0000000001',
      form: '4',
    },
  };
  const source = {
    query: async (sql: string) => {
      if (sql.includes('FROM filings f')) return [];
      if (sql.includes('FROM source_items s'))
        return [
          row,
          { ...row, id: 'open', eventState: 'OPEN' },
          { ...row, id: 'raw', sourceMetadata: {} },
        ];
      return [
        { sourceId: 'sec', companyId: 'mine' },
        { sourceId: 'sec', companyId: 'other' },
      ];
    },
  } as unknown as DataSource;
  const items = await confirmedFilingsForCompanies(source, [company]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.summaryTitle, '[매수신호] Jane Doe CEO +1,000주 시장·장외매수');
  assert.equal(items[0]!.url, '/events/sec-event');
  assert.deepEqual(items[0]!.relatedCompanies, [company]);
  assert.equal(items[0]!.eventDate, '2026-09-02');
});
