import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { TossMarketClient } from '../market-data/toss-market.client';
import { HTTP_FETCH, type FetchImplementation } from '../opendart/opendart.client';
import {
  type IndicatorObservation,
  parseBithumbDaily,
  parseBithumbQuotes,
  parseEia,
  parseGoldHistory,
  parseGoldQuote,
  parseTossDaily,
  parseTossFx,
  parseTossIndicators,
  parseTreasury,
} from './parsers';

export type IndicatorSource = 'TOSS' | 'BITHUMB' | 'TREASURY' | 'GOLD_API' | 'EIA';
export interface IndicatorTask {
  source: IndicatorSource;
  instrumentIds: readonly string[];
  configured: boolean;
  collect: () => Promise<IndicatorObservation[]>;
}

const ORIGINS: Record<Exclude<IndicatorSource, 'TOSS'>, string> = {
  BITHUMB: 'https://api.bithumb.com',
  TREASURY: 'https://home.treasury.gov',
  GOLD_API: 'https://api.gold-api.com',
  EIA: 'https://api.eia.gov',
};

export class IndicatorRequestError extends Error {
  constructor(
    readonly source: IndicatorSource,
    readonly httpStatus: number | null,
    readonly retryAt: Date | null,
  ) {
    super(httpStatus ? `${source} HTTP ${httpStatus}` : `${source} 응답을 확인할 수 없습니다.`);
  }
}

export function retryDelayMs(header: string | null, now: number, failures: number): number {
  const parsed =
    header && /^\d+(?:\.\d+)?$/u.test(header)
      ? Number(header) * 1000
      : header
        ? Date.parse(header) - now
        : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.max(1000, parsed)
    : Math.min(900_000, 60_000 * 2 ** Math.max(0, failures - 1));
}

