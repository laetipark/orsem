import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { NaverNewsBudgetService, naverUsagePeriod } from './naver-news-budget.service';
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

function database(daily = 0, monthly = 0) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const query = async (sql: string, args: unknown[] = []) => {
    if (sql.includes('SUM(')) return [{ daily: String(daily), monthly: String(monthly) }];
    if (sql.startsWith('INSERT INTO api_usage_counters')) {
      daily++;
      monthly++;
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

test('concurrent reservations across two instances share the durable month serialization', async () => {
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
  assert.doesNotMatch(JSON.stringify(db.writes), /private query|private result/);
});
