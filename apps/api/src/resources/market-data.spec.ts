import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  companyLivePriceSchema,
  companyTimelineSchema,
  ConnectorStatus,
  RightsMode,
  watchlistQuotesQuerySchema,
  watchlistQuotesSchema,
} from '@orsem/contracts';
import { PriceBarEntity } from '@orsem/database';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { LivePriceService } from './live-price.service';
import { OrsemDataService } from './orsem-data.service';
import { CompaniesController } from './resource.controllers';
import { OperationsController } from '../operations/operations.controller';
import { WorkerQueueService } from '../operations/worker-queue.service';

const company = new FixtureStoreService().companies[0]!;
const configured = loadAppConfig({
  NODE_ENV: 'test',
  TOSS_CLIENT_ID: 'test-client',
  TOSS_CLIENT_SECRET: 'test-secret',
});

function bar(
  source: string,
  interval: '1d' | '1m',
  at: string,
  close: number,
  sessionDate: string,
): PriceBarEntity {
  return Object.assign(new PriceBarEntity(), {
    companyId: company.id,
    source,
    interval,
    barAt: new Date(at),
    sessionDate,
    open: String(close),
    high: String(close),
    low: String(close),
    close: String(close),
    volume: '10',
    currency: 'KRW',
    rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
    observedAt: new Date(at),
  });
}

function dataService(rows: PriceBarEntity[], config = configured) {
  const queries: Array<Record<string, unknown>> = [];
  const database = {
    dataSource: {
      getRepository: () => ({
        createQueryBuilder: () => {
          const parameters: Record<string, unknown> = {};
          queries.push(parameters);
          const qb = {
            where(_clause: string, values: Record<string, unknown>) {
              parameters.clauses = [_clause];
              Object.assign(parameters, values);
              return qb;
            },
            andWhere(_clause: string, values: Record<string, unknown>) {
              (parameters.clauses as string[]).push(_clause);
              Object.assign(parameters, values);
              return qb;
            },
            select() {
              return qb;
            },
            orderBy(_field: string, direction: string) {
              parameters.direction = direction;
              return qb;
            },
            take(limit: number) {
              parameters.limit = limit;
              return qb;
            },
            async getMany() {
              if (parameters.before0) {
                return rows
                  .filter((row) =>
                    Object.keys(parameters).some((key) => {
                      if (!/^company\d+$/.test(key)) return false;
                      const index = key.slice('company'.length);
                      return (
                        row.companyId === parameters[key] &&
                        row.source === parameters[`source${index}`] &&
                        row.currency === parameters[`currency${index}`] &&
                        row.interval === '1d' &&
                        row.sessionDate! < String(parameters[`before${index}`]) &&
                        row.rightsMode === parameters.closeRightsMode
                      );
                    }),
                  )
                  .sort((a, b) => b.sessionDate!.localeCompare(a.sessionDate!));
              }
              return rows
                .filter(
                  (row) =>
                    row.companyId === parameters.companyId &&
                    row.source === parameters.source &&
                    row.interval === parameters.interval,
                )
                .filter((row) => !parameters.cutoff || row.barAt >= (parameters.cutoff as Date))
                .filter((row) => !parameters.before || row.barAt < (parameters.before as Date))
                .sort((a, b) => b.barAt.getTime() - a.barAt.getTime())
                .slice(0, Number(parameters.limit));
            },
          };
          return qb;
        },
      }),
    },
  } as unknown as DatabaseRuntimeService;
  const data = new OrsemDataService(config, database, new FixtureStoreService());
  data.getCompany = async () => company;
  data.listEvents = async () => ({
    items: [],
    nextCursor: null,
    pageInfo: { nextCursor: null, hasMore: false },
  });
  return { data, queries };
}

test('the default Toss timeline never mixes or silently falls back to legacy prices', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const at = `${today}T00:00:00.000Z`;
  const { data } = dataService([
    bar('KRX', '1d', at, 100, today),
    bar('TOSS_KR', '1d', at, 200, today),
  ]);
  const current = companyTimelineSchema.parse(await data.companyTimeline(company.id, '1M'));
  assert.equal(current.provider, 'toss');
  assert.equal(current.status, 'READY');
  assert.deepEqual(
    current.prices.map((price) => [price.source, price.close]),
    [['TOSS_KR', 200]],
  );
  const onlyLegacy = dataService([bar('KRX', '1d', at, 100, today)]);
  const empty = await onlyLegacy.data.companyTimeline(company.id, '1M');
  assert.equal(empty.status, 'PENDING');
  assert.deepEqual(empty.prices, []);
});

