import type { DataSource } from 'typeorm';
import {
  NEWS_API_WINDOW_MS,
  newsApiBudgetStore,
  reserveNewsApiRequest,
  type NewsApiBudgetState,
} from '../src/connectors/news-api-budget';

const now = new Date('2026-09-07T23:59:50.000Z');
const empty: NewsApiBudgetState = { reservations: [], retryAt: null, lastError: null };

/** Transaction emulator serializes the same stable lock across independent store instances. */
function databaseHarness() {
  const rows = new Map<string, unknown>();
  const counters = new Map<string, number>();
  const queries: string[] = [];
  let chain = Promise.resolve();
  const database = {
    transaction: jest.fn(
      async (
        work: (manager: {
          query: (sql: string, args: unknown[]) => Promise<unknown>;
        }) => Promise<void>,
      ) => {
        const previous = chain;
        let release!: () => void;
        chain = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        const localRows = new Map(rows);
        const localCounters = new Map(counters);
        try {
          await work({
            async query(sql, args) {
              queries.push(sql);
              if (sql.includes('INSERT INTO source_checkpoints')) {
                const key = `${args[1]}:${args[2]}`;
                if (!localRows.has(key)) localRows.set(key, null);
                return [];
              }
              if (sql.startsWith('SELECT metadata_json')) {
                expect(sql).toContain('FOR UPDATE');
                return [{ metadataJson: localRows.get(`${args[0]}:${args[1]}`) }];
              }
              if (sql.includes('INSERT INTO api_usage_counters')) {
                const key = `${args[1]}:${args[2]}`;
                localCounters.set(key, (localCounters.get(key) ?? 0) + 1);
                return [];
              }
              if (sql.startsWith('UPDATE source_checkpoints')) {
                localRows.set(`${args[1]}:${args[2]}`, JSON.parse(String(args[0])));
                return [];
              }
              throw new Error('Unexpected SQL');
            },
          });
          rows.clear();
          localRows.forEach((value, key) => rows.set(key, value));
          counters.clear();
          localCounters.forEach((value, key) => counters.set(key, value));
        } finally {
          release();
        }
      },
    ),
  } as unknown as DataSource;
  return { database, rows, counters, queries };
}

describe('durable free news request reservations', () => {
  it('rejects daily and minute exhaustion with the actual rolling expiry', () => {
    const state = { ...empty, reservations: [now.getTime() - 1000, now.getTime() - 500] };
    expect(() =>
      reserveNewsApiRequest('MARKETAUX', state, { daily: 2, perMinute: null }, now),
    ).toThrow();
    try {
      reserveNewsApiRequest('FINNHUB', state, { daily: 120, perMinute: 2 }, now);
    } catch (error) {
      expect(error).toMatchObject({
        httpStatus: 429,
        retryAt: new Date(now.getTime() + 59_000),
        requestAttempted: false,
      });
    }
  });
  it('retains history across UTC or KST midnight and expires only after 24 hours', () => {
    const first = reserveNewsApiRequest('MARKETAUX', empty, { daily: 1, perMinute: null }, now);
    expect(() =>
      reserveNewsApiRequest(
        'MARKETAUX',
        first,
        { daily: 1, perMinute: null },
        new Date('2026-09-08T00:00:01Z'),
      ),
    ).toThrow();
    expect(
      reserveNewsApiRequest(
        'MARKETAUX',
        first,
        { daily: 1, perMinute: null },
        new Date(now.getTime() + NEWS_API_WINDOW_MS),
      ).reservations,
    ).toEqual([now.getTime() + NEWS_API_WINDOW_MS]);
  });
  it('reserves atomically across simultaneous workers and recreating stores does not reset usage', async () => {
    const db = databaseHarness();
    const first = newsApiBudgetStore(db.database, () => now);
    const second = newsApiBudgetStore(db.database, () => now);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).reserve('MARKETAUX', { daily: 3, perMinute: null }),
      ),
    );
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(3);
    expect(db.counters.get('MARKETAUX:2026-09-07')).toBe(3);
    await expect(
      newsApiBudgetStore(db.database, () => now).reserve('MARKETAUX', {
        daily: 3,
        perMinute: null,
      }),
    ).rejects.toMatchObject({ httpStatus: 429 });
    expect(db.queries.filter((sql) => sql.includes('FOR UPDATE'))).toHaveLength(13);
  });
  it('counts reservations even if the subsequent HTTP request fails', async () => {
    const db = databaseHarness();
    const store = newsApiBudgetStore(db.database, () => now);
    await store.reserve('FINNHUB', { daily: 1, perMinute: 10 });
    await store.defer('FINNHUB', new Date(now.getTime() + 60_000), 'PROVIDER_FAILURE');
    expect(db.counters.get('FINNHUB:2026-09-07')).toBe(1);
    await expect(store.reserve('FINNHUB', { daily: 1, perMinute: 10 })).rejects.toMatchObject({
      httpStatus: 429,
      requestAttempted: false,
    });
  });
  it('keeps cooldown durable and never shortens an existing cooldown', async () => {
    const db = databaseHarness();
    const store = newsApiBudgetStore(db.database, () => now);
    await store.defer('MARKETAUX', new Date(now.getTime() + NEWS_API_WINDOW_MS), 'DAILY_LIMIT');
    await newsApiBudgetStore(db.database, () => now).defer(
      'MARKETAUX',
      new Date(now.getTime() + 60_000),
      'RATE_LIMIT',
    );
    await expect(store.reserve('MARKETAUX', { daily: 50, perMinute: null })).rejects.toMatchObject({
      retryAt: new Date(now.getTime() + NEWS_API_WINDOW_MS),
    });
    await expect(
      store.reserve('ALPHAVANTAGE', { daily: 20, perMinute: null }),
    ).resolves.toBeUndefined();
    expect(db.counters.get('ALPHAVANTAGE:2026-09-07')).toBe(1);
  });
  it('fails closed for corrupt persisted budgets and invalid configuration', async () => {
    const db = databaseHarness();
    db.rows.set('MARKETAUX:NEWS_API_BUDGET', { reservations: ['bad'] });
    await expect(
      newsApiBudgetStore(db.database, () => now).reserve('MARKETAUX', {
        daily: 50,
        perMinute: null,
      }),
    ).rejects.toThrow('budget is invalid');
    expect(db.counters.size).toBe(0);
    expect(() =>
      reserveNewsApiRequest('MARKETAUX', empty, { daily: 0, perMinute: null }, now),
    ).toThrow();
  });
});
