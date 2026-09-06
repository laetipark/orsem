import {
  ConnectorHealthEntity,
  MarketInstrumentEntity,
  MarketObservationEntity,
} from '@orsem/database';
import { FindOperator, type DataSource, type FindManyOptions } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import { TossMarketClient } from '../src/market-data/toss-market.client';
import {
  MarketIndicatorClient,
  IndicatorRequestError,
  retryDelayMs,
  type IndicatorTask,
} from '../src/market-indicators/market-indicator.client';
import { MarketIndicatorIngestionService } from '../src/market-indicators/market-indicator-ingestion.service';
import {
  parseBithumbDaily,
  parseBithumbQuotes,
  parseEia,
  parseGoldHistory,
  parseGoldQuote,
  parseTossFx,
  parseTossIndicators,
  parseTreasury,
  type IndicatorObservation,
} from '../src/market-indicators/parsers';

const now = new Date('2026-09-04T02:00:00Z');
const config = loadWorkerConfig({ NODE_ENV: 'test' });
const toss = { enabled: false } as TossMarketClient;

describe('market indicator source normalization', () => {
  it('uses the supplied Bithumb KRW market and previous close without applying a currency conversion', () => {
    const result = parseBithumbQuotes(
      [
        {
          market: 'KRW-BTC',
          trade_price: 120_000_000,
          prev_closing_price: 119_000_000,
          trade_timestamp: now.getTime(),
        },
      ],
      now,
    );
    expect(result[0]).toMatchObject({
      instrumentId: 'btc',
      value: '120000000',
      referenceValue: '119000000',
      sourceDate: '2026-09-04',
      referenceDate: '2026-09-03',
      referenceLabel: '빗썸 전일 종가(KST) 대비',
    });
    expect(
      parseBithumbQuotes(
        [
          {
            market: 'KRW-BTC',
            trade_price: 120_000_000,
            prev_closing_price: 119_000_000,
            trade_timestamp: new Date('2026-09-03T16:00:00Z').getTime(),
          },
        ],
        now,
      )[0],
    ).toMatchObject({ sourceDate: '2026-09-04', referenceDate: '2026-09-03' });
    expect(() => parseBithumbQuotes([{ market: 'USDT-BTC' }], now)).toThrow();
  });

  it('preserves Bithumb KST candle dates and uses the exclusive KST pagination cursor', () => {
    const result = parseBithumbDaily(
      [{ market: 'KRW-ETH', candle_date_time_kst: '2026-09-04T00:00:00', trade_price: 4_000_000 }],
      'eth',
      now,
    );
    expect(result.rows[0]).toMatchObject({
      period: '2026-09-04',
      sourceDate: '2026-09-04',
      providerAt: new Date('2026-09-03T15:00:00Z'),
    });
    expect(result.nextBefore).toBe('2026-09-04T00:00:00');
    expect(() =>
      parseBithumbDaily(
        [{ market: 'KRW-BTC', candle_date_time_kst: '2026-09-04T00:00:00', trade_price: 4 }],
        'eth',
        now,
      ),
    ).toThrow();
  });

  it('handles Treasury XML namespaces, type attributes and missing yields without inventing zeroes or instants', () => {
    const result = parseTreasury(
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:m="urn:meta" xmlns:d="urn:data"><entry><content><m:properties><d:NEW_DATE m:type="Edm.DateTime">2026-09-03T00:00:00</d:NEW_DATE><d:BC_2YEAR m:type="Edm.Double">3.75</d:BC_2YEAR><d:BC_10YEAR m:null="true" /></m:properties></content></entry></feed>',
      now,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      instrumentId: 'us2y',
      value: '3.75',
      providerAt: null,
      sourceDate: '2026-09-03',
    });
    expect(() => parseTreasury('<!DOCTYPE foo [<!ENTITY test "123">]><feed/>', now)).toThrow();
    expect(() => parseTreasury('<feed><entry>', now)).toThrow();
  });

  it('rejects inverse FX and preserves the reference-rate fields without misusing spread basis points', () => {
    const result = parseTossFx(
      {
        result: {
          baseCurrency: 'USD',
          quoteCurrency: 'KRW',
          rate: '1380.5',
          basisPoint: '40',
          validFrom: now.toISOString(),
        },
      },
      now,
    );
    expect(result[0]).toMatchObject({ instrumentId: 'usd-krw', value: '1380.5' });
    expect(result[0]?.referenceValue).toBeUndefined();
    expect(result[1]).toMatchObject({ kind: 'DAILY', raw: { aggregation: 'OBSERVED_LAST' } });
    expect(() =>
      parseTossFx(
        {
          result: {
            baseCurrency: 'KRW',
            quoteCurrency: 'USD',
            rate: '0.001',
            validFrom: now.toISOString(),
          },
        },
        now,
      ),
    ).toThrow();
  });

  it('preserves optional Toss times as unknown and rejects future times or invalid symbols', () => {
    expect(
      parseTossIndicators(
        { result: [{ symbol: 'KOSPI', lastPrice: '2000', timestamp: null }] },
        now,
      )[0],
    ).toMatchObject({
      value: '2000',
      providerAt: null,
      sourceDate: null,
      raw: { timestamp: null },
    });
    expect(() =>
      parseTossIndicators(
        { result: [{ symbol: 'KOSPI', lastPrice: '2000', timestamp: '2027-01-01T00:00:00Z' }] },
        now,
      ),
    ).toThrow();
    expect(() =>
      parseTossIndicators(
        { result: [{ symbol: 'SP500', lastPrice: '2000', timestamp: now.toISOString() }] },
        now,
      ),
    ).toThrow();
    const row = { symbol: 'KOSPI', lastPrice: '2000', timestamp: now.toISOString() };
    expect(() => parseTossIndicators({ result: [row, row] }, now)).toThrow();
  });

  it('uses matching Bithumb UTC/KST fields despite an offset epoch and rejects inconsistent or future times', () => {
    const raw = {
      market: 'KRW-BTC',
      trade_price: 120_000_000,
      prev_closing_price: 119_000_000,
      trade_date: '20260904',
      trade_time: '020000',
      trade_date_kst: '20260904',
      trade_time_kst: '110000',
      trade_timestamp: now.getTime() + 9 * 3_600_000,
    };
    expect(parseBithumbQuotes([raw], now)[0]).toMatchObject({
      providerAt: now,
      sourceDate: '2026-09-04',
      referenceDate: '2026-09-03',
      raw: {
        trade_timestamp: raw.trade_timestamp,
        normalizedTimeField: 'trade_date/trade_time (UTC)',
      },
    });
    expect(() => parseBithumbQuotes([{ ...raw, trade_time_kst: '120000' }], now)).toThrow();
    expect(() =>
      parseBithumbQuotes([{ ...raw, trade_time: '020200', trade_time_kst: '110200' }], now),
    ).toThrow();
  });

  it('keeps gold daily averages distinct from current prices and refuses a default maximum series', () => {
    expect(
      parseGoldHistory([{ day: '2026-09-03', avg_price: 4100.12 }], 'gold', now)[0],
    ).toMatchObject({ value: '4100.12', providerAt: null, raw: { aggregation: 'DAILY_AVERAGE' } });
    expect(() => parseGoldHistory([{ day: '2026-09-03', max_price: 4300 }], 'gold', now)).toThrow();
    expect(() =>
      parseGoldQuote(
        { symbol: 'XAU', currency: 'KRW', price: 4100, updatedAt: now.toISOString() },
        'gold',
        now,
      ),
    ).toThrow();
    expect(() => parseGoldHistory([{ day: '2026-02-30', avg_price: 100 }], 'gold', now)).toThrow();
  });

  it('normalizes Gold daily midnight labels without inventing instants or accepting intraday/malformed dates', () => {
    const day = '2026-09-03 00:00:00';
    expect(parseGoldHistory([{ day, avg_price: 4100.12 }], 'gold', now)[0]).toMatchObject({
      period: '2026-09-03',
      sourceDate: '2026-09-03',
      providerAt: null,
      value: '4100.12',
      raw: { day, aggregation: 'DAILY_AVERAGE' },
    });
    for (const invalid of ['2026-09-03 12:00:00', '2026-02-30 00:00:00', '2026-09-05 00:00:00']) {
      expect(() => parseGoldHistory([{ day: invalid, avg_price: 100 }], 'silver', now)).toThrow();
    }
  });

  it('allows signed commodity observations while preserving source date and rejecting wrong EIA units', () => {
    const input = {
      response: {
        data: [
          {
            period: '2020-04-20',
            value: '-36.98',
            series: 'RWTC',
            'value-units': 'Dollars per Barrel',
          },
        ],
      },
    };
    expect(parseEia(input, now)[0]).toMatchObject({
      value: '-36.98',
      sourceDate: '2020-04-20',
      providerAt: null,
    });
    expect(
      parseEia(
        {
          response: {
            data: [
              ...input.response.data,
              { period: '2026-09-03', value: null },
              { period: '2026-09-02', value: '' },
            ],
          },
        },
        now,
      ),
    ).toHaveLength(1);
    expect(() =>
      parseEia(
        { response: { data: [{ period: '2026-09-03', value: 90, 'value-units': 'Gallons' }] } },
        now,
      ),
    ).toThrow();
  });
});

