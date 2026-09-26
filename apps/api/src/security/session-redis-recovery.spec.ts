import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import session, { type SessionData, type Store } from 'express-session';
import { createClient } from 'redis';
import { loadAppConfig } from '../config/app-config';
import { SessionRuntimeService } from './session-runtime.service';

const redisServerError = spawnSync('redis-server', ['--version']).error;
const redisServerMissing =
  redisServerError && 'code' in redisServerError && redisServerError.code === 'ENOENT';

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'condition did not become true before the deadline');
    await delay(25);
  }
}

function runtime(port: number): SessionRuntimeService {
  return new SessionRuntimeService({
    ...loadAppConfig({
      NODE_ENV: 'test',
      REDIS_URL: `redis://127.0.0.1:${port}`,
      REDIS_PREFIX: 'synthetic-recovery-test:',
    }),
    nodeEnv: 'production',
  });
}

function get(store: Store, id: string): Promise<SessionData | null | undefined> {
  return new Promise((resolve, reject) =>
    store.get(id, (error, data) => (error ? reject(error) : resolve(data))),
  );
}

function set(store: Store, id: string, data: SessionData): Promise<void> {
  return new Promise((resolve, reject) =>
    store.set(id, data, (error) => (error ? reject(error) : resolve())),
  );
}

test('production Redis session startup fails promptly instead of silently switching to memory', async () => {
  const service = runtime(await unusedPort());
  const started = Date.now();
  await assert.rejects(service.createStore(), { message: 'Redis session store unavailable.' });
  assert.ok(Date.now() - started < 2500);
  assert.deepEqual(service.health, { ready: false, message: 'Redis connection unavailable.' });
  await service.onApplicationShutdown();
});

test('an accepted connection that never completes the Redis handshake still has a startup deadline', async (t) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const service = runtime(address.port);
  t.after(async () => {
    await service.onApplicationShutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const started = Date.now();
  await assert.rejects(service.createStore(), { message: 'Redis session store unavailable.' });
  assert.ok(Date.now() - started < 3500, 'an incomplete handshake must not hang API startup');
  assert.deepEqual(service.health, { ready: false, message: 'Redis connection unavailable.' });
});

for (const persistence of ['rdb', 'aof'] as const)
  test(
    `saved sessions survive API restart and Redis ${persistence.toUpperCase()} reload while the API reconnects`,
    {
      timeout: 20000,
      skip: redisServerMissing
        ? 'Redis integration test requires the local redis-server binary'
        : false,
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'orsem-session-redis-test-'));
      const port = await unusedPort();
      let redis: ChildProcess | undefined;
      const services: SessionRuntimeService[] = [];
      const inspectionClients: ReturnType<typeof createClient>[] = [];
      const stopRedis = async () => {
        if (!redis || redis.exitCode !== null || redis.signalCode !== null) return;
        const closed = once(redis, 'close');
        redis.kill('SIGKILL');
        await closed;
      };
      t.after(async () => {
        for (const client of inspectionClients) if (client.isOpen) client.destroy();
        await Promise.all(services.map((service) => service.onApplicationShutdown()));
        await stopRedis();
        await rm(directory, { recursive: true, force: true });
      });
      const startRedis = async () => {
        redis = spawn(
          'redis-server',
          [
            '--bind',
            '127.0.0.1',
            '--port',
            String(port),
            '--dir',
            directory,
            '--dbfilename',
            'synthetic-session.rdb',
            '--save',
            '',
            '--appendonly',
            persistence === 'aof' ? 'yes' : 'no',
            '--appendfsync',
            'everysec',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        let launchError: Error | null = null;
        redis.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        redis.stderr?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        redis.once('error', (error) => {
          launchError = error;
        });
        await eventually(() => {
          if (launchError) throw launchError;
          if (redis?.exitCode !== null && redis?.exitCode !== undefined) {
            throw new Error(`Isolated Redis failed to start: ${output}`);
          }
          return output.includes('Ready to accept connections');
        });
      };
      const inspector = async () => {
        const client = createClient({
          url: `redis://127.0.0.1:${port}`,
          socket: { connectTimeout: 1000, reconnectStrategy: false },
          disableOfflineQueue: true,
        });
        client.on('error', () => {});
        inspectionClients.push(client);
        await client.connect();
        return client;
      };
      const newService = async () => {
        const service = runtime(port);
        services.push(service);
        const store = await service.createStore();
        assert.ok(store);
        return { service, store };
      };

      await startRedis();
      const before = await inspector();
      // For AOF, take an empty baseline before sign-in. A later snapshot must not rescue the test.
      await before.sendCommand(['SAVE']);
      const baseline = await readFile(join(directory, 'synthetic-session.rdb'));
      const baselinePersistence = await before.info('persistence');
      const baselineAofSize = Number(baselinePersistence.match(/^aof_current_size:(\d+)/mu)?.[1]);
      const first = await newService();
      const sessionId = 'synthetic-session-that-never-reaches-production';
      const cookie = new session.Cookie();
      cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
      const data: SessionData = {
        cookie,
        memberId: 'synthetic-member',
        sessionStartedAt: new Date().toISOString(),
      };
      await set(first.store, sessionId, data);
      await first.service.onApplicationShutdown();
      const second = await newService();
      assert.equal((await get(second.store, sessionId))?.memberId, data.memberId);

      if (persistence === 'rdb') {
        await before.sendCommand(['SAVE']);
      } else {
        assert.equal((await before.configGet('appendfsync')).appendfsync, 'everysec');
        // Allow the every-second fsync worker to run, then ensure all writes have reached its queue.
        await delay(2200);
        await eventually(async () => {
          const info = await before.info('persistence');
          const field = (name: string) =>
            info.match(new RegExp(`^${name}:([^\\r\\n]+)`, 'mu'))?.[1];
          return (
            field('aof_last_write_status') === 'ok' &&
            field('aof_buffer_length') === '0' &&
            field('aof_pending_bio_fsync') === '0' &&
            Number(field('aof_current_size')) > baselineAofSize
          );
        });
        assert.deepEqual(
          await readFile(join(directory, 'synthetic-session.rdb')),
          baseline,
          'the session must never have reached an RDB snapshot before the crash',
        );
      }
      await before.quit();
      await stopRedis();
      await eventually(() => !second.service.health.ready);
      assert.equal(second.service.health.message, 'Redis connection unavailable.');
      const failedReadStarted = Date.now();
      await assert.rejects(get(second.store, sessionId));
      assert.ok(
        Date.now() - failedReadStarted < 1000,
        'offline reads must not wait for Redis recovery',
      );

      await startRedis();
      await eventually(() => second.service.health.ready);
      assert.deepEqual(second.service.health, { ready: true, message: null });
      assert.equal((await get(second.store, sessionId))?.memberId, data.memberId);
      const after = await inspector();
      const ttl = await after.ttl(`synthetic-recovery-test:session:${sessionId}`);
      assert.ok(ttl > 29 * 24 * 60 * 60, 'persisted session retains its expiration');

      await stopRedis();
      await eventually(() => !second.service.health.ready);
      const shutdownStarted = Date.now();
      await second.service.onApplicationShutdown();
      assert.ok(Date.now() - shutdownStarted < 1000, 'shutdown must stop reconnection promptly');
      await startRedis();
      await delay(750);
      assert.equal(second.service.health.ready, false, 'a stopped service must not reconnect');
    },
  );
