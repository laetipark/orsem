import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { checkRedisHealth, evaluateRedisPersistence } from './check-redis-health.mjs';

const healthyRdb = '# Persistence\r\nrdb_last_bgsave_status:ok\r\naof_enabled:0\r\n';
const healthyAof = [
  'rdb_last_bgsave_status:ok',
  'aof_enabled:1',
  'aof_last_write_status:ok',
  'aof_last_bgrewrite_status:ok',
].join('\r\n');
const environment = { REDIS_URL: 'redis://private-user:private-secret@localhost:6379/0' };

function fakeClient(overrides = {}) {
  const client = new EventEmitter();
  client.isOpen = false;
  client.commands = [];
  client.destroyed = false;
  client.connect = async () => {
    client.isOpen = true;
  };
  client.info = async (section) => {
    client.commands.push(['INFO', section]);
    return healthyRdb;
  };
  client.destroy = () => {
    client.isOpen = false;
    client.destroyed = true;
  };
  return Object.assign(client, overrides);
}

test('Redis diagnostics flag the failed RDB snapshot that can block login writes', () => {
  const result = evaluateRedisPersistence(healthyRdb.replace('status:ok', 'status:err'));
  assert.equal(result.state, 'FAIL');
  assert.match(result.detail, /RDB snapshot failed.*reject writes/);
});

test('Redis diagnostics verify enabled AOF writes and rewrites', () => {
  assert.equal(evaluateRedisPersistence(healthyAof).state, 'OK');
  for (const name of ['aof_last_write_status', 'aof_last_bgrewrite_status']) {
    const result = evaluateRedisPersistence(healthyAof.replace(`${name}:ok`, `${name}:err`));
    assert.equal(result.state, 'FAIL');
    assert.match(result.detail, /AOF/);
  }
  assert.equal(evaluateRedisPersistence(`${healthyRdb}aof_last_write_status:err\r\n`).state, 'OK');
});

test('Redis diagnostics never mark missing or unrecognized persistence statuses healthy', () => {
  for (const info of [
    undefined,
    '',
    'private-server-response',
    'aof_enabled:0',
    'rdb_last_bgsave_status:ok',
    healthyRdb.replace('status:ok', 'status:private-server-response'),
    healthyAof.replace('aof_last_write_status:ok', ''),
    healthyAof.replace('aof_last_bgrewrite_status:ok', ''),
  ]) {
    const result = evaluateRedisPersistence(info);
    assert.equal(result.state, 'WARN');
    assert.doesNotMatch(JSON.stringify(result), /private-server-response/);
  }
});

test('Redis diagnostics skip unused or absent configuration without creating a client', async () => {
  const clientFactory = () => assert.fail('client must not be created');
  assert.equal((await checkRedisHealth({}, { clientFactory })).state, 'WARN');
  for (const FIXTURE_MODE of ['1', ' true ', 'YES', 'on']) {
    assert.equal(
      (await checkRedisHealth({ ...environment, FIXTURE_MODE }, { clientFactory })).state,
      'DISABLED',
    );
  }
  for (const REDIS_URL of ['private-secret', 'https://private-user:private-secret@localhost']) {
    const result = await checkRedisHealth({ REDIS_URL }, { clientFactory });
    assert.equal(result.state, 'FAIL');
    assert.doesNotMatch(JSON.stringify(result), /private-user|private-secret/);
  }
});

test('Redis diagnostics only read persistence INFO and close their own client', async () => {
  const client = fakeClient();
  const result = await checkRedisHealth(environment, {
    clientFactory: (options) => {
      assert.equal(options.socket.reconnectStrategy, false);
      assert.equal(options.socket.connectTimeout, 1_500);
      assert.equal(options.disableOfflineQueue, true);
      return client;
    },
  });
  assert.equal(result.state, 'OK');
  assert.deepEqual(client.commands, [['INFO', 'persistence']]);
  assert.equal(client.destroyed, true);
  assert.doesNotMatch(JSON.stringify(result), /private-user|private-secret/);
});

test('Redis diagnostics sanitize connection, INFO, emitted, and cleanup errors', async () => {
  for (const method of ['connect', 'info']) {
    const client = fakeClient({
      [method]: async () => {
        client.isOpen = true;
        client.emit('error', new Error('private-emitted-error'));
        throw new Error('private-server-error');
      },
    });
    const result = await checkRedisHealth(environment, { clientFactory: () => client });
    assert.equal(result.state, 'FAIL');
    assert.equal(client.destroyed, true);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
  const result = await checkRedisHealth(environment, {
    clientFactory: () => {
      throw new Error('private-factory-error');
    },
  });
  assert.equal(result.state, 'FAIL');
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  const cleanupClient = fakeClient({
    destroy: () => {
      throw new Error('private-cleanup-error');
    },
  });
  assert.equal(
    (await checkRedisHealth(environment, { clientFactory: () => cleanupClient })).state,
    'OK',
  );
});

for (const method of ['connect', 'info']) {
  test(`Redis diagnostics bound a stalled ${method} and close the client`, async () => {
    const client = fakeClient({
      [method]: () => {
        client.isOpen = true;
        return new Promise(() => {});
      },
    });
    const result = await checkRedisHealth(environment, {
      clientFactory: () => client,
      timeoutMs: 20,
    });
    assert.equal(result.state, 'FAIL');
    assert.match(result.detail, /timed out/);
    assert.equal(client.destroyed, true);
  });
}
