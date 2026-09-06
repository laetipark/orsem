import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConnectorStatus, MARKET_CONNECTOR_IDS, MARKET_INSTRUMENTS } from '@orsem/contracts';
import {
  ConnectorHealthEntity,
  MarketInstrumentEntity,
  MarketObservationEntity,
} from '@orsem/database';
import { DataSource, Raw, type Repository } from 'typeorm';
import {
  IndicatorRequestError,
  MarketIndicatorClient,
  type IndicatorSource,
} from './market-indicator.client';
import type { IndicatorObservation } from './parsers';

type ComponentStatus = 'HEALTHY' | 'DEGRADED' | 'UNCONFIGURED';
interface SourceResult {
  status: ComponentStatus;
  instrumentIds: readonly string[];
  retryAt?: string;
  httpStatus?: number;
}

const LOOKUP_BATCH_SIZE = 200;
const instrumentDefinitions = new Map(MARKET_INSTRUMENTS.map((item) => [item.id, item]));
type DailyReference = Pick<MarketObservationEntity, 'sourceDate' | 'value'>;

function observationKey(row: Pick<IndicatorObservation, 'instrumentId' | 'kind' | 'period'>) {
  return `${row.instrumentId}:${row.kind}:${row.period}`;
}

function earlierReference(rows: readonly DailyReference[], date: string | null) {
  if (!date) return undefined;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle]!.sourceDate! < date) low = middle + 1;
    else high = middle;
  }
  return rows[low - 1];
}

@Injectable()
export class MarketIndicatorIngestionService implements OnModuleInit {
  private catalogReady: Promise<void> | null = null;
  constructor(
    private readonly db: DataSource,
    private readonly client: MarketIndicatorClient,
  ) {}