test('missing Toss credentials produce an explicit empty state without loading historical sources', async () => {
  const { data, queries } = dataService([], loadAppConfig({ NODE_ENV: 'test' }));
  const value = await data.companyTimeline(company.id, '3M');
  assert.equal(value.status, 'NOT_CONFIGURED');
  assert.deepEqual(value.prices, []);
  assert.equal(queries.length, 0);
});

test('NAVER scheduled search ignores legacy persisted health without current in-memory evidence', async () => {
  const { data } = dataService(
    [],
    loadAppConfig({
      NODE_ENV: 'test',
      NAVER_API_PROVIDER: 'ncloud',
      NAVER_CLIENT_ID: 'test-cloud-client',
      NAVER_CLIENT_SECRET: 'test-cloud-secret',
    }),
  );
  const checkedAt = new Date().toISOString();
  data.connectors = async () => [
    {
      connector: 'naver',
      status: ConnectorStatus.HEALTHY,
      message: null,
      lastSuccessAt: checkedAt,
      lastFailureAt: null,
      checkedAt,
    },
  ];
  data.hasCompatibleIrSources = async () => false;
  const naver = (await data.connectorSourceViews()).find((source) => source.id === 'naver');
  assert.equal(naver?.name, 'NAVER Cloud 뉴스검색');
  assert.equal(naver?.status, ConnectorStatus.DISABLED);
  assert.match(String(naver?.message), /순환 검색/);
  assert.equal(naver?.lastSuccessAt, null);
});

test('retired price providers are rejected with HTTP 400 and hidden from market health', async () => {
  const { data } = dataService([]);
  const sessions = {} as SessionRuntimeService;
  const queue = {} as WorkerQueueService;
  const controller = new CompaniesController(
    data,
    new LivePriceService(configured, data, sessions),
    queue,
    {} as never,
    {} as never,
  );
  await assert.rejects(
    controller.timeline(company.id, { source: 'legacy' }),
    (error: unknown) => error instanceof BadRequestException && error.getStatus() === 400,
  );
  data.connectors = async () =>
    ['krx', 'alpaca'].map((connector) => ({
      connector,
      status: ConnectorStatus.UNCONFIGURED,
      message: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      checkedAt: new Date().toISOString(),
    }));
  data.hasCompatibleIrSources = async () => false;
  const sources = await data.connectorSourceViews();
  assert.deepEqual(
    sources.filter((source) => source.category === 'MARKET').map((source) => source.id),
    ['toss'],
  );
  const operations = new OperationsController(configured, data, sessions, queue);
  const connectors = await operations.connectorList();
  assert.equal(
    connectors.some((source) => source.connector === 'krx' || source.connector === 'alpaca'),
    false,
  );
});

test('minute timelines return the latest 1000 instants in order and never compute daily returns from minutes', async () => {
  const rows = Array.from({ length: 1002 }, (_, index) => {
    const at = new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString();
    return bar('TOSS_KR', '1m', at, index + 1, '2026-09-01');
  });
  const { data, queries } = dataService(rows);
  const value = companyTimelineSchema.parse(await data.companyTimeline(company.id, '1Y', '1m'));
  assert.equal(value.prices.length, 1000);
  assert.equal(value.prices[0]?.close, 3);
  assert.equal(value.prices.at(-1)?.close, 1002);
  assert.equal(value.prices[0]?.time, rows[2]?.barAt.toISOString());
  assert.equal(value.prices[0]?.sessionDate, '2026-09-01');
  assert.equal(queries[0]?.cutoff, undefined);
  assert.deepEqual(value.returns, {
    oneDay: null,
    oneMonth: null,
    sinceLatestEvent: null,
    benchmarkOneMonth: null,
  });
  assert.deepEqual(value.markers, []);
});

test('daily session dates are retained independently of the UTC instant', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const row = bar('TOSS_KR', '1d', `${today}T23:00:00.000Z`, 100, today);
  const { data } = dataService([row]);
  const value = await data.companyTimeline(company.id, '1M');
  assert.equal(value.prices[0]?.time, today);
  assert.equal(value.prices[0]?.sessionDate, today);
});

