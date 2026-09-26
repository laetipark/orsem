import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RightsMode, type CompanyTimeline, type EventSummaryView } from '@orsem/contracts';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { buildCompanyTimeline } from './company-timeline';
import { mapEventSummary, type EventFilingFacts } from './resource-projections';

const fixtures = new FixtureStoreService();
const company = fixtures.companies[0]!;

function timeline(
  events: EventSummaryView[],
  prices: CompanyTimeline['prices'] = [],
  indicatorWarmupPrices: CompanyTimeline['prices'] = [],
) {
  return buildCompanyTimeline({
    company,
    configured: true,
    interval: '1d',
    prices,
    indicatorWarmupPrices,
    events,
  });
}

function price(time: string, close: number): CompanyTimeline['prices'][number] {
  return {
    time,
    sessionDate: time,
    observedAt: `${time}T06:30:00.000Z`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
    source: 'TOSS_KR',
    rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
  };
}

test('holding changes, insider transactions and trade plans keep distinct facts and timeline markers', () => {
  const holder: EventFilingFacts = {
    ...fixtures.filings[0]!,
    detailType: 'D001',
    transactions: [],
    largeHolding: {
      changes: [
        {
          id: '10000000-0000-4000-8000-000000000099',
          eventDate: '2026-09-01',
          methodRaw: '원인 검토 필요',
          direction: 'UNKNOWN',
          shareChange: '1000.000000',
        },
      ],
    },
  };
  const facts = [holder, fixtures.filings[0]!, fixtures.filings[1]!];
  const summaries = facts.map((filing, index) =>
    mapEventSummary(
      { ...fixtures.events[0]!, id: `event-${index}`, filing, company: filing.company },
      filing,
      undefined,
      null,
    ),
  );
  assert.deepEqual(
    summaries.map(({ detailType, nature, direction, eventAt }) => ({
      detailType,
      nature,
      direction,
      eventAt,
    })),
    [
      { detailType: 'D001', nature: null, direction: 'UNKNOWN', eventAt: '2026-09-01' },
      { detailType: 'D002', nature: 'MARKET_BUY', direction: 'INCREASE', eventAt: '2026-09-01' },
      { detailType: 'D005', nature: 'UNKNOWN', direction: 'UNKNOWN', eventAt: '2026-09-10' },
    ],
  );
  const value = timeline(summaries);
  assert.deepEqual(
    value.markers.filter((marker) => marker.kind === 'TRADE').map((marker) => marker.detailType),
    ['D001', 'D002'],
  );
  assert.deepEqual(
    value.markers.filter((marker) => marker.kind === 'FILING').map((marker) => marker.detailType),
    ['D001', 'D002', 'D005'],
  );
  assert.equal(summaries[0]?.rightsMode, RightsMode.OFFICIAL_PUBLIC_DATA);
  assert.equal(holder.largeHolding?.changes[0]?.shareChange, '1000.000000');
});

test('news markers use publication dates in KST while observation instants and source rights remain intact', () => {
  const source = {
    ...fixtures.sourceItems[0]!,
    source: 'COMPANY_IR',
    publishedAt: '2026-09-04T15:10:00.000Z',
    firstObservedAt: '2026-09-06T01:00:00.000Z',
    rightsMode: RightsMode.STORE_METADATA_ONLY,
  };
  const event = {
    ...fixtures.events[0]!,
    filing: null,
    sourceItems: [source],
    occurredAt: null,
    publishedAt: source.publishedAt,
    firstObservedAt: source.firstObservedAt,
  };
  const summary = mapEventSummary(event, null, undefined, null);
  assert.equal(summary.eventAt, null);
  assert.equal(summary.rceptDate, null);
  assert.equal(summary.publishedAt, '2026-09-04T15:10:00.000Z');
  assert.equal(summary.firstObservedAt, '2026-09-06T01:00:00.000Z');
  assert.equal(summary.rightsMode, RightsMode.STORE_METADATA_ONLY);
  assert.equal(summary.officialUrl, source.url);
  assert.deepEqual(
    timeline([summary]).markers.map(({ kind, time }) => ({ kind, time })),
    [{ kind: 'NEWS', time: '2026-09-05' }],
  );
});

test('non-trading-day return windows use stored sessions and exclude indicator warmup prices', () => {
  const summary = mapEventSummary(fixtures.events[0]!, fixtures.filings[0]!, undefined, null);
  const value = timeline(
    [{ ...summary, eventAt: null, rceptDate: '2026-09-06' }],
    [price('2026-09-04', 100), price('2026-09-07', 110), price('2026-09-08', 121)],
    [price('2026-09-03', 1)],
  );
  assert.deepEqual(value.markers[0]?.returnWindows, {
    pre1d: 10,
    post1d: 10,
    post5d: null,
    post20d: null,
  });
  assert.deepEqual(value.returns, {
    oneDay: 10,
    oneMonth: 21,
    sinceLatestEvent: 10,
    benchmarkOneMonth: null,
  });
  assert.equal(value.prices.length, 3);
  assert.equal(value.indicatorWarmupPrices?.length, 1);
  assert.equal(value.priceSources.length, 1);
  assert.equal(value.priceSources[0]?.source, 'TOSS_KR');
  assert.equal(value.priceSources[0]?.rightsMode, RightsMode.PRIVATE_DISPLAY_ONLY);
  assert.equal(value.latestCloseAt, '2026-09-08');
});
