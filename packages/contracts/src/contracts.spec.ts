import assert from 'node:assert/strict';
import test from 'node:test';
import {
  companyTimelineQuerySchema,
  ClassificationReviewResult,
  createIrSourceSchema,
  backfillRequestSchema,
  Direction,
  EffectiveFilingState,
  EvidenceGrade,
  FilingRelationType,
  RelationReviewDecision,
  ReviewTaskStatus,
  RightsMode,
  SubmissionKind,
  TransactionNature,
  WorkerJobName,
  companySchema,
  companyTimelineSchema,
  deliveryAckSchema,
  deviceCommandSchema,
  integerStringSchema,
  loginRequestSchema,
  pairingClaimSchema,
} from './index';

test('large quantities stay strings at the JSON boundary', () => {
  const value = '9223372036854775807';
  assert.equal(integerStringSchema.parse(value), value);
  assert.throws(() => integerStringSchema.parse(Number(value)));
});

test('OpenDART backfills validate order and preserve explicit detail types', () => {
  const valid = backfillRequestSchema.parse({
    detailTypes: ['D001', 'D002'],
    startDate: '2025-01-01',
    endDate: '2026-09-03',
  });
  assert.deepEqual(valid.detailTypes, ['D001', 'D002']);
  assert.equal(
    backfillRequestSchema.safeParse({
      detailTypes: ['D005'],
      startDate: '2026-09-03',
      endDate: '2026-01-01',
    }).success,
    false,
  );
  assert.equal(
    backfillRequestSchema.safeParse({
      detailTypes: ['D002', 'D002'],
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    }).success,
    false,
  );
});

test('transaction literals are stable', () => {
  assert.equal(TransactionNature.MARKET_BUY, 'MARKET_BUY');
  assert.equal(Direction.INCREASE, 'INCREASE');
});

test('Alpaca asset-master synchronization has a distinct worker contract', () => {
  assert.equal(WorkerJobName.SYNC_ALPACA_ASSETS, 'sync-alpaca-assets');
  assert.notEqual(WorkerJobName.SYNC_ALPACA_ASSETS, WorkerJobName.INGEST_TOSS_CANDLES);
});

test('login requires a meaningful password length', () => {
  assert.equal(
    loginRequestSchema.safeParse({ email: 'a@example.com', password: 'short' }).success,
    false,
  );
});

test('approved rights, evidence and review vocabularies do not drift', () => {
  assert.deepEqual(Object.values(RightsMode), [
    'OFFICIAL_PUBLIC_DATA',
    'PRIVATE_DISPLAY_ONLY',
    'STORE_METADATA_ONLY',
    'LINK_ONLY',
    'NO_REDISTRIBUTION',
  ]);
  assert.deepEqual(Object.values(EvidenceGrade), ['A', 'B', 'C', 'UNVERIFIED']);
  assert.deepEqual(Object.values(ClassificationReviewResult), [
    'RULE_CONFIRMED',
    'AI_CONFIRMED',
    'AI_SUGGESTED',
    'REVIEW_REQUIRED',
  ]);
  assert.deepEqual(Object.values(ReviewTaskStatus), [
    'OPEN',
    'RESOLVED',
    'DISMISSED',
    'SUPERSEDED',
  ]);
});

test('filing submission and effective state are independent axes', () => {
  assert.equal(SubmissionKind.CORRECTION, 'CORRECTION');
  assert.equal(EffectiveFilingState.SUPERSEDED, 'SUPERSEDED');
  assert.equal(FilingRelationType.EXECUTION_CANDIDATE, 'EXECUTION_CANDIDATE');
  assert.equal(RelationReviewDecision.REJECTED, 'REJECTED');
});

test('MessengerBotR wire payloads accept the ES5 bridge shapes', () => {
  assert.equal(
    pairingClaimSchema.safeParse({
      code: '123456',
      deviceId: 'device-1',
      room: '관리자방',
      authorHash: 'author-hash',
      packageName: 'com.kakao.talk',
      botVersion: '0.1.0',
    }).success,
    true,
  );
  assert.equal(
    deviceCommandSchema.parse({ deviceId: 'device-1', command: 'STATUS', query: null }).query,
    '',
  );
  assert.equal(
    deliveryAckSchema.safeParse({ ok: true, error: null, externalMessageId: 'discord-1' }).success,
    true,
  );
});