test('cached live prices expose receiving states without returning raw provider frames', async () => {
  let available = true;
  let cached: string | null = null;
  const { data } = dataService([]);
  const sessions = {
    readMarketQuote: async () => ({ available, value: cached }),
  } as unknown as SessionRuntimeService;
  const live = new LivePriceService(configured, data, sessions);
  assert.equal((await live.companyLivePrice(company.id)).status, 'WAITING');
  available = false;
  assert.equal((await live.companyLivePrice(company.id)).status, 'UNAVAILABLE');
  available = true;
  const snapshot = {
    companyId: company.id,
    symbol: company.stockCode!,
    source: 'TOSS_KR_INTEGRATED',
    currency: 'KRW',
    price: '123.45',
    providerAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
    lossy: true,
    rawPayload: { providerOnly: 'must not leave the cache' },
  };
  cached = JSON.stringify(snapshot);
  const value = companyLivePriceSchema.parse(await live.companyLivePrice(company.id));
  assert.equal(value.status, 'LIVE');
  assert.equal(value.quote?.price, '123.45');
  assert.equal('rawPayload' in value.quote!, false);
  assert.equal('companyId' in value.quote!, false);

  cached = JSON.stringify({ ...snapshot, providerAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal((await live.companyLivePrice(company.id)).status, 'STALE');
  cached = JSON.stringify({ ...snapshot, observedAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal((await live.companyLivePrice(company.id)).status, 'STALE');
  cached = JSON.stringify({ ...snapshot, companyId: 'another-company' });
  assert.equal((await live.companyLivePrice(company.id)).status, 'UNAVAILABLE');
  cached = '{invalid json';
  assert.equal((await live.companyLivePrice(company.id)).status, 'UNAVAILABLE');

  const missing = new LivePriceService(loadAppConfig({ NODE_ENV: 'test' }), data, sessions);
  assert.equal((await missing.companyLivePrice(company.id)).status, 'NOT_CONFIGURED');
});

test('watchlist quote batches read cache once, preserve stale prices and compare only previous sessions', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-05T03:00:00.000Z') });
  const fixtures = new FixtureStoreService();
  const companies = [fixtures.companies[0]!, fixtures.companies[2]!];
  const { data } = dataService([]);
  let requested: string[] = [];
  let cacheReads = 0;
  data.watchedCompanies = async (ids) => {
    requested = ids;
    return companies;
  };
  const snapshots = companies.map((item, index) => ({
    companyId: item.id,
    symbol: item.stockCode ?? item.ticker,
    source: index === 0 ? 'TOSS_KR_INTEGRATED' : 'TOSS_US',
    currency: index === 0 ? 'KRW' : 'USD',
    price: index === 0 ? '120' : '80',
    providerAt: index === 0 ? '2026-09-04T01:00:00.000Z' : '2026-09-04T00:00:00.000Z',
    observedAt: '2026-09-04T01:00:00.000Z',
    rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
    lossy: true,
    rawPayload: { private: 'omit' },
  }));
  const sessions = {
    readMarketQuote: async () => {
      throw new Error('Must not perform per-company reads');
    },
    readMarketQuotes: async () => {
      cacheReads += 1;
      return { available: true, values: snapshots.map((row) => JSON.stringify(row)) };
    },
  } as unknown as SessionRuntimeService;
  let closeReads = 0;
  data.previousDailyCloses = async (references) => {
    closeReads += 1;
    if (references.length === 1 && references[0]?.beforeDate === '2026-09-05') {
      assert.equal(references[0].companyId, companies[0]!.id);
      return new Map([[companies[0]!.id, { close: 125, sessionDate: '2026-09-04' }]]);
    }
    assert.deepEqual(
      references.map((item) => [item.source, item.currency, item.beforeDate]),
      [
        ['TOSS_KR', 'KRW', '2026-09-04'],
        ['TOSS_US', 'USD', '2026-09-03'],
      ],
    );
    return new Map([[companies[0]!.id, { close: 100, sessionDate: '2026-09-03' }]]);
  };
  const value = watchlistQuotesSchema.parse(
    await new LivePriceService(configured, data, sessions).watchlistQuotes(
      companies.map((item) => item.id),
    ),
  );
  assert.deepEqual(
    requested,
    companies.map((item) => item.id),
  );
  assert.equal(cacheReads, 1);
  assert.equal(closeReads, 2);
  assert.equal(value.items[0]?.status, 'STALE');
  assert.equal(value.items[0]?.quote?.price, '120');
  assert.equal(value.items[0]?.fallbackClose?.price, '125');
  assert.equal(value.items[0]?.fallbackClose?.sessionDate, '2026-09-04');
  assert.equal('rawPayload' in value.items[0]!.quote!, false);
  assert.equal(value.items[0]?.change, 20);
  assert.equal(value.items[0]?.changePercent, 20);
  assert.equal(value.items[0]?.referenceDate, '2026-09-03');
  assert.equal(value.items[1]?.previousClose, null);
  assert.equal(value.items[1]?.fallbackClose, null);
  assert.equal(value.items[1]?.changePercent, null);
});

test('quote batches reject invalid IDs, excessive payloads and non-watchlist companies before cache access', async () => {
  const fixtures = new FixtureStoreService();
  for (const ids of ['', 'not-an-id', Array(101).fill(company.id).join(',')]) {
    assert.equal(watchlistQuotesQuerySchema.safeParse({ ids }).success, false);
  }
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {} as DatabaseRuntimeService,
    fixtures,
  );
  assert.deepEqual(
    (await data.watchedCompanies([company.id, company.id])).map((item) => item.id),
    [company.id],
  );
  const live = new LivePriceService(configured, data, {
    readMarketQuotes: async () => {
      throw new Error('Cache must not be accessed');
    },
  } as unknown as SessionRuntimeService);
  await assert.rejects(
    () => live.watchlistQuotes([fixtures.companies[2]!.id]),
    BadRequestException,
  );
});

test('domestic close fallback uses the last stored earlier session across weekends and holidays', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-06T23:00:00.000Z') });
  const { data, queries } = dataService([
    bar('TOSS_KR', '1d', '2026-09-04T06:30:00.000Z', 71200, '2026-09-04'),
    bar('TOSS_KR', '1d', '2026-09-07T00:00:00.000Z', 72000, '2026-09-07'),
    bar('TOSS_KR', '1m', '2026-09-06T06:30:00.000Z', 99000, '2026-09-06'),
    bar('KRX', '1d', '2026-09-06T06:30:00.000Z', 98000, '2026-09-06'),
    Object.assign(bar('TOSS_KR', '1d', '2026-09-06T06:30:00.000Z', 97000, '2026-09-06'), {
      rightsMode: RightsMode.LINK_ONLY,
    }),
  ]);
  const live = new LivePriceService(configured, data, {
    readMarketQuote: async () => ({ available: true, value: null }),
  } as unknown as SessionRuntimeService);
  const value = companyLivePriceSchema.parse(await live.companyLivePrice(company.id));
  assert.equal(value.status, 'WAITING');
  assert.equal(value.quote, null);
  assert.deepEqual(value.fallbackClose, {
    price: '71200',
    currency: 'KRW',
    sessionDate: '2026-09-04',
    source: 'TOSS_KR',
  });
  assert.equal(queries[0]?.before0, '2026-09-07');
  assert.equal(queries[0]?.source0, 'TOSS_KR');
  assert.equal(queries[0]?.closeRightsMode, RightsMode.PRIVATE_DISPLAY_ONLY);
  const clauses = (queries[0]?.clauses as string[]).join('\n');
  assert.match(clauses, /bar\.interval = '1d'/);
  assert.match(clauses, /bar\.rightsMode = :closeRightsMode/);
  assert.match(clauses, /previous\.rights_mode = :closeRightsMode/);
  assert.match(clauses, /previous\.session_date < :before0/);
  context.mock.timers.setTime(new Date('2026-09-07T23:00:00.000Z').getTime());
  // The next day can also be a closure: use available history, never subtract one calendar day.
  data.previousDailyCloses = async (requests) => {
    assert.equal(requests[0]?.beforeDate, '2026-09-08');
    return new Map([[company.id, { close: 71200, sessionDate: '2026-09-04' }]]);
  };
  assert.equal((await live.companyLivePrice(company.id)).fallbackClose?.sessionDate, '2026-09-04');
});

test('today live and stale quotes take priority, while yesterday cache keeps its provenance beside the close', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-04T16:00:00.000Z') });
  const { data, queries } = dataService([
    bar('TOSS_KR', '1d', '2026-09-04T06:30:00.000Z', 71200, '2026-09-04'),
  ]);
  let providerAt = new Date().toISOString();
  const live = new LivePriceService(configured, data, {
    readMarketQuote: async () => ({
      available: true,
      value: JSON.stringify({
        companyId: company.id,
        symbol: company.stockCode,
        source: 'TOSS_KR_INTEGRATED',
        currency: 'KRW',
        price: '71100',
        providerAt,
        observedAt: new Date().toISOString(),
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        lossy: true,
      }),
    }),
  } as unknown as SessionRuntimeService);
  let value = await live.companyLivePrice(company.id);
  assert.equal(value.status, 'LIVE');
  assert.equal(value.fallbackClose, null);
  providerAt = '2026-09-04T15:00:01.000Z'; // September 5 in KST, despite the UTC date.
  value = await live.companyLivePrice(company.id);
  assert.equal(value.status, 'STALE');
  assert.equal(value.fallbackClose, null);
  assert.equal(queries.length, 0);
  providerAt = '2026-09-04T14:59:59.000Z';
  value = await live.companyLivePrice(company.id);
  assert.equal(value.status, 'STALE');
  assert.equal(value.quote?.providerAt, providerAt);
  assert.equal(value.quote?.price, '71100');
  assert.equal(value.fallbackClose?.price, '71200');
});

