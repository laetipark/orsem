import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { z } from 'zod';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { HTTP_FETCH, type FetchImplementation } from '../opendart/opendart.client';

export const TOSS_REST_ORIGIN = 'https://openapi.tossinvest.com';
export const TOSS_WS_URL = 'wss://openapi-ws.tossinvest.com/ws/v1';
export const tossInstantSchema = z.string().datetime({ offset: true });
const decimal = z
  .string()
  .max(40)
  .regex(/^\d+(?:\.\d+)?$/u);
export const tossCandleSchema = z
  .object({
    timestamp: tossInstantSchema,
    openPrice: decimal,
    highPrice: decimal,
    lowPrice: decimal,
    closePrice: decimal,
    volume: decimal,
    currency: z.enum(['KRW', 'USD']),
  })
  .passthrough();
export type TossCandle = z.infer<typeof tossCandleSchema>;
const candlePageSchema = z.object({
  result: z.object({
    candles: z.array(tossCandleSchema).max(200),
    nextBefore: tossInstantSchema.nullish(),
  }),
});
export const tossStockSchema = z
  .object({
    symbol: z.string().min(1).max(32),
    name: z.string(),
    englishName: z.string().nullish(),
    isinCode: z.string(),
    market: z.string(),
    status: z.string(),
    currency: z.enum(['KRW', 'USD']),
  })
  .passthrough();
export type TossStock = z.infer<typeof tossStockSchema>;
const stockMarketSchema = z.enum(['KOSPI', 'KOSDAQ', 'NYSE', 'NASDAQ', 'AMEX', 'KR_ETC', 'US_ETC']);
export type TossStockMarket = z.infer<typeof stockMarketSchema>;
export interface TossStockUniverseFilter {
  readonly status?: 'ACTIVE' | 'DELISTED';
  readonly securityType?: 'ETF';
}
const listedStockSchema = z
  .object({
    symbol: z.string().min(1).max(32),
    name: z.string(),
    securityType: z.string(),
    isCommonShare: z.boolean(),
    isinCode: z.string(),
  })
  .passthrough();
export type TossListedStock = z.infer<typeof listedStockSchema>;
const pricesSchema = z.object({
  result: z
    .array(
      z
        .object({
          symbol: z.string(),
          timestamp: tossInstantSchema.nullish(),
          lastPrice: decimal,
          currency: z.enum(['KRW', 'USD']),
        })
        .passthrough(),
    )
    .max(200),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
});
const cachedTokenSchema = z.object({ token: z.string().min(1), expiresAt: z.number() });
const READ_ENDPOINTS = new Set([
  '/api/v1/candles',
  '/api/v1/prices',
  '/api/v1/stocks',
  '/api/v1/stocks/all',
  '/api/v1/market-indicators/prices',
  '/api/v1/exchange-rate',
  '/api/v1/market-indicators/KOSPI/candles',
  '/api/v1/market-indicators/KOSDAQ/candles',
]);

export class TossHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly providerCode: string | null = null,
  ) {
    super(`Toss HTTP ${status}${providerCode ? ` (${providerCode})` : ''}`);
    this.name = 'TossHttpError';
  }
}

