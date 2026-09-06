import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AlertStatus, DeliveryChannel, WatchPriority } from '@orsem/contracts';
import {
  AlertDeliveryEntity,
  AlertEntity,
  AlertOutboxEntity,
  BotDeliveryEntity,
  BotRoomBindingEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  FILING_ALERT_INELIGIBLE,
  filingAlertIsEligible,
  MarketLeaderScopeEntity,
} from '@orsem/database';
import { DataSource, IsNull, LessThanOrEqual, type EntityManager } from 'typeorm';
import { PushFanoutService } from '../push/push-fanout.service';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 10;
const LEASE_MS = 10 * 60_000;

export function allowsExternalRealtime(
  input: Readonly<{
    operational: boolean;
    priority: string | null;
    realtimeAlerts: boolean;
  }>,
): boolean {
  return (
    input.operational ||
    (input.realtimeAlerts &&
      (input.priority === WatchPriority.P1 || input.priority === WatchPriority.P2))
  );
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown alert outbox error').slice(0, 4000);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function deliveryPayload(
  alert: AlertEntity,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const phase = stringValue(payload['phase']);
  const stage = phase === 'PARSED' ? 'ENRICHED' : 'DETECTED';
  const headline =
    stringValue(payload['summary']) ??
    [stringValue(payload['companyName']), stringValue(payload['reportName'])]
      .filter((value): value is string => Boolean(value))
      .join(' — ');
  const content = [headline, stringValue(payload['message']), stringValue(payload['officialUrl'])]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .slice(0, 1_900);
  return {
    alertId: alert.id,
    operation: phase === 'PARSED' ? 'FOLLOW_UP' : 'SEND',
    stage,
    content: content || '오르셈 새 관찰 이벤트',
    externalMessageId: null,
  };
}

@Injectable()
export class AlertOutboxDispatcherService {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly pushFanout: PushFanoutService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  public async dispatch(): Promise<{ claimed: number; dispatched: number }> {
    const repository = this.dataSource.getRepository(AlertOutboxEntity);
    const now = new Date();
    await repository.update(
      {
        status: AlertStatus.SENDING,
        availableAt: LessThanOrEqual(now),
      },
      {
        status: AlertStatus.PENDING,
        lastError: 'Recovered expired alert outbox lease.',
      },
    );

    const claimed = await this.dataSource.transaction(async (manager) => {
      const rows = await manager
        .getRepository(AlertOutboxEntity)
        .createQueryBuilder('outbox')
        .where('outbox.status = :status', { status: AlertStatus.PENDING })
        .andWhere('outbox.availableAt <= :now', { now })
        .orderBy('outbox.availableAt', 'ASC')
        .addOrderBy('outbox.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(BATCH_SIZE)
        .getMany();
      for (const row of rows) {
        row.status = AlertStatus.SENDING;
        row.availableAt = new Date(now.getTime() + LEASE_MS);
        row.attempts += 1;
      }
      if (rows.length > 0) {
        await manager.getRepository(AlertOutboxEntity).save(rows);
      }
      return rows;
    });

    let dispatched = 0;
    for (const claimedRow of claimed) {
      try {
        await this.materialize(claimedRow.id);
        dispatched += 1;
      } catch (error) {
        const retryStatus =
          claimedRow.attempts >= MAX_ATTEMPTS ? AlertStatus.FAILED : AlertStatus.PENDING;
        await repository.update(
          { id: claimedRow.id, status: AlertStatus.SENDING },
          {
            status: retryStatus,
            availableAt: new Date(
              Date.now() + Math.min(60 * 60_000, 2 ** claimedRow.attempts * 1_000),
            ),
            lastError: messageOf(error),
          },
        );
      }
    }
    return { claimed: claimed.length, dispatched };
  }

