import { AlertStatus, EventState, EventType, RightsMode, SubmissionKind } from '@orsem/contracts';
import {
  AdminEntity,
  AlertEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  MemberEntity,
  NewsItemEntity,
  NotificationPreferenceEntity,
  NotificationCompanyPreferenceEntity,
  PushDeliveryEntity,
  PushSubscriptionEntity,
  SourceItemEntity,
  MarketLeaderScopeEntity,
  WatchlistItemEntity,
} from '@orsem/database';
import type { DataSource, EntityManager } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import type { WorkerConfig } from '../src/config/worker-config';
import {
  PushDeliveryService,
  PUSH_LEASE_MS,
  PUSH_MAX_ATTEMPTS,
  pushRetryAt,
} from '../src/push/push-delivery.service';
import { PushFanoutService } from '../src/push/push-fanout.service';
import {
  alertPushMessage,
  pushMessageIsSafe,
  pushPreferenceAllows,
  pushTopicForAlert,
} from '../src/push/push-policy';
import { AlertOutboxDispatcherService } from '../src/queues/alert-outbox-dispatcher.service';
import { PushRequestError, WebPushClient, type WebPushSend } from '../src/push/web-push.client';

const NOW = new Date('2026-09-04T14:00:00Z');
const earlier = new Date(NOW.getTime() - 60_000);
const consentAt = new Date(NOW.getTime() - 120_000);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ownerKey = `MEMBER:${uuid(1)}`;
const sampleAlert = (): AlertEntity =>
  ({
    id: uuid(2),
    eventClusterId: uuid(3),
    createdAt: earlier,
    status: AlertStatus.SENT,
    idempotencyKey: 'test-alert',
    alertVersion: 1,
    updatedAt: earlier,
    payloadJson: {
      phase: 'DETECTED',
      detailType: 'D002',
      companyName: '테스트 회사',
      reportName: '임원ㆍ주요주주특정증권등소유상황보고서',
    },
  }) as AlertEntity;
const sampleEvent = (): EventClusterEntity =>
  ({
    id: uuid(3),
    companyId: uuid(4),
    state: EventState.OPEN,
    canonicalEventType: EventType.INSIDER_OWNERSHIP,
  }) as EventClusterEntity;
const sampleSubscription = (): PushSubscriptionEntity =>
  ({
    id: uuid(5),
    ownerKey,
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-device',
    endpointHash: 'test-hash',
    p256dh: 'test-public-key',
    auth: 'test-auth',
    expirationTime: null,
    createdAt: consentAt,
    updatedAt: consentAt,
  }) as PushSubscriptionEntity;
const samplePreference = (): NotificationPreferenceEntity =>
  ({
    ownerKey,
    enabled: true,
    topicsJson: ['FILINGS', 'NEWS'],
    watchlistOnly: true,
    createdAt: consentAt,
    updatedAt: consentAt,
  }) as NotificationPreferenceEntity;

type Row = Record<string, any>;
function matches(row: Row, criteria: Row): boolean {
  return Object.entries(criteria).every(([key, value]) => {
    if (value instanceof Date)
      return row[key] instanceof Date && row[key].getTime() === value.getTime();
    if (value && typeof value === 'object' && '_type' in value) {
      if (value._type === 'in') return value._value.includes(row[key]);
      if (value._type === 'lessThanOrEqual') return row[key] !== null && row[key] <= value._value;
      if (value._type === 'lessThan') return row[key] < value._value;
      if (value._type === 'moreThanOrEqual') return row[key] >= value._value;
    }
    return row[key] === value;
  });
}