test('fallback survives cache outage and missing credentials, but never substitutes US or nonexistent closes', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-05T03:00:00.000Z') });
  const { data } = dataService([
    bar('TOSS_KR', '1d', '2026-09-04T06:30:00.000Z', 71200, '2026-09-04'),
  ]);
  const sessions = {
    readMarketQuote: async () => ({ available: false, value: null }),
  } as unknown as SessionRuntimeService;
  const live = new LivePriceService(configured, data, sessions);
  const unavailable = await live.companyLivePrice(company.id);
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.equal(unavailable.fallbackClose?.price, '71200');
  const unconfigured = await new LivePriceService(
    loadAppConfig({ NODE_ENV: 'test' }),
    data,
    sessions,
  ).companyLivePrice(company.id);
  assert.equal(unconfigured.status, 'NOT_CONFIGURED');
  assert.equal(unconfigured.fallbackClose?.price, '71200');
  data.getCompany = async () => ({ ...company, market: 'NASDAQ' });
  assert.equal((await live.companyLivePrice(company.id)).fallbackClose, null);
  data.getCompany = async () => company;
  data.previousDailyCloses = async () => new Map();
  assert.equal((await live.companyLivePrice(company.id)).fallbackClose, null);
  data.previousDailyCloses = async () => {
    throw new Error('Database is unavailable');
  };
  assert.equal((await live.companyLivePrice(company.id)).fallbackClose, null);
});

