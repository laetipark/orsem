import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import {
  NaverNewsBudgetService,
  naverUsagePeriod,
  NAVER_ROLLING_INTERVAL_MS,
} from './naver-news-budget.service';
import { NaverNewsSearchService } from './naver-news-search.service';

const now = new Date('2026-09-06T00:00:00Z');
function config(extra: NodeJS.ProcessEnv = {}) {
  return loadAppConfig({
    NODE_ENV: 'test',
    NAVER_API_PROVIDER: 'ncloud',
    NAVER_CLIENT_ID: 'synthetic',
    NAVER_CLIENT_SECRET: 'synthetic-secret',
    NAVER_NEWS_FREE_UNTIL: '2026-09-07T00:00:00Z',
    NAVER_NEWS_FREE_MONTH: '2026-09',
    NAVER_NEWS_FREE_REQUESTS: '100',
    NAVER_NEWS_DAILY_LIMIT: '10',
    NAVER_NEWS_MONTHLY_LIMIT: '100',
    ...extra,
  });
}

function database(daily = 0, monthly = 0, previousRequest: Date | null = null) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const counters = new Map<string, number>([
    ['2026-09-01', monthly - daily],
    ['2026-09-06', daily],
  ]);
  let metadata: unknown = null;
  let lastRequestAt = previousRequest;
  const query = async (sql: string, args: unknown[] = []) => {
    if (sql.includes('SUM('))
      return [
        {
          daily: String(counters.get(String(args[0])) ?? 0),
          monthly: String(
            [...counters].reduce(
              (sum, [date, count]) =>
                date >= String(args[2]) && date <= String(args[3]) ? sum + count : sum,
              0,
            ),
          ),
        },
      ];
    if (sql.includes('MAX(last_request_at)'))
      return [{ lastRequestAt: lastRequestAt?.toISOString() ?? null }];
    if (sql.startsWith('SELECT metadata_json')) {
      writes.push({ sql, args });
      return [{ metadataJson: structuredClone(metadata) }];
    }
    if (sql.startsWith('UPDATE source_checkpoints')) metadata = JSON.parse(String(args[0]));
    if (sql.startsWith('INSERT INTO api_usage_counters')) {
      const day = String(args[2]);
      counters.set(day, (counters.get(day) ?? 0) + 1);
      lastRequestAt = args[3] as Date;
    }
    writes.push({ sql, args });
    return [];
  };
  let turn = Promise.resolve();
  const source = {
    query,
    transaction<T>(fn: (manager: { query: typeof query }) => Promise<T>): Promise<T> {
      const result = turn.then(() => fn({ query }));
      turn = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return {
    value: { requireDataSource: () => source } as unknown as DatabaseRuntimeService,
    writes,
    metadata: () => structuredClone(metadata),
    setMetadata: (value: unknown) => {
      metadata = value;
    },
  };
}

test('NAVER quota periods use KST midnight and month boundary', () => {
  assert.deepEqual(naverUsagePeriod(new Date('2026-09-30T14:59:59Z')), {
    day: '2026-09-30',
    month: '2026-09',
    firstDay: '2026-09-01',
  });
  assert.deepEqual(naverUsagePeriod(new Date('2026-09-30T15:00:00Z')), {
    day: '2026-10-01',
    month: '2026-10',
    firstDay: '2026-10-01',
  });
});

test('expired, unverified and previous-month free allowance prevent any reservation', async () => {
  for (const extra of [
    { NAVER_NEWS_FREE_UNTIL: '' },
    { NAVER_NEWS_FREE_UNTIL: '2026-09-05T00:00:00Z' },
    { NAVER_NEWS_FREE_MONTH: '2026-08' },
    { NAVER_NEWS_FREE_REQUESTS: '0' },
  ]) {
    const db = database();
    const service = new NaverNewsBudgetService(config(extra), db.value);
    assert.equal((await service.status(now)).automaticAllowed, false);
    await assert.rejects(
      () => service.reserve(now),
      (e) => e instanceof HttpException && e.getStatus() === 503,
    );
    assert.equal(db.writes.length, 0);
  }
});

test('free allowance caps the app budget and exhausted day/month blocks requests', async () => {
  const db = database(3, 8);
  const service = new NaverNewsBudgetService(config({ NAVER_NEWS_FREE_REQUESTS: '9' }), db.value);
  assert.deepEqual(await service.status(now), {
    configured: true,
    automaticAllowed: true,
    mode: 'ON_DEMAND',
    freeUntil: '2026-09-07T00:00:00Z',
    dailyLimit: 10,
    monthlyLimit: 9,
    remainingToday: 7,
    remainingMonth: 1,
    rollingLimit: 10,
    remainingWindow: 10,
    nextRequestAt: null,
    reason: null,
  });
  await service.reserve(now);
  await assert.rejects(
    () => service.reserve(now),
    (e) => e instanceof HttpException && e.getStatus() === 429,
  );
  assert.equal((await service.status(now)).automaticAllowed, false);
  const daily = new NaverNewsBudgetService(config(), database(10, 10).value);
  await assert.rejects(
    () => daily.reserve(now),
    (e) => e instanceof HttpException && e.getStatus() === 429,
  );
});

test('concurrent reservations across two instances share durable serialization and daily limits', async () => {
  const db = database(9, 9);
  const a = new NaverNewsBudgetService(config(), db.value);
  const b = new NaverNewsBudgetService(config(), db.value);
  const results = await Promise.allSettled([a.reserve(now), b.reserve(now)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(db.writes.filter((w) => w.sql.includes('FOR UPDATE')).length, 2);
  assert.equal(
    db.writes.filter((w) => w.sql.startsWith('INSERT INTO api_usage_counters')).length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(db.writes), /synthetic-secret|"synthetic"/);
});

test('database outage fails closed and never contacts the provider', async () => {
  const db = {
    requireDataSource: () => {
      throw new Error('private DB credentials');
    },
  } as unknown as DatabaseRuntimeService;
  const budget = new NaverNewsBudgetService(config(), db);
  assert.equal((await budget.status(now)).automaticAllowed, false);
  await assert.rejects(
    () => budget.reserve(now),
    (e) => e instanceof HttpException && !e.message.includes('private'),
  );
  let calls = 0;
  const rejectingBudget = { reserve: () => budget.reserve(now) } as NaverNewsBudgetService;
  const search = new NaverNewsSearchService(
    config(),
    (async () => {
      calls++;
      return Response.json({});
    }) as typeof fetch,
    rejectingBudget,
  );
  await assert.rejects(() => search.search({ q: 'private query', start: 1, sort: 'date' }));
  assert.equal(calls, 0);
});

test('provider failures still consume the reserved request and do not store search content', async () => {
  const db = database();
  const budget = new NaverNewsBudgetService(config(), db.value);
  const fixedBudget = { reserve: () => budget.reserve(now) } as NaverNewsBudgetService;
  const search = new NaverNewsSearchService(
    config(),
    (async () => new Response('private result', { status: 403 })) as typeof fetch,
    fixedBudget,
  );
  await assert.rejects(
    () => search.search({ q: 'private query', start: 1, sort: 'date' }),
    (e) => e instanceof HttpException && e.getStatus() === 503,
  );
  assert.equal((await budget.status(now)).remainingToday, 9);
  assert.equal((await budget.status(now)).remainingWindow, 9);
  assert.doesNotMatch(JSON.stringify(db.writes), /private query|private result/);
});

const generous = {
  NAVER_NEWS_DAILY_LIMIT: '100',
  NAVER_NEWS_MONTHLY_LIMIT: '200',
  NAVER_NEWS_FREE_REQUESTS: '200',
};
const throttled = (error: unknown) => error instanceof HttpException && error.getStatus() === 429;

test('the shared rolling window caps concurrent calls and survives a fresh API instance', async () => {
  const db = database();
  const a = new NaverNewsBudgetService(config(generous), db.value);
  const b = new NaverNewsBudgetService(config(generous), db.value);
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).reserve(now)),
  );
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 10);
  assert.ok(
    results.filter((item) => item.status === 'rejected').every((item) => throttled(item.reason)),
  );
  const restarted = new NaverNewsBudgetService(config(generous), db.value);
  const status = await restarted.status(now);
  assert.equal(status.automaticAllowed, false);
  assert.equal(status.remainingWindow, 0);
  assert.equal(
    status.nextRequestAt,
    new Date(now.getTime() + NAVER_ROLLING_INTERVAL_MS).toISOString(),
  );
  await assert.rejects(
    () => restarted.reserve(new Date(now.getTime() + NAVER_ROLLING_INTERVAL_MS - 1)),
    throttled,
  );
  await restarted.reserve(new Date(now.getTime() + NAVER_ROLLING_INTERVAL_MS));
  assert.equal(
    (await restarted.status(new Date(now.getTime() + NAVER_ROLLING_INTERVAL_MS))).remainingWindow,
    9,
  );
  const saved = db.metadata() as { version: number; reservations: number[] };
  assert.deepEqual(Object.keys(saved).sort(), ['reservations', 'version']);
  assert.equal(saved.reservations.length, 1);
  assert.ok(
    db.writes
      .filter((item) => item.sql.startsWith('UPDATE source_checkpoints'))
      .every((item) => JSON.parse(String(item.args[0])).reservations.length <= 10),
  );
});