  async onModuleInit(): Promise<void> {
    // This seeds only the fixed instrument definitions, never simulated prices.
    this.catalogReady ??= this.db
      .getRepository(MarketInstrumentEntity)
      .upsert(
        MARKET_INSTRUMENTS.map((definitionJson) => ({ id: definitionJson.id, definitionJson })),
        ['id'],
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.catalogReady = null;
        throw error;
      });
    await this.catalogReady;
  }

  async refresh(mode: 'quotes' | 'history'): Promise<Record<string, unknown>> {
    await this.onModuleInit();
    const now = new Date();
    const tasks = mode === 'quotes' ? this.client.quoteTasks(now) : this.client.historyTasks(now);
    const results = new Map<IndicatorSource, SourceResult[]>();
    let saved = 0;
    for (const task of tasks) {
      const sourceResults = results.get(task.source) ?? [];
      results.set(task.source, sourceResults);
      if (!task.configured) {
        sourceResults.push({ status: 'UNCONFIGURED', instrumentIds: task.instrumentIds });
        continue;
      }
      try {
        const rows = await task.collect();
        const observedIds = new Set(rows.map((row) => row.instrumentId));
        if (rows.some((row) => !task.instrumentIds.includes(row.instrumentId)))
          throw new Error('Unexpected instrument');
        const missingIds = task.instrumentIds.filter((id) => !observedIds.has(id));
        if (rows.length) saved += await this.saveObservations(task.source, rows, now);
        sourceResults.push({
          status: missingIds.length ? 'DEGRADED' : 'HEALTHY',
          instrumentIds: missingIds.length ? missingIds : task.instrumentIds,
        });
      } catch (error) {
        sourceResults.push({
          status: 'DEGRADED',
          instrumentIds: task.instrumentIds,
          ...(error instanceof IndicatorRequestError && error.retryAt
            ? { retryAt: error.retryAt.toISOString() }
            : {}),
          ...(error instanceof IndicatorRequestError && error.httpStatus
            ? { httpStatus: error.httpStatus }
            : {}),
        });
      }
    }
    for (const [source, sourceResults] of results)
      await this.recordHealth(source, mode, sourceResults, now);
    return {
      mode,
      saved,
      sources: [...results].map(([source, items]) => ({
        source,
        statuses: items.map((item) => item.status),
      })),
    };
  }

  async saveObservations(
    source: IndicatorSource,
    input: readonly IndicatorObservation[],
    now: Date,
  ): Promise<number> {
    if (!input.length) return 0;
    const repo = this.db.getRepository(MarketObservationEntity);
    const next = new Map<string, IndicatorObservation>();
    const promotedFrom = new Map<string, string>();
    for (const row of input) {
      const definition = instrumentDefinitions.get(row.instrumentId);
      if (!definition || definition.provider !== source || definition.displayKind !== 'NATIVE')
        throw new Error('Unexpected instrument source');
      const key = observationKey(row);
      const previous = next.get(key);
      if (
        !previous ||
        !previous.providerAt ||
        !row.providerAt ||
        previous.providerAt <= row.providerAt
      )
        next.set(key, row);
    }
    // Daily publications also supply the current value, without inventing a publication instant.
    if (source === 'TREASURY' || source === 'EIA') {
      const latestByInstrument = new Map<string, IndicatorObservation>();
      for (const row of next.values()) {
        if (row.kind !== 'DAILY') continue;
        const latest = latestByInstrument.get(row.instrumentId);
        if (!latest || latest.period < row.period) latestByInstrument.set(row.instrumentId, row);
      }
      for (const [id, latest] of latestByInstrument) {
        const key = `${id}:QUOTE:latest`;
        next.set(key, { ...latest, kind: 'QUOTE', period: 'latest' });
        promotedFrom.set(key, observationKey(latest));
      }
    }
    const existing = await this.readCurrentObservations(repo, [...next.values()]);
    const current = new Map(existing.map((row) => [observationKey(row), row]));
    for (const [key, row] of next) {
      const previous = current.get(key);
      if (
        (previous?.providerAt && row.providerAt && previous.providerAt > row.providerAt) ||
        (previous?.sourceDate && row.sourceDate && previous.sourceDate > row.sourceDate)
      )
        next.delete(key);
    }
    for (const [key, dailyKey] of promotedFrom) if (!next.has(dailyKey)) next.delete(key);
    const references = await this.readDailyReferences(repo, [...next.values()], existing);
    const writes: MarketObservationEntity[] = [];
    for (const [key, row] of next) {
      const previous = current.get(key);
      const definition = instrumentDefinitions.get(row.instrumentId)!;
      const reference = earlierReference(references.get(row.instrumentId) ?? [], row.sourceDate);
      const referenceLabel =
        row.referenceLabel ??
        (definition.historyKind === 'daily_average'
          ? '이전 일평균 대비'
          : definition.historyKind === 'observed'
            ? '이전 일별 관측값 대비'
            : definition.category === 'BOND'
              ? '이전 발표값 대비'
              : '전일 종가 대비');
      writes.push(
        repo.create({
          ...(previous ? { id: previous.id } : {}),
          instrumentId: row.instrumentId,
          kind: row.kind,
          period: row.period,
          value: row.value,
          sourceDate: row.sourceDate,
          providerAt: row.providerAt,
          firstObservedAt: previous?.firstObservedAt ?? now,
          lastObservedAt: now,
          source,
          sourceUrl: definition.sourceUrl,
          rightsMode: definition.rightsMode,
          referenceValue: row.referenceValue ?? reference?.value ?? null,
          referenceDate: row.referenceDate ?? reference?.sourceDate ?? null,
          referenceLabel,
          rawMetadataJson: row.raw,
        }),
      );
    }
    if (writes.length) await repo.save(writes, { chunk: 200 });
    return writes.length;
  }

  private async readCurrentObservations(
    repo: Repository<MarketObservationEntity>,
    input: readonly IndicatorObservation[],
  ): Promise<MarketObservationEntity[]> {
    const rows: MarketObservationEntity[] = [];
    for (let offset = 0; offset < input.length; offset += LOOKUP_BATCH_SIZE) {
      rows.push(
        ...(await repo.find({
          select: {
            id: true,
            instrumentId: true,
            kind: true,
            period: true,
            value: true,
            sourceDate: true,
            providerAt: true,
            firstObservedAt: true,
          },
          where: input.slice(offset, offset + LOOKUP_BATCH_SIZE).map((row) => ({
            instrumentId: row.instrumentId,
            kind: row.kind,
            period: row.period,
          })),
        })),
      );
    }
    return rows;
  }

  private async readDailyReferences(
    repo: Repository<MarketObservationEntity>,
    input: readonly IndicatorObservation[],
    existing: readonly MarketObservationEntity[],
  ): Promise<Map<string, DailyReference[]>> {
    const thresholds = new Map<string, { instrumentId: string; sourceDate: string }>();
    for (const row of input) {
      if (row.sourceDate && (row.referenceValue == null || row.referenceDate == null))
        thresholds.set(`${row.instrumentId}:${row.sourceDate}`, {
          instrumentId: row.instrumentId,
          sourceDate: row.sourceDate,
        });
    }
    const daily = new Map<string, Map<string, DailyReference>>();
    const add = (row: DailyReference & { instrumentId: string }) => {
      if (!row.sourceDate) return;
      let dates = daily.get(row.instrumentId);
      if (!dates) daily.set(row.instrumentId, (dates = new Map()));
      dates.set(row.sourceDate, row);
    };
    const targets = [...thresholds.values()];
    for (let offset = 0; offset < targets.length; offset += LOOKUP_BATCH_SIZE) {
      // Each indexed MAX lookup returns only the nearest prior date; long histories stay in SQL.
      const rows = await repo.find({
        select: { instrumentId: true, sourceDate: true, value: true },
        where: targets.slice(offset, offset + LOOKUP_BATCH_SIZE).map((row, index) => ({
          instrumentId: row.instrumentId,
          kind: 'DAILY',
          sourceDate: Raw(
            (alias) =>
              `${alias} = (SELECT MAX(prior.source_date) FROM market_observations prior ` +
              `WHERE prior.instrument_id = :instrument${index} AND prior.kind = 'DAILY' ` +
              `AND prior.source_date < :before${index})`,
            { [`instrument${index}`]: row.instrumentId, [`before${index}`]: row.sourceDate },
          ),
        })),
      });
      for (const row of rows) add(row);
    }
    for (const row of existing) if (row.kind === 'DAILY') add(row);
    // Accepted corrections win for a date. Rejected stale input never becomes a reference.
    for (const row of input) if (row.kind === 'DAILY') add(row);
    return new Map(
      [...daily].map(([id, dates]) => [
        id,
        [...dates.values()].sort((a, b) => a.sourceDate!.localeCompare(b.sourceDate!)),
      ]),
    );
  }

  private async recordHealth(
    source: IndicatorSource,
    mode: 'quotes' | 'history',
    results: SourceResult[],
    now: Date,
  ): Promise<void> {
    const repo = this.db.getRepository(ConnectorHealthEntity);
    const connector = MARKET_CONNECTOR_IDS[source];
    const previous = await repo.findOneBy({ connector });
    const component = mode === 'quotes' ? 'quote' : 'history';
    const componentStatus: ComponentStatus = results.every((item) => item.status === 'UNCONFIGURED')
      ? 'UNCONFIGURED'
      : results.every((item) => item.status === 'HEALTHY')
        ? 'HEALTHY'
        : 'DEGRADED';
    const metadata: Record<string, unknown> = {
      ...previous?.metadataJson,
      provider: source,
      [`${component}Status`]: componentStatus,
      [`${component}CheckedAt`]: now.toISOString(),
      [`${component}UnavailableInstruments`]: results
        .filter((item) => item.status !== 'HEALTHY')
        .flatMap((item) => item.instrumentIds),
      [`${component}RetryAt`]:
        results
          .map((item) => item.retryAt)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
      [`${component}HttpStatus`]: results.find((item) => item.httpStatus)?.httpStatus ?? null,
    };
    const statuses = [metadata.quoteStatus, metadata.historyStatus].filter(
      (value): value is string => typeof value === 'string',
    );
    const status = statuses.every((value) => value === 'UNCONFIGURED')
      ? ConnectorStatus.DISABLED
      : statuses.every((value) => value === 'HEALTHY')
        ? ConnectorStatus.HEALTHY
        : ConnectorStatus.DEGRADED;
    const message =
      status === ConnectorStatus.HEALTHY
        ? null
        : componentStatus === 'UNCONFIGURED'
          ? `${source} ${component === 'history' ? '이력' : '시세'} 연결 설정이 필요합니다.`
          : status === ConnectorStatus.DEGRADED
            ? `${source} 일부 데이터가 지연되었거나 연결 설정이 필요합니다. 마지막 수신 값을 유지합니다.`
            : `${source} 연결 설정이 필요합니다.`;
    await repo.save(
      repo.create({
        ...(previous ? { id: previous.id } : {}),
        connector,
        status,
        message,
        checkedAt: now,
        lastSuccessAt: componentStatus === 'HEALTHY' ? now : (previous?.lastSuccessAt ?? null),
        lastFailureAt: componentStatus === 'DEGRADED' ? now : (previous?.lastFailureAt ?? null),
        metadataJson: metadata,
      }),
    );
  }
}