function harness() {
  const tables = new Map<unknown, Row[]>([
    [MemberEntity, [{ id: uuid(1), status: 'APPROVED', role: 'VIEWER', provider: 'KAKAO' }]],
    [AdminEntity, []],
    [NotificationPreferenceEntity, [samplePreference()]],
    [NotificationCompanyPreferenceEntity, []],
    [PushSubscriptionEntity, [sampleSubscription()]],
    [AlertEntity, [sampleAlert()]],
    [EventClusterEntity, [sampleEvent()]],
    [MarketLeaderScopeEntity, [{ companyId: uuid(4), priority: 'P3', realtimeAlerts: false }]],
    [
      EventClusterItemEntity,
      [{ eventClusterId: uuid(3), itemType: 'FILING', itemId: uuid(6), isPrimary: true }],
    ],
    [
      FilingEntity,
      [
        {
          id: uuid(6),
          source: 'OPENDART',
          reportName: '임원ㆍ주요주주특정증권등소유상황보고서',
          canonicalType: 'D002',
          classificationStatus: 'CONFIRMED',
          sourceDetailType: null,
          submissionKind: SubmissionKind.INITIAL,
        },
      ],
    ],
    [PushDeliveryEntity, []],
    [NewsItemEntity, []],
    [SourceItemEntity, []],
  ]);
  const repositories = new Map<unknown, any>();
  let transactionActive = false;
  let sequence = 100;
  const getRepository = (entity: unknown): any => {
    if (repositories.has(entity)) return repositories.get(entity);
    const table = tables.get(entity)!;
    const builder: Record<string, any> = {};
    for (const name of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'setLock',
      'setOnLocked',
      'take',
    ])
      builder[name] = jest.fn().mockReturnValue(builder);
    builder.getMany = jest.fn(async () =>
      table.filter(
        (row) =>
          row.status === AlertStatus.PENDING &&
          row.availableAt <= NOW &&
          row.attempts < PUSH_MAX_ATTEMPTS,
      ),
    );
    const repo = {
      find: jest.fn(async (options: { where?: Row } = {}) =>
        table.filter((row) => matches(row, options.where ?? {})),
      ),
      findOneBy: jest.fn(async (where: Row) => table.find((row) => matches(row, where)) ?? null),
      findOne: jest.fn(
        async ({ where }: { where: Row }) => table.find((row) => matches(row, where)) ?? null,
      ),
      create: jest.fn((row: Row) => ({ ...row })),
      save: jest.fn(async (input: Row | Row[]) => {
        const save = (value: Row) => {
          const row: Row = { createdAt: NOW, updatedAt: NOW, ...value };
          row.id ??= uuid(sequence++);
          const index = table.findIndex((item) => item.id === row.id);
          if (index < 0) table.push(row);
          else table[index] = row;
          return row;
        };
        return Array.isArray(input) ? input.map(save) : save(input);
      }),
      update: jest.fn(async (where: Row, changes: Row) => {
        let affected = 0;
        for (const row of table)
          if (matches(row, where)) {
            Object.assign(row, changes);
            affected++;
          }
        return { affected };
      }),
      delete: jest.fn(async (where: Row) => {
        let affected = 0;
        for (let index = table.length - 1; index >= 0; index--)
          if (matches(table[index]!, where)) {
            table.splice(index, 1);
            affected++;
          }
        return { affected };
      }),
      createQueryBuilder: jest.fn(() => builder),
    };
    repositories.set(entity, repo);
    return repo;
  };
  const manager = { getRepository } as EntityManager;
  const db = {
    manager,
    getRepository,
    transaction: async (fn: (manager: EntityManager) => Promise<unknown>) => {
      transactionActive = true;
      try {
        return await fn(manager);
      } finally {
        transactionActive = false;
      }
    },
  } as unknown as DataSource;
  const delivery = (changes: Row = {}) => {
    const row = {
      id: uuid(sequence++),
      ownerKey,
      subscriptionId: uuid(5),
      dedupeKey: `${uuid(5)}:alert:${uuid(2)}`,
      alertId: uuid(2),
      eventClusterId: uuid(3),
      topic: 'FILINGS',
      status: AlertStatus.SENDING,
      payloadJson: { ...alertPushMessage(sampleAlert(), 'FILINGS') },
      attempts: 1,
      availableAt: earlier,
      leaseUntil: new Date(NOW.getTime() + PUSH_LEASE_MS),
      createdAt: earlier,
      updatedAt: earlier,
      sentAt: null,
      lastError: null,
      ...changes,
    } as PushDeliveryEntity;
    tables.get(PushDeliveryEntity)!.push(row);
    return row;
  };
  return { tables, db, manager, delivery, getRepository, inTransaction: () => transactionActive };
}

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => jest.useRealTimers());

