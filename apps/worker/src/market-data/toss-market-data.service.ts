import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ConnectorStatus,
  Market,
  ProcessingStatus,
  RightsMode,
  WatchPriority,
} from '@orsem/contracts';
import {
  CompanyEntity,
  ConnectorHealthEntity,
  IngestionRunEntity,
  PriceBarEntity,
  SourceCheckpointEntity,
  WatchlistItemEntity,
} from '@orsem/database';
import { parseDecimal } from '@orsem/opendart-parser';
import { DataSource, In, Like } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import type { TossCandlesJob } from '../queues/job-data';
import { dateOnlyInTimeZone } from './market-data-ingestion.service';
import { TossMarketClient, type TossCandle, type TossStock } from './toss-market.client';
import { TossStockInfoService } from './toss-stock-info.service';
import { planTossViewFetch } from './toss-view-fetch-policy';
import {
  APPROVED_GROUP_COMPANIES_SQL,
  MARKET_SELECTION_COMPANIES_SQL,
} from '../connectors/news-relevance';

const KR_MARKETS: readonly string[] = [Market.KRX, Market.KOSPI, Market.KOSDAQ, Market.KONEX];
const US_MARKETS: readonly string[] = [Market.NASDAQ, Market.NYSE, Market.AMEX];
export interface TossScopeCompany {
  companyId: string;
  symbol: string;
  region: 'kr' | 'us';
  currency: 'KRW' | 'USD';
  priority: string | null;
}
export interface NormalizedTossCandle {
  companyId: string;
  interval: '1d' | '1m';
  barAt: Date;
  sessionDate: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  currency: 'KRW' | 'USD';
  source: 'TOSS_KR' | 'TOSS_US';
  rightsMode: typeof RightsMode.PRIVATE_DISPLAY_ONLY;
  rawPayloadJson: Record<string, unknown>;
  provenanceJson: Record<string, unknown>;
  observedAt: Date;
}

export function tossDecimal(raw: string, field: string): string {
  const parsed = parseDecimal(raw, field);
  if (parsed.value === null || parsed.warning || parsed.value.startsWith('-')) {
    throw new Error(`Toss ${field} is outside the nonnegative DECIMAL(38,6) contract.`);
  }
  return parsed.value;
}
function scaled(value: string): bigint {
  const [integer = '0', fraction = ''] = value.split('.');
  return BigInt(integer + fraction.padEnd(6, '0'));
}

export function normalizeTossCandle(
  scope: TossScopeCompany,
  interval: '1d' | '1m',
  raw: TossCandle,
  observedAt: Date,
): NormalizedTossCandle {
  if (raw.currency !== scope.currency)
    throw new Error(`Toss currency mismatch for ${scope.symbol}.`);
  const barAt = new Date(raw.timestamp);
  if (!Number.isFinite(barAt.getTime())) throw new Error('Toss candle has an invalid timestamp.');
  if (barAt.getTime() > observedAt.getTime() + 60_000)
    throw new Error('Toss candle starts in the future.');
  const open = tossDecimal(raw.openPrice, 'open');
  const high = tossDecimal(raw.highPrice, 'high');
  const low = tossDecimal(raw.lowPrice, 'low');
  const close = tossDecimal(raw.closePrice, 'close');
  const volume = tossDecimal(raw.volume, 'volume');
  const [o, h, l, c, v] = [open, high, low, close, volume].map(scaled) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  const noTrades = o === 0n && h === 0n && l === 0n && v === 0n;
  if (!noTrades && (h < o || h < l || h < c || l > o || l > c))
    throw new Error('Toss returned an invalid OHLC envelope.');
  return {
    companyId: scope.companyId,
    interval,
    barAt,
    sessionDate: dateOnlyInTimeZone(
      barAt,
      scope.region === 'kr' ? 'Asia/Seoul' : 'America/New_York',
    ),
    open,
    high,
    low,
    close,
    volume,
    currency: raw.currency,
    source: scope.region === 'kr' ? 'TOSS_KR' : 'TOSS_US',
    rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
    rawPayloadJson: { ...raw },
    provenanceJson: {
      provider: 'TOSS',
      endpoint: '/api/v1/candles',
      symbol: scope.symbol,
      interval,
      adjusted: false,
      adjustment: 'RAW',
      providerTimestamp: raw.timestamp,
      exchangeCoverage: 'PROVIDER_UNSPECIFIED',
      observedAt: observedAt.toISOString(),
      noTrades,
      complete: interval === '1m' ? barAt.getTime() + 60_000 <= observedAt.getTime() : null,
    },
    observedAt,
  };
}

