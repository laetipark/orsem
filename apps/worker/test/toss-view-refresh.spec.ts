import { IngestionRunEntity, PriceBarEntity, SourceCheckpointEntity } from '@orsem/database';
import type { DataSource, EntityManager } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  normalizeTossCandle,
  TossMarketDataService,
  type TossScopeCompany,
} from '../src/market-data/toss-market-data.service';
import type { TossMarketClient } from '../src/market-data/toss-market.client';
import type { TossStockInfoService } from '../src/market-data/toss-stock-info.service';
import type { TossCandlesJob } from '../src/queues/job-data';

const now = new Date('2026-09-04T09:30:00Z');
const scope: TossScopeCompany = {
  companyId: '00000000-0000-4000-8000-000000000001',
  symbol: '005930',
  region: 'kr',
  currency: 'KRW',
  priority: 'P1',
};

function ingestionHarness() {
  let checkpoint: Partial<SourceCheckpointEntity> | null = null;
  let commitError: Error | null = null;
  const checkpoints = {
    findOne: jest.fn(async () => checkpoint),
    create: jest.fn((row: Partial<SourceCheckpointEntity>) => row),
    save: jest.fn(async (row: Partial<SourceCheckpointEntity>) => {
      checkpoint = row;
      return row;
    }),
  };
  const insert = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  const prices = {
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => insert),
  };
  const runs = {
    create: jest.fn((row: Partial<IngestionRunEntity>) => row),
    save: jest.fn(async (row: Partial<IngestionRunEntity>) => row),
    update: jest.fn().mockResolvedValue({}),
  };
  const getRepository = (entity: unknown) => {
    if (entity === SourceCheckpointEntity) return checkpoints;
    if (entity === PriceBarEntity) return prices;
    if (entity === IngestionRunEntity) return runs;
    throw new Error('Unexpected test repository.');
  };
  const dataSource = {
    getRepository,
    transaction: jest.fn(async (work: (manager: EntityManager) => Promise<unknown>) => {
      const previous = checkpoint;
      try {
        const result = await work({ getRepository } as unknown as EntityManager);
        if (commitError) {
          const error = commitError;
          commitError = null;
          throw error;
        }
        return result;
      } catch (error) {
        checkpoint = previous;
        throw error;
      }
    }),
  } as unknown as DataSource;
  const client = {
    enabled: true,
    stocks: jest
      .fn()
      .mockResolvedValue([
        { symbol: scope.symbol, currency: 'KRW', market: 'KOSPI', status: 'ACTIVE' },
      ]),
  } as unknown as TossMarketClient;
  const stockInfo = {
    lookup: jest.fn(
      async () =>
        new Map((await client.stocks([scope.symbol])).map((stock) => [stock.symbol, stock])),
    ),
  } as unknown as TossStockInfoService;
  const service = new TossMarketDataService(dataSource, loadWorkerConfig({}), client, stockInfo);
  jest.spyOn(service, 'scope').mockResolvedValue([scope]);
  jest.spyOn(service, 'recordHealth').mockResolvedValue();
  const fetch = jest.spyOn(service, 'fetchCandles').mockImplementation(async (company, input) => [
    normalizeTossCandle(
      company,
      input.interval,
      {
        timestamp: new Date().toISOString(),
        openPrice: '10',
        highPrice: '12',
        lowPrice: '9',
        closePrice: '11',
        volume: '100',
        currency: company.currency,
      },
      new Date(),
    ),
  ]);
  return {
    service,
    fetch,
    checkpoints,
    checkpoint: () => checkpoint,
    failCommit: () => {
      commitError = new Error('Test commit failure.');
    },
  };
}