describe('personal push fan-out and source policy', () => {
  it.each(['D003', 'D004'])(
    'requires explicit personal %s consent and rechecks it before delivery',
    async (detailType) => {
      const h = harness();
      const alert = h.tables.get(AlertEntity)![0]!;
      const event = h.tables.get(EventClusterEntity)![0]!;
      const filing = h.tables.get(FilingEntity)![0]!;
      const preference = h.tables.get(NotificationPreferenceEntity)![0]!;
      Object.assign(filing, {
        detailType,
        canonicalType: detailType,
        reportName: detailType === 'D003' ? '의결권대리행사권유참고서류' : '공개매수신고서',
      });
      alert.payloadJson.detailType = detailType;
      event.canonicalEventType =
        detailType === 'D003' ? EventType.PROXY_SOLICITATION : EventType.TENDER_OFFER;
      const fanout = new PushFanoutService();
      expect(await fanout.enqueueAlert(h.db.manager, alert as AlertEntity, NOW)).toBe(0);
      preference.filingTypesJson = [detailType];
      expect(await fanout.enqueueAlert(h.db.manager, alert as AlertEntity, NOW)).toBe(1);
      Object.assign(h.tables.get(MarketLeaderScopeEntity)![0]!, {
        priority: 'P1',
        realtimeAlerts: true,
      });
      const dispatcher = new AlertOutboxDispatcherService(h.db, fanout, {
        openDartGlobalAlertTypes: ['D001', 'D002', 'D005'],
      } as unknown as WorkerConfig);
      expect(
        await (
          dispatcher as unknown as {
            externalFanOutAllowed: (manager: EntityManager, alert: AlertEntity) => Promise<boolean>;
          }
        ).externalFanOutAllowed(h.manager, alert as AlertEntity),
      ).toBe(false);
      const delivery = h.tables.get(PushDeliveryEntity)![0]! as PushDeliveryEntity;
      expect(await fanout.resolveDelivery(h.db.manager, delivery, NOW)).not.toBeNull();
      preference.filingTypesJson = [];
      expect(await fanout.resolveDelivery(h.db.manager, delivery, NOW)).toBeNull();
    },
  );
  it('classifies detected/parsed/correction alerts and excludes cancelled or superseded events', () => {
    const alert = sampleAlert();
    const event = sampleEvent();
    expect(pushTopicForAlert(alert, event, SubmissionKind.INITIAL)).toBe('FILINGS');
    alert.payloadJson.phase = 'PARSED';
    expect(pushTopicForAlert(alert, event, SubmissionKind.INITIAL)).toBe('ANALYSIS');
    expect(pushTopicForAlert(alert, event, SubmissionKind.ATTACHMENT_CORRECTION)).toBe(
      'CORRECTIONS',
    );
    event.state = EventState.SUPERSEDED;
    expect(pushTopicForAlert(alert, event, SubmissionKind.CORRECTION)).toBeNull();
    alert.eventClusterId = null;
    alert.payloadJson.phase = 'OPERATIONAL';
    expect(pushTopicForAlert(alert, null, null)).toBe('OPERATIONS');
  });

  it('requires individual opt-in and active ownership; operations remain admin-only and TEST ignores topic selections', () => {
    const base = {
      ownerKey,
      subscriptionOwnerKey: ownerKey,
      ownerAuthorized: true,
      enabled: true,
      topics: ['OPERATIONS'],
      topic: 'OPERATIONS' as const,
      watchlistOnly: true,
      watchlisted: false,
    };
    expect(pushPreferenceAllows(base)).toBe(false);
    expect(
      pushPreferenceAllows({
        ...base,
        ownerKey: `ADMIN:${uuid(1)}`,
        subscriptionOwnerKey: `ADMIN:${uuid(1)}`,
      }),
    ).toBe(true);
    expect(pushPreferenceAllows({ ...base, topic: 'TEST', topics: [] })).toBe(true);
    expect(pushPreferenceAllows({ ...base, topic: 'TEST', enabled: false })).toBe(false);
    expect(pushPreferenceAllows({ ...base, topic: 'TEST', ownerAuthorized: false })).toBe(false);
  });

  it('materializes one durable device delivery independently of the P3/bot realtime setting', async () => {
    const h = harness();
    const fanout = new PushFanoutService();
    expect(await fanout.enqueueAlert(h.manager, sampleAlert(), NOW)).toBe(1);
    expect(await fanout.enqueueAlert(h.manager, sampleAlert(), NOW)).toBe(0);
    expect(h.tables.get(PushDeliveryEntity)).toHaveLength(1);
    expect(h.tables.get(PushDeliveryEntity)![0]).toMatchObject({
      topic: 'FILINGS',
      dedupeKey: `${uuid(5)}:alert:${uuid(2)}`,
      status: 'PENDING',
    });
  });

  it('applies company overrides without bypassing account, topic, or filing-type gates', () => {
    const base = {
      ownerKey,
      subscriptionOwnerKey: ownerKey,
      ownerAuthorized: true,
      enabled: true,
      topics: ['FILINGS'],
      topic: 'FILINGS' as const,
      watchlistOnly: true,
      watchlisted: false,
    };
    expect(pushPreferenceAllows({ ...base, companyEnabled: true })).toBe(true);
    expect(pushPreferenceAllows({ ...base, watchlisted: true, companyEnabled: false })).toBe(false);
    expect(pushPreferenceAllows({ ...base, companyEnabled: true, enabled: false })).toBe(false);
    expect(pushPreferenceAllows({ ...base, companyEnabled: true, topics: [] })).toBe(false);
    expect(pushPreferenceAllows({ ...base, companyEnabled: true, ownerAuthorized: false })).toBe(
      false,
    );
    expect(pushPreferenceAllows({ ...base, companyEnabled: true, filingType: 'D003' })).toBe(false);
  });

  it('does not fan out a pre-subscription backlog, disabled topic, or removed account', async () => {
    const h = harness();
    const fanout = new PushFanoutService();
    expect(
      await fanout.enqueueAlert(
        h.manager,
        { ...sampleAlert(), createdAt: new Date(consentAt.getTime() - 1) },
        NOW,
      ),
    ).toBe(0);
    h.tables.get(NotificationPreferenceEntity)![0]!.topicsJson = ['NEWS'];
    expect(await fanout.enqueueAlert(h.manager, sampleAlert(), NOW)).toBe(0);
    h.tables.get(NotificationPreferenceEntity)![0]!.topicsJson = ['FILINGS'];
    h.tables.get(MemberEntity)![0]!.role = 'ADMIN';
    expect(await fanout.enqueueAlert(h.manager, sampleAlert(), NOW)).toBe(0);
    h.tables.get(MemberEntity)!.length = 0;
    expect(await fanout.enqueueAlert(h.manager, sampleAlert(), NOW)).toBe(0);
  });

  it('cancels queued NAVER notifications on eligibility recheck and blocks new market feeds', async () => {
    const h = harness();
    const fanout = new PushFanoutService();
    const news = {
      id: uuid(7),
      sourceItemId: uuid(8),
      companyId: uuid(4),
      title: 'Official news',
      publishedAt: earlier,
    } as NewsItemEntity;
    const source = {
      id: uuid(8),
      source: 'SEC',
      firstObservedAt: earlier,
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    } as SourceItemEntity;
    h.tables.get(NewsItemEntity)!.push(news);
    h.tables.get(SourceItemEntity)!.push(source);
    expect(await fanout.enqueueNews(h.manager, news, source, NOW)).toBe(1);
    const delivery = h.tables.get(PushDeliveryEntity)![0] as PushDeliveryEntity;
    source.source = 'NAVER';
    expect(await fanout.resolveDelivery(h.manager, delivery, NOW)).toBeNull();
    for (const connector of [
      'NAVER',
      'NEWS_RSS',
      'IR',
      'GDELT',
      'MARKETAUX',
      'ALPHAVANTAGE',
      'FINNHUB',
    ]) {
      expect(
        await fanout.enqueueNews(
          h.manager,
          { ...news, id: uuid(9) },
          { ...source, source: connector },
          NOW,
        ),
      ).toBe(0);
    }
  });

  it('enqueues only recent first-observed news, deduplicates repeated hooks, and rejects old or unknown publication dates', async () => {
    const h = harness();
    const fanout = new PushFanoutService();
    const news = {
      id: uuid(7),
      sourceItemId: uuid(8),
      companyId: uuid(4),
      title: '새 공식 뉴스',
      publishedAt: earlier,
    } as NewsItemEntity;
    const source = {
      id: uuid(8),
      firstObservedAt: earlier,
      rightsMode: RightsMode.STORE_METADATA_ONLY,
    } as SourceItemEntity;
    expect(await fanout.enqueueNews(h.manager, news, source, NOW)).toBe(1);
    expect(await fanout.enqueueNews(h.manager, news, source, NOW)).toBe(0);
    expect(
      await fanout.enqueueNews(
        h.manager,
        { ...news, id: uuid(9), publishedAt: new Date(consentAt.getTime() - 1) },
        source,
        NOW,
      ),
    ).toBe(0);
    expect(await fanout.enqueueNews(h.manager, { ...news, publishedAt: null }, source, NOW)).toBe(
      0,
    );
    expect(
      await fanout.enqueueNews(
        h.manager,
        { ...news, publishedAt: new Date(NOW.getTime() - 86_400_001) },
        source,
        NOW,
      ),
    ).toBe(0);
  });
});

