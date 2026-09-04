import { Inject, Injectable } from '@nestjs/common';
import { AlertStatus, ConnectorStatus, DeliveryChannel, RightsMode } from '@orsem/contracts';
import {
  AlertEntity,
  AlertOutboxEntity,
  ConnectorHealthEntity,
  IrSourceEntity,
  SyncCheckpointEntity,
} from '@orsem/database';
import { DataSource } from 'typeorm';
import { CompatibleClassifierClient } from '../ai/compatible-classifier.client';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { HTTP_FETCH, type FetchImplementation } from '../opendart/opendart.client';
import {
  createLinkDiscoveryAdapters,
  MAX_REGISTERED_IR_FEEDS,
  RegisteredIrFeedConnector,
  type ConnectorHealthCheck,
} from './connector-adapters';

export type OperationalConnectorHealthCheck = Omit<ConnectorHealthCheck, 'connector'> & {
  readonly connector: ConnectorHealthCheck['connector'] | 'AI' | 'TOSS';
};

@Injectable()
export class ConnectorHealthService {
  public constructor(
    private readonly dataSource: DataSource,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: FetchImplementation,
    private readonly classifier: CompatibleClassifierClient,
  ) {}

  public async checkAll(): Promise<readonly OperationalConnectorHealthCheck[]> {
    const registeredIrSources = await this.dataSource
      .getRepository(IrSourceEntity)
      .find({ where: { isActive: true } });
    const compatibleIrUrls = new Set(this.config.irFeedUrls);
    let invalidIrSources = 0;
    for (const source of registeredIrSources) {
      try {
        if (
          !['RSS', 'ATOM'].includes(source.sourceType.toUpperCase()) ||
          source.rightsMode !== RightsMode.OFFICIAL_PUBLIC_DATA
        ) {
          throw new Error('unsupported registered IR source contract');
        }
        new RegisteredIrFeedConnector([source.url], this.config.httpTimeoutMs);
        const normalizedUrl = new URL(source.url).toString();
        if (
          !compatibleIrUrls.has(normalizedUrl) &&
          compatibleIrUrls.size >= MAX_REGISTERED_IR_FEEDS
        ) {
          throw new Error('registered IR feed safety limit exceeded');
        }
        compatibleIrUrls.add(normalizedUrl);
      } catch {
        invalidIrSources += 1;
      }
    }
    const effectiveConfig: WorkerConfig = {
      ...this.config,
      irFeedUrls: Object.freeze([...compatibleIrUrls]),
    };
    const adapters = createLinkDiscoveryAdapters(effectiveConfig, this.fetchImpl);
    const adapterChecks = await Promise.all(
      adapters.map((adapter) =>
        ['NEWS_RSS', 'SEC'].includes(adapter.name)
          ? this.discoveryHealth(adapter.health())
          : adapter.check(),
      ),
    );
    if (invalidIrSources > 0) {
      const index = adapterChecks.findIndex((check) => check.connector === 'IR');
      const existing = index >= 0 ? adapterChecks[index] : undefined;
      const invalidMessage = `${invalidIrSources} active IR source(s) violate the registered HTTPS RSS/Atom and OFFICIAL_PUBLIC_DATA contract.`;
      const degraded = Object.freeze({
        connector: 'IR' as const,
        status: ConnectorStatus.DEGRADED,
        message: existing?.message ? `${existing.message} ${invalidMessage}` : invalidMessage,
        checkedAt: new Date(),
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        metadata: {
          ...(existing?.metadata ?? {}),
          invalidRegisteredSources: invalidIrSources,
        },
      });
      if (index >= 0) adapterChecks[index] = degraded;
      else adapterChecks.push(degraded);
    }
    const aiHealth = await this.classifier.probeHealth();
    const checks: OperationalConnectorHealthCheck[] = [
      await this.openDartHealth(),
      ...adapterChecks,
      await this.tossHealth(),
      Object.freeze({
        connector: 'AI',
        status: aiHealth.status,
        message: aiHealth.message,
        checkedAt: aiHealth.checkedAt,
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        metadata: {
          healthSource: 'OPENAI_COMPATIBLE_MODELS',
          enabled: aiHealth.enabled,
          configuredModelPresent: aiHealth.configuredModelPresent,
        },
      }),
    ];
    const repository = this.dataSource.getRepository(ConnectorHealthEntity);
    for (const check of checks) {
      const marketDataHealth = check.metadata?.healthSource === 'TOSS_INGESTION';
      const rssDiscoveryHealth = check.metadata?.healthSource === 'NEWS_RSS_INGESTION';
      const secDiscoveryHealth = check.metadata?.healthSource === 'SEC_INGESTION';
      // 시세 커넥터가 설정되어 있으면 마지막으로 저장된 토스 상태를 읽기만 합니다.
      // 여기서 이전 상태를 다시 저장하면 checkAll 실행 중에 커밋된 수집 결과를
      // 경합으로 덮어쓸 수 있습니다.
      if (marketDataHealth && check.metadata?.credentialsConfigured === true) continue;
      // RSS health comes from real collection. Do not add a probe request or overwrite a newer run.
      if (rssDiscoveryHealth && check.metadata?.configured === true) continue;
      if (
        secDiscoveryHealth &&
        check.metadata?.configured === true &&
        check.metadata?.ingestionStateAvailable === true
      )
        continue;
      const existing = await repository.findOne({
        where: { connector: check.connector.toLowerCase() },
      });
      const row = existing ?? repository.create({ connector: check.connector.toLowerCase() });
      row.status = check.status;
      row.message = check.message;
      row.checkedAt = check.checkedAt;
      row.metadataJson = {
        rightsMode: check.rightsMode,
        ...(check.metadata ?? {}),
      };
      const preserveMarketDataFreshness =
        marketDataHealth || rssDiscoveryHealth || secDiscoveryHealth;
      // A legacy SEC probe/empty-scope success is not evidence of an ingestion success.
      if (secDiscoveryHealth && check.metadata?.ingestionStateAvailable === false)
        row.lastSuccessAt = null;
      if (!preserveMarketDataFreshness && check.status === ConnectorStatus.HEALTHY) {
        row.lastSuccessAt = check.checkedAt;
      } else if (
        !preserveMarketDataFreshness &&
        (check.status === ConnectorStatus.DEGRADED || check.status === ConnectorStatus.FAILED)
      ) {
        row.lastFailureAt = check.checkedAt;
      }
      row.lastSuccessAt ??= null;
      row.lastFailureAt ??= null;
      await repository.save(row);
    }
    return Object.freeze(checks);
  }

