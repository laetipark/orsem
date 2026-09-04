import { Injectable } from '@nestjs/common';
import { AlertStatus } from '@orsem/contracts';
import { PushDeliveryEntity, PushSubscriptionEntity } from '@orsem/database';
import { DataSource, In, LessThan, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { PushFanoutService } from './push-fanout.service';
import { PUSH_MAX_AGE_MS, pushMessageIsSafe } from './push-policy';
import { PushRequestError, WebPushClient } from './web-push.client';

export const PUSH_MAX_ATTEMPTS = 6;
export const PUSH_LEASE_MS = 10 * 60_000;
const BATCH_SIZE = 20;

export function pushRetryAt(error: PushRequestError, attempts: number, now: Date): Date {
  const header = error.retryAfter;
  const retry =
    header && /^\d+(?:\.\d+)?$/u.test(header)
      ? now.getTime() + Number(header) * 1000
      : header
        ? Date.parse(header)
        : Number.NaN;
  const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(
    Number.isFinite(retry)
      ? Math.min(now.getTime() + PUSH_MAX_AGE_MS, Math.max(now.getTime() + 1000, retry))
      : now.getTime() + delay,
  );
}

@Injectable()
export class PushDeliveryService {
  constructor(
    private readonly db: DataSource,
    private readonly recipients: PushFanoutService,
    private readonly client: WebPushClient,
  ) {}

  async dispatch(): Promise<{ configured: boolean; claimed: number; sent: number }> {
    if (!this.client.enabled) return { configured: false, claimed: 0, sent: 0 };
    const now = new Date();
    const repo = this.db.getRepository(PushDeliveryEntity);
    await repo.update(
      {
        status: AlertStatus.SENDING,
        leaseUntil: LessThanOrEqual(now),
        attempts: MoreThanOrEqual(PUSH_MAX_ATTEMPTS),
      },
      {
        status: AlertStatus.FAILED,
        leaseUntil: null,
        lastError: 'Web Push retry limit reached after an expired lease.',
      },
    );
    await repo.update(
      {
        status: AlertStatus.SENDING,
        leaseUntil: LessThanOrEqual(now),
        attempts: LessThan(PUSH_MAX_ATTEMPTS),
      },
      {
        status: AlertStatus.PENDING,
        leaseUntil: null,
        lastError: 'Recovered expired Web Push lease.',
      },
    );
    const claimed = await this.db.transaction(async (manager) => {
      const deliveries = manager.getRepository(PushDeliveryEntity);
      const rows = await deliveries
        .createQueryBuilder('push')
        .where('push.status = :status', { status: AlertStatus.PENDING })
        .andWhere('push.availableAt <= :now', { now })
        .andWhere('push.attempts < :maxAttempts', { maxAttempts: PUSH_MAX_ATTEMPTS })
        .orderBy('push.availableAt', 'ASC')
        .addOrderBy('push.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(BATCH_SIZE)
        .getMany();
      for (const row of rows) {
        row.status = AlertStatus.SENDING;
        row.leaseUntil = new Date(now.getTime() + PUSH_LEASE_MS);
        row.attempts += 1;
      }
      if (rows.length) await deliveries.save(rows);
      return rows;
    });
    let sent = 0;
    for (const row of claimed) if (await this.sendClaimed(row)) sent += 1;
    return { configured: true, claimed: claimed.length, sent };
  }

  async sendClaimed(row: PushDeliveryEntity): Promise<boolean> {
    const repo = this.db.getRepository(PushDeliveryEntity);
    if (row.status !== AlertStatus.SENDING || !row.leaseUntil) return false;
    const claim = {
      id: row.id,
      status: AlertStatus.SENDING,
      attempts: row.attempts,
      leaseUntil: row.leaseUntil,
    };
    let subscription: PushSubscriptionEntity | null = null;
    try {
      const now = new Date();
      if (row.leaseUntil <= now) return false;
      subscription = await this.recipients.resolveDelivery(this.db.manager, row, now);
      if (!subscription || !pushMessageIsSafe(row.payloadJson)) {
        await repo.update(claim, {
          status: AlertStatus.CANCELLED,
          leaseUntil: null,
          lastError: 'Web Push recipient, preference, or event is no longer eligible.',
        });
        return false;
      }
      // Recheck ownership after authorization queries: disabling notifications or
      // approving a correction can cancel a claimed row while validation runs.
      if (!(await repo.findOneBy(claim))) return false;
      const ttl =
        row.topic === 'TEST'
          ? 300
          : Math.max(0, (row.createdAt.getTime() + PUSH_MAX_AGE_MS - now.getTime()) / 1000);
      // Network I/O stays outside the claim transaction. A crash after provider
      // acceptance can be retried; the stable notification tag collapses duplicates.
      await this.client.send(subscription, row.payloadJson, ttl);
      const result = await repo.update(claim, {
        status: AlertStatus.SENT,
        sentAt: new Date(),
        leaseUntil: null,
        lastError: null,
      });
      return (result.affected ?? 0) > 0;
    } catch (error) {
      const failure = error instanceof PushRequestError ? error : new PushRequestError(null, null);
      const expired = failure.statusCode === 404 || failure.statusCode === 410;
      const terminal =
        expired ||
        row.attempts >= PUSH_MAX_ATTEMPTS ||
        (failure.statusCode !== null &&
          failure.statusCode < 500 &&
          failure.statusCode !== 408 &&
          failure.statusCode !== 429);
      await this.db.transaction(async (manager) => {
        const deliveries = manager.getRepository(PushDeliveryEntity);
        const result = await deliveries.update(claim, {
          status: terminal ? AlertStatus.FAILED : AlertStatus.PENDING,
          leaseUntil: null,
          availableAt: terminal ? new Date() : pushRetryAt(failure, row.attempts, new Date()),
          lastError: failure.message,
        });
        if (expired && subscription && result.affected) {
          const removed = await manager.getRepository(PushSubscriptionEntity).delete({
            id: subscription.id,
            ownerKey: subscription.ownerKey,
            updatedAt: subscription.updatedAt,
          });
          if (removed.affected)
            await deliveries.update(
              {
                subscriptionId: subscription.id,
                status: In([AlertStatus.PENDING, AlertStatus.SENDING]),
              },
              {
                status: AlertStatus.CANCELLED,
                leaseUntil: null,
                lastError: 'Web Push subscription expired.',
              },
            );
        }
      });
      return false;
    }
  }
}