@Injectable()
export class MarketIndicatorClient {
  private readonly cooldown = new Map<
    string,
    { until: number; failures: number; status: number | null }
  >();
  private readonly lastRequest = new Map<IndicatorSource, number>();

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: FetchImplementation,
    private readonly toss: TossMarketClient,
  ) {}

  private async request(
    source: Exclude<IndicatorSource, 'TOSS'>,
    path: string,
    params: Record<string, string> = {},
    xml = false,
  ): Promise<unknown> {
    // Gold history has its own key quota; a history failure must not block public quotes.
    const cooldownKey = source === 'GOLD_API' && path === '/history' ? 'GOLD_API_HISTORY' : source;
    const state = this.cooldown.get(cooldownKey);
    const now = Date.now();
    if (state && state.until > now)
      throw new IndicatorRequestError(source, state.status, new Date(state.until));
    const wait = (this.lastRequest.get(source) ?? 0) + 1200 - now;
    if (wait > 0) await delay(wait);
    const url = new URL(path, ORIGINS[source]);
    if (url.origin !== ORIGINS[source]) throw new Error('Invalid market-data origin');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      Accept: xml ? 'application/xml' : 'application/json',
    };
    if (source === 'GOLD_API' && path === '/history' && this.config.goldApiKey)
      headers['x-api-key'] = this.config.goldApiKey;
    if (source === 'EIA' && this.config.eiaApiKey)
      url.searchParams.set('api_key', this.config.eiaApiKey);
    this.lastRequest.set(source, Date.now());
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });
      if (!response.ok) {
        const failures = (state?.failures ?? 0) + 1;
        const until =
          Date.now() + retryDelayMs(response.headers.get('retry-after'), Date.now(), failures);
        this.cooldown.set(cooldownKey, { until, failures, status: response.status });
        await response.body?.cancel();
        throw new IndicatorRequestError(source, response.status, new Date(until));
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty provider body');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 4_000_000) throw new Error('Provider response exceeded the size limit');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const parsed: unknown = xml ? body : JSON.parse(body);
      this.cooldown.delete(cooldownKey);
      return parsed;
    } catch (error) {
      if (error instanceof IndicatorRequestError) throw error;
      const failures = (state?.failures ?? 0) + 1;
      const until = Date.now() + retryDelayMs(null, Date.now(), failures);
      this.cooldown.set(cooldownKey, { until, failures, status: null });
      // Never expose provider bodies, request URLs with API keys, or fetch errors.
      throw new IndicatorRequestError(source, null, new Date(until));
    }
  }

  quoteTasks(now = new Date()): IndicatorTask[] {
    return [
      {
        source: 'TOSS',
        instrumentIds: ['kospi', 'kosdaq'],
        configured: this.toss.enabled,
        collect: async () =>
          parseTossIndicators(
            await this.toss.get('/api/v1/market-indicators/prices', { symbols: 'KOSPI,KOSDAQ' }),
            now,
          ),
      },
      {
        source: 'TOSS',
        instrumentIds: ['usd-krw'],
        configured: this.toss.enabled,
        collect: async () =>
          parseTossFx(
            await this.toss.get('/api/v1/exchange-rate', {
              baseCurrency: 'USD',
              quoteCurrency: 'KRW',
            }),
            now,
          ),
      },
      {
        source: 'BITHUMB',
        instrumentIds: ['btc', 'eth'],
        configured: true,
        collect: async () =>
          parseBithumbQuotes(
            await this.request('BITHUMB', '/v1/ticker', { markets: 'KRW-BTC,KRW-ETH' }),
            now,
          ),
      },
      ...(['gold', 'silver'] as const).map((id): IndicatorTask => ({
        source: 'GOLD_API',
        instrumentIds: [id],
        configured: true,
        collect: async () =>
          parseGoldQuote(
            await this.request('GOLD_API', `/price/${id === 'gold' ? 'XAU' : 'XAG'}`),
            id,
            now,
          ),
      })),
    ];
  }

  historyTasks(now = new Date()): IndicatorTask[] {
    const start = new Date(now.getTime() - 370 * 86_400_000);
    return [
      ...(['kospi', 'kosdaq'] as const).map((id): IndicatorTask => ({
        source: 'TOSS',
        instrumentIds: [id],
        configured: this.toss.enabled,
        collect: async () => {
          const rows: IndicatorObservation[] = [];
          let before: string | null = null;
          for (let page = 0; page < 3; page += 1) {
            const params: Record<string, string> = { interval: '1d', count: '200' };
            if (before) params.before = before;
            const result = parseTossDaily(
              await this.toss.get(`/api/v1/market-indicators/${id.toUpperCase()}/candles`, params),
              id,
              now,
            );
            rows.push(...result.rows);
            if (
              !result.nextBefore ||
              result.rows.length === 0 ||
              result.rows.some((row) => row.sourceDate! < start.toISOString().slice(0, 10))
            )
              break;
            if (before && result.nextBefore >= before)
              throw new Error('Toss history pagination made no progress');
            before = result.nextBefore;
          }
          return rows.filter((row) => row.sourceDate! >= start.toISOString().slice(0, 10));
        },
      })),
      ...(['btc', 'eth'] as const).map((id): IndicatorTask => ({
        source: 'BITHUMB',
        instrumentIds: [id],
        configured: true,
        collect: async () => {
          const rows: IndicatorObservation[] = [];
          let before: string | null = null;
          for (let page = 0; page < 2; page += 1) {
            const params: Record<string, string> = {
              market: id === 'btc' ? 'KRW-BTC' : 'KRW-ETH',
              count: '200',
            };
            if (before) params.to = before;
            const result = parseBithumbDaily(
              await this.request('BITHUMB', '/v1/candles/days', params),
              id,
              now,
            );
            rows.push(...result.rows);
            if (!result.nextBefore || result.rows.length < 200) break;
            if (before && result.nextBefore >= before)
              throw new Error('Bithumb history pagination made no progress');
            before = result.nextBefore;
          }
          return rows.filter((row) => row.sourceDate! >= start.toISOString().slice(0, 10));
        },
      })),
      {
        source: 'TREASURY',
        instrumentIds: ['us2y', 'us10y'],
        configured: true,
        collect: async () => {
          const rows: IndicatorObservation[] = [];
          const firstYear = start.getUTCFullYear();
          for (let year = firstYear; year <= now.getUTCFullYear(); year += 1) {
            const body = await this.request(
              'TREASURY',
              '/resource-center/data-chart-center/interest-rates/pages/xml',
              { data: 'daily_treasury_yield_curve', field_tdr_date_value: String(year) },
              true,
            );
            rows.push(...parseTreasury(String(body), now));
          }
          return rows.filter((row) => row.sourceDate! >= start.toISOString().slice(0, 10));
        },
      },
      ...(['gold', 'silver'] as const).map((id): IndicatorTask => ({
        source: 'GOLD_API',
        instrumentIds: [id],
        configured: Boolean(this.config.goldApiKey),
        collect: async () =>
          parseGoldHistory(
            await this.request('GOLD_API', '/history', {
              symbol: id === 'gold' ? 'XAU' : 'XAG',
              startTimestamp: String(Math.floor(start.getTime() / 1000)),
              endTimestamp: String(Math.floor(now.getTime() / 1000)),
              groupBy: 'day',
              aggregation: 'avg',
              orderBy: 'asc',
            }),
            id,
            now,
          ),
      })),
      {
        source: 'EIA',
        instrumentIds: ['wti'],
        configured: Boolean(this.config.eiaApiKey),
        collect: async () =>
          parseEia(
            await this.request('EIA', '/v2/seriesid/PET.RWTC.D', {
              start: start.toISOString().slice(0, 10),
              end: now.toISOString().slice(0, 10),
              length: '400',
              'sort[0][column]': 'period',
              'sort[0][direction]': 'desc',
            }),
            now,
          ),
      },
    ];
  }
}
