import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { loadAppConfig } from '../config/app-config';
import { SessionRuntimeService } from '../security/session-runtime.service';

// Never use REDIS_URL: this test creates a private nonpersistent Unix-socket Redis.
// An explicitly supplied test socket supports sandboxed test runners and must be under /tmp.
test('actual Redis atomically caps concurrent logos across API instances and rolls the window conservatively', async (t) => {
  const supplied = process.env.ORSEM_LOGO_TEST_REDIS_SOCKET;
  if (supplied && !/^\/tmp\/orsem-logo-[A-Za-z0-9_/-]+\.sock$/u.test(supplied))
    throw new Error('Only an isolated /tmp/orsem-logo-*.sock test server may be used');
  const directory = await mkdtemp(join(tmpdir(), 'orsem-logo-redis-'));
  const socket = supplied ?? join(directory, 'redis.sock');
  let server: ChildProcess | null = null;
  let client: ReturnType<typeof createClient> | null = null;
  const prefix = `orsem-logo-regression:${randomUUID()}:`;
  t.after(async () => {
    if (client?.isReady) {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length) await client.del(keys);
      await client.quit();
    }
    if (server?.pid && server.exitCode === null) {
      const stopped = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
      server.kill('SIGTERM');
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  });
  if (!supplied) {
    server = spawn(
      'redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        socket,
        '--unixsocketperm',
        '700',
        '--save',
        '',
        '--appendonly',
        'no',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const ready = await new Promise<'ready' | 'unavailable' | 'sandbox'>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(
        () => reject(new Error('Isolated Redis did not become ready')),
        5000,
      );
      const finish = (value: 'ready' | 'unavailable' | 'sandbox') => {
        clearTimeout(timeout);
        resolve(value);
      };
      server!.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (error.code === 'ENOENT') finish('unavailable');
        else reject(error);
      });
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('ready to accept connections')) finish('ready');
      };
      server!.stdout!.on('data', read);
      server!.stderr!.on('data', read);
      server!.on('exit', () => {
        if (/Operation not permitted|Permission denied/u.test(output)) finish('sandbox');
        else {
          clearTimeout(timeout);
          reject(new Error('Isolated Redis exited before readiness'));
        }
      });
    });
    if (ready !== 'ready') {
      t.skip(
        ready === 'unavailable'
          ? 'redis-server binary is not installed'
          : 'sandbox blocks local Unix sockets; rerun with an isolated permitted Redis socket',
      );
      return;
    }
  }
  client = createClient({
    socket: { path: socket, connectTimeout: 1500, reconnectStrategy: false },
  });
  client.on('error', () => undefined);
  await client.connect();
  const first = new SessionRuntimeService(
    loadAppConfig({ NODE_ENV: 'test', REDIS_PREFIX: prefix }),
  );
  const second = new SessionRuntimeService(
    loadAppConfig({ NODE_ENV: 'test', REDIS_PREFIX: prefix }),
  );
  (first as unknown as { client: unknown }).client = client;
  (second as unknown as { client: unknown }).client = client;
  const base = Date.now();
  const time = t.mock.method(Date, 'now', () => base);
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      (i % 2 ? first : second).consumeCompanyLogoBudget('logoDev', 17),
    ),
  );
  assert.equal(results.filter(Boolean).length, 17);
  assert.equal(await first.consumeCompanyLogoBudget('logoDev', 17), false);
  assert.equal(await first.consumeCompanyLogoBudget('brandfetch', 17), true);
  for (const days of [1, 31, 32]) {
    time.mock.mockImplementation(() => base + days * 86_400_000);
    assert.equal(
      await second.consumeCompanyLogoBudget('logoDev', 17),
      false,
      `cap must not reset at day ${days}`,
    );
  }
  time.mock.mockImplementation(() => base + 33 * 86_400_000);
  assert.equal(await second.consumeCompanyLogoBudget('logoDev', 17), true);
  const date = new Date(Date.now()).toISOString().slice(0, 10);
  const key = `${prefix}logo:budget:logoDev:${date}`;
  assert.equal(await client.get(key), '1');
  assert.ok((await client.pTTL(key)) > 33 * 86_400_000);
  await client.set(key, 'corrupt-counter');
  assert.equal(await second.consumeCompanyLogoBudget('logoDev', 17), false);
  (first as unknown as { client: unknown }).client = null;
  assert.equal(await first.consumeCompanyLogoBudget('brandfetch', 17), false);
});