  private async discoveryHealth(configured: ConnectorHealthCheck): Promise<ConnectorHealthCheck> {
    if (configured.status === ConnectorStatus.UNCONFIGURED) return configured;
    const existing = await this.dataSource
      .getRepository(ConnectorHealthEntity)
      .findOne({ where: { connector: configured.connector.toLowerCase() } });
    const isSec = configured.connector === 'SEC';
    const usable =
      existing &&
      existing.status !== ConnectorStatus.UNCONFIGURED &&
      (!isSec ||
        (existing.metadataJson?.healthSource === 'SEC_INGESTION' &&
          existing.metadataJson?.ingestionStateAvailable !== false));
    return Object.freeze({
      ...configured,
      status: usable ? existing.status : ConnectorStatus.DEGRADED,
      message: usable
        ? existing.message
        : `Configured; awaiting the first ${isSec ? 'SEC' : 'RSS'} discovery result.`,
      metadata: {
        ...existing?.metadataJson,
        ...configured.metadata,
        ...(isSec ? { ingestionStateAvailable: Boolean(usable) } : {}),
      },
    });
  }

  public async recordOpenDart(
    status: ConnectorStatus,
    message: string | null,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const repository = this.dataSource.getRepository(ConnectorHealthEntity);
    const now = new Date();
    const row =
      (await repository.findOne({ where: { connector: 'opendart' } })) ??
      repository.create({ connector: 'opendart' });
    row.status = status;
    row.message = message;
    row.checkedAt = now;
    row.metadataJson = {
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      ...metadata,
    };
    if (status === ConnectorStatus.HEALTHY) row.lastSuccessAt = now;
    if (status === ConnectorStatus.DEGRADED || status === ConnectorStatus.FAILED) {
      row.lastFailureAt = now;
    }
    row.lastSuccessAt ??= null;
    row.lastFailureAt ??= null;
    await repository.save(row);
  }