  private async materialize(outboxId: string): Promise<void> {
    const snapshot = await this.dataSource
      .getRepository(AlertOutboxEntity)
      .findOne({ where: { id: outboxId } });
    if (!snapshot || snapshot.status !== AlertStatus.SENDING) return;
    await this.dataSource.transaction(async (manager) => {
      // 정정 승인과 동일하게 Alert -> AlertOutbox 순서로 잠급니다.
      // 알림 분배와 정정 사이의 교착으로 재시도가 발생해 취소된 outbox가
      // 되살아나는 것을 방지합니다.
      const alert = await manager
        .getRepository(AlertEntity)
        .createQueryBuilder('alert')
        .setLock('pessimistic_write')
        .where('alert.id = :alertId', { alertId: snapshot.alertId })
        .getOne();
      const outbox = await manager
        .getRepository(AlertOutboxEntity)
        .createQueryBuilder('outbox')
        .setLock('pessimistic_write')
        .where('outbox.id = :outboxId', { outboxId })
        .getOne();
      if (!outbox || outbox.status !== AlertStatus.SENDING) return;
      if (!alert) throw new Error('Alert outbox references a missing alert.');
      if (outbox.alertId !== alert.id) {
        throw new Error('Alert outbox target changed during fan-out.');
      }
      if (alert.status === AlertStatus.CANCELLED) {
        outbox.status = AlertStatus.CANCELLED;
        outbox.lastError = 'Alert was cancelled before fan-out.';
        await manager.getRepository(AlertOutboxEntity).save(outbox);
        return;
      }
      if (!(await filingAlertIsEligible(manager, alert))) {
        outbox.status = AlertStatus.CANCELLED;
        outbox.lastError = FILING_ALERT_INELIGIBLE;
        alert.status = AlertStatus.CANCELLED;
        await manager.getRepository(AlertOutboxEntity).save(outbox);
        await manager.getRepository(AlertEntity).save(alert);
        return;
      }

      if (
        !(await manager.getRepository(AlertDeliveryEntity).findOne({
          where: {
            alertId: alert.id,
            channel: DeliveryChannel.WEB,
            destinationHash: IsNull(),
          },
        }))
      ) {
        await manager.getRepository(AlertDeliveryEntity).save({
          alertId: alert.id,
          channel: DeliveryChannel.WEB,
          destinationHash: null,
          status: AlertStatus.SENT,
          externalMessageId: null,
          sentAt: new Date(),
          acknowledgedAt: null,
          errorMessage: null,
        });
      }

      await this.pushFanout.enqueueAlert(manager, alert);
      const payload = deliveryPayload(alert, outbox.payload);
      const externalFanOutAllowed = await this.externalFanOutAllowed(manager, alert);
      if (
        externalFanOutAllowed &&
        (outbox.channel === DeliveryChannel.WEB || outbox.channel === DeliveryChannel.DISCORD)
      ) {
        await this.ensureBotDelivery(
          manager,
          'DISCORD',
          null,
          alert.id,
          `${outbox.idempotencyKey}:discord`,
          payload,
        );
      }
      if (
        externalFanOutAllowed &&
        (outbox.channel === DeliveryChannel.WEB || outbox.channel === DeliveryChannel.MESSENGERBOTR)
      ) {
        const bindings = await manager.getRepository(BotRoomBindingEntity).find({
          where: { consumer: 'MESSENGERBOTR', isActive: true },
        });
        const deviceIds = new Set(
          bindings
            .map((binding) => binding.deviceId)
            .filter((deviceId): deviceId is string => Boolean(deviceId)),
        );
        for (const deviceId of deviceIds) {
          await this.ensureBotDelivery(
            manager,
            'MESSENGERBOTR',
            deviceId,
            alert.id,
            `${outbox.idempotencyKey}:messenger:${deviceId}`,
            payload,
          );
        }
      }

      outbox.status = AlertStatus.SENT;
      outbox.lastError = null;
      alert.status = AlertStatus.SENT;
      await manager.getRepository(AlertOutboxEntity).save(outbox);
      await manager.getRepository(AlertEntity).save(alert);
    });
  }

  private async externalFanOutAllowed(
    manager: EntityManager,
    alert: AlertEntity,
  ): Promise<boolean> {
    // 운영 알림에는 이벤트 묶음이 없지만 운영자에게 전달되어야 합니다.
    // 외부 수신 대상을 명시한 outbox를 포함한 모든 기업 이벤트에는 동일한
    // P1/P2 실시간 알림 수신 동의 조건을 적용합니다. 시장 전체 데이터는
    // DB와 웹에서 계속 조회할 수 있습니다.
    if (alert.eventClusterId === null) {
      return allowsExternalRealtime({
        operational: true,
        priority: null,
        realtimeAlerts: false,
      });
    }
    const event = await manager.getRepository(EventClusterEntity).findOne({
      where: { id: alert.eventClusterId },
    });
    if (!event?.companyId) return false;
    const memberships = await manager.getRepository(EventClusterItemEntity).find({
      where: { eventClusterId: event.id, itemType: 'FILING' },
      order: { isPrimary: 'DESC' },
    });
    if (memberships.length > 0) {
      const filingId = stringValue(alert.payloadJson['filingId']);
      const rceptNo = stringValue(alert.payloadJson['rceptNo']);
      const repository = manager.getRepository(FilingEntity);
      const filing = filingId
        ? await repository.findOneBy({ id: filingId })
        : rceptNo
          ? await repository.findOneBy({ rceptNo })
          : await repository.findOneBy({ id: memberships[0]!.itemId });
      if (!filing) return false;
      if (
        filing.source === 'OPENDART' &&
        !this.config.openDartGlobalAlertTypes.some((type) => type === filing.canonicalType)
      ) {
        return false;
      }
    }
    const watch = await manager.getRepository(MarketLeaderScopeEntity).findOne({
      where: { companyId: event.companyId },
    });
    return allowsExternalRealtime({
      operational: false,
      priority: watch?.priority ?? null,
      realtimeAlerts: watch?.realtimeAlerts ?? false,
    });
  }

  private async ensureBotDelivery(
    manager: EntityManager,
    consumer: 'DISCORD' | 'MESSENGERBOTR',
    deviceId: string | null,
    alertId: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const channel =
      consumer === 'DISCORD' ? DeliveryChannel.DISCORD : DeliveryChannel.MESSENGERBOTR;
    const destinationHash = deviceId ? createHash('sha256').update(deviceId).digest('hex') : null;
    const deliveryRepository = manager.getRepository(AlertDeliveryEntity);
    let alertDelivery = await deliveryRepository.findOne({
      where: {
        alertId,
        channel,
        destinationHash: destinationHash === null ? IsNull() : destinationHash,
      },
    });
    if (!alertDelivery) {
      alertDelivery = await deliveryRepository.save({
        alertId,
        channel,
        destinationHash,
        status: AlertStatus.PENDING,
        externalMessageId: null,
        sentAt: null,
        acknowledgedAt: null,
        errorMessage: null,
      });
    }
    const repository = manager.getRepository(BotDeliveryEntity);
    const existing = await repository.findOne({ where: { consumer, dedupeKey } });
    if (existing) {
      if (existing.alertDeliveryId !== alertDelivery.id) {
        existing.alertId = alertId;
        existing.alertDeliveryId = alertDelivery.id;
        await repository.save(existing);
      }
      return;
    }
    await repository.save({
      consumer,
      deviceId,
      alertId,
      alertDeliveryId: alertDelivery.id,
      dedupeKey,
      status: AlertStatus.PENDING,
      payload,
      availableAt: new Date(),
      leaseUntil: null,
      externalMessageId: null,
      acknowledgedAt: null,
      attempts: 0,
      lastError: null,
    });
  }
}
