import { Market, RightsMode } from '@orsem/contracts';
import {
  AlpacaAssetEntity,
  CompanyEntity,
  IngestionRunEntity,
  SourceCheckpointEntity,
} from '@orsem/database';
import { DataSource, type EntityManager } from 'typeorm';
import type { Job } from 'bullmq';
import { loadWorkerConfig } from '../src/config/worker-config';
import { AlpacaAssetMasterClient } from '../src/market-data/alpaca-asset-master.client';
import {
  alpacaAssetMarket,
  assertAlpacaAssetSnapshotSize,
  dateOnlyInTimeZone,
  MarketDataIngestionService,
} from '../src/market-data/market-data-ingestion.service';
import { MarketDataProcessor } from '../src/processors/market-data.processor';
import type { TossMarketDataService } from '../src/market-data/toss-market-data.service';
import type { MarketIndicatorIngestionService } from '../src/market-indicators/market-indicator-ingestion.service';

describe('asset identity connectors', () => {
  it('fetches one bounded Alpaca asset snapshot and preserves raw provider fields', async () => {
    let requestedUrl = '';
    let requestedHeaders = new Headers();
    const client = new AlpacaAssetMasterClient(
      'alpaca-key',
      'alpaca-secret',
      'https://paper-api.alpaca.markets',
      async (input, init) => {
        requestedUrl = new URL(input instanceof Request ? input.url : input.toString()).toString();
        requestedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify([
            {
              id: '00000000-0000-4000-8000-000000000301',
              class: 'us_equity',
              exchange: 'NASDAQ',
              symbol: 'msft',
              name: 'Microsoft Corporation',
              status: 'active',
              tradable: true,
              marginable: true,
              maintenance_margin_requirement: 30,
              shortable: true,
              easy_to_borrow: true,
              fractionable: true,
              attributes: ['fractional_eh_enabled'],
              provider_only_field: 'preserved',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      5_000,
    );

    const snapshot = await client.fetchActiveUsEquities();

    expect(requestedUrl).toBe(
      'https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity',
    );
    expect(requestedHeaders.get('APCA-API-KEY-ID')).toBe('alpaca-key');
    expect(requestedHeaders.get('APCA-API-SECRET-KEY')).toBe('alpaca-secret');
    expect(snapshot.provenanceUrl).toBe(requestedUrl);
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        providerAssetId: '00000000-0000-4000-8000-000000000301',
        symbol: 'MSFT',
        exchange: 'NASDAQ',
        maintenanceMarginRequirement: '30',
        raw: expect.objectContaining({ provider_only_field: 'preserved', symbol: 'msft' }),
      }),
    ]);
  });

  it('rejects an empty Alpaca asset snapshot before it can retire current assets', async () => {
    const client = new AlpacaAssetMasterClient(
      'alpaca-key',
      'alpaca-secret',
      'https://paper-api.alpaca.markets',
      async () => new Response('[]', { status: 200 }),
      5_000,
    );

    await expect(client.fetchActiveUsEquities()).rejects.toThrow(/not valid bounded JSON/u);
  });

  it('accepts only active, tradable, unambiguous Alpaca-compatible US symbols', () => {
    const base = {
      assetClass: 'us_equity',
      exchange: 'NASDAQ',
      status: 'active',
      symbol: 'MSFT',
      tradable: true,
    } as const;
    expect(alpacaAssetMarket(base)).toBe(Market.NASDAQ);
    expect(alpacaAssetMarket({ ...base, exchange: 'NYSE' })).toBe(Market.NYSE);
    expect(alpacaAssetMarket({ ...base, exchange: 'ARCA' })).toBeNull();
    expect(alpacaAssetMarket({ ...base, tradable: false })).toBeNull();
    expect(alpacaAssetMarket({ ...base, status: 'inactive' })).toBeNull();
    expect(alpacaAssetMarket({ ...base, symbol: 'INVALID/SYMBOL' })).toBeNull();
  });

  it('restricts the trading origin to official Alpaca HTTPS hosts', () => {
    expect(
      loadWorkerConfig({ ALPACA_TRADING_BASE_URL: 'https://paper-api.alpaca.markets' })
        .alpacaTradingBaseUrl,
    ).toBe('https://paper-api.alpaca.markets');
    expect(() =>
      loadWorkerConfig({ ALPACA_TRADING_BASE_URL: 'http://paper-api.alpaca.markets' }),
    ).toThrow(/ALPACA_TRADING_BASE_URL/u);
    expect(() =>
      loadWorkerConfig({ ALPACA_TRADING_BASE_URL: 'https://alpaca.example.test' }),
    ).toThrow(/ALPACA_TRADING_BASE_URL/u);
  });
});