test('domestic stock codes and SEC CIK values keep their fixed-width identities', () => {
  const base = {
    id: 'company-1',
    market: 'KOSPI',
    corpCode: '00126380',
    stockCode: '005930',
    ticker: null,
    cik: null,
    nameKo: '삼성전자',
    nameEn: 'Samsung Electronics',
    isListed: true,
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  assert.equal(companySchema.safeParse(base).success, true);
  assert.equal(companySchema.safeParse({ ...base, stockCode: '5930' }).success, false);
  assert.equal(
    companySchema.safeParse({ ...base, stockCode: null, cik: '1045810' }).success,
    false,
  );
});

test('IR sources accept only public HTTPS RSS/Atom feeds with official-data rights', () => {
  const base = {
    companyId: '00000000-0000-4000-8000-000000000001',
    sourceType: 'RSS' as const,
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    isActive: true,
  };
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, url: 'https://example.com/feed.xml' }).success,
    true,
  );
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, sourceType: 'PAGE', url: 'https://example.com/' })
      .success,
    false,
  );
  assert.equal(
    createIrSourceSchema.safeParse({
      ...base,
      rightsMode: RightsMode.LINK_ONLY,
      url: 'https://example.com/feed.xml',
    }).success,
    false,
  );
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, url: 'http://example.com/feed.xml' }).success,
    false,
  );
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, url: 'file:///etc/passwd' }).success,
    false,
  );
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, url: 'https://user:secret@example.com/feed' })
      .success,
    false,
  );
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, url: 'https://127.0.0.1/feed' }).success,
    false,
  );
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, url: 'https://169.254.169.254/latest/meta-data' })
      .success,
    false,
  );
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, url: 'https://[::1]/feed' }).success,
    false,
  );
  assert.equal(
    createIrSourceSchema.safeParse({ ...base, url: 'https://[::ffff:127.0.0.1]/feed' }).success,
    false,
  );
});

test('price timelines preserve source rights and feed limitations', () => {
  const parsed = companyTimelineSchema.parse({
    companyId: 'company-1',
    currency: 'USD',
    provider: 'toss',
    interval: '1d',
    status: 'READY',
    prices: [
      {
        time: '2026-09-02',
        sessionDate: '2026-09-02',
        observedAt: null,
        open: 100,
        high: 103,
        low: 99,
        close: 102,
        volume: 1000,
        source: 'TOSS_US',
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      },
    ],
    priceSources: [
      {
        source: 'TOSS_US',
        sourceName: '토스증권 Open API',
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        feed: 'REST 캔들',
        adjustment: 'RAW',
        attribution: '출처: 토스증권 Open API',
        limitation: '비조정 일봉입니다.',
      },
    ],
    markers: [],
    returns: {
      oneDay: null,
      oneMonth: null,
      sinceLatestEvent: null,
      benchmarkOneMonth: null,
    },
    latestCloseAt: '2026-09-02',
  });

  assert.equal(parsed.prices[0]?.source, 'TOSS_US');
  assert.equal(parsed.priceSources[0]?.adjustment, 'RAW');
  assert.equal(
    companyTimelineSchema.safeParse({
      ...parsed,
      prices: parsed.prices.map((point) => ({ ...point, source: 'ALPACA_IEX_RAW' })),
    }).success,
    false,
  );
  assert.equal(
    companyTimelineSchema.safeParse({
      ...parsed,
      priceSources: parsed.priceSources.map((source) => ({ ...source, source: 'KRX' })),
    }).success,
    false,
  );
  assert.equal(companyTimelineSchema.safeParse({ ...parsed, interval: '1m' }).success, false);
  const minute = {
    ...parsed,
    interval: '1m',
    prices: parsed.prices.map((point) => ({ ...point, time: '2026-09-02T14:30:00.000Z' })),
    latestCloseAt: '2026-09-02T14:30:00.000Z',
  };
  assert.equal(companyTimelineSchema.safeParse(minute).success, true);
  assert.equal(companyTimelineSchema.safeParse({ ...minute, interval: '1d' }).success, false);
});

test('timeline queries default to daily and keep provider selection explicit', () => {
  assert.deepEqual(companyTimelineQuerySchema.parse({}), { range: '3M', interval: '1d' });
  assert.equal(companyTimelineQuerySchema.parse({ source: 'toss', interval: '1m' }).source, 'toss');
  assert.equal(companyTimelineQuerySchema.safeParse({ source: 'combined' }).success, false);
  assert.equal(companyTimelineQuerySchema.safeParse({ source: 'legacy' }).success, false);
  assert.equal(WorkerJobName.INGEST_TOSS_CANDLES, 'ingest-toss-candles');
});
