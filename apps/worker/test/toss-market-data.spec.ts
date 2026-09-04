import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RightsMode } from '@orsem/contracts';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import type { Queue } from 'bullmq';
import WebSocket from 'ws';
import { loadWorkerConfig } from '../src/config/worker-config';
import { TossMarketClient, type TossCandle } from '../src/market-data/toss-market.client';
import type { TossStockInfoService } from '../src/market-data/toss-stock-info.service';
import {
  normalizeTossCandle,
  tossCompanyScope,
  TossMarketDataService,
  type TossScopeCompany,
} from '../src/market-data/toss-market-data.service';
import {
  TossLiveQuoteService,
  tossQuoteFromFrame,
  tossTradeDeclaration,
} from '../src/market-data/toss-live-quote.service';
import { tossCandlesJobSchema } from '../src/queues/job-data';
import { WorkerSchedulerService } from '../src/scheduling/worker-scheduler.service';

const kr: TossScopeCompany = {
  companyId: '00000000-0000-4000-8000-000000000001',
  symbol: '005930',
  region: 'kr',
  currency: 'KRW',
  priority: 'P1',
};
const us: TossScopeCompany = {
  companyId: '00000000-0000-4000-8000-000000000002',
  symbol: 'NVDA',
  region: 'us',
  currency: 'USD',
  priority: 'P2',
};
const now = new Date('2026-09-04T09:30:00Z');
const candle = (timestamp: string, currency: 'KRW' | 'USD' = 'KRW'): TossCandle => ({
  timestamp,
  openPrice: '10.00',
  highPrice: '12',
  lowPrice: '9',
  closePrice: '11.50',
  volume: '100',
  currency,
  originalExtraField: 'kept',
});