  private async tossHealth(): Promise<OperationalConnectorHealthCheck> {
    const configured =
      this.config.marketDataProvider === 'toss' &&
      Boolean(this.config.tossClientId && this.config.tossClientSecret);
    const existing = await this.dataSource
      .getRepository(ConnectorHealthEntity)
      .findOne({ where: { connector: 'toss' } });
    return {
      connector: 'TOSS',
      status: !configured
        ? ConnectorStatus.UNCONFIGURED
        : existing?.status && existing.status !== ConnectorStatus.UNCONFIGURED
          ? existing.status
          : ConnectorStatus.DEGRADED,
      message: !configured
        ? 'Toss is disabled or its credentials are missing.'
        : (existing?.message ??
          (existing?.lastSuccessAt
            ? null
            : 'Configured; awaiting the first successful Toss candle ingestion.')),
      checkedAt: new Date(),
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      metadata: {
        ...(existing?.metadataJson ?? {}),
        healthSource: 'TOSS_INGESTION',
        credentialsConfigured: configured,
      },
    };
  }

  public async pauseOpenDartUntil(
    until: Date,
    message = 'OpenDART daily request limit reached.',
  ): Promise<void> {
    const repository = this.dataSource.getRepository(SyncCheckpointEntity);
    const checkpoint =
      (await repository.findOne({
        where: { connector: 'OPENDART', stream: 'GLOBAL_RATE_LIMIT' },
      })) ??
      repository.create({
        connector: 'OPENDART',
        stream: 'GLOBAL_RATE_LIMIT',
        lastSuccessDate: null,
        cursor: null,
        lastSuccessAt: null,
      });
    checkpoint.metadataJson = {
      ...(checkpoint.metadataJson ?? {}),
      pausedUntil: until.toISOString(),
      pauseReason: 'OPENDART_STATUS_020',
    };
    await repository.save(checkpoint);
    await this.recordOpenDart(ConnectorStatus.DEGRADED, message, {
      pausedUntil: until.toISOString(),
      status: '020',
    });
    await this.materializeOpenDartLimitAlert(until, message);
  }

  public async openDartPausedUntil(now = new Date()): Promise<Date | null> {
    const pause = await this.dataSource.getRepository(SyncCheckpointEntity).findOne({
      where: { connector: 'OPENDART', stream: 'GLOBAL_RATE_LIMIT' },
    });
    const raw = pause?.metadataJson?.pausedUntil;
    if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) return null;
    const until = new Date(raw);
    return until.getTime() > now.getTime() ? until : null;
  }

  private async materializeOpenDartLimitAlert(until: Date, message: string): Promise<void> {
    const idempotencyKey = `connector:opendart:020:${until.toISOString()}:WEB:v1`;
    await this.dataSource.transaction(async (manager) => {
      const alerts = manager.getRepository(AlertEntity);
      if (await alerts.findOne({ where: { idempotencyKey } })) return;
      const payload = {
        phase: 'OPERATIONAL',
        connector: 'OPENDART',
        status: '020',
        pausedUntil: until.toISOString(),
        message,
      };
      const alert = await alerts.save({
        eventClusterId: null,
        idempotencyKey,
        status: AlertStatus.PENDING,
        alertVersion: 1,
        payloadJson: payload,
      });
      await manager.getRepository(AlertOutboxEntity).save({
        alertId: alert.id,
        channel: DeliveryChannel.WEB,
        idempotencyKey,
        status: AlertStatus.PENDING,
        payload,
        availableAt: new Date(),
        attempts: 0,
        lastError: null,
      });
    });
  }

  private async openDartHealth(): Promise<ConnectorHealthCheck> {
    const now = new Date();
    if (!this.config.openDartApiKey) {
      return Object.freeze({
        connector: 'OPENDART',
        status: ConnectorStatus.UNCONFIGURED,
        message: 'OPENDART_API_KEY missing',
        checkedAt: now,
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      });
    }
    const pausedUntil = await this.openDartPausedUntil(now);
    if (pausedUntil) {
      return Object.freeze({
        connector: 'OPENDART',
        status: ConnectorStatus.DEGRADED,
        message: `OpenDART request circuit is paused until ${pausedUntil.toISOString()}.`,
        checkedAt: now,
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        metadata: { pausedUntil: pausedUntil.toISOString() },
      });
    }
    const existing = await this.dataSource
      .getRepository(ConnectorHealthEntity)
      .findOne({ where: { connector: 'opendart' } });
    return Object.freeze({
      connector: 'OPENDART',
      status: existing?.lastSuccessAt ? ConnectorStatus.HEALTHY : ConnectorStatus.DEGRADED,
      message: existing?.lastSuccessAt
        ? null
        : 'Configured; awaiting the first successful OpenDART request.',
      checkedAt: now,
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    });
  }
}
