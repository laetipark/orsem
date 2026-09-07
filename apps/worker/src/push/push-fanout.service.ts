import { Injectable } from '@nestjs/common';
import { AlertStatus, RightsMode } from '@orsem/contracts';
import {
  AdminEntity,
  AlertEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  filingAlertIsEligible,
  MemberEntity,
  NewsItemEntity,
  NotificationPreferenceEntity,
  PushDeliveryEntity,
  PushSubscriptionEntity,
  SourceItemEntity,
  MarketLeaderScopeEntity,
} from '@orsem/database';
import type { EntityManager } from 'typeorm';
import {
  alertPushMessage,
  isRecentPushEvent,
  newsPushMessage,
  pushPreferenceAllows,
  pushTopicForAlert,
  type PushMessage,
  type PushTopic,
} from './push-policy';

@Injectable()
export class PushFanoutService {
  async enqueueAlert(
    manager: EntityManager,
    alert: AlertEntity,
    now = new Date(),
  ): Promise<number> {
    const context = await this.alertContext(manager, alert);
    if (!context.topic || !isRecentPushEvent(alert.createdAt, now)) return 0;
    return this.enqueue(
      manager,
      context.topic,
      context.companyId,
      alert.createdAt,
      {
        alertId: alert.id,
        eventClusterId: alert.eventClusterId,
        key: `alert:${alert.id}`,
        payload: alertPushMessage(alert, context.topic),
      },
      now,
      context.filingType,
    );
  }

  async enqueueNews(
    manager: EntityManager,
    news: NewsItemEntity,
    source: SourceItemEntity,
    now = new Date(),
  ): Promise<number> {
    if (!this.newsIsEligible(news, source, now)) return 0;
    return this.enqueue(
      manager,
      'NEWS',
      news.companyId,
      new Date(Math.min(source.firstObservedAt.getTime(), news.publishedAt!.getTime())),
      {
        alertId: null,
        eventClusterId: null,
        key: `news:${news.id}`,
        payload: newsPushMessage(news.id, news.title),
      },
      now,
    );
  }

  private async enqueue(
    manager: EntityManager,
    topic: PushTopic,
    companyId: string | null,
    eventAt: Date,
    event: {
      alertId: string | null;
      eventClusterId: string | null;
      key: string;
      payload: PushMessage;
    },
    now: Date,
    filingType: string | null = null,
  ): Promise<number> {
    const preferences = await manager
      .getRepository(NotificationPreferenceEntity)
      .find({ where: { enabled: true } });
    let created = 0;
    for (const preference of preferences) {
      if (!preference.topicsJson.includes(topic as never)) continue;
      const subscriptions = await manager
        .getRepository(PushSubscriptionEntity)
        .find({ where: { ownerKey: preference.ownerKey } });
      for (const subscription of subscriptions) {
        if (
          !(await this.canReceive(
            manager,
            subscription,
            preference,
            topic,
            companyId,
            eventAt,
            now,
            filingType,
          ))
        )
          continue;
        const dedupeKey = `${subscription.id}:${event.key}`;
        const deliveries = manager.getRepository(PushDeliveryEntity);
        if (await deliveries.findOneBy({ dedupeKey })) continue;
        // The alert/source transaction makes this fan-out durable. A unique key also
        // prevents repeated outbox channels from creating duplicate device messages.
        await deliveries.save(
          deliveries.create({
            subscriptionId: subscription.id,
            ownerKey: preference.ownerKey,
            dedupeKey,
            alertId: event.alertId,
            eventClusterId: event.eventClusterId,
            topic,
            payloadJson: { ...event.payload },
            status: AlertStatus.PENDING,
            availableAt: now,
            leaseUntil: null,
            attempts: 0,
            lastError: null,
            sentAt: null,
          }),
        );
        created += 1;
      }
    }
    return created;
  }

  async resolveDelivery(
    manager: EntityManager,
    delivery: PushDeliveryEntity,
    now: Date,
  ): Promise<PushSubscriptionEntity | null> {
    const subscription = await manager
      .getRepository(PushSubscriptionEntity)
      .findOneBy({ id: delivery.subscriptionId, ownerKey: delivery.ownerKey });
    const preference = await manager
      .getRepository(NotificationPreferenceEntity)
      .findOneBy({ ownerKey: delivery.ownerKey });
    if (!subscription || !preference || !isRecentPushEvent(delivery.createdAt, now)) return null;
    let companyId: string | null = null;
    let filingType: string | null = null;
    let eventAt = delivery.createdAt;
    if (delivery.topic === 'TEST') {
      if (delivery.alertId !== null || delivery.eventClusterId !== null) return null;
    } else if (delivery.alertId) {
      const alert = await manager.getRepository(AlertEntity).findOneBy({ id: delivery.alertId });
      if (!alert || alert.eventClusterId !== delivery.eventClusterId) return null;
      const context = await this.alertContext(manager, alert);
      if (context.topic !== delivery.topic) return null;
      companyId = context.companyId;
      filingType = context.filingType;
      eventAt = alert.createdAt;
    } else if (delivery.topic === 'NEWS' && !delivery.eventClusterId) {
      const prefix = `${subscription.id}:news:`;
      if (!delivery.dedupeKey.startsWith(prefix)) return null;
      const id = delivery.dedupeKey.slice(prefix.length);
      if (!/^[a-f0-9-]{36}$/u.test(id)) return null;
      const news = await manager.getRepository(NewsItemEntity).findOneBy({ id });
      if (!news) return null;
      const source = await manager
        .getRepository(SourceItemEntity)
        .findOneBy({ id: news.sourceItemId });
      if (!source || !this.newsIsEligible(news, source, now)) return null;
      companyId = news.companyId;
      eventAt = new Date(Math.min(source.firstObservedAt.getTime(), news.publishedAt!.getTime()));
    } else return null;
    return (await this.canReceive(
      manager,
      subscription,
      preference,
      delivery.topic,
      companyId,
      eventAt,
      now,
      filingType,
    ))
      ? subscription
      : null;
  }

