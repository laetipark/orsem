import { describe, expect, it } from 'vitest';
import { marketSchedule, scheduledRegion } from './market-schedule';

describe('KST domestic / US market schedule', () => {
  it.each([
    ['2026-09-04T05:59:59+09:00', 'us', '2026-09-04T06:00:00+09:00'],
    ['2026-09-04T06:00:00+09:00', 'kr', '2026-09-04T18:00:00+09:00'],
    ['2026-09-04T17:59:59+09:00', 'kr', '2026-09-04T18:00:00+09:00'],
    ['2026-09-04T18:00:00+09:00', 'us', '2026-09-05T06:00:00+09:00'],
    ['2026-09-05T00:00:00+09:00', 'us', '2026-09-05T06:00:00+09:00'],
  ])('%s selects %s through the next boundary', (now, region, next) => {
    expect(marketSchedule(Date.parse(now))).toMatchObject({
      region,
      nextBoundary: Date.parse(next),
    });
  });
  it('honors explicit links and schedules missing, all or invalid values', () => {
    const now = Date.parse('2026-09-04T12:00:00+09:00');
    expect(scheduledRegion('us', now)).toBe('us');
    for (const value of [null, 'all', 'invalid']) expect(scheduledRegion(value, now)).toBe('kr');
  });
});
