import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConnectorStatus, MARKET_CONNECTOR_IDS, MARKET_INSTRUMENTS } from '@orsem/contracts';
import {
  ConnectorHealthEntity,
  MarketInstrumentEntity,
  MarketObservationEntity,
} from '@orsem/database';
import { DataSource, In } from 'typeorm';
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
    const repo = this.db.getRepository(MarketObservationEntity);
    const ids = [...new Set(input.map((row) => row.instrumentId))];
    const existing = await repo.find({ where: { instrumentId: In(ids) } });
    const current = new Map(
      existing.map((row) => [`${row.instrumentId}:${row.kind}:${row.period}`, row]),
    );
    const next = new Map<string, IndicatorObservation>();
    for (const row of input) {
      const definition = MARKET_INSTRUMENTS.find((item) => item.id === row.instrumentId);
      if (!definition || definition.provider !== source || definition.displayKind !== 'NATIVE')
        throw new Error('Unexpected instrument source');
      const key = `${row.instrumentId}:${row.kind}:${row.period}`;
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
      for (const id of ids) {
        const latest = [...next.values()]
          .filter((row) => row.instrumentId === id && row.kind === 'DAILY')
          .sort((a, b) => b.period.localeCompare(a.period))[0];
        if (latest) next.set(`${id}:QUOTE:latest`, { ...latest, kind: 'QUOTE', period: 'latest' });
      }
    }
    const writes: MarketObservationEntity[] = [];
    for (const [key, row] of next) {
      const previous = current.get(key);
      if (previous?.providerAt && row.providerAt && previous.providerAt > row.providerAt) continue;
      if (previous?.sourceDate && row.sourceDate && previous.sourceDate > row.sourceDate) continue;
      const definition = MARKET_INSTRUMENTS.find((item) => item.id === row.instrumentId)!;
      const dailyByDate = new Map(
        [
          ...existing.filter(
            (item) => item.instrumentId === row.instrumentId && item.kind === 'DAILY',
          ),
          ...[...next.values()].filter(
            (item) => item.instrumentId === row.instrumentId && item.kind === 'DAILY',
          ),
        ]
          .filter((item) => item.sourceDate && row.sourceDate && item.sourceDate < row.sourceDate)
          .map((item) => [item.sourceDate!, item]),
      );
      // The current response supersedes older persisted values for a corrected source date.
      const candidates = [...dailyByDate.values()].sort((a, b) =>
        b.sourceDate!.localeCompare(a.sourceDate!),
      );
      const reference = candidates[0];
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