export function tossCompanyScope(
  company: Pick<CompanyEntity, 'id' | 'market' | 'stockCode' | 'ticker' | 'isListed'>,
  priority: string | null = null,
): TossScopeCompany | null {
  if (!company.isListed) return null;
  if (
    KR_MARKETS.includes(company.market) &&
    company.stockCode &&
    /^[0-9A-Z]{6}$/u.test(company.stockCode)
  ) {
    return {
      companyId: company.id,
      symbol: company.stockCode,
      region: 'kr',
      currency: 'KRW',
      priority,
    };
  }
  const ticker = company.ticker?.trim().toUpperCase();
  if (US_MARKETS.includes(company.market) && ticker && /^[A-Z][A-Z0-9.-]{0,14}$/u.test(ticker)) {
    return { companyId: company.id, symbol: ticker, region: 'us', currency: 'USD', priority };
  }
  return null;
}

@Injectable()
export class TossMarketDataService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly client: TossMarketClient,
    private readonly stockInfo: TossStockInfoService,
  ) {}

  async scope(companyIds?: readonly string[]): Promise<readonly TossScopeCompany[]> {
    const watches = await this.dataSource
      .getRepository(WatchlistItemEntity)
      .find({ where: { priority: In([WatchPriority.P1, WatchPriority.P2]) } });
    const priorities = new Map(watches.map((watch) => [watch.companyId, watch.priority]));
    const grouped: Array<{ companyId: string }> = companyIds
      ? []
      : await this.dataSource.query(`${APPROVED_GROUP_COMPANIES_SQL} ORDER BY companyId`);
    const automatic: Array<{ companyId: string }> = companyIds
      ? []
      : await this.dataSource.query(MARKET_SELECTION_COMPANIES_SQL);
    let requested = companyIds
      ? [...companyIds]
      : [...watches.map((watch) => watch.companyId), ...grouped.map((row) => row.companyId)];
    if (this.client.enabled) {
      const redis = await this.client.storage();
      const activeKey = `${this.config.redisPrefix}market:toss:active`;
      if (companyIds?.length) {
        await redis.zadd(activeKey, ...companyIds.flatMap((id) => [String(Date.now()), id]));
        await redis.expire(activeKey, 600);
      } else {
        await redis.zremrangebyscore(activeKey, '-inf', Date.now() - 300_000);
        const active = await redis.zrevrangebyscore(
          activeKey,
          '+inf',
          Date.now() - 300_000,
          'LIMIT',
          0,
          100,
        );
        requested = [...active, ...requested];
      }
    }
    const ids = [...new Set([...automatic.map((row) => row.companyId), ...requested])].slice(
      0,
      this.config.tossMaxSubscriptions,
    );
    if (ids.length === 0) return [];
    const companies = await this.dataSource
      .getRepository(CompanyEntity)
      .find({ where: { id: In(ids), isListed: true } });
    const scopes = companies
      .map((company) => tossCompanyScope(company, priorities.get(company.id) ?? null))
      .filter((scope): scope is TossScopeCompany => scope !== null);
    const counts = new Map<string, number>();
    for (const scope of scopes)
      counts.set(
        `${scope.region}:${scope.symbol}`,
        (counts.get(`${scope.region}:${scope.symbol}`) ?? 0) + 1,
      );
    // 모호한 식별자로 다른 증권의 가격을 연결해서는 안 됩니다.
    return scopes
      .filter((scope) => counts.get(`${scope.region}:${scope.symbol}`) === 1)
      .sort((a, b) => ids.indexOf(a.companyId) - ids.indexOf(b.companyId));
  }

  private async verifiedStocks(
    scopes: readonly TossScopeCompany[],
  ): Promise<Map<string, TossStock>> {
    return this.stockInfo.lookup(scopes);
  }

  async syncStocks(companyIds?: readonly string[]): Promise<Record<string, unknown>> {
    if (!this.client.enabled) return { disabled: true, connector: 'TOSS' };
    if (companyIds && companyIds.length > 100)
      throw new Error('Toss stock information scope exceeds 100 companies.');
    let selected = companyIds;
    if (!selected) {
      const watches = await this.dataSource.getRepository(WatchlistItemEntity).find({
        select: { companyId: true },
        order: { priority: 'ASC', createdAt: 'DESC' },
        take: 100,
      });
      const recent = await this.dataSource.getRepository(SourceCheckpointEntity).find({
        where: { connector: 'TOSS', stream: Like('PRICE_BARS:%') },
        order: { lastSuccessAt: 'DESC' },
        take: 200,
      });
      const grouped: Array<{ companyId: string }> = await this.dataSource.query(
        `${APPROVED_GROUP_COMPANIES_SQL} ORDER BY companyId`,
      );
      const automatic: Array<{ companyId: string }> = await this.dataSource.query(
        MARKET_SELECTION_COMPANIES_SQL,
      );
      selected = [
        ...new Set([
          ...automatic.map((row) => row.companyId),
          ...watches.map((watch) => watch.companyId),
          ...grouped.map((row) => row.companyId),
          ...recent
            .map((checkpoint) => checkpoint.stream.split(':').at(-1)!)
            .filter((id) => /^[0-9a-f-]{36}$/iu.test(id)),
        ]),
      ].slice(0, 100);
    }
    // 이름 동기화는 시세 조회/실시간 구독의 active 목록을 활성화하지 않는다.
    const ids = [...new Set(selected)];
    const companies = ids.length
      ? await this.dataSource.getRepository(CompanyEntity).find({
          where: { id: In(ids), isListed: true },
        })
      : [];
    const candidates = companies
      .map((company) => tossCompanyScope(company))
      .filter((scope): scope is TossScopeCompany => scope !== null);
    const counts = new Map<string, number>();
    for (const scope of candidates) counts.set(scope.symbol, (counts.get(scope.symbol) ?? 0) + 1);
    const scopes = candidates
      .filter((scope) => counts.get(scope.symbol) === 1)
      .sort((a, b) => ids.indexOf(a.companyId) - ids.indexOf(b.companyId));
    const stocks = await this.verifiedStocks(scopes);
    return {
      connector: 'TOSS',
      stream: 'STOCK_INFO',
      companiesRequested: scopes.length,
      companiesAvailable: stocks.size,
      unavailableSymbols: scopes
        .filter((scope) => !stocks.has(scope.symbol))
        .map((scope) => scope.symbol),
      withoutKoreanNames: scopes
        .filter((scope) => {
          const stock = stocks.get(scope.symbol);
          return scope.region === 'us' && stock && !/[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(stock.name);
        })
        .map((scope) => scope.symbol),
      excludedCompanyIds: ids.filter((id) => !scopes.some((scope) => scope.companyId === id)),
    };
  }

  async fetchCandles(
    scope: TossScopeCompany,
    input: TossCandlesJob,
  ): Promise<readonly NormalizedTossCandle[]> {
    const now = new Date();
    const maximum = input.interval === '1d' ? 400 : 1000;
    const maxPages = input.maxPages ?? (input.interval === '1d' ? 3 : 6);
    const cutoff =
      now.getTime() - (input.lookbackDays ?? (input.interval === '1d' ? 366 : 7)) * 86_400_000;
    const rows = new Map<number, NormalizedTossCandle>();
    let before = input.before;
    const cursors = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await this.client.candlePage(scope.symbol, input.interval, before);
      let oldest = Number.POSITIVE_INFINITY;
      let added = 0;
      for (const raw of payload.candles) {
        const row = normalizeTossCandle(scope, input.interval, raw, now);
        const timestamp = row.barAt.getTime();
        if (before && timestamp > Date.parse(before))
          throw new Error('Toss candle exceeds the requested inclusive cursor.');
        oldest = Math.min(oldest, timestamp);
        if (timestamp < cutoff || rows.has(timestamp) || rows.size >= maximum) continue;
        rows.set(timestamp, row);
        added += 1;
      }
      if (
        !payload.nextBefore ||
        payload.candles.length === 0 ||
        oldest < cutoff ||
        rows.size >= maximum
      )
        break;
      const nextInstant = Date.parse(payload.nextBefore);
      if (
        cursors.has(payload.nextBefore) ||
        (before && nextInstant >= Date.parse(before)) ||
        (page > 0 && added === 0)
      ) {
        throw new Error('Toss candle pagination made no progress.');
      }
      cursors.add(payload.nextBefore);
      before = payload.nextBefore;
    }
    return [...rows.values()].sort((a, b) => a.barAt.getTime() - b.barAt.getTime());
  }

  async ingest(input: TossCandlesJob): Promise<Record<string, unknown>> {
    if (!this.client.enabled) return { disabled: true, connector: 'TOSS' };
    const startedAt = new Date();
    const runs = this.dataSource.getRepository(IngestionRunEntity);
    const run = await runs.save(
      runs.create({
        id: randomUUID(),
        connector: 'TOSS',
        stream: `PRICE_BARS:${input.interval}`,
        status: ProcessingStatus.PROCESSING,
        itemsSeen: '0',
        itemsCreated: '0',
        startedAt,
        finishedAt: null,
        errorMessage: null,
      }),
    );
    let saved = 0;
    let created = 0;
    let succeeded = 0;
    const failures: string[] = [];
    try {
      const scopes = await this.scope(input.companyIds);
      const stocks = await this.verifiedStocks(scopes);
      for (const scope of scopes) {
        if (!stocks.has(scope.symbol)) {
          failures.push(`${scope.symbol}: unavailable or inconsistent stock identity`);
          continue;
        }
        try {
          const stream = `PRICE_BARS:${input.interval}:${scope.companyId}`;
          const checkpoint =
            input.reason === 'VIEW'
              ? await this.dataSource
                  .getRepository(SourceCheckpointEntity)
                  .findOne({ where: { connector: 'TOSS', stream } })
              : null;
          const viewPlan = planTossViewFetch(scope, input, checkpoint?.metadataJson, Date.now());
          const bars = await this.fetchCandles(scope, viewPlan.input);
          if (!bars.length) {
            failures.push(`${scope.symbol}: no bars in the requested range`);
            continue;
          }
          const stock = stocks.get(scope.symbol)!;
          for (const bar of bars) bar.provenanceJson.stock = { ...stock };
          const newlyCreated = await this.dataSource.transaction(async (manager) => {
            const existing = await manager.getRepository(PriceBarEntity).find({
              where: {
                companyId: scope.companyId,
                source: bars[0]!.source,
                interval: input.interval,
                barAt: In(bars.map((bar) => bar.barAt)),
              },
              select: { barAt: true },
            });
            for (let start = 0; start < bars.length; start += 200) {
              await manager
                .getRepository(PriceBarEntity)
                .createQueryBuilder()
                .insert()
                .into(PriceBarEntity)
                .values(
                  bars
                    .slice(start, start + 200)
                    .map((bar) => ({ ...bar })) as QueryDeepPartialEntity<PriceBarEntity>[],
                )
                .orUpdate([
                  'open',
                  'high',
                  'low',
                  'close',
                  'volume',
                  'currency',
                  'rights_mode',
                  'session_date',
                  'raw_payload_json',
                  'provenance_json',
                  'observed_at',
                ])
                .execute();
            }
            const checkpoints = manager.getRepository(SourceCheckpointEntity);
            const current = await checkpoints.findOne({
              where: { connector: 'TOSS', stream },
              lock: { mode: 'pessimistic_write' },
            });
            const latest = bars.at(-1)!;
            const advance =
              !current?.lastSuccessDate || latest.sessionDate >= current.lastSuccessDate;
            const completedAt = new Date();
            const metadataJson: Record<string, unknown> = {
              ...(current?.metadataJson ?? {}),
              ...(advance
                ? {
                    companyId: scope.companyId,
                    symbol: scope.symbol,
                    source: latest.source,
                    interval: input.interval,
                    adjusted: false,
                    rows: bars.length,
                    latestBarAt: latest.barAt.toISOString(),
                  }
                : {}),
            };
            if (viewPlan.historyPolicy) {
              // 이력 표식은 봉과 함께 커밋하며, 일부만 수집되거나 실패한 경우에는 저장하지 않습니다.
              metadataJson.viewHistory = {
                ...viewPlan.historyPolicy,
                hydratedAt: viewPlan.hydratedAt ?? completedAt.toISOString(),
                refreshedAt: completedAt.toISOString(),
              };
            }
            await checkpoints.save(
              checkpoints.create({
                ...current,
                connector: 'TOSS',
                stream,
                lastSuccessDate: advance ? latest.sessionDate : current.lastSuccessDate,
                lastSuccessAt: completedAt,
                cursor: null,
                metadataJson,
              }),
            );
            return bars.length - existing.length;
          });
          saved += bars.length;
          created += newlyCreated;
          succeeded += 1;
        } catch (error) {
          failures.push(`${scope.symbol}: ${this.safeError(error)}`);
        }
      }
      if (failures.length && succeeded === 0) throw new Error(failures.slice(0, 5).join('; '));
      await runs.update(run.id, {
        status: ProcessingStatus.COMPLETED,
        itemsSeen: String(saved),
        itemsCreated: String(created),
        finishedAt: new Date(),
        errorMessage: failures.length ? failures.slice(0, 5).join('; ') : null,
      });
      await this.recordHealth(
        failures.length || !saved ? ConnectorStatus.DEGRADED : ConnectorStatus.HEALTHY,
        failures.length
          ? failures.slice(0, 3).join('; ')
          : !saved
            ? 'No eligible watchlist or active-page companies.'
            : null,
        {
          interval: input.interval,
          rows: saved,
          companiesSucceeded: succeeded,
          companiesFailed: failures.length,
        },
      );
      return {
        connector: 'TOSS',
        interval: input.interval,
        rows: saved,
        itemsCreated: created,
        companiesSucceeded: succeeded,
        companiesFailed: failures.length,
      };
    } catch (error) {
      const message = this.safeError(error);
      await runs.update(run.id, {
        status: ProcessingStatus.FAILED,
        finishedAt: new Date(),
        errorMessage: message,
      });
      await this.recordHealth(ConnectorStatus.FAILED, message, { interval: input.interval });
      throw new Error(message);
    }
  }

  private safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : 'Toss market-data request failed.';
    for (const secret of [this.config.tossClientId, this.config.tossClientSecret])
      if (secret) message = message.replaceAll(secret, '[REDACTED]');
    // Zod 오류에 제공자 응답 값이 포함될 수 있으므로 일반적인 검증 실패 정보만 남깁니다.
    if (error instanceof Error && error.name === 'ZodError')
      return 'Toss response did not match the market-data contract.';
    return message.slice(0, 2000);
  }

  async recordHealth(
    status: ConnectorStatus,
    message: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const repository = this.dataSource.getRepository(ConnectorHealthEntity);
    const current = await repository.findOne({ where: { connector: 'toss' } });
    const now = new Date();
    await repository.save(
      repository.create({
        ...current,
        connector: 'toss',
        status,
        message,
        checkedAt: now,
        lastSuccessAt: status === ConnectorStatus.HEALTHY ? now : (current?.lastSuccessAt ?? null),
        lastFailureAt: status === ConnectorStatus.FAILED ? now : (current?.lastFailureAt ?? null),
        metadataJson: {
          ...(current?.metadataJson ?? {}),
          ...metadata,
          healthSource: 'TOSS_INGESTION',
          rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
          provider: 'TOSS',
        },
      }),
    );
  }
}