describe('durable Web Push sender', () => {
  it('sends an owner-requested TEST despite empty topic selections and watchlist scope', async () => {
    const h = harness();
    h.tables.get(NotificationPreferenceEntity)![0]!.topicsJson = [];
    h.tables.get(MarketLeaderScopeEntity)!.length = 0;
    const row = h.delivery({
      topic: 'TEST',
      alertId: null,
      eventClusterId: null,
      dedupeKey: `test:${uuid(11)}`,
      payloadJson: {
        title: '테스트 알림',
        body: '이 기기에서 알림을 받을 수 있습니다.',
        url: '/settings/notifications',
        tag: `test-${uuid(11)}`,
      },
    });
    const send = jest.fn().mockResolvedValue(undefined);
    const service = new PushDeliveryService(h.db, new PushFanoutService(), {
      enabled: true,
      send,
    } as unknown as WebPushClient);
    expect(await service.sendClaimed(row)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('SENT');
  });

  it('claims with a lease and performs the HTTP send outside the database transaction', async () => {
    const h = harness();
    const row = h.delivery({ status: AlertStatus.PENDING, leaseUntil: null, attempts: 0 });
    const send = jest.fn(async () => {
      expect(h.inTransaction()).toBe(false);
    });
    const service = new PushDeliveryService(h.db, new PushFanoutService(), {
      enabled: true,
      send,
    } as unknown as WebPushClient);
    expect(await service.dispatch()).toEqual({ configured: true, claimed: 1, sent: 1 });
    const saved = h.tables.get(PushDeliveryEntity)!.find((item) => item.id === row.id)!;
    expect(saved).toMatchObject({ status: 'SENT', attempts: 1, leaseUntil: null, sentAt: NOW });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      h.getRepository(PushDeliveryEntity).createQueryBuilder().setOnLocked,
    ).toHaveBeenCalledWith('skip_locked');
  });

  it.each(['preference', 'owner', 'subscription', 'correction', 'classification', 'type'])(
    'cancels before send when %s eligibility changes after fan-out',
    async (reason) => {
      const h = harness();
      const row = h.delivery();
      if (reason === 'preference') h.tables.get(NotificationPreferenceEntity)![0]!.enabled = false;
      if (reason === 'owner') h.tables.get(MemberEntity)![0]!.status = 'REJECTED';
      if (reason === 'subscription') h.tables.get(PushSubscriptionEntity)!.length = 0;
      if (reason === 'correction')
        h.tables.get(EventClusterEntity)![0]!.state = EventState.CANCELLED;
      if (reason === 'classification')
        h.tables.get(FilingEntity)![0]!.classificationStatus = 'UNSUPPORTED';
      if (reason === 'type') h.tables.get(AlertEntity)![0]!.payloadJson.detailType = 'D005';
      const send = jest.fn();
      const service = new PushDeliveryService(h.db, new PushFanoutService(), {
        enabled: true,
        send,
      } as unknown as WebPushClient);
      expect(await service.sendClaimed(row)).toBe(false);
      expect(row.status).toBe('CANCELLED');
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('does not resurrect or send a claimed row cancelled concurrently during recipient validation', async () => {
    const h = harness();
    const row = h.delivery();
    const originalClaim = { ...row };
    const recipients = {
      resolveDelivery: jest.fn(async () => {
        row.status = AlertStatus.CANCELLED;
        row.leaseUntil = null;
        return sampleSubscription();
      }),
    } as unknown as PushFanoutService;
    const send = jest.fn();
    const service = new PushDeliveryService(h.db, recipients, {
      enabled: true,
      send,
    } as unknown as WebPushClient);
    expect(await service.sendClaimed(originalClaim)).toBe(false);
    expect(row.status).toBe('CANCELLED');
    expect(send).not.toHaveBeenCalled();
  });

  it('honors 429 Retry-After without exposing errors or retrying immediately', async () => {
    const h = harness();
    const row = h.delivery();
    const send = jest.fn().mockRejectedValue(new PushRequestError(429, '120'));
    const service = new PushDeliveryService(h.db, new PushFanoutService(), {
      enabled: true,
      send,
    } as unknown as WebPushClient);
    await service.sendClaimed(row);
    expect(row).toMatchObject({
      status: 'PENDING',
      leaseUntil: null,
      availableAt: new Date(NOW.getTime() + 120_000),
      lastError: 'Web Push HTTP 429.',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      pushRetryAt(
        new PushRequestError(503, new Date(NOW.getTime() + 180_000).toUTCString()),
        1,
        NOW,
      ),
    ).toEqual(new Date(NOW.getTime() + 180_000));
  });

  it('removes expired subscriptions on 410, preserves delivery history, and cancels their pending work', async () => {
    const h = harness();
    const row = h.delivery();
    const next = h.delivery({ status: AlertStatus.PENDING, leaseUntil: null });
    const service = new PushDeliveryService(h.db, new PushFanoutService(), {
      enabled: true,
      send: jest.fn().mockRejectedValue(new PushRequestError(410, null)),
    } as unknown as WebPushClient);
    await service.sendClaimed(row);
    expect(row.status).toBe('FAILED');
    expect(next.status).toBe('CANCELLED');
    expect(h.tables.get(PushSubscriptionEntity)).toHaveLength(0);
    expect(h.tables.get(PushDeliveryEntity)).toHaveLength(2);
  });

  it('stops after the final attempt and does not overwrite a reclaimed lease', async () => {
    const h = harness();
    const row = h.delivery({ attempts: PUSH_MAX_ATTEMPTS });
    const service = new PushDeliveryService(h.db, new PushFanoutService(), {
      enabled: true,
      send: jest.fn().mockRejectedValue(new PushRequestError(null, null)),
    } as unknown as WebPushClient);
    await service.sendClaimed(row);
    expect(row.status).toBe('FAILED');
    const other = h.delivery();
    const stale = { ...other, attempts: 0 };
    expect(await service.sendClaimed(stale)).toBe(false);
    expect(other.status).toBe('SENDING');
  });

  it('recovers expired leases without endlessly retrying exhausted deliveries', async () => {
    const h = harness();
    h.delivery({ leaseUntil: new Date(NOW.getTime() - 1), attempts: PUSH_MAX_ATTEMPTS });
    const service = new PushDeliveryService(h.db, new PushFanoutService(), {
      enabled: true,
      send: jest.fn(),
    } as unknown as WebPushClient);
    expect(await service.dispatch()).toMatchObject({ claimed: 0, sent: 0 });
    expect(h.tables.get(PushDeliveryEntity)![0]!.status).toBe('FAILED');
  });
});

describe('Web Push transport boundary', () => {
  const configured = () => ({
    ...loadWorkerConfig({}),
    webPush: {
      enabled: true,
      publicKey: 'test-public',
      privateKey: 'test-private',
      subject: 'mailto:ops@example.test',
    },
  });

  it('uses encrypted VAPID transport only for approved service origins and safe in-app links', async () => {
    const send = jest.fn().mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    const client = new WebPushClient(configured(), send as WebPushSend);
    const message = alertPushMessage(sampleAlert(), 'FILINGS');
    await client.send(sampleSubscription(), message, 300);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ keys: { p256dh: 'test-public-key', auth: 'test-auth' } }),
      JSON.stringify(message),
      expect.objectContaining({
        contentEncoding: 'aes128gcm',
        TTL: 300,
        vapidDetails: {
          publicKey: 'test-public',
          privateKey: 'test-private',
          subject: 'mailto:ops@example.test',
        },
      }),
    );
    await expect(
      client.send({ ...sampleSubscription(), endpoint: 'https://127.0.0.1/private' }, message, 300),
    ).rejects.toThrow('HTTP 400');
    expect(send).toHaveBeenCalledTimes(1);
    expect(pushMessageIsSafe({ ...message, url: '//evil.example/path' })).toBe(false);
    expect(pushMessageIsSafe({ ...message, url: '/events/../../admin' })).toBe(false);
  });

  it('rejects redirects and sanitizes provider errors containing endpoint URLs or keys', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ statusCode: 307, headers: { location: 'https://evil.example' } })
      .mockRejectedValueOnce({
        statusCode: 429,
        headers: { 'retry-after': '60' },
        body: 'private-key',
        endpoint: 'private-endpoint',
      });
    const client = new WebPushClient(configured(), send as WebPushSend);
    const message = alertPushMessage(sampleAlert(), 'FILINGS');
    await expect(client.send(sampleSubscription(), message, 300)).rejects.toThrow('HTTP 307');
    const failure = await client
      .send(sampleSubscription(), message, 300)
      .catch((error) => error as PushRequestError);
    expect(failure).toMatchObject({ message: 'Web Push HTTP 429.', retryAfter: '60' });
    expect(JSON.stringify(failure)).not.toContain('private-');
  });

  it('leaves optional push disabled with missing credentials', async () => {
    const config = loadWorkerConfig({ SEC_USER_AGENT: 'Orsem ops@example.test' });
    expect(config.webPush.enabled).toBe(false);
    expect(config.secUserAgent).toBe('Orsem ops@example.test');
    const h = harness();
    const client = new WebPushClient(config, jest.fn());
    expect(await new PushDeliveryService(h.db, new PushFanoutService(), client).dispatch()).toEqual(
      { configured: false, claimed: 0, sent: 0 },
    );
  });
});