  private newsIsEligible(news: NewsItemEntity, source: SourceItemEntity, now: Date): boolean {
    return (
      source.id === news.sourceItemId &&
      !['NAVER', 'NEWS_RSS', 'IR', 'GDELT', 'MARKETAUX', 'ALPHAVANTAGE', 'FINNHUB'].includes(
        source.source,
      ) &&
      source.sourcePolicyJson?.policyVersion !== 2 &&
      source.sourcePolicyJson?.notifyAllowed !== false &&
      source.rightsMode !== RightsMode.NO_REDISTRIBUTION &&
      source.rightsMode !== RightsMode.PRIVATE_DISPLAY_ONLY &&
      isRecentPushEvent(source.firstObservedAt, now) &&
      news.publishedAt !== null &&
      isRecentPushEvent(news.publishedAt, now)
    );
  }

  private async alertContext(
    manager: EntityManager,
    alert: AlertEntity,
  ): Promise<{ topic: PushTopic | null; companyId: string | null; filingType: string | null }> {
    if (!(await filingAlertIsEligible(manager, alert)))
      return { topic: null, companyId: null, filingType: null };
    const event = alert.eventClusterId
      ? await manager.getRepository(EventClusterEntity).findOneBy({ id: alert.eventClusterId })
      : null;
    let submissionKind: string | null = null;
    let filingType: string | null = null;
    if (event) {
      const memberships = await manager.getRepository(EventClusterItemEntity).find({
        where: { eventClusterId: event.id, itemType: 'FILING' },
        order: { isPrimary: 'DESC' },
      });
      const filingId =
        typeof alert.payloadJson['filingId'] === 'string' && alert.payloadJson['filingId'].trim()
          ? alert.payloadJson['filingId'].trim()
          : null;
      const rceptNo =
        typeof alert.payloadJson['rceptNo'] === 'string' && alert.payloadJson['rceptNo'].trim()
          ? alert.payloadJson['rceptNo'].trim()
          : null;
      const repository = manager.getRepository(FilingEntity);
      const filing = filingId
        ? await repository.findOneBy({ id: filingId })
        : rceptNo
          ? await repository.findOneBy({ rceptNo })
          : memberships[0]
            ? await repository.findOneBy({ id: memberships[0].itemId })
            : null;
      submissionKind = filing?.submissionKind ?? null;
      filingType = filing?.canonicalType ?? filing?.detailType ?? null;
    }
    return {
      topic: pushTopicForAlert(alert, event, submissionKind),
      companyId: event?.companyId ?? null,
      filingType,
    };
  }

  private async canReceive(
    manager: EntityManager,
    subscription: PushSubscriptionEntity,
    preference: NotificationPreferenceEntity,
    topic: PushTopic,
    companyId: string | null,
    eventAt: Date,
    now: Date,
    filingType: string | null = null,
  ): Promise<boolean> {
    if (subscription.expirationTime && subscription.expirationTime <= now) return false;
    if (
      !isRecentPushEvent(eventAt, now) ||
      eventAt < subscription.createdAt ||
      eventAt < preference.updatedAt
    )
      return false;
    const match = /^(ADMIN|MEMBER):([a-f0-9-]{36})$/u.exec(preference.ownerKey);
    if (!match) return false;
    const ownerAuthorized =
      match[1] === 'ADMIN'
        ? Boolean(
            await manager.getRepository(AdminEntity).findOneBy({ id: match[2], isActive: true }),
          )
        : Boolean(
            await manager
              .getRepository(MemberEntity)
              .findOneBy({ id: match[2], status: 'APPROVED', role: 'VIEWER', provider: 'KAKAO' }),
          );
    const watchlisted = companyId
      ? Boolean(await manager.getRepository(MarketLeaderScopeEntity).findOneBy({ companyId }))
      : false;
    return pushPreferenceAllows({
      ownerKey: preference.ownerKey,
      subscriptionOwnerKey: subscription.ownerKey,
      ownerAuthorized,
      enabled: preference.enabled,
      topics: preference.topicsJson,
      topic,
      watchlistOnly: preference.watchlistOnly,
      watchlisted,
      filingType,
      filingTypes: preference.filingTypesJson,
    });
  }
}