test('timestamps expire individually instead of resetting a fixed fifteen-minute bucket', async () => {
  const db = database();
  const service = new NaverNewsBudgetService(config(generous), db.value);
  const later = new Date(now.getTime() + 7 * 60_000);
  for (let i = 0; i < 5; i++) await service.reserve(now);
  for (let i = 0; i < 5; i++) await service.reserve(later);
  const boundary = new Date(now.getTime() + NAVER_ROLLING_INTERVAL_MS);
  assert.equal((await service.status(boundary)).remainingWindow, 5);
  for (let i = 0; i < 5; i++) await service.reserve(boundary);
  await assert.rejects(() => service.reserve(boundary), throttled);
  assert.equal(
    (await service.status(boundary)).nextRequestAt,
    new Date(later.getTime() + NAVER_ROLLING_INTERVAL_MS).toISOString(),
  );
});

test('month rollover uses one persistent lock and retains the previous month rolling reservations', async () => {
  const db = database();
  const before = new Date('2026-09-30T14:59:59Z');
  const after = new Date('2026-09-30T15:00:00Z');
  const september = new NaverNewsBudgetService(
    config({ ...generous, NAVER_NEWS_FREE_UNTIL: '2026-11-01T00:00:00Z' }),
    db.value,
  );
  const october = new NaverNewsBudgetService(
    config({
      ...generous,
      NAVER_NEWS_FREE_MONTH: '2026-10',
      NAVER_NEWS_FREE_UNTIL: '2026-11-01T00:00:00Z',
    }),
    db.value,
  );
  for (let i = 0; i < 9; i++) await september.reserve(before);
  const attempts = await Promise.allSettled([september.reserve(before), october.reserve(after)]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  await assert.rejects(() => october.reserve(after), throttled);
  assert.equal((await october.status(after)).remainingMonth, 200);
  assert.equal((await october.status(after)).remainingWindow, 0);
  const streams = db.writes
    .filter((item) => item.sql.includes('FOR UPDATE'))
    .map((item) => item.args[1]);
  assert.deepEqual([...new Set(streams)], ['SEARCH_BUDGET']);
});

test('first upgrade conservatively waits for existing latest usage to leave the window', async () => {
  const db = database(2, 2, now);
  const service = new NaverNewsBudgetService(config(generous), db.value);
  assert.equal((await service.status(now)).remainingWindow, 0);
  await assert.rejects(() => service.reserve(now), throttled);
  assert.equal(
    db.writes.filter((item) => item.sql.startsWith('INSERT INTO api_usage_counters')).length,
    0,
  );
  await service.reserve(new Date(now.getTime() + NAVER_ROLLING_INTERVAL_MS));
  assert.equal((db.metadata() as { reservations: number[] }).reservations.length, 1);
});

test('malformed durable window fails closed rather than resetting the request allowance', async () => {
  for (const metadata of [
    '{bad json',
    { version: 1, reservations: Array(11).fill(now.getTime()) },
    { version: 1, reservations: ['secret'] },
  ]) {
    const db = database();
    db.setMetadata(metadata);
    const service = new NaverNewsBudgetService(config(generous), db.value);
    assert.equal((await service.status(now)).automaticAllowed, false);
    await assert.rejects(
      () => service.reserve(now),
      (error) => error instanceof HttpException && error.getStatus() === 503,
    );
    assert.equal(
      db.writes.filter((item) => item.sql.startsWith('INSERT INTO api_usage_counters')).length,
      0,
    );
  }
});
