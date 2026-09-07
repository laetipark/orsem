import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { ConnectorRequestError } from './connector-adapters';

export type FreeNewsProvider = 'MARKETAUX' | 'ALPHAVANTAGE' | 'FINNHUB';
export const NEWS_API_BUDGET_STREAM = 'NEWS_API_BUDGET';
export const NEWS_API_WINDOW_MS = 24 * 60 * 60_000;
export interface NewsApiBudgetLimits {
  daily: number;
  perMinute: number | null;
}
export interface NewsApiBudgetStore {
  reserve(provider: FreeNewsProvider, limits: NewsApiBudgetLimits): Promise<void>;
  defer(provider: FreeNewsProvider, retryAt: Date, reason: string): Promise<void>;
}

export interface NewsApiBudgetState {
  reservations: number[];
  retryAt: string | null;
  lastError: string | null;
  dailyRequestBudget?: number;
}

function readState(raw: unknown): NewsApiBudgetState {
  if (raw === null || raw === undefined)
    return { reservations: [], retryAt: null, lastError: null };
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object') throw new Error('News request budget is invalid.');
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.reservations) ||
    record.reservations.length > 10_000 ||
    !record.reservations.every((item) => typeof item === 'number' && Number.isFinite(item)) ||
    (record.retryAt !== null &&
      record.retryAt !== undefined &&
      (typeof record.retryAt !== 'string' || !Number.isFinite(Date.parse(record.retryAt))))
  )
    throw new Error('News request budget is invalid.');
  return {
    reservations: record.reservations as number[],
    retryAt: typeof record.retryAt === 'string' ? record.retryAt : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    ...(typeof record.dailyRequestBudget === 'number'
      ? { dailyRequestBudget: record.dailyRequestBudget }
      : {}),
  };
}

/** Pure transition shared by the transactional store and its deterministic tests. */
export function reserveNewsApiRequest(
  provider: FreeNewsProvider,
  state: NewsApiBudgetState,
  limits: NewsApiBudgetLimits,
  now: Date,
): NewsApiBudgetState {
  if (
    !Number.isInteger(limits.daily) ||
    limits.daily < 1 ||
    limits.daily > 1000 ||
    (limits.perMinute !== null && (!Number.isInteger(limits.perMinute) || limits.perMinute < 1))
  )
    throw new Error('News request budget limits are invalid.');
  const at = now.getTime();
  const reservations = state.reservations
    .filter((time) => time > at - NEWS_API_WINDOW_MS)
    .sort((a, b) => a - b);
  let retryAt = state.retryAt ? Date.parse(state.retryAt) : 0;
  if (reservations.length >= limits.daily)
    retryAt = Math.max(
      retryAt,
      reservations[reservations.length - limits.daily]! + NEWS_API_WINDOW_MS,
    );
  const minute = reservations.filter((time) => time > at - 60_000);
  if (limits.perMinute !== null && minute.length >= limits.perMinute)
    retryAt = Math.max(retryAt, minute[minute.length - limits.perMinute]! + 60_000);
  if (retryAt > at)
    throw new ConnectorRequestError(
      provider,
      'news-budget',
      429,
      null,
      new Date(retryAt),
      null,
      null,
      false,
    );
  return {
    reservations: [...reservations, at],
    retryAt: null,
    lastError: null,
    dailyRequestBudget: limits.daily,
  };
}

async function lockedState(manager: EntityManager, provider: FreeNewsProvider) {
  await manager.query(
    `INSERT INTO source_checkpoints
     (id,connector,stream,created_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE id=id`,
    [randomUUID(), provider, NEWS_API_BUDGET_STREAM],
  );
  const rows: Array<{ metadataJson: unknown }> = await manager.query(
    'SELECT metadata_json AS metadataJson FROM source_checkpoints WHERE connector=? AND stream=? FOR UPDATE',
    [provider, NEWS_API_BUDGET_STREAM],
  );
  if (rows.length !== 1) throw new Error('News request budget lock is unavailable.');
  return readState(rows[0]!.metadataJson);
}

async function writeState(
  manager: EntityManager,
  provider: FreeNewsProvider,
  state: NewsApiBudgetState,
  daily?: number,
) {
  await manager.query(
    'UPDATE source_checkpoints SET metadata_json=?,updated_at=UTC_TIMESTAMP(6) WHERE connector=? AND stream=?',
    [
      JSON.stringify({
        version: 1,
        ...state,
        dailyRequestBudget: daily ?? state.dailyRequestBudget ?? null,
        rollingRequestBudget: daily ?? state.dailyRequestBudget ?? null,
        rollingRequestCount: state.reservations.length,
        requestBudgetWindow: 'ROLLING_24_HOURS',
      }),
      provider,
      NEWS_API_BUDGET_STREAM,
    ],
  );
}

/** A reservation is committed before HTTP; failed requests never refund the allowance. */
export function newsApiBudgetStore(
  dataSource: DataSource,
  clock: () => Date = () => new Date(),
): NewsApiBudgetStore {
  return {
    async reserve(provider, limits) {
      await dataSource.transaction(async (manager) => {
        const state = await lockedState(manager, provider);
        const now = clock();
        const reserved = reserveNewsApiRequest(provider, state, limits, now);
        await manager.query(
          `INSERT INTO api_usage_counters
           (id,connector,usage_date,request_count,item_count,last_request_at,created_at,updated_at)
           VALUES (?,?,?,1,0,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))
           ON DUPLICATE KEY UPDATE request_count=request_count+1,last_request_at=VALUES(last_request_at),updated_at=UTC_TIMESTAMP(6)`,
          [randomUUID(), provider, now.toISOString().slice(0, 10), now],
        );
        await writeState(manager, provider, reserved, limits.daily);
      });
    },
    async defer(provider, retryAt, reason) {
      if (!Number.isFinite(retryAt.getTime()) || !/^[A-Z_0-9]{1,64}$/.test(reason))
        throw new Error('Invalid news cooldown.');
      await dataSource.transaction(async (manager) => {
        const state = await lockedState(manager, provider);
        state.retryAt = new Date(
          Math.max(Date.parse(state.retryAt ?? '') || 0, retryAt.getTime()),
        ).toISOString();
        state.lastError = reason;
        await writeState(manager, provider, state);
      });
    },
  };
}

export const unavailableNewsApiBudgetStore: NewsApiBudgetStore = {
  async reserve() {
    throw new Error('Durable news request budget storage is required.');
  },
  async defer() {
    throw new Error('Durable news request budget storage is required.');
  },
};