describe('Toss VIEW history refresh', () => {
  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());

  it.each([
    ['1d', 366, 3, 400],
    ['1m', 7, 6, 1000],
  ] as const)(
    'hydrates %s history despite a scheduled checkpoint, then refreshes one page without losing history',
    async (interval, lookbackDays, fullPages, maximumBars) => {
      const harness = ingestionHarness();
      const view: TossCandlesJob = { interval, lookbackDays, reason: 'VIEW' };
      const scheduled: TossCandlesJob = {
        interval,
        lookbackDays: 1,
        maxPages: 1,
        reason: 'SCHEDULED',
      };
      await harness.service.ingest(scheduled);
      expect(harness.checkpoint()?.metadataJson?.viewHistory).toBeUndefined();

      await harness.service.ingest(view);
      expect(harness.fetch).toHaveBeenLastCalledWith(scope, { ...view, maxPages: fullPages });
      const history = harness.checkpoint()?.metadataJson?.viewHistory;
      expect(history).toEqual({
        version: 1,
        source: 'TOSS_KR',
        symbol: scope.symbol,
        interval,
        adjusted: false,
        lookbackDays,
        maximumBars,
        hydratedAt: now.toISOString(),
        refreshedAt: now.toISOString(),
      });

      jest.setSystemTime(new Date(now.getTime() + 2000));
      await harness.service.ingest(scheduled);
      expect(harness.checkpoint()?.metadataJson?.viewHistory).toEqual(history);
      await harness.service.ingest(view);
      expect(harness.fetch).toHaveBeenLastCalledWith(scope, { ...view, maxPages: 1 });
      expect(harness.checkpoint()?.metadataJson?.viewHistory).toEqual({
        ...(history as Record<string, unknown>),
        refreshedAt: new Date(now.getTime() + 2000).toISOString(),
      });
      expect(harness.checkpoints.findOne).toHaveBeenCalledWith({
        where: { connector: 'TOSS', stream: `PRICE_BARS:${interval}:${scope.companyId}` },
        lock: { mode: 'pessimistic_write' },
      });
    },
  );

  it.each(['fetch', 'empty', 'commit'] as const)(
    'never marks history ready after a %s failure',
    async (failure) => {
      const harness = ingestionHarness();
      const view: TossCandlesJob = { interval: '1m', lookbackDays: 7, reason: 'VIEW' };
      if (failure === 'fetch')
        harness.fetch.mockRejectedValueOnce(new Error('Test fetch failure.'));
      if (failure === 'empty') harness.fetch.mockResolvedValueOnce([]);
      if (failure === 'commit') harness.failCommit();
      await expect(harness.service.ingest(view)).rejects.toThrow();
      expect(harness.checkpoint()?.metadataJson?.viewHistory).toBeUndefined();

      await harness.service.ingest(view);
      expect(harness.fetch).toHaveBeenLastCalledWith(scope, { ...view, maxPages: 6 });
      expect(harness.checkpoint()?.metadataJson?.viewHistory).toBeDefined();
    },
  );

  it('does not establish complete history from limited or historical VIEW requests', async () => {
    const harness = ingestionHarness();
    const view: TossCandlesJob = { interval: '1d', lookbackDays: 366, reason: 'VIEW' };
    await harness.service.ingest({ ...view, maxPages: 1 });
    expect(harness.checkpoint()?.metadataJson?.viewHistory).toBeUndefined();
    await harness.service.ingest({ ...view, before: now.toISOString() });
    expect(harness.checkpoint()?.metadataJson?.viewHistory).toBeUndefined();
    await harness.service.ingest(view);
    expect(harness.fetch).toHaveBeenLastCalledWith(scope, { ...view, maxPages: 3 });
  });

  it('rehydrates when the requested coverage grows or a long VIEW absence may leave a page gap', async () => {
    const harness = ingestionHarness();
    const view: TossCandlesJob = { interval: '1m', lookbackDays: 7, reason: 'VIEW' };
    await harness.service.ingest({ ...view, lookbackDays: 1 });
    await harness.service.ingest(view);
    expect(harness.fetch).toHaveBeenLastCalledWith(scope, { ...view, maxPages: 6 });

    jest.setSystemTime(new Date(now.getTime() + 181 * 60_000));
    await harness.service.ingest({ ...view, reason: 'SCHEDULED', maxPages: 1 });
    await harness.service.ingest(view);
    expect(harness.fetch).toHaveBeenLastCalledWith(scope, { ...view, maxPages: 6 });
    await harness.service.ingest(view);
    expect(harness.fetch).toHaveBeenLastCalledWith(scope, { ...view, maxPages: 1 });
  });
});