describe('market indicator request isolation', () => {
  it('leaves public quotes configured when optional EIA and gold history credentials are missing', () => {
    const client = new MarketIndicatorClient(config, jest.fn(), toss);
    expect(
      client
        .quoteTasks(now)
        .filter((task) => task.source === 'GOLD_API')
        .every((task) => task.configured),
    ).toBe(true);
    expect(
      client
        .historyTasks(now)
        .filter((task) => ['EIA', 'GOLD_API'].includes(task.source))
        .every((task) => !task.configured),
    ).toBe(true);
  });

  it('honors Retry-After and does not send another request during cooldown', async () => {
    const fetch = jest.fn().mockResolvedValue(
      new Response('secret response must never be logged', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
    );
    const client = new MarketIndicatorClient(config, fetch, toss);
    const task = client.quoteTasks(now).find((item) => item.source === 'BITHUMB')!;
    await expect(task.collect()).rejects.toBeInstanceOf(IndicatorRequestError);
    await expect(task.collect()).rejects.toThrow('BITHUMB HTTP 429');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(retryDelayMs(null, now.getTime(), 6)).toBe(900_000);
    expect(retryDelayMs(new Date(now.getTime() + 180_000).toUTCString(), now.getTime(), 1)).toBe(
      180_000,
    );
  });

  it('requests daily-average gold history with only its key and blocks redirects', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ day: '2026-09-03', avg_price: 4100 }])));
    const client = new MarketIndicatorClient(
      loadWorkerConfig({
        NODE_ENV: 'test',
        GOLD_API_KEY: 'test-gold-key',
        EIA_API_KEY: 'test-eia-key',
      }),
      fetch,
      toss,
    );
    await client
      .historyTasks(now)
      .find((item) => item.instrumentIds.includes('gold'))!
      .collect();
    const [input, options] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(input.origin).toBe('https://api.gold-api.com');
    expect(input.searchParams.get('aggregation')).toBe('avg');
    expect(input.searchParams.get('groupBy')).toBe('day');
    expect(new Headers(options.headers).get('x-api-key')).toBe('test-gold-key');
    expect(input.toString()).not.toContain('test-eia-key');
    expect(options.redirect).toBe('error');
  });

  it('reuses Toss client requests and permits no arbitrary HTTP endpoints', async () => {
    const client = new TossMarketClient(config, jest.fn());
    await expect(client.get('/api/v1/orders', {})).rejects.toThrow('Unsupported');
    await expect(
      client.get('/api/v1/market-indicators/../../../oauth2/token/candles', {}),
    ).rejects.toThrow('Unsupported');
    client.onModuleDestroy();
  });

  it('keeps public gold quotes available when the separate history quota is exhausted', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3600' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ symbol: 'XAU', price: 4100, updatedAt: now.toISOString() })),
      );
    const client = new MarketIndicatorClient(
      loadWorkerConfig({ NODE_ENV: 'test', GOLD_API_KEY: 'test-gold-key' }),
      fetch,
      toss,
    );
    await expect(
      client
        .historyTasks(now)
        .find((item) => item.instrumentIds.includes('gold'))!
        .collect(),
    ).rejects.toThrow('GOLD_API HTTP 429');
    await expect(
      client
        .quoteTasks(now)
        .find((item) => item.instrumentIds.includes('gold'))!
        .collect(),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ instrumentId: 'gold', value: '4100' })]),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function databaseHarness(initial: MarketObservationEntity[] = []) {
  const observations = [...initial];
  const health = new Map<string, ConnectorHealthEntity>();
  const quoteRepo = {
    find: jest.fn(async (options: FindManyOptions<MarketObservationEntity>) => {
      const conditions = Array.isArray(options.where) ? options.where : [options.where];
      return observations
        .filter((row) =>
          conditions.some((condition) => {
            if (!condition) return true;
            if (row.instrumentId !== condition.instrumentId || row.kind !== condition.kind)
              return false;
            if (condition.period && row.period !== condition.period) return false;
            if (condition.sourceDate instanceof FindOperator) {
              const params = condition.sourceDate.objectLiteralParameters!;
              const before = Object.entries(params).find(([key]) => key.startsWith('before'))![1];
              const previousDate = observations
                .filter(
                  (item) =>
                    item.instrumentId === row.instrumentId &&
                    item.kind === 'DAILY' &&
                    item.sourceDate &&
                    item.sourceDate < before,
                )
                .map((item) => item.sourceDate!)
                .sort()
                .at(-1);
              return row.sourceDate === previousDate;
            }
            return true;
          }),
        )
        .map(
          (row) =>
            Object.fromEntries(
              Object.keys(options.select ?? row).map((key) => [
                key,
                row[key as keyof MarketObservationEntity],
              ]),
            ) as unknown as MarketObservationEntity,
        );
    }),
    create: jest.fn((value) => value),
    save: jest.fn(async (values: MarketObservationEntity[]) => {
      for (const value of values) {
        const index = observations.findIndex(
          (row) =>
            row.instrumentId === value.instrumentId &&
            row.kind === value.kind &&
            row.period === value.period,
        );
        if (index < 0) observations.push(value);
        else observations[index] = value;
      }
      return values;
    }),
  };
  const healthRepo = {
    findOneBy: jest.fn(
      async ({ connector }: { connector: string }) => health.get(connector) ?? null,
    ),
    create: jest.fn((value) => value),
    save: jest.fn(async (value: ConnectorHealthEntity) => {
      health.set(value.connector, value);
      return value;
    }),
  };
  const instrumentRepo = { upsert: jest.fn().mockResolvedValue({}) };
  const db = {
    getRepository: (entity: unknown) =>
      entity === MarketObservationEntity
        ? quoteRepo
        : entity === ConnectorHealthEntity
          ? healthRepo
          : entity === MarketInstrumentEntity
            ? instrumentRepo
            : undefined,
  } as unknown as DataSource;
  return { db, quoteRepo, health, observations, instrumentRepo };
}

