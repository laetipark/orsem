import * as mysql from 'mysql2';
import type { Pool, PoolConnection, PoolOptions } from 'mysql2';

/** Set the server session as well as the client's Date encoder to UTC. */
export function withUtcSessions(pool: Pool): Pool {
  const acquire = pool.getConnection.bind(pool);
  pool.getConnection = (callback) => {
    acquire((error, connection) => {
      if (error) return callback(error, connection);
      // Run on every checkout: a reused connection may have changed its session.
      connection.query("SET SESSION time_zone = '+00:00'", (timezoneError) => {
        if (timezoneError) {
          connection.destroy();
          callback(timezoneError, undefined as unknown as PoolConnection);
          return;
        }
        callback(null, connection);
      });
    });
  };
  return pool;
}

export const utcMysqlDriver = {
  ...mysql,
  createPool: (options: PoolOptions) => withUtcSessions(mysql.createPool(options)),
};