describe('verified secondary share-class notification scope', () => {
  it('allows current secondary-class alerts without putting the class in the representative quote list', async () => {
    const h = harness();
    h.tables.set(WatchlistItemEntity, []);
    Object.assign(h.tables.get(MarketLeaderScopeEntity)![0]!, {
      representativeCompanyId: uuid(99),
      priority: 'P1',
      realtimeAlerts: true,
    });
    const fanout = new PushFanoutService();
    expect(await fanout.enqueueAlert(h.manager, sampleAlert(), NOW)).toBe(1);
    const dispatcher = new AlertOutboxDispatcherService(h.db, fanout, {
      openDartGlobalAlertTypes: ['D001', 'D002', 'D005'],
    } as unknown as WorkerConfig);
    const eligible = () =>
      (
        dispatcher as unknown as {
          externalFanOutAllowed: (manager: EntityManager, alert: AlertEntity) => Promise<boolean>;
        }
      ).externalFanOutAllowed(h.manager, sampleAlert());
    expect(await eligible()).toBe(true);
    const delivery = h.tables.get(PushDeliveryEntity)![0]! as PushDeliveryEntity;
    expect(await fanout.resolveDelivery(h.manager, delivery, NOW)).not.toBeNull();
    h.tables.get(MarketLeaderScopeEntity)!.length = 0;
    expect(await eligible()).toBe(false);
    expect(await fanout.resolveDelivery(h.manager, delivery, NOW)).toBeNull();
    expect(h.tables.get(WatchlistItemEntity)).toHaveLength(0);
  });
});