describe('market observations and partial connector health', () => {
  const gold: IndicatorObservation = {
    instrumentId: 'gold',
    kind: 'QUOTE',
    period: 'latest',
    value: '4000',
    sourceDate: '2026-09-04',
    providerAt: now,
    raw: { symbol: 'XAU' },
  };

  it('preserves first observation time and does not replace a quote with an older provider observation', async () => {
    const firstObservedAt = new Date('2026-09-01T00:00:00Z');
    const harness = databaseHarness([
      {
        ...gold,
        id: 'existing',
        firstObservedAt,
        lastObservedAt: now,
        source: 'GOLD_API',
      } as unknown as MarketObservationEntity,
    ]);
    const service = new MarketIndicatorIngestionService(harness.db, {} as MarketIndicatorClient);
    await service.saveObservations(
      'GOLD_API',
      [{ ...gold, value: '4100' }],
      new Date(now.getTime() + 60_000),
    );
    expect(harness.observations[0]).toMatchObject({ value: '4100', firstObservedAt });
    await service.saveObservations(
      'GOLD_API',
      [{ ...gold, value: '10', providerAt: new Date(now.getTime() - 60_000) }],
      now,
    );
    expect(harness.observations[0]?.value).toBe('4100');
  });

  it('promotes the latest daily yield and preserves missing publication time and previous available business date', async () => {
    const harness = databaseHarness();
    const service = new MarketIndicatorIngestionService(harness.db, {} as MarketIndicatorClient);
    await service.saveObservations(
      'TREASURY',
      ['2026-08-28', '2026-08-31'].map((date, index) => ({
        instrumentId: 'us2y',
        kind: 'DAILY',
        period: date,
        sourceDate: date,
        providerAt: null,
        value: index ? '3.9' : '3.8',
        raw: {},
      })),
      now,
    );
    expect(harness.observations.find((row) => row.kind === 'QUOTE')).toMatchObject({
      value: '3.9',
      sourceDate: '2026-08-31',
      providerAt: null,
      referenceValue: '3.8',
      referenceDate: '2026-08-28',
    });
    await service.saveObservations(
      'TREASURY',
      ['2026-08-28', '2026-08-31'].map((date, index) => ({
        instrumentId: 'us2y',
        kind: 'DAILY',
        period: date,
        sourceDate: date,
        providerAt: null,
        value: index ? '3.9' : '3.7',
        raw: {},
      })),
      now,
    );
    expect(harness.observations.find((row) => row.kind === 'QUOTE')?.referenceValue).toBe('3.7');
  });

  const daily = (
    instrumentId: string,
    date: string,
    value: string,
    overrides: Partial<IndicatorObservation> = {},
  ): IndicatorObservation => ({
    instrumentId,
    kind: 'DAILY',
    period: date,
    sourceDate: date,
    providerAt: null,
    value,
    raw: {},
    ...overrides,
  });
  const persisted = (row: IndicatorObservation): MarketObservationEntity =>
    ({
      ...row,
      id: `${row.instrumentId}:${row.kind}:${row.period}`,
      firstObservedAt: new Date('2026-08-01T00:00:00Z'),
      lastObservedAt: now,
      rawMetadataJson: { unchanged: 'source data stays out of lookup results' },
    }) as unknown as MarketObservationEntity;

  it('reads only matching rows and each nearest earlier date across mixed instruments and dates', async () => {
    const harness = databaseHarness(
      [
        daily('us2y', '2026-08-20', '3.1'),
        daily('us2y', '2026-08-27', '3.2'),
        daily('us2y', '2026-08-28', '3.3'),
        daily('us2y', '2026-09-01', '3.4'),
        daily('us2y', '2026-09-02', '3.5'),
        daily('us2y', '2026-09-03', '3.6'),
        daily('us10y', '2026-08-27', '4.0'),
        daily('us10y', '2026-09-02', '4.2'),
        daily('gold', '2026-09-03', '9999'),
      ].map(persisted),
    );
    const service = new MarketIndicatorIngestionService(harness.db, {} as MarketIndicatorClient);
    await service.saveObservations(
      'TREASURY',
      [
        daily('us2y', '2026-09-04', '3.8'),
        daily('us2y', '2026-08-28', '3.25'),
        daily('us2y', '2026-08-31', '3.3'),
        daily('us10y', '2026-09-04', '4.3'),
      ],
      now,
    );
    expect(harness.observations.find((row) => row.period === '2026-08-31')).toMatchObject({
      referenceDate: '2026-08-28',
      referenceValue: '3.25',
    });
    expect(
      harness.observations.find((row) => row.instrumentId === 'us2y' && row.kind === 'QUOTE'),
    ).toMatchObject({ referenceDate: '2026-09-03', referenceValue: '3.6' });
    expect(
      harness.observations.find((row) => row.instrumentId === 'us10y' && row.kind === 'QUOTE'),
    ).toMatchObject({ referenceDate: '2026-09-02', referenceValue: '4.2' });
    const readRows = (
      await Promise.all(harness.quoteRepo.find.mock.results.map((item) => item.value))
    ).flat() as MarketObservationEntity[];
    expect(readRows).toHaveLength(5);
    expect(readRows.every((row) => row.rawMetadataJson === undefined)).toBe(true);
    expect(readRows.some((row) => row.sourceDate === '2026-08-20')).toBe(false);
    expect(harness.quoteRepo.find).toHaveBeenCalledTimes(2);
  });

  it('rejects stale daily corrections as both writes and references and keeps a newer promoted quote', async () => {
    const newerAt = new Date(now.getTime() + 60_000);
    const harness = databaseHarness([
      persisted(daily('us2y', '2026-09-02', '3.8', { providerAt: newerAt })),
      persisted(daily('us2y', '2026-09-04', '4.1', { kind: 'QUOTE', period: 'latest' })),
    ]);
    const service = new MarketIndicatorIngestionService(harness.db, {} as MarketIndicatorClient);
    await expect(
      service.saveObservations(
        'TREASURY',
        [daily('us2y', '2026-09-02', '1', { providerAt: now }), daily('us2y', '2026-09-03', '3.9')],
        now,
      ),
    ).resolves.toBe(1);
    expect(harness.observations.find((row) => row.period === '2026-09-03')).toMatchObject({
      referenceDate: '2026-09-02',
      referenceValue: '3.8',
    });
    expect(harness.observations.find((row) => row.kind === 'QUOTE')).toMatchObject({
      value: '4.1',
      sourceDate: '2026-09-04',
    });
  });

  it('retains newest duplicate input, explicit references, and first-observed metadata for corrections', async () => {
    const old = persisted(daily('gold', '2026-09-03', '4000'));
    const harness = databaseHarness([old]);
    const service = new MarketIndicatorIngestionService(harness.db, {} as MarketIndicatorClient);
    await service.saveObservations(
      'GOLD_API',
      [
        daily('gold', '2026-09-03', '4100', {
          providerAt: now,
          referenceValue: '3900',
          referenceDate: '2026-09-01',
        }),
        daily('gold', '2026-09-03', '10', { providerAt: new Date(now.getTime() - 1) }),
      ],
      now,
    );
    expect(harness.observations[0]).toMatchObject({
      value: '4100',
      referenceValue: '3900',
      referenceDate: '2026-09-01',
      firstObservedAt: old.firstObservedAt,
      lastObservedAt: now,
    });
    expect(harness.quoteRepo.find).toHaveBeenCalledTimes(1);
  });

  it('does not promote rejected stale daily input when no current quote has been stored', async () => {
    const harness = databaseHarness([
      persisted(daily('us2y', '2026-09-03', '3.8', { providerAt: now })),
    ]);
    const service = new MarketIndicatorIngestionService(harness.db, {} as MarketIndicatorClient);
    await expect(
      service.saveObservations(
        'TREASURY',
        [daily('us2y', '2026-09-03', '1', { providerAt: new Date(now.getTime() - 1) })],
        now,
      ),
    ).resolves.toBe(0);
    expect(harness.observations).toHaveLength(1);
    expect(harness.quoteRepo.save).not.toHaveBeenCalled();
  });

  it('returns immediately for empty input and validates source ownership before any lookup', async () => {
    const harness = databaseHarness();
    const service = new MarketIndicatorIngestionService(harness.db, {} as MarketIndicatorClient);
    await expect(service.saveObservations('GOLD_API', [], now)).resolves.toBe(0);
    await expect(service.saveObservations('TREASURY', [gold], now)).rejects.toThrow(
      'Unexpected instrument source',
    );
    expect(harness.quoteRepo.find).not.toHaveBeenCalled();
    expect(harness.quoteRepo.save).not.toHaveBeenCalled();
  });

  it('bounds lookup batches for large incoming histories while preserving consecutive references', async () => {
    const rows = Array.from({ length: 401 }, (_, index) => {
      const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
      return daily('gold', date, String(4000 + index));
    });
    const harness = databaseHarness();
    const service = new MarketIndicatorIngestionService(harness.db, {} as MarketIndicatorClient);
    await expect(service.saveObservations('GOLD_API', rows, now)).resolves.toBe(401);
    expect(harness.quoteRepo.find).toHaveBeenCalledTimes(6);
    expect(
      harness.quoteRepo.find.mock.calls.map(([options]) =>
        Array.isArray(options.where) ? options.where.length : 0,
      ),
    ).toEqual([200, 200, 1, 200, 200, 1]);
    expect(harness.observations.at(-1)).toMatchObject({
      referenceValue: '4399',
      referenceDate: rows.at(-2)!.sourceDate,
    });
  });

  it('retains healthy gold quotes when history is unconfigured and preserves the last value on later quote failure', async () => {
    const harness = databaseHarness();
    const collect = jest.fn().mockResolvedValue([gold]);
    const client = {
      quoteTasks: (): IndicatorTask[] => [
        { source: 'GOLD_API', instrumentIds: ['gold'], configured: true, collect },
      ],
      historyTasks: (): IndicatorTask[] => [
        {
          source: 'GOLD_API',
          instrumentIds: ['gold', 'silver'],
          configured: false,
          collect: jest.fn(),
        },
      ],
    } as unknown as MarketIndicatorClient;
    const service = new MarketIndicatorIngestionService(harness.db, client);
    await service.refresh('quotes');
    await service.refresh('history');
    expect(harness.health.get('market:gold')?.metadataJson).toMatchObject({
      quoteStatus: 'HEALTHY',
      historyStatus: 'UNCONFIGURED',
    });
    expect(harness.instrumentRepo.upsert).toHaveBeenCalledTimes(1);
    collect.mockRejectedValue(new Error('private credentials from unsafe provider exception'));
    await service.refresh('quotes');
    expect(harness.observations.find((row) => row.kind === 'QUOTE')?.value).toBe('4000');
    expect(harness.health.get('market:gold')?.message).not.toContain('private credentials');
    expect(harness.health.get('market:gold')?.metadataJson).toMatchObject({
      quoteStatus: 'DEGRADED',
      historyStatus: 'UNCONFIGURED',
    });
  });
});
