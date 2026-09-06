import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { WorkerJobName, WorkerQueueName, type BackfillRequest } from '@orsem/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export const MANUAL_ALPACA_ASSET_SYNC_JOB_ID = 'manual-alpaca-asset-master-sync';

@Injectable()
export class WorkerQueueService implements OnApplicationShutdown {
  private pollQueue: Queue | null = null;
  private marketDataQueue: Queue | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async requestGroupTossCandles(companyIds: readonly string[]): Promise<void> {
    if (this.config.fixtureMode || !this.config.tossClientId || !this.config.tossClientSecret)
      return;
    const ids = [...new Set(companyIds)];
    if (ids.length > 21) throw new Error('A visible group page cannot exceed 21 companies.');
    if (!ids.length) return;
    await this.marketDataWorkerQueue().addBulk(
      ids.map((companyId) => {
        const dedupeId = `toss-view-${companyId}-1d`;
        return {
          name: WorkerJobName.INGEST_TOSS_CANDLES,
          data: {
            companyIds: [companyId],
            interval: '1d',
            reason: 'VIEW',
            lookbackDays: 60,
            maxPages: 1,
          },
          opts: {
            jobId: dedupeId,
            deduplication: { id: dedupeId, ttl: 60_000 },
            attempts: 2,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: true,
            removeOnFail: true,
          },
        };
      }),
    );
  }

  async requestTossCandles(companyId: string, interval: '1d' | '1m'): Promise<void> {
    if (this.config.fixtureMode || !this.config.tossClientId || !this.config.tossClientSecret)
      return;
    const dedupeId = `toss-view-${companyId}-${interval}`;
    await this.marketDataWorkerQueue().add(
      WorkerJobName.INGEST_TOSS_CANDLES,
      {
        companyIds: [companyId],
        interval,
        reason: 'VIEW',
        lookbackDays: interval === '1d' ? 366 : 7,
      },
      {
        // 화면의 2초 조회 간격보다 오래 걸려도 대기 또는 실행 중인
        // 갱신 작업은 최대 하나만 유지합니다.
        jobId: dedupeId,
        deduplication: { id: dedupeId, ttl: 2_000 },
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async enqueueBackfill(input: BackfillRequest): Promise<{
    queued: number;
    jobIds: string[];
    suppressAlerts: true;
  }> {
    const windows = splitDateWindows(input.startDate, input.endDate, 90);
    const jobs = input.detailTypes.flatMap((detailType) =>
      windows.map((window) => ({
        name: WorkerJobName.BACKFILL_OPENDART,
        data: {
          detailType,
          startDate: window.start,
          endDate: window.end,
          suppressAlerts: true,
          reason: 'BACKFILL' as const,
        },
        opts: {
          jobId: `backfill-${detailType}-${window.start}-${window.end}`,
          attempts: 3,
          backoff: { type: 'exponential' as const, delay: 60_000 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      })),
    );
    if (!this.config.fixtureMode) {
      if (!this.config.opendartApiKey) {
        throw new ServiceUnavailableException('OPENDART_API_KEY가 없어 백필을 시작할 수 없습니다.');
      }
      const queue = this.workerQueue();
      try {
        await queue.addBulk(jobs);
      } catch {
        throw new ServiceUnavailableException(
          'worker 큐에 연결할 수 없습니다. 운영 상태와 Redis 연결을 확인하세요.',
        );
      }
    }
    return {
      queued: jobs.length,
      jobIds: jobs.map((job) => job.opts.jobId),
      suppressAlerts: true,
    };
  }

  async enqueueAlpacaAssetSync(): Promise<{
    queued: 1;
    jobId: string;
    deduplicated: true;
  }> {
    if (!this.config.alpacaApiKey || !this.config.alpacaApiSecret) {
      throw new ServiceUnavailableException(
        'Alpaca 자격 증명이 없어 자산 마스터 동기화를 시작할 수 없습니다.',
      );
    }
    if (!this.config.fixtureMode) {
      try {
        await this.marketDataWorkerQueue().add(
          WorkerJobName.SYNC_ALPACA_ASSETS,
          { reason: 'MANUAL' },
          {
            // 고정 ID로 동시에 들어온 관리자 요청을 하나로 합칩니다.
            // 성공이나 최종 실패 시 행을 제거해 나중에 수동 동기화를
            // 다시 요청할 수 있도록 합니다.
            jobId: MANUAL_ALPACA_ASSET_SYNC_JOB_ID,
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      } catch {
        throw new ServiceUnavailableException(
          'worker 큐에 연결할 수 없습니다. 운영 상태와 Redis 연결을 확인하세요.',
        );
      }
    }
    return {
      queued: 1,
      jobId: MANUAL_ALPACA_ASSET_SYNC_JOB_ID,
      deduplicated: true,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [this.pollQueue, this.marketDataQueue]
        .filter((queue): queue is Queue => queue !== null)
        .map((queue) => queue.close()),
    );
  }

  private workerQueue(): Queue {
    if (!this.pollQueue) {
      this.pollQueue = this.createQueue(WorkerQueueName.POLL);
    }
    return this.pollQueue;
  }

  private marketDataWorkerQueue(): Queue {
    if (!this.marketDataQueue) {
      this.marketDataQueue = this.createQueue(WorkerQueueName.MARKET_DATA);
    }
    return this.marketDataQueue;
  }

  private createQueue(name: WorkerQueueName): Queue {
    if (!this.config.redisUrl) {
      throw new ServiceUnavailableException(
        'REDIS_URL가 설정되지 않아 worker 큐를 사용할 수 없습니다.',
      );
    }
    return new Queue(name, {
      connection: redisConnection(this.config.redisUrl),
      prefix: this.config.redisPrefix,
    });
  }
}

function redisConnection(value: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls?: Record<string, never>;
  connectTimeout: number;
  maxRetriesPerRequest: number;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceUnavailableException('REDIS_URL 형식이 올바르지 않습니다.');
  }
  if ((url.protocol !== 'redis:' && url.protocol !== 'rediss:') || !url.hostname) {
    throw new ServiceUnavailableException('REDIS_URL은 redis:// 또는 rediss:// 형식이어야 합니다.');
  }
  const port = url.port ? Number(url.port) : 6379;
  const dbText = url.pathname.replace(/^\//u, '');
  const db = dbText ? Number(dbText) : 0;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !Number.isInteger(db) || db < 0) {
    throw new ServiceUnavailableException('REDIS_URL의 포트 또는 DB 번호가 올바르지 않습니다.');
  }
  return {
    host: url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    connectTimeout: 1_500,
    maxRetriesPerRequest: 1,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

function splitDateWindows(
  startDate: string,
  endDate: string,
  maximumDays: number,
): Array<{ start: string; end: string }> {
  const windows: Array<{ start: string; end: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const maximumEnd = addUtcDays(cursor, maximumDays - 1);
    const end = maximumEnd < endDate ? maximumEnd : endDate;
    windows.push({ start: cursor, end });
    cursor = addUtcDays(end, 1);
  }
  return windows;
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