test('domestic watchlist fallback stays batched when every quote is missing', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-05T03:00:00.000Z') });
  const companies = ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].map((market, index) => ({
    ...company,
    id: `00000000-0000-4000-8000-00000000000${index}`,
    market: market as typeof company.market,
  }));
  const { data } = dataService([]);
  data.watchedCompanies = async () => companies;
  let batches = 0;
  data.previousDailyCloses = async (requests) => {
    if (!requests.length) return new Map();
    batches += 1;
    assert.deepEqual(
      requests.map((request) => request.companyId),
      companies.map((item) => item.id),
    );
    assert.ok(requests.every((request) => request.beforeDate === '2026-09-05'));
    return new Map(
      requests.map((request) => [request.companyId, { close: 71200, sessionDate: '2026-09-04' }]),
    );
  };
  const value = watchlistQuotesSchema.parse(
    await new LivePriceService(configured, data, {
      readMarketQuotes: async () => ({ available: false, values: [] }),
    } as unknown as SessionRuntimeService).watchlistQuotes(companies.map((item) => item.id)),
  );
  assert.equal(batches, 1);
  assert.ok(value.items.every((item) => item.fallbackClose?.price === '71200'));
  assert.ok(
    value.items.every(
      (item) => item.quote === null && item.change === null && item.status === 'UNAVAILABLE',
    ),
  );
});

test('timeline warmup reads earlier same-source candles without changing visible prices or returns', async () => {
  const current = new Date();
  current.setUTCHours(0, 0, 0, 0);
  const rows = Array.from({ length: 160 }, (_, index) => {
    const day = new Date(current.getTime() - (159 - index) * 86_400_000).toISOString().slice(0, 10);
    return bar('TOSS_KR', '1d', `${day}T00:00:00.000Z`, index + 1, day);
  });
  const wrongSource = { ...rows[0]!, source: 'KRX' } as PriceBarEntity;
  const wrongInterval = { ...rows[0]!, interval: '1m' } as PriceBarEntity;
  const { data, queries } = dataService([...rows, wrongSource, wrongInterval]);
  const value = companyTimelineSchema.parse(await data.companyTimeline(company.id, '1M'));
  const warmup = value.indicatorWarmupPrices!;
  assert.equal(warmup.length, 119);
  assert.ok(
    warmup.every((point) => point.source === 'TOSS_KR' && point.time < value.prices[0]!.time),
  );
  assert.ok(value.prices.length <= 32);
  assert.equal(value.prices.at(-1)?.close, 160);
  assert.equal(value.returns.oneDay, ((160 - 159) / 159) * 100);
  assert.equal(queries[1]?.limit, 119);
  assert.equal(queries[1]?.cutoff, undefined);
});
