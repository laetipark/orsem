import { planTossViewFetch } from '../src/market-data/toss-view-fetch-policy';
import type { TossCandlesJob } from '../src/queues/job-data';

const now = Date.parse('2026-09-04T09:30:00Z');
const scope = { region: 'kr' as const, symbol: '005930' };
const request: TossCandlesJob = { interval: '1m', lookbackDays: 7, reason: 'VIEW' };
const hydratedAt = '2026-09-04T00:00:00Z';
const history = {
  version: 1,
  source: 'TOSS_KR',
  symbol: '005930',
  interval: '1m',
  adjusted: false,
  lookbackDays: 7,
  maximumBars: 1000,
  hydratedAt,
  refreshedAt: new Date(now).toISOString(),
};

describe('Toss VIEW fetch coverage policy', () => {
  it.each([
    [0, 1],
    [180 * 60_000 - 1, 1],
    [180 * 60_000, 6],
    [-1, 6],
  ])('uses %i ms since last refresh to choose %i pages', (elapsed, pages) => {
    const metadata = {
      viewHistory: { ...history, refreshedAt: new Date(now - elapsed).toISOString() },
    };
    expect(planTossViewFetch(scope, request, metadata, now).input.maxPages).toBe(pages);
  });

  it('uses the daily gap boundary independently of the minute boundary', () => {
    const input: TossCandlesJob = { interval: '1d', lookbackDays: 366, reason: 'VIEW' };
    const elapsed = 180 * 86_400_000;
    const metadata = {
      viewHistory: {
        ...history,
        interval: '1d',
        lookbackDays: 366,
        maximumBars: 400,
        hydratedAt: new Date(now - elapsed - 1).toISOString(),
        refreshedAt: new Date(now - elapsed + 1).toISOString(),
      },
    };
    expect(planTossViewFetch(scope, input, metadata, now).input.maxPages).toBe(1);
    metadata.viewHistory.refreshedAt = new Date(now - elapsed).toISOString();
    expect(planTossViewFetch(scope, input, metadata, now).input.maxPages).toBe(3);
  });

  it.each([
    { hydratedAt: 'invalid' },
    { refreshedAt: 'invalid' },
    { hydratedAt: new Date(now + 1).toISOString() },
    { source: 'TOSS_US' },
    { symbol: '000660' },
    { adjusted: true },
    { lookbackDays: 1 },
    { maximumBars: 200 },
  ])('does not reuse incompatible or invalid stored coverage: %j', (patch) => {
    const plan = planTossViewFetch(scope, request, { viewHistory: { ...history, ...patch } }, now);
    expect(plan.input.maxPages).toBe(6);
    expect(plan.hydratedAt).toBeNull();
  });

  it.each([{ reason: 'SCHEDULED' as const }, { maxPages: 1 }, { before: '2026-09-04T00:00:00Z' }])(
    'keeps partial or non-VIEW requests outside the hydration policy: %j',
    (patch) => {
      const input = { ...request, ...patch };
      expect(planTossViewFetch(scope, input, { viewHistory: history }, now)).toEqual({
        input,
        historyPolicy: null,
        hydratedAt: null,
      });
    },
  );

  it('does not mutate the request or checkpoint and preserves the first hydration time', () => {
    const input = Object.freeze({ ...request });
    const metadata = Object.freeze({ viewHistory: Object.freeze({ ...history }) });
    const plan = planTossViewFetch(scope, input, metadata, now);
    expect(plan.input).toEqual({ ...request, maxPages: 1 });
    expect(plan.hydratedAt).toBe(hydratedAt);
    expect(input).toEqual(request);
    expect(metadata.viewHistory).toEqual(history);
  });
});