function memoryRedis(): Redis {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    eval: jest.fn(async (script: string, _count: number, key: string, arg: string) => {
      if (script.includes('next-now')) return 0;
      const previous = store.get(key);
      if (script.includes('.token==ARGV[1]')) {
        if (previous && (JSON.parse(previous) as { token: string }).token === arg) {
          store.delete(key);
          return 1;
        }
      } else if (previous === arg) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  } as unknown as Redis;
}

describe('Toss market-data protocol', () => {
  it('loads external credentials without requiring the provider when they are absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orsem-toss-test-'));
    const path = join(directory, 'credentials.json');
    try {
      writeFileSync(path, JSON.stringify({ clientId: 'file-id', clientSecret: 'file-secret' }), {
        mode: 0o600,
      });
      const config = loadWorkerConfig({ TOSS_CREDENTIALS_FILE: path, TOSS_CLIENT_ID: 'env-id' });
      expect(config).toMatchObject({
        marketDataProvider: 'toss',
        tossClientId: 'env-id',
        tossClientSecret: 'file-secret',
      });
      expect(
        loadWorkerConfig({ TOSS_CREDENTIALS_FILE: join(directory, 'missing') }).tossClientId,
      ).toBeNull();
      expect(() => loadWorkerConfig({ MARKET_DATA_PROVIDER: 'legacy' })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains raw source fields, UTC instants, source-specific rights and the NY trading date', () => {
    const raw = candle('2026-09-04T05:00:00+09:00', 'USD');
    const normalized = normalizeTossCandle(us, '1d', raw, now);
    expect(normalized).toMatchObject({
      source: 'TOSS_US',
      barAt: new Date('2026-09-03T20:00:00Z'),
      sessionDate: '2026-09-03',
      open: '10',
      close: '11.5',
      observedAt: now,
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      provenanceJson: {
        adjusted: false,
        providerTimestamp: raw.timestamp,
        exchangeCoverage: 'PROVIDER_UNSPECIFIED',
      },
    });
    expect(normalized.rawPayloadJson).toEqual(raw);
    expect(normalized.rawPayloadJson).not.toBe(raw);
    expect(normalizeTossCandle(kr, '1m', candle('2026-09-04T09:30:00+09:00'), now).source).toBe(
      'TOSS_KR',
    );
  });

  it('rejects currency, precision and OHLC errors without inventing prices for no-trade rows', () => {
    expect(() =>
      normalizeTossCandle(kr, '1d', candle('2026-09-03T09:00:00+09:00', 'USD'), now),
    ).toThrow(/currency/u);
    expect(() =>
      normalizeTossCandle(
        kr,
        '1d',
        { ...candle('2026-09-03T09:00:00+09:00'), closePrice: '13' },
        now,
      ),
    ).toThrow(/OHLC/u);
    expect(() =>
      normalizeTossCandle(
        kr,
        '1m',
        { ...candle('2026-09-03T09:00:00+09:00'), closePrice: '11.1234567' },
        now,
      ),
    ).toThrow(/DECIMAL/u);
    const noTrade = {
      ...candle('2026-09-03T09:00:00+09:00'),
      openPrice: '0',
      highPrice: '0',
      lowPrice: '0',
      volume: '0',
    };
    expect(normalizeTossCandle(kr, '1d', noTrade, now)).toMatchObject({
      open: '0',
      high: '0',
      low: '0',
      close: '11.5',
      volume: '0',
      provenanceJson: { noTrades: true },
    });
  });

  it('matches company symbols only in their market and listed scope', () => {
    const company = {
      id: kr.companyId,
      market: 'KRX' as const,
      stockCode: '005930',
      ticker: null,
      isListed: true,
    };
    expect(tossCompanyScope(company)).toMatchObject({
      symbol: '005930',
      region: 'kr',
      currency: 'KRW',
    });
    expect(tossCompanyScope({ ...company, isListed: false })).toBeNull();
    expect(tossCompanyScope({ ...company, market: 'OTHER' })).toBeNull();
    expect(
      tossCandlesJobSchema.safeParse({
        interval: '1m',
        companyIds: [kr.companyId],
        reason: 'VIEW',
        maxPages: 6,
      }).success,
    ).toBe(true);
  });

  it('shares one OAuth token across concurrent REST/WS clients and encodes inclusive candle cursors', async () => {
    const redis = memoryRedis();
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    let issues = 0;
    const fetcher = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push({ url, init });
      if (url.endsWith('/oauth2/token')) {
        issues += 1;
        return new Response(
          JSON.stringify({
            access_token: `token-${issues}`,
            token_type: 'Bearer',
            expires_in: 86400,
          }),
        );
      }
      return new Response(JSON.stringify({ result: { candles: [], nextBefore: null } }));
    });
    const config = loadWorkerConfig({ TOSS_CLIENT_ID: 'client', TOSS_CLIENT_SECRET: 'secret' });
    const first = new TossMarketClient(config, fetcher);
    const second = new TossMarketClient(config, fetcher);
    jest.spyOn(first, 'storage').mockResolvedValue(redis);
    jest.spyOn(second, 'storage').mockResolvedValue(redis);
    try {
      expect(
        await Promise.all([first.accessToken(), first.accessToken(), second.accessToken()]),
      ).toEqual(['token-1', 'token-1', 'token-1']);
      expect(issues).toBe(1);
      await first.candlePage('005930', '1d', '2026-09-03T09:00:00+09:00');
      const request = requests.at(-1)!;
      const url = new URL(request.url);
      expect(url.searchParams.get('adjusted')).toBe('false');
      expect(url.searchParams.get('before')).toBe('2026-09-03T09:00:00+09:00');
      expect(request.url).toContain('%2B09%3A00');
      expect(new Headers(request.init?.headers).get('authorization')).toBe('Bearer token-1');
      await expect(first.get('/api/v1/orders', {})).rejects.toThrow(/Unsupported/u);
      await first.invalidateToken('old-token');
      expect(await second.accessToken()).toBe('token-1');
    } finally {
      first.onModuleDestroy();
      second.onModuleDestroy();
    }
  });

  it('deduplicates inclusive pages and preserves the exact nextBefore cursor', async () => {
    jest.useFakeTimers({ now });
    const latest = candle('2026-09-03T09:00:00+09:00');
    const overlap = candle('2026-09-02T09:00:00+09:00');
    const oldest = candle('2026-09-01T09:00:00+09:00');
    const candlePage = jest
      .fn()
      .mockResolvedValueOnce({ candles: [latest, overlap], nextBefore: overlap.timestamp })
      .mockResolvedValueOnce({ candles: [overlap, oldest], nextBefore: null });
    const service = new TossMarketDataService(
      {} as DataSource,
      loadWorkerConfig({}),
      {
        candlePage,
      } as unknown as TossMarketClient,
      {} as TossStockInfoService,
    );
    try {
      const result = await service.fetchCandles(kr, { interval: '1d' });
      expect(result.map((bar) => bar.sessionDate)).toEqual([
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
      ]);
      expect(candlePage).toHaveBeenNthCalledWith(2, '005930', '1d', overlap.timestamp);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops a repeating cursor and never accepts bars beyond the requested cursor', async () => {
    jest.useFakeTimers({ now });
    const raw = candle('2026-09-03T09:00:00+09:00');
    const candlePage = jest.fn().mockResolvedValue({ candles: [raw], nextBefore: raw.timestamp });
    const service = new TossMarketDataService(
      {} as DataSource,
      loadWorkerConfig({}),
      {
        candlePage,
      } as unknown as TossMarketClient,
      {} as TossStockInfoService,
    );
    try {
      await expect(service.fetchCandles(kr, { interval: '1d' })).rejects.toThrow(/no progress/u);
      expect(candlePage).toHaveBeenCalledTimes(2);
      await expect(
        service.fetchCandles(kr, { interval: '1d', before: '2026-09-02T09:00:00+09:00' }),
      ).rejects.toThrow(/inclusive cursor/u);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses declared trade channels only and treats streamed prices as lossy snapshots', () => {
    expect(tossTradeDeclaration([kr, us])).toEqual([
      { type: 'trade:kr', codes: ['005930'] },
      { type: 'trade:us', codes: ['NVDA'] },
    ]);
    const frame = {
      type: 'message',
      topic: 'trade:kr:005930',
      data: {
        price: '72000',
        volume: '8',
        timestamp: '2026-09-04T09:30:00+09:00',
        currency: 'KRW',
      },
      extra: 'retained',
    };
    const snapshot = tossQuoteFromFrame(frame, [kr, us], now);
    expect(snapshot).toMatchObject({
      companyId: kr.companyId,
      source: 'TOSS_KR_INTEGRATED',
      price: '72000',
      lossy: true,
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      rawPayload: frame,
    });
    expect(snapshot).not.toHaveProperty('volume');
    expect(snapshot).not.toHaveProperty('open');
    expect(tossQuoteFromFrame({ ...frame, topic: 'personal:order:3' }, [kr], now)).toBeNull();
    expect(tossQuoteFromFrame({ ...frame, topic: 'trade:kr:000660' }, [kr], now)).toBeNull();
    expect(
      tossQuoteFromFrame({ ...frame, data: { ...frame.data, currency: 'USD' } }, [kr], now),
    ).toBeNull();
  });

  it('fetches a REST snapshot for newly viewed companies on an already open socket and retains stale prices', async () => {
    const redis = memoryRedis();
    const prices = jest
      .fn()
      .mockResolvedValue([
        { symbol: us.symbol, lastPrice: '180', timestamp: '2026-09-03T20:00:00Z', currency: 'USD' },
      ]);
    const client = {
      enabled: true,
      storage: jest.fn().mockResolvedValue(redis),
      prices,
    } as unknown as TossMarketClient;
    const marketData = {
      scope: jest.fn().mockResolvedValue([kr, us]),
    } as unknown as TossMarketDataService;
    const service = new TossLiveQuoteService(loadWorkerConfig({}), client, marketData);
    const send = jest.fn();
    service['lease'] = true;
    service['scopes'] = [kr];
    service['signature'] = JSON.stringify(tossTradeDeclaration([kr]));
    service['socket'] = {
      readyState: WebSocket.OPEN,
      send,
      terminate: jest.fn(),
    } as unknown as WebSocket;
    try {
      await service['refreshScope']();
      expect(prices).toHaveBeenCalledWith(['NVDA']);
      expect(send).toHaveBeenCalledWith(JSON.stringify(tossTradeDeclaration([kr, us])));
      const cacheWrite = jest
        .mocked(redis.eval)
        .mock.calls.find((args) => String(args[0]).includes('providerAt>ARGV[2]'))!;
      expect(cacheWrite.at(-1)).toBe(86_400);
      expect(JSON.parse(String(cacheWrite[3]))).toMatchObject({
        companyId: us.companyId,
        providerAt: '2026-09-03T20:00:00.000Z',
        price: '180',
      });
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each(['internal-error', 'rate-limit-exceeded'])(
    'redeclares subscriptions after transient %s errors',
    async (code) => {
      jest.useFakeTimers({ now });
      const redis = memoryRedis();
      const client = {
        enabled: true,
        storage: jest.fn().mockResolvedValue(redis),
      } as unknown as TossMarketClient;
      const marketData = {
        scope: jest.fn().mockResolvedValue([kr]),
      } as unknown as TossMarketDataService;
      const service = new TossLiveQuoteService(loadWorkerConfig({}), client, marketData);
      const send = jest.fn();
      service['lease'] = true;
      service['scopes'] = [kr];
      service['signature'] = JSON.stringify(tossTradeDeclaration([kr]));
      service['socket'] = {
        readyState: WebSocket.OPEN,
        send,
        terminate: jest.fn(),
      } as unknown as WebSocket;
      try {
        await service.receive(
          JSON.stringify({ type: 'error', error: { code, message: 'retry later' } }),
        );
        expect(send).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1100);
        expect(send).toHaveBeenCalledWith(JSON.stringify(tossTradeDeclaration([kr])));
      } finally {
        await service.onModuleDestroy();
        jest.useRealTimers();
      }
    },
  );

  it('replaces legacy price schedules with Toss and keeps asset identity sync separate', async () => {
    const queue = () =>
      ({
        add: jest.fn().mockResolvedValue({}),
        getRepeatableJobs: jest.fn().mockResolvedValue([]),
        removeRepeatableByKey: jest.fn().mockResolvedValue(true),
      }) as unknown as Queue;
    const market = queue();
    await new WorkerSchedulerService(
      queue(),
      queue(),
      queue(),
      market,
      loadWorkerConfig({
        TOSS_CLIENT_ID: 'client',
        TOSS_CLIENT_SECRET: 'secret',
        ALPACA_API_KEY: 'key',
        ALPACA_API_SECRET: 'secret',
      }),
      queue(),
      queue(),
    ).onModuleInit();
    const names = jest.mocked(market.add).mock.calls.map(([name]) => name);
    expect(names).toContain('ingest-toss-candles');
    expect(names).toContain('sync-alpaca-assets');
    expect(names).toContain('sync-toss-stocks');
    expect(names).not.toContain('ingest-krx-eod');
    expect(names).not.toContain('ingest-alpaca-eod');
  });
});
