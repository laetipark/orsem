import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createECDH, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import {
  NotificationPreferenceEntity,
  PushDeliveryEntity,
  PushSubscriptionEntity,
} from '@orsem/database';
import { type NotificationPreferences, type PushSubscriptionInput } from '@orsem/contracts';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { HybridRateLimitGuard } from '../security/security';
import type { SessionRuntimeService } from '../security/session-runtime.service';
import { NotificationsController, notificationOwner } from './notifications.controller';
import { NotificationsService, type NotificationOwner } from './notifications.service';

const member: NotificationOwner = {
  key: 'MEMBER:00000000-0000-4000-8000-000000000001',
  isAdmin: false,
};
const other: NotificationOwner = {
  key: 'MEMBER:00000000-0000-4000-8000-000000000002',
  isAdmin: false,
};
const admin: NotificationOwner = {
  key: 'ADMIN:00000000-0000-4000-8000-000000000003',
  isAdmin: true,
};
const preferences: NotificationPreferences = {
  enabled: true,
  topics: ['FILINGS', 'NEWS'],
  watchlistOnly: true,
};
const vapid = createECDH('prime256v1');
vapid.generateKeys();
const pushEnvironment = {
  WEB_PUSH_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
  WEB_PUSH_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
  WEB_PUSH_SUBJECT: 'mailto:notifications@example.test',
};
function input(token = 'fixture-token'): PushSubscriptionInput {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${token}`,
    expirationTime: null,
    keys: {
      p256dh: pair.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
    deviceName: '테스트 브라우저',
  };
}
function fixtureService() {
  return new NotificationsService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true', ...pushEnvironment }),
    {} as DatabaseRuntimeService,
  );
}
function request(owner: NotificationOwner): Request {
  return {
    session: owner.isAdmin ? { adminId: owner.key.slice(6) } : { memberId: owner.key.slice(7) },
  } as Request;
}

test('preferences default off and remain isolated by session identity while metadata omits endpoint keys', async () => {
  const service = fixtureService();
  const defaults = await service.settings(member);
  assert.equal(defaults.enabled, false);
  assert.deepEqual(defaults.topics, ['FILINGS', 'ANALYSIS', 'CORRECTIONS', 'NEWS']);
  assert.equal(defaults.watchlistOnly, true);
  assert.equal(defaults.pushConfigured, false);
  assert.equal(defaults.publicKey, null);
  const registered = await service.subscribe(member, input());
  await service.updateSettings(member, preferences);
  const own = await service.settings(member);
  assert.equal(own.enabled, true);
  assert.deepEqual(
    own.subscriptions.map((item) => item.id),
    [registered.id],
  );
  assert.deepEqual(Object.keys(own.subscriptions[0]!).sort(), [
    'createdAt',
    'deviceName',
    'id',
    'lastSeenAt',
  ]);
  assert.equal(JSON.stringify(own).includes('fcm.googleapis.com'), false);
  assert.equal(JSON.stringify(own).includes(pushEnvironment.WEB_PUSH_PRIVATE_KEY), false);
  assert.equal((await service.settings(other)).enabled, false);
  assert.deepEqual((await service.settings(other)).subscriptions, []);
});

test('subscription keys can rotate only for their current owner and canonical endpoint aliases cannot take over', async () => {
  const service = fixtureService();
  const original = input();
  const first = await service.subscribe(member, original);
  const updated = await service.subscribe(member, { ...input(), deviceName: '새 이름' });
  assert.equal(updated.id, first.id);
  assert.equal((await service.settings(member)).subscriptions.length, 1);
  assert.equal((await service.settings(member)).subscriptions[0]?.deviceName, '새 이름');
  await assert.rejects(
    () =>
      service.subscribe(other, {
        ...input(),
        endpoint: original.endpoint.replace('fcm.googleapis.com', 'FCM.GOOGLEAPIS.COM'),
      }),
    ConflictException,
  );
  await assert.rejects(() => service.unsubscribe(other, first.id), NotFoundException);
  await service.updateSettings(other, preferences);
  await assert.rejects(() => service.test(other, first.id), NotFoundException);
  await service.unsubscribe(member, first.id);
  assert.deepEqual((await service.settings(member)).subscriptions, []);
});

test('a per-owner limit of ten subscriptions permits refresh and deletion without affecting other owners', async () => {
  const service = fixtureService();
  const ids = [];
  for (let index = 0; index < 10; index += 1)
    ids.push((await service.subscribe(member, input(`token-${index}`))).id);
  await assert.rejects(() => service.subscribe(member, input('too-many')), ConflictException);
  assert.equal((await service.subscribe(member, input('token-0'))).id, ids[0]);
  await service.subscribe(other, input('other-owner-token'));
  await service.unsubscribe(member, ids[0]!);
  await service.subscribe(member, input('replacement'));
  assert.equal((await service.settings(member)).subscriptions.length, 10);
});

test('operations topics require an admin and a test can run with no selected event topic only after enabling', async () => {
  const service = fixtureService();
  await assert.rejects(
    () => service.updateSettings(member, { ...preferences, topics: ['OPERATIONS'] }),
    ForbiddenException,
  );
  assert.deepEqual(
    (await service.updateSettings(admin, { ...preferences, topics: ['OPERATIONS'] })).topics,
    ['OPERATIONS'],
  );
  const subscription = await service.subscribe(member, input());
  await assert.rejects(() => service.test(member, subscription.id), BadRequestException);
  await service.updateSettings(member, { ...preferences, topics: [] });
  assert.deepEqual(await service.test(member, subscription.id), { queued: true, simulated: true });
});

test('controller rejects body ownership claims, unsafe endpoint variants, malformed curve keys and expiration', async () => {
  const service = fixtureService();
  const controller = new NotificationsController(service);
  const req = request(member);
  assert.deepEqual(notificationOwner(req), member);
  assert.throws(
    () => controller.updateSettings({ ...preferences, ownerKey: admin.key }, req),
    BadRequestException,
  );
  assert.throws(
    () => controller.subscribe({ ...input(), ownerKey: admin.key }, req),
    BadRequestException,
  );
  for (const endpoint of [
    'http://fcm.googleapis.com/token',
    'https://127.0.0.1/token',
    'https://[::1]/token',
    'https://fcm.googleapis.com.attacker.test/token',
    'https://user:secret@fcm.googleapis.com/token',
    'https://fcm.googleapis.com:444/token',
    'https://fcm.googleapis.com/token#fragment',
    'https://attacker.test/token',
  ])
    assert.throws(() => controller.subscribe({ ...input(), endpoint }, req), BadRequestException);
  const invalidCurveKey = Buffer.alloc(65, 1);
  invalidCurveKey[0] = 4;
  await assert.rejects(
    () =>
      controller.subscribe(
        { ...input(), keys: { ...input().keys, p256dh: invalidCurveKey.toString('base64url') } },
        req,
      ),
    BadRequestException,
  );
  await assert.rejects(
    () => controller.subscribe({ ...input(), expirationTime: Date.now() - 1000 }, req),
    BadRequestException,
  );
});

test('notification test routes have a five-request rate limit without a guard exemption', async () => {
  const guard = new HybridRateLimitGuard(new Reflector(), {
    consumeRateLimit: async () => null,
  } as unknown as SessionRuntimeService);
  const context = {
    getClass: () => NotificationsController,
    getHandler: () => NotificationsController.prototype.test,
    switchToHttp: () => ({
      getRequest: () => ({
        ip: '127.0.0.1',
        method: 'POST',
        route: { path: '/notifications/test' },
      }),
    }),
  } as unknown as ExecutionContext;
  for (let index = 0; index < 5; index += 1) assert.equal(await guard.canActivate(context), true);
  await assert.rejects(() => guard.canActivate(context), /요청이 너무 많습니다/u);
});

function databaseHarness() {
  const preferences = new Map<string, NotificationPreferenceEntity>();
  const subscriptions = new Map<string, PushSubscriptionEntity>();
  const deliveries: PushDeliveryEntity[] = [];
  const cancelled: unknown[] = [];
  const trace: string[] = [];
  const preferenceRepository = {
    findOneBy: async ({ ownerKey }: { ownerKey: string }) => preferences.get(ownerKey) ?? null,
    save: async (row: NotificationPreferenceEntity) => {
      preferences.set(row.ownerKey, row);
      return row;
    },
    createQueryBuilder() {
      let inserted: NotificationPreferenceEntity;
      let ownerKey: string;
      const query = {
        insert: () => query,
        values: (row: NotificationPreferenceEntity) => {
          inserted = row;
          return query;
        },
        orIgnore: () => query,
        execute: async () => {
          if (!preferences.has(inserted.ownerKey)) preferences.set(inserted.ownerKey, inserted);
        },
        setLock: (mode: string) => {
          trace.push(mode);
          return query;
        },
        where: (_sql: string, params: { ownerKey: string }) => {
          ownerKey = params.ownerKey;
          return query;
        },
        getOneOrFail: async () => preferences.get(ownerKey)!,
      };
      return query;
    },
  };
  const subscriptionRepository = {
    findOneBy: async (where: Partial<PushSubscriptionEntity>) =>
      [...subscriptions.values()].find((row) =>
        Object.entries(where).every(
          ([key, value]) => row[key as keyof PushSubscriptionEntity] === value,
        ),
      ) ?? null,
    find: async ({ where }: { where: { ownerKey: string } }) =>
      [...subscriptions.values()].filter((row) => row.ownerKey === where.ownerKey),
    countBy: async ({ ownerKey }: { ownerKey: string }) =>
      [...subscriptions.values()].filter((row) => row.ownerKey === ownerKey).length,
    save: async (row: PushSubscriptionEntity) => {
      subscriptions.set(row.id, row);
      return row;
    },
    delete: async ({ id, ownerKey }: { id: string; ownerKey: string }) => {
      assert.equal(subscriptions.get(id)?.ownerKey, ownerKey);
      subscriptions.delete(id);
    },
  };
  const manager = {
    getRepository(entity: unknown) {
      if (entity === NotificationPreferenceEntity) return preferenceRepository;
      if (entity === PushSubscriptionEntity) return subscriptionRepository;
      assert.equal(entity, PushDeliveryEntity);
      return {
        save: async (row: PushDeliveryEntity) => {
          deliveries.push(row);
          return row;
        },
        update: async (where: unknown, value: unknown) => {
          cancelled.push({ where, value });
        },
      };
    },
  };
  const source = {
    ...manager,
    transaction: async (callback: (manager: unknown) => Promise<unknown>) => {
      trace.push('transaction');
      return callback(manager);
    },
  };
  const service = new NotificationsService(
    loadAppConfig({ NODE_ENV: 'test', ...pushEnvironment }),
    { requireDataSource: () => source } as unknown as DatabaseRuntimeService,
  );
  return { service, preferences, subscriptions, deliveries, cancelled, trace };
}

test('persisted subscriptions lock ownership, queue TEST without network, and cancel only owner deliveries on removal', async () => {
  const harness = databaseHarness();
  const { service } = harness;
  await service.updateSettings(member, { ...preferences, topics: [] });
  const subscription = await service.subscribe(member, input());
  assert.deepEqual(await service.test(member, subscription.id), { queued: true });
  assert.equal(harness.deliveries.length, 1);
  assert.equal(harness.deliveries[0]?.topic, 'TEST');
  assert.equal(harness.deliveries[0]?.status, 'PENDING');
  assert.equal(harness.deliveries[0]?.ownerKey, member.key);
  assert.equal(harness.deliveries[0]?.subscriptionId, subscription.id);
  assert.equal(harness.deliveries[0]?.payloadJson.url, '/settings/notifications');
  assert.equal(harness.deliveries[0]?.eventClusterId, null);
  assert.equal(harness.deliveries[0]?.attempts, 0);
  await assert.rejects(() => service.test(other, subscription.id), NotFoundException);
  await service.unsubscribe(member, subscription.id);
  const cancelled = harness.cancelled.at(-1) as {
    where: { ownerKey: string; subscriptionId: string };
    value: { status: string };
  };
  assert.equal(cancelled.where.ownerKey, member.key);
  assert.equal(cancelled.where.subscriptionId, subscription.id);
  assert.equal(cancelled.value.status, 'CANCELLED');
  assert.equal(harness.subscriptions.size, 0);
  assert.equal(
    harness.trace.filter((item) => item === 'pessimistic_write').length,
    harness.trace.filter((item) => item === 'transaction').length,
  );
});

test('missing push configuration prevents live subscriptions and tests', async () => {
  const service = new NotificationsService(
    loadAppConfig({ NODE_ENV: 'test' }),
    {} as DatabaseRuntimeService,
  );
  await assert.rejects(() => service.subscribe(member, input()), ServiceUnavailableException);
  await assert.rejects(
    () => service.test(member, '00000000-0000-4000-8000-000000000004'),
    ServiceUnavailableException,
  );
});
