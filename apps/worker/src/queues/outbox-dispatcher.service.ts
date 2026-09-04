import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ProcessingStatus } from '@orsem/contracts';
import { FilingEntity, ProcessingOutboxEntity } from '@orsem/database';
import { Queue } from 'bullmq';
import { DataSource, LessThan } from 'typeorm';
import {
  applyParseProjectionJobSchema,
  discoverLinksJobSchema,
  enrichFilingJobSchema,
  reviewParseWithAiJobSchema,
  type EnrichFilingJob,
} from './job-data';
import { JobName, QueueName } from './queue.constants';
import { AlertOutboxDispatcherService } from './alert-outbox-dispatcher.service';
import { PushDeliveryService } from '../push/push-delivery.service';

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 10;

function queueJobId(dedupeKey: string): string {
  return createHash('sha256').update(dedupeKey).digest('hex');
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown outbox error').slice(0, 4000);
}

@Injectable()
export class OutboxDispatcherService {
  public constructor(
    private readonly dataSource: DataSource,
    @InjectQueue(QueueName.FILING) private readonly filingQueue: Queue,
    @InjectQueue(QueueName.AI_REVIEW) private readonly aiReviewQueue: Queue,
    @InjectQueue(QueueName.CONNECTOR_HEALTH)
    private readonly connectorQueue: Queue,
    private readonly alertDispatcher: AlertOutboxDispatcherService,
    private readonly pushDispatcher: PushDeliveryService,
  ) {}

  public async dispatch(): Promise<{
    processing: { claimed: number; dispatched: number };
    alerts: { claimed: number; dispatched: number };
    push: { configured: boolean; claimed: number; sent: number };
  }> {
    const repository = this.dataSource.getRepository(ProcessingOutboxEntity);
    await repository.update(
      {
        status: ProcessingStatus.PROCESSING,
        lockedAt: LessThan(new Date(Date.now() - 10 * 60_000)),
      },
      {
        status: ProcessingStatus.PENDING,
        lockedAt: null,
        lastError: 'Recovered stale outbox lease.',
      },
    );

    const claimed = await this.dataSource.transaction(async (manager) => {
      const rows = await manager
        .getRepository(ProcessingOutboxEntity)
        .createQueryBuilder('outbox')
        .where('outbox.status = :status', { status: ProcessingStatus.PENDING })
        .andWhere('outbox.available_at <= :now', { now: new Date() })
        .orderBy('outbox.available_at', 'ASC')
        .addOrderBy('outbox.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(BATCH_SIZE)
        .getMany();
      const lockedAt = new Date();
      for (const row of rows) {
        row.status = ProcessingStatus.PROCESSING;
        row.lockedAt = lockedAt;
        row.attempts += 1;
      }
      await manager.getRepository(ProcessingOutboxEntity).save(rows);
      return rows;
    });

    let dispatched = 0;
    for (const row of claimed) {
      try {
        const resolved =
          row.kind === 'ENRICH_FILING'
            ? {
                queue: this.filingQueue,
                name: JobName.ENRICH_FILING,
                payload: await this.resolveEnrichPayload(row.payloadJson),
              }
            : row.kind === 'REVIEW_PARSE_WITH_AI'
              ? {
                  queue: this.aiReviewQueue,
                  name: JobName.REVIEW_PARSE_WITH_AI,
                  payload: reviewParseWithAiJobSchema.parse(row.payloadJson),
                }
              : row.kind === 'APPLY_PARSE_PROJECTION'
                ? {
                    queue: this.filingQueue,
                    name: JobName.APPLY_PARSE_PROJECTION,
                    payload: applyParseProjectionJobSchema.parse(row.payloadJson),
                  }
                : row.kind === 'DISCOVER_NEWS_LINKS'
                  ? {
                      queue: this.connectorQueue,
                      name: JobName.DISCOVER_LINKS,
                      payload: discoverLinksJobSchema.parse(row.payloadJson),
                    }
                  : null;
        if (!resolved) {
          throw new Error(`Unsupported processing outbox kind: ${row.kind}`);
        }
        await resolved.queue.add(resolved.name, resolved.payload, {
          // 완료된 BullMQ 작업은 보존 기간 동안 ID를 유지합니다. 저장된 outbox의
          // 세대 번호를 포함해 재활성화한 교차 검증 행이 이전 완료 작업에 연결되지 않고
          // 다시 실행되도록 합니다.
          jobId: queueJobId(`${row.dedupeKey}:${row.attempts}`),
          // 설정 가능한 최대 AI 임대 시간은 8회 지수 백오프 재시도 기간보다 깁니다.
          // AI 재시도를 한 번 추가하면 추론 도중 워커가 종료되어도 임대 만료 후
          // 작업이 다시 전달됩니다.
          attempts: resolved.name === JobName.REVIEW_PARSE_WITH_AI ? 9 : 8,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 1_000 },
        });
        await repository.update(
          { id: row.id, status: ProcessingStatus.PROCESSING },
          {
            status: ProcessingStatus.COMPLETED,
            lockedAt: null,
            lastError: null,
          },
        );
        dispatched += 1;
      } catch (error) {
        const retryStatus =
          row.attempts >= MAX_ATTEMPTS ? ProcessingStatus.FAILED : ProcessingStatus.PENDING;
        await repository.update(
          { id: row.id, status: ProcessingStatus.PROCESSING },
          {
            status: retryStatus,
            availableAt: new Date(Date.now() + Math.min(60 * 60_000, 2 ** row.attempts * 1_000)),
            lockedAt: null,
            lastError: messageOf(error),
          },
        );
      }
    }
    const alerts = await this.alertDispatcher.dispatch();
    const push = await this.pushDispatcher.dispatch();
    return {
      processing: { claimed: claimed.length, dispatched },
      alerts,
      push,
    };
  }

  private async resolveEnrichPayload(raw: Record<string, unknown>): Promise<EnrichFilingJob> {
    const filingId = typeof raw.filingId === 'string' ? raw.filingId : '';
    const filing = await this.dataSource
      .getRepository(FilingEntity)
      .findOne({ where: { id: filingId } });
    if (!filing) throw new Error('Outbox filing no longer exists.');
    return enrichFilingJobSchema.parse({
      filingId: filing.id,
      rceptNo: filing.rceptNo,
      detailType: filing.detailType,
      suppressAlerts: raw.suppressAlerts ?? false,
    });
  }
}