/** REST와 WebSocket이 공유하며 주문이나 계좌 엔드포인트는 제공하지 않습니다. */
@Injectable()
export class TossMarketClient implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly tokenKey: string;
  private tokenFlight: Promise<string> | null = null;
  private redisFlight: Promise<unknown> | null = null;
  private closed = false;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: FetchImplementation,
  ) {
    this.redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.redis.on('error', () => undefined);
    const fingerprint = createHash('sha256')
      .update(`${config.tossClientId ?? ''}:${config.tossClientSecret ?? ''}`)
      .digest('hex')
      .slice(0, 24);
    this.tokenKey = `${config.redisPrefix}market:toss:oauth:${fingerprint}`;
  }

  get enabled(): boolean {
    return (
      this.config.marketDataProvider === 'toss' &&
      Boolean(this.config.tossClientId && this.config.tossClientSecret)
    );
  }

  async storage(): Promise<Redis> {
    if (this.closed) throw new Error('Toss client is stopping.');
    if (this.redis.status === 'wait')
      this.redisFlight ??= this.redis.connect().finally(() => {
        this.redisFlight = null;
      });
    if (this.redisFlight) await this.redisFlight;
    return this.redis;
  }

  async accessToken(): Promise<string> {
    if (!this.enabled)
      throw new Error('Toss credentials are not configured or the provider is disabled.');
    if (!this.tokenFlight) {
      this.tokenFlight = this.loadOrIssueToken().finally(() => {
        this.tokenFlight = null;
      });
    }
    return this.tokenFlight;
  }

  private async cachedToken(redis: Redis): Promise<string | null> {
    const raw = await redis.get(this.tokenKey);
    if (!raw) return null;
    try {
      const cached = cachedTokenSchema.parse(JSON.parse(raw));
      return cached.expiresAt > Date.now() + 60_000 ? cached.token : null;
    } catch {
      return null;
    }
  }

  private async loadOrIssueToken(): Promise<string> {
    const redis = await this.storage();
    const lockKey = `${this.tokenKey}:lock`;
    const owner = randomUUID();
    const deadline = Date.now() + this.config.httpTimeoutMs * 2 + 30_000;
    while (Date.now() < deadline && !this.closed) {
      const cached = await this.cachedToken(redis);
      if (cached) return cached;
      const locked = await redis.set(
        lockKey,
        owner,
        'PX',
        this.config.httpTimeoutMs + 15_000,
        'NX',
      );
      if (!locked) {
        await delay(150);
        continue;
      }
      try {
        const afterLock = await this.cachedToken(redis);
        if (afterLock) return afterLock;
        const response = await this.fetchImpl(`${TOSS_REST_ORIGIN}/oauth2/token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.config.tossClientId!,
            client_secret: this.config.tossClientSecret!,
          }),
          signal: AbortSignal.timeout(this.config.httpTimeoutMs),
        });
        if (!response.ok) throw new TossHttpError(response.status);
        const token = tokenSchema.parse(await this.readJson(response));
        const expiresAt = Date.now() + token.expires_in * 1000;
        await redis.set(
          this.tokenKey,
          JSON.stringify({ token: token.access_token, expiresAt }),
          'PX',
          token.expires_in * 1000,
        );
        return token.access_token;
      } finally {
        await redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          lockKey,
          owner,
        );
      }
    }
    throw new Error('Timed out waiting for the shared Toss token.');
  }

  async invalidateToken(token: string): Promise<void> {
    const redis = await this.storage();
    await redis.eval(
      "local v=redis.call('GET',KEYS[1]); if v and cjson.decode(v).token==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
      1,
      this.tokenKey,
      token,
    );
  }

  private async pace(endpoint: string): Promise<void> {
    const redis = await this.storage();
    const group =
      endpoint === '/api/v1/stocks/all'
        ? 'stock-all'
        : endpoint === '/api/v1/stocks'
          ? 'stock'
          : endpoint.startsWith('/api/v1/market-indicators/')
            ? endpoint.endsWith('/candles')
              ? 'indicator-chart'
              : 'indicator'
            : endpoint === '/api/v1/exchange-rate'
              ? 'info'
              : endpoint === '/api/v1/candles'
                ? 'chart'
                : 'data';
    const key = `${this.config.redisPrefix}market:toss:pace:${group}`;
    while (!this.closed) {
      const wait = Number(
        await redis.eval(
          "local now=tonumber(ARGV[1]); local next=tonumber(redis.call('GET',KEYS[1]) or '0'); if next>now then return next-now end redis.call('SET',KEYS[1],now+tonumber(ARGV[2]),'PX',2000); return 0",
          1,
          key,
          Date.now(),
          group === 'stock-all' ? 1000 : 300,
        ),
      );
      if (wait <= 0) return;
      await delay(Math.min(wait, 1000));
    }
    throw new Error('Toss client is stopping.');
  }

  private async readJson(response: Response): Promise<unknown> {
    const body = await response.text();
    if (body.length > 4_000_000) throw new Error('Toss response exceeded the size limit.');
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error('Toss returned invalid JSON.');
    }
  }

  async get(endpoint: string, params: Record<string, string>): Promise<unknown> {
    if (!READ_ENDPOINTS.has(endpoint)) throw new Error('Unsupported Toss market-data endpoint.');
    const url = new URL(endpoint, TOSS_REST_ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = await this.accessToken();
      await this.pace(endpoint);
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
        redirect: 'error',
      });
      if (response.ok) return this.readJson(response);
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.invalidateToken(token);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const retryAfter = response.headers.get('retry-after');
        const parsedDelay =
          retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter)
            ? Number(retryAfter) * 1000
            : retryAfter
              ? Date.parse(retryAfter) - Date.now()
              : Number.NaN;
        const backoff = Number.isFinite(parsedDelay)
          ? Math.max(1000, parsedDelay)
          : 1000 * 2 ** attempt + Math.random() * 500;
        if (backoff > 60_000) throw new TossHttpError(response.status);
        await delay(backoff);
        continue;
      }
      // 제공자의 응답 본문, 요청 헤더, 토큰은 로그에 기록하지 않습니다.
      throw new TossHttpError(response.status);
    }
    throw new Error('Toss request retry limit reached.');
  }

  async candlePage(symbol: string, interval: '1d' | '1m', before?: string) {
    const params: Record<string, string> = { symbol, interval, count: '200', adjusted: 'false' };
    if (before) params.before = before;
    return candlePageSchema.parse(await this.get('/api/v1/candles', params)).result;
  }

  async stocks(symbols: readonly string[]): Promise<readonly TossStock[]> {
    if (symbols.length === 0) return [];
    if (symbols.length > 200) throw new Error('Toss stock lookup supports at most 200 symbols.');
    return z
      .object({ result: z.array(tossStockSchema).max(200) })
      .parse(await this.get('/api/v1/stocks', { symbols: symbols.join(',') })).result;
  }

  async stocksAll(
    market: TossStockMarket,
    filter: TossStockUniverseFilter = {},
  ): Promise<readonly TossListedStock[]> {
    return z.object({ result: z.array(listedStockSchema).max(20_000) }).parse(
      await this.get('/api/v1/stocks/all', {
        market: stockMarketSchema.parse(market),
        status: z.enum(['ACTIVE', 'DELISTED']).parse(filter.status ?? 'ACTIVE'),
        ...(filter.securityType
          ? { securityType: z.literal('ETF').parse(filter.securityType) }
          : {}),
      }),
    ).result;
  }

  async prices(symbols: readonly string[]) {
    if (symbols.length === 0) return [];
    if (symbols.length > 200) throw new Error('Toss price lookup supports at most 200 symbols.');
    return pricesSchema.parse(await this.get('/api/v1/prices', { symbols: symbols.join(',') }))
      .result;
  }

  onModuleDestroy(): void {
    this.closed = true;
    this.redis.disconnect();
  }
}