describe('market identity persistence and queue compatibility', () => {
  it('derives stable KST and New York session dates across US DST', () => {
    const summerRun = new Date('2026-07-07T22:30:00Z');
    const winterRun = new Date('2026-01-06T22:30:00Z');
    expect(dateOnlyInTimeZone(summerRun, 'Asia/Seoul')).toBe('2026-07-08');
    expect(dateOnlyInTimeZone(winterRun, 'America/New_York')).toBe('2026-01-06');
    expect(dateOnlyInTimeZone(summerRun, 'America/New_York')).toBe('2026-07-07');
  });

  it('rejects an implausibly truncated Alpaca asset snapshot', () => {
    expect(() => assertAlpacaAssetSnapshotSize(14_287, 0)).toThrow(/empty/u);
    expect(() => assertAlpacaAssetSnapshotSize(14_287, 1_000)).toThrow(/shrank unexpectedly/u);
    expect(() => assertAlpacaAssetSnapshotSize(14_287, 12_000)).not.toThrow();
    expect(() => assertAlpacaAssetSnapshotSize(0, 8_766)).not.toThrow();
  });

  it.each(['ingest-krx-eod', 'ingest-alpaca-eod'])(
    'permanently rejects the retired %s job',
    async (name) => {
      const syncAlpacaAssets = jest.fn();
      const ingest = jest.fn();
      const processor = new MarketDataProcessor(
        { syncAlpacaAssets } as unknown as MarketDataIngestionService,
        { ingest } as unknown as TossMarketDataService,
        {} as MarketIndicatorIngestionService,
      );
      await expect(
        processor.process({
          name,
          data: {},
          timestamp: Date.parse('2026-09-01T00:00:00Z'),
          opts: { prevMillis: Date.parse('2026-09-03T09:30:00Z') },
        } as Job<unknown>),
      ).rejects.toThrow(/retired/u);
      expect(syncAlpacaAssets).not.toHaveBeenCalled();
      expect(ingest).not.toHaveBeenCalled();
    },
  );

  it('still commits Alpaca asset identities and raw provenance without requesting or writing prices', async () => {
    const observedAt = new Date('2026-09-04T09:30:00Z');
    const company = { id: 'company-1', market: Market.NASDAQ, ticker: 'MSFT', isListed: true };
    const raw = {
      id: '00000000-0000-4000-8000-000000000301',
      class: 'us_equity',
      exchange: 'NASDAQ',
      symbol: 'MSFT',
      name: 'Microsoft Corporation',
      status: 'active',
      tradable: true,
      marginable: true,
      shortable: true,
      easy_to_borrow: true,
      fractionable: true,
      provider_only_field: 'preserved',
    };
    const insert = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    const assets = {
      find: jest
        .fn()
        .mockResolvedValue([
          { providerAssetId: raw.id, companyId: company.id, exchange: 'NASDAQ', symbol: 'MSFT' },
        ]),
      update: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn(() => insert),
    };
    const companies = {
      find: jest.fn().mockResolvedValue([company]),
      update: jest.fn().mockResolvedValue({}),
    };
    const run = { id: 'run-1' };
    const runs = {
      create: jest.fn((row) => row),
      save: jest.fn().mockResolvedValue(run),
      update: jest.fn().mockResolvedValue({}),
    };
    const checkpointQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    const checkpoints = {
      createQueryBuilder: jest.fn(() => checkpointQuery),
      create: jest.fn((row) => row),
      save: jest.fn().mockResolvedValue({}),
    };
    const repositories = new Map<unknown, unknown>([
      [AlpacaAssetEntity, assets],
      [CompanyEntity, companies],
      [IngestionRunEntity, runs],
      [SourceCheckpointEntity, checkpoints],
    ]);
    const getRepository = jest.fn((entity: unknown) => {
      if (!repositories.has(entity)) throw new Error('Unexpected non-identity repository.');
      return repositories.get(entity);
    });
    const runner = {
      manager: { getRepository },
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ acquired: 1 }]),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const fetcher = jest.fn(async () => new Response(JSON.stringify([raw])));
    const service = new MarketDataIngestionService(
      { getRepository, createQueryRunner: () => runner } as unknown as DataSource,
      loadWorkerConfig({ ALPACA_API_KEY: 'test-key', ALPACA_API_SECRET: 'test-secret' }),
      fetcher,
    );

    await expect(service.syncAlpacaAssets(observedAt)).resolves.toMatchObject({
      stream: 'ASSET_MASTER',
      itemsSeen: 1,
      assetsCreated: 0,
      assetsUpdated: 1,
      companiesAvailable: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String((fetcher.mock.calls as unknown[][])[0]?.[0])).toContain('/v2/assets?');
    expect(insert.values).toHaveBeenCalledWith([
      expect.objectContaining({
        providerAssetId: raw.id,
        companyId: company.id,
        rawJson: raw,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      }),
    ]);
    expect(insert.orUpdate.mock.calls[0]?.[0]).not.toContain('first_observed_at');
    expect(companies.update).toHaveBeenCalledWith(expect.anything(), { isListed: true });
    expect(checkpoints.save).toHaveBeenCalledWith(
      expect.objectContaining({ stream: 'ASSET_MASTER' }),
    );
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('routes the distinct Alpaca asset-master job without applying EOD date semantics', async () => {
    const syncAlpacaAssets = jest.fn().mockResolvedValue({ synchronized: 3 });
    const processor = new MarketDataProcessor(
      {
        syncAlpacaAssets,
      } as unknown as MarketDataIngestionService,
      {} as TossMarketDataService,
      {} as MarketIndicatorIngestionService,
    );

    await expect(
      processor.process({
        name: 'sync-alpaca-assets',
        data: { reason: 'MANUAL' },
        timestamp: Number.NaN,
        opts: {},
      } as Job<unknown>),
    ).resolves.toEqual({ synchronized: 3 });
    expect(syncAlpacaAssets).toHaveBeenCalledTimes(1);
  });

  it('holds a connector lock through commit on the same query-runner transaction', async () => {
    const calls: string[] = [];
    const manager = {} as EntityManager;
    const runner = {
      manager,
      isTransactionActive: true,
      connect: jest.fn(async () => calls.push('connect')),
      query: jest
        .fn()
        .mockImplementationOnce(async () => {
          calls.push('lock');
          return [{ acquired: 1 }];
        })
        .mockImplementationOnce(async () => {
          calls.push('unlock');
          return [{ released: 1 }];
        }),
      startTransaction: jest.fn(async () => calls.push('begin')),
      commitTransaction: jest.fn(async () => calls.push('commit')),
      rollbackTransaction: jest.fn(async () => calls.push('rollback')),
      release: jest.fn(async () => calls.push('release')),
    };
    const service = new MarketDataIngestionService(
      { createQueryRunner: () => runner } as unknown as DataSource,
      loadWorkerConfig({}),
      async () => new Response('{}'),
    );

    await expect(
      service['withConnectorTransaction']('ALPACA', async (receivedManager) => {
        expect(receivedManager).toBe(manager);
        calls.push('work');
        return 'done';
      }),
    ).resolves.toBe('done');
    expect(calls).toEqual(['connect', 'lock', 'begin', 'work', 'commit', 'unlock', 'release']);
    expect(runner.query).toHaveBeenNthCalledWith(1, 'SELECT GET_LOCK(?, 30) AS acquired', [
      'orsem:market-data:alpaca',
    ]);
  });
});
