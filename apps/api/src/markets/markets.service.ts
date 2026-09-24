import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  MARKET_CONNECTOR_IDS,
  MARKET_INSTRUMENTS,
  marketHistorySchema,
  marketOverviewSchema,
  type MarketHistory,
  type MarketHistoryRange,
  type MarketInstrument,
  type MarketQuote,
  type Region,
} from '@orsem/contracts';
import { ConnectorHealthEntity, MarketObservationEntity, dateToIso } from '@orsem/database';
import { Between, In } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';

const dayMs = 86_400_000;
const dailyProviders = new Set(['TREASURY', 'EIA']);
// EIA는 일별 관측값을 주 단위로 묶어 발표하며 미국 공휴일에는 발표가 늦어집니다.
const sourceDateMaxAgeDays = (provider: string) => (provider === 'EIA' ? 14 : 7);
const failed = new Set(['FAILED', 'DEGRADED']);
const number = (value: string | null | undefined): number | null =>
  value != null && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
function decimal(value: number): string | null {
  return Number.isFinite(value) ? String(Number(value.toFixed(10))) : null;
}
function providerDate(instrument: MarketInstrument, value: Date): string {
  if (instrument.region === 'kr')
    return new Date(value.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function projectMarketQuote(
  instrument: MarketInstrument,
  observations: readonly MarketObservationEntity[],
  health: ConnectorHealthEntity | undefined,
  configured: boolean,
  now = new Date(),
): MarketQuote {
  const daily = observations
    .filter((row) => row.kind === 'DAILY' && row.sourceDate && number(row.value) !== null)
    .sort((a, b) => b.sourceDate!.localeCompare(a.sourceDate!));
  const quote = observations.find((row) => row.kind === 'QUOTE' && number(row.value) !== null);
  const latest = quote ?? daily[0];
  const isDaily = dailyProviders.has(instrument.provider);
  const componentStatus = health?.metadataJson?.[isDaily ? 'historyStatus' : 'quoteStatus'];
  const unavailableIds =
    health?.metadataJson?.[
      isDaily ? 'historyUnavailableInstruments' : 'quoteUnavailableInstruments'
    ];
  const componentFailed =
    failed.has(String(componentStatus ?? health?.status ?? '')) &&
    (!Array.isArray(unavailableIds) || unavailableIds.includes(instrument.id));
  const period =
    latest?.sourceDate ?? (latest?.providerAt ? providerDate(instrument, latest.providerAt) : null);
  const previous = period ? daily.find((row) => row.sourceDate! < period) : undefined;
  const referenceValue = latest?.referenceValue ?? previous?.value ?? null;
  const referenceDate = latest?.referenceDate ?? previous?.sourceDate ?? null;
  const current = number(latest?.value);
  const reference = number(referenceValue);
  const delta = current !== null && reference !== null ? current - reference : null;
  const observationAge = latest ? now.getTime() - latest.lastObservedAt.getTime() : Infinity;
  const providerAge = latest?.providerAt ? now.getTime() - latest.providerAt.getTime() : 0;
  // 일별 자료는 휴장일에도 마지막 값을 유지하며 수집 시각과 제공 시각을 구분합니다.
  const oldDaily =
    isDaily && period
      ? now.getTime() - Date.parse(period) > sourceDateMaxAgeDays(instrument.provider) * dayMs
      : false;
  const closedKr =
    instrument.region === 'kr' &&
    instrument.category === 'INDEX' &&
    isKoreanMarketClosed(now) &&
    providerAge >= 0 &&
    providerAge <= 5 * dayMs;
  const providerStale = !isDaily && !closedKr && providerAge > 5 * 60_000;
  const stale =
    observationAge > (isDaily ? 7 * 3_600_000 : 5 * 60_000) ||
    observationAge < -5_000 ||
    providerAge < -5_000 ||
    providerStale ||
    oldDaily ||
    componentFailed;
  const status: MarketQuote['status'] =
    instrument.displayKind === 'WIDGET'
      ? 'EMBEDDED'
      : !configured
        ? 'NOT_CONFIGURED'
        : current === null
          ? componentFailed
            ? 'UNAVAILABLE'
            : 'WAITING'
          : stale
            ? 'STALE'
            : 'AVAILABLE';
  return {
    ...instrument,
    status,
    value: current === null ? null : latest!.value,
    change: delta === null ? null : decimal(instrument.category === 'BOND' ? delta * 100 : delta),
    changePercent:
      delta === null || reference === 0 || reference === null || instrument.category === 'BOND'
        ? null
        : decimal((delta / Math.abs(reference)) * 100),
    changeUnit: instrument.category === 'BOND' ? 'bp' : 'percent',
    changeLabel:
      latest?.referenceLabel ??
      (instrument.historyKind === 'daily_average'
        ? '직전 일평균 대비'
        : instrument.historyKind === 'observed'
          ? '직전 관측일 대비'
          : instrument.category === 'BOND'
            ? '직전 발표일 대비'
            : '직전 거래일 대비'),
    valueDate: period,
    providerAt: dateToIso(latest?.providerAt),
    observedAt: dateToIso(latest?.lastObservedAt),
    referenceValue,
    referenceDate,
    convertedValue: null,
    conversionRate: null,
    conversionAt: null,
    message:
      status === 'NOT_CONFIGURED'
        ? '데이터 연결 설정이 필요합니다.'
        : status === 'WAITING'
          ? '첫 관측값을 기다리고 있습니다.'
          : status === 'UNAVAILABLE'
            ? '현재 공급자 데이터를 가져올 수 없습니다.'
            : status === 'STALE'
              ? '마지막으로 확인된 값입니다. 기준 시각을 확인하세요.'
              : !isDaily && latest && !latest.providerAt
                ? '공급자 제공 시각 미확인 · 수집 시각 기준'
                : closedKr
                  ? '최근 거래 시세 · 장 종료'
                  : null,
  };
}

function isKoreanMarketClosed(now: Date): boolean {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const minute = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return [0, 6].includes(kst.getUTCDay()) || minute < 9 * 60 || minute >= 15 * 60 + 30;
}

export function convertCryptoQuotes(items: MarketQuote[]): MarketQuote[] {
  const fx = items.find((item) => item.id === 'usd-krw');
  const rate = number(fx?.value);
  return items.map((item) => {
    if (
      item.category !== 'CRYPTO' ||
      item.value === null ||
      !fx ||
      fx.status !== 'AVAILABLE' ||
      rate === null ||
      rate <= 0
    )
      return item;
    return {
      ...item,
      convertedValue: decimal(Number(item.value) / rate),
      conversionRate: fx.value,
      conversionAt: fx.providerAt ?? fx.observedAt,
    };
  });
}

@Injectable()
export class MarketsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
  ) {}

  private configured(instrument: MarketInstrument, history = false): boolean {
    if (instrument.provider === 'TOSS')
      return Boolean(this.config.tossClientId && this.config.tossClientSecret);
    if (instrument.provider === 'EIA') return Boolean(this.config.eiaApiKey);
    if (history && instrument.provider === 'GOLD_API') return Boolean(this.config.goldApiKey);
    return true;
  }

  async overview(region: Region = 'all', historyRange?: '1m') {
    const now = new Date();
    const { rows, health } = await this.readSnapshots(now, historyRange ? 31 : 14);
    const items = convertCryptoQuotes(
      MARKET_INSTRUMENTS.map((instrument) =>
        projectMarketQuote(
          instrument,
          rows.filter(
            (row) => row.instrumentId === instrument.id && row.source === instrument.provider,
          ),
          health.find(
            (row) =>
              row.connector ===
              (instrument.provider === 'TRADINGVIEW' || instrument.provider === 'FRED'
                ? ''
                : MARKET_CONNECTOR_IDS[instrument.provider]),
          ),
          this.configured(instrument),
          now,
        ),
      ),
    ).filter((item) => region === 'all' || item.region === region);
    const histories = historyRange
      ? Object.fromEntries(
          await Promise.all(
            items
              .filter((item) => item.displayKind === 'NATIVE')
              .map(async (item) => [
                item.id,
                await this.history(item.id, historyRange, { rows, health, now }),
              ]),
          ),
        )
      : undefined;
    return marketOverviewSchema.parse({ asOf: now.toISOString(), items, histories });
  }

  private async readSnapshots(now: Date, days = 14) {
    if (this.config.fixtureMode)
      return { rows: [] as MarketObservationEntity[], health: [] as ConnectorHealthEntity[] };
    const source = this.database.requireDataSource();
    const ids = MARKET_INSTRUMENTS.filter((item) => item.displayKind === 'NATIVE').map(
      (item) => item.id,
    );
    const [rows, health] = await Promise.all([
      source.getRepository(MarketObservationEntity).find({
        where: [
          { instrumentId: In(ids), kind: 'QUOTE' },
          {
            instrumentId: In(ids),
            kind: 'DAILY',
            sourceDate: Between(
              new Date(now.getTime() - days * dayMs).toISOString().slice(0, 10),
              providerDate(MARKET_INSTRUMENTS[0]!, now),
            ),
          },
        ],
      }),
      source
        .getRepository(ConnectorHealthEntity)
        .find({ where: { connector: In(Object.values(MARKET_CONNECTOR_IDS)) } }),
    ]);
    return { rows, health };
  }

  async history(
    id: string,
    range: MarketHistoryRange,
    batch?: { rows: MarketObservationEntity[]; health: ConnectorHealthEntity[]; now: Date },
  ): Promise<MarketHistory> {
    const instrument = MARKET_INSTRUMENTS.find((item) => item.id === id);
    if (!instrument) throw new NotFoundException('시장 지표를 찾을 수 없습니다.');
    const now = batch?.now ?? new Date();
    const start = new Date(now.getTime() - { '1m': 31, '3m': 93, '1y': 366 }[range] * dayMs)
      .toISOString()
      .slice(0, 10);
    const rows = batch
      ? batch.rows
          .filter(
            (row) =>
              row.instrumentId === id &&
              row.source === instrument.provider &&
              row.kind === 'DAILY' &&
              row.sourceDate &&
              row.sourceDate >= start &&
              row.sourceDate <= providerDate(instrument, now),
          )
          .sort((a, b) => a.sourceDate!.localeCompare(b.sourceDate!))
      : this.config.fixtureMode || instrument.displayKind === 'WIDGET'
        ? []
        : await this.database
            .requireDataSource()
            .getRepository(MarketObservationEntity)
            .find({
              where: {
                instrumentId: id,
                source: instrument.provider,
                kind: 'DAILY',
                sourceDate: Between(start, providerDate(instrument, now)),
              },
              order: { sourceDate: 'ASC' },
            });
    const points = rows
      .filter((row) => row.sourceDate && number(row.value) !== null)
      .map((row) => ({ date: row.sourceDate!, value: row.value }));
    const configured = this.configured(instrument, true);
    const source =
      this.config.fixtureMode || instrument.displayKind === 'WIDGET'
        ? null
        : this.database.requireDataSource();
    const health = batch
      ? batch.health.find(
          (row) =>
            row.connector ===
            MARKET_CONNECTOR_IDS[instrument.provider as keyof typeof MARKET_CONNECTOR_IDS],
        )
      : source && instrument.provider !== 'TRADINGVIEW' && instrument.provider !== 'FRED'
        ? await source
            .getRepository(ConnectorHealthEntity)
            .findOneBy({ connector: MARKET_CONNECTOR_IDS[instrument.provider] })
        : null;
    const component = instrument.historyKind === 'observed' ? 'quote' : 'history';
    const unavailableIds = health?.metadataJson?.[`${component}UnavailableInstruments`];
    const historyFailed =
      failed.has(String(health?.metadataJson?.[`${component}Status`] ?? '')) &&
      (!Array.isArray(unavailableIds) || unavailableIds.includes(id));
    const latest = rows.at(-1);
    const historyStale =
      !configured ||
      historyFailed ||
      (latest
        ? now.getTime() - latest.lastObservedAt.getTime() > 7 * 3_600_000 ||
          now.getTime() - Date.parse(latest.sourceDate!) >
            sourceDateMaxAgeDays(instrument.provider) * dayMs
        : false);
    const status =
      instrument.displayKind === 'WIDGET'
        ? 'EMBEDDED'
        : !configured && points.length === 0
          ? 'NOT_CONFIGURED'
          : points.length > 0
            ? historyStale
              ? 'STALE'
              : 'AVAILABLE'
            : 'WAITING';
    return marketHistorySchema.parse({
      asOf: now.toISOString(),
      instrument,
      range,
      points,
      historyKind: instrument.historyKind,
      status,
      message:
        status === 'NOT_CONFIGURED'
          ? '과거 데이터용 무료 API 키 설정이 필요합니다.'
          : status === 'WAITING'
            ? '이 기간에 수집된 값이 없습니다.'
            : status === 'STALE'
              ? '이력 갱신이 지연되어 마지막으로 저장한 값을 표시합니다.'
              : instrument.historyKind === 'observed'
                ? '수집 시작 이후 일별 마지막 관측값입니다.'
                : instrument.historyKind === 'daily_average'
                  ? '일별 평균 가격입니다.'
                  : null,
      sourceUrl: instrument.sourceUrl,
    });
  }

  async freshness() {
    const now = new Date();
    const source = this.config.fixtureMode ? null : this.database.requireDataSource();
    const rows = source
      ? await source
          .getRepository(ConnectorHealthEntity)
          .find({ where: { connector: In(Object.values(MARKET_CONNECTOR_IDS)) } })
      : [];
    const names = {
      TOSS: '토스 시장 지표',
      BITHUMB: '빗썸',
      TREASURY: '미국 국채',
      GOLD_API: '금·은',
      EIA: 'WTI 현물',
    };
    return Object.entries(MARKET_CONNECTOR_IDS).map(([provider, id]) => {
      const instrument = MARKET_INSTRUMENTS.find((item) => item.provider === provider)!;
      const row = rows.find((health) => health.connector === id);
      const configured = this.configured(instrument);
      const lastSuccessAt = dateToIso(row?.lastSuccessAt);
      return {
        id,
        name: names[provider as keyof typeof names],
        category: 'MARKET' as const,
        status: !configured ? 'DISABLED' : (row?.status ?? 'UNCONFIGURED'),
        lastSuccessAt,
        lagSeconds: lastSuccessAt
          ? Math.max(0, Math.floor((now.getTime() - Date.parse(lastSuccessAt)) / 1000))
          : null,
        rightsMode: instrument.rightsMode,
        message: !configured
          ? '연결 설정 필요'
          : row?.status === 'DEGRADED'
            ? '일부 데이터 갱신 지연'
            : null,
      };
    });
  }
}
