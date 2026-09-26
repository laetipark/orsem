import { createClient } from 'redis';

const persistenceFields = new Set([
  'rdb_last_bgsave_status',
  'aof_enabled',
  'aof_last_write_status',
  'aof_last_bgrewrite_status',
]);

// Only known status fields influence output; never return raw INFO or error messages.
export function evaluateRedisPersistence(info) {
  if (typeof info !== 'string') {
    return { state: 'WARN', detail: 'persistence health could not be verified' };
  }
  const fields = new Map();
  for (const line of info.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    const name = line.slice(0, separator);
    if (persistenceFields.has(name)) fields.set(name, line.slice(separator + 1));
  }
  if (fields.get('rdb_last_bgsave_status') === 'err') {
    return {
      state: 'FAIL',
      detail: 'RDB snapshot failed; Redis may reject writes; check disk space and Redis logs',
    };
  }
  const aofEnabled = fields.get('aof_enabled');
  if (aofEnabled === '1') {
    if (fields.get('aof_last_write_status') === 'err') {
      return { state: 'FAIL', detail: 'AOF writes failed; check disk space and Redis logs' };
    }
    if (fields.get('aof_last_bgrewrite_status') === 'err') {
      return { state: 'FAIL', detail: 'AOF rewrite failed; check disk space and Redis logs' };
    }
  }
  if (
    fields.get('rdb_last_bgsave_status') !== 'ok' ||
    !['0', '1'].includes(aofEnabled) ||
    (aofEnabled === '1' &&
      (fields.get('aof_last_write_status') !== 'ok' ||
        fields.get('aof_last_bgrewrite_status') !== 'ok'))
  ) {
    return { state: 'WARN', detail: 'persistence health could not be verified' };
  }
  return { state: 'OK', detail: 'connected; RDB and enabled AOF persistence report healthy' };
}

export async function checkRedisHealth(
  environment,
  { clientFactory = createClient, timeoutMs = 1_500 } = {},
) {
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  if (['1', 'true', 'yes', 'on'].includes(trim(environment.FIXTURE_MODE).toLowerCase())) {
    return { state: 'DISABLED', detail: 'fixture mode uses an in-memory session store' };
  }
  const value = trim(environment.REDIS_URL);
  if (!value) return { state: 'WARN', detail: 'not configured' };
  try {
    const url = new URL(value);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    return { state: 'FAIL', detail: 'invalid Redis URL' };
  }

  let client;
  let timer;
  let expired = false;
  try {
    client = clientFactory({
      url: value,
      socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
      disableOfflineQueue: true,
    });
    // node-redis requires an error listener; errors must not expose credentials or server text.
    client.on('error', () => {});
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error());
      }, timeoutMs);
    });
    const request = async () => {
      await client.connect();
      if (expired) throw new Error();
      return evaluateRedisPersistence(await client.info('persistence'));
    };
    return await Promise.race([request(), deadline]);
  } catch {
    return {
      state: 'FAIL',
      detail: expired
        ? 'connection or persistence check timed out'
        : 'connection or persistence check failed; check connectivity, credentials and INFO permission',
    };
  } finally {
    clearTimeout(timer);
    try {
      if (client?.isOpen) client.destroy();
    } catch {
      // Cleanup errors must not replace a sanitized diagnostic result.
    }
  }
}
