import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAppConfig } from '../config/app-config';
import { SessionRuntimeService } from './session-runtime.service';

const persistenceError = new Error(
  'MISCONF Redis persistence failed; nonce=synthetic-secret-nonce',
);
const persistenceMessage = 'Redis persistence failed; writes are blocked.';

function runtime(client: object | null) {
  const service = new SessionRuntimeService(
    loadAppConfig({ NODE_ENV: 'test', REDIS_PREFIX: 'session-runtime-test:' }),
  );
  const internal = service as unknown as { client: unknown; redisReady: boolean };
  internal.client = client;
  internal.redisReady = true;
  return service;
}

test('rate-limit writes fail closed during Redis persistence errors and restore health after recovery', async () => {
  let failing = true;
  const expirations: Array<{ key: string; windowMs: number }> = [];
  const service = runtime({
    isReady: true,
    incr: async () => {
      if (failing) throw persistenceError;
      return 1;
    },
    pExpire: async (key: string, windowMs: number) => {
      expirations.push({ key, windowMs });
      return true;
    },
  });

  assert.equal(await service.consumeRateLimit('kakao:start', 60_000), null);
  assert.deepEqual(service.health, { ready: false, message: persistenceMessage });
  assert.deepEqual(expirations, []);

  failing = false;
  assert.equal(await service.consumeRateLimit('kakao:start', 60_000), 1);
  assert.deepEqual(service.health, { ready: true, message: null });
  assert.deepEqual(expirations, [
    { key: 'session-runtime-test:rate:kakao:start', windowMs: 60_000 },
  ]);
});

test('rate-limit health stays failed when increment succeeds but expiration fails', async () => {
  let failing = true;
  const service = runtime({
    isReady: true,
    incr: async () => 1,
    pExpire: async () => {
      if (failing) throw persistenceError;
      return true;
    },
  });

  assert.equal(await service.consumeRateLimit('kakao:callback', 60_000), null);
  assert.deepEqual(service.health, { ready: false, message: persistenceMessage });

  failing = false;
  assert.equal(await service.consumeRateLimit('kakao:callback', 60_000), 1);
  assert.deepEqual(service.health, { ready: true, message: null });
});

test('Kakao state writes record persistence failures and recover without changing state expiry', async () => {
  let failing = true;
  const writes: Array<{ value: string; options: { EX: number; NX: boolean } }> = [];
  const service = runtime({
    isReady: true,
    set: async (_key: string, value: string, options: { EX: number; NX: boolean }) => {
      if (failing) throw persistenceError;
      writes.push({ value, options });
      return 'OK';
    },
  });

  assert.equal(await service.storeKakaoState('session', 'state-hash', 'nonce', 123), false);
  assert.deepEqual(service.health, { ready: false, message: persistenceMessage });

  failing = false;
  assert.equal(await service.storeKakaoState('session', 'state-hash', 'nonce', 123), true);
  assert.deepEqual(service.health, { ready: true, message: null });
  assert.deepEqual(writes, [
    { value: JSON.stringify({ nonce: 'nonce', createdAt: 123 }), options: { EX: 300, NX: true } },
  ]);
});

test('Kakao state collisions still fail closed even after Redis health recovers', async () => {
  let failing = true;
  const service = runtime({
    isReady: true,
    set: async () => {
      if (failing) throw persistenceError;
      return null;
    },
  });

  assert.equal(await service.storeKakaoState('session', 'state-hash', 'nonce', 123), false);
  assert.equal(service.health.ready, false);
  failing = false;
  assert.equal(await service.storeKakaoState('session', 'state-hash', 'nonce', 123), false);
  assert.deepEqual(service.health, { ready: true, message: null });
});

test('Kakao state consumption records failures and recovers while preserving single-use results', async () => {
  let failing = true;
  let stored: string | null = JSON.stringify({ nonce: 'nonce', createdAt: 123 });
  const service = runtime({
    isReady: true,
    getDel: async () => {
      if (failing) throw persistenceError;
      const value = stored;
      stored = null;
      return value;
    },
  });

  assert.equal(await service.consumeKakaoState('session', 'state-hash'), null);
  assert.deepEqual(service.health, { ready: false, message: persistenceMessage });

  failing = false;
  assert.equal(
    await service.consumeKakaoState('session', 'state-hash'),
    JSON.stringify({ nonce: 'nonce', createdAt: 123 }),
  );
  assert.deepEqual(service.health, { ready: true, message: null });
  assert.equal(await service.consumeKakaoState('session', 'state-hash'), null);
});

test('public Redis health never includes auth state or connection details from write errors', async () => {
  const service = runtime({
    isReady: true,
    getDel: async () => {
      throw new Error(
        'ERR nonce=synthetic-secret-nonce url=redis://test-user:test-password@example.invalid',
      );
    },
  });

  assert.equal(await service.consumeKakaoState('session', 'state-hash'), null);
  assert.deepEqual(service.health, { ready: false, message: 'Redis write failed.' });
  assert.doesNotMatch(JSON.stringify(service.health), /nonce|redis:\/\/|test-password/u);
});

test('unavailable Redis never permits rate limits or Kakao states through a memory fallback', async () => {
  for (const client of [null, { isReady: false }]) {
    const service = runtime(client);
    assert.equal(await service.consumeRateLimit('kakao:start', 60_000), null);
    assert.equal(await service.storeKakaoState('session', 'state-hash', 'nonce', 123), false);
    assert.equal(await service.consumeKakaoState('session', 'state-hash'), null);
  }
});
