import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection, QueryError } from 'mysql2';
import { withUtcSessions } from './utc-mysql-driver';

test('a pooled connection is not handed out until server timezone is set, including reuse', async () => {
  const order: string[] = [];
  const connection = {
    query: (sql: string, callback: (error: Error | null) => void) => {
      assert.equal(sql, "SET SESSION time_zone = '+00:00'");
      order.push('set-utc');
      queueMicrotask(() => callback(null));
    },
  } as unknown as PoolConnection;
  const pool = withUtcSessions({
    getConnection: (callback: (error: null, value: PoolConnection) => void) =>
      callback(null, connection),
  } as Pool);
  for (let index = 0; index < 2; index++) {
    await new Promise<void>((resolve, reject) =>
      pool.getConnection((error, value) => {
        if (error) return reject(error);
        assert.equal(value, connection);
        order.push('query');
        resolve();
      }),
    );
  }
  assert.deepEqual(order, ['set-utc', 'query', 'set-utc', 'query']);
});

test('timezone setup failure discards the connection instead of writing local timestamps', async () => {
  let destroyed = false;
  const failure = new Error('timezone unavailable') as QueryError;
  const pool = withUtcSessions({
    getConnection: (callback: (error: null, value: PoolConnection) => void) =>
      callback(null, {
        query: (_sql: string, done: (error: QueryError) => void) => done(failure),
        destroy: () => {
          destroyed = true;
        },
      } as unknown as PoolConnection),
  } as Pool);
  await new Promise<void>((resolve) =>
    pool.getConnection((error, connection) => {
      assert.equal(error, failure);
      assert.equal(connection, undefined);
      assert.equal(destroyed, true);
      resolve();
    }),
  );
});
