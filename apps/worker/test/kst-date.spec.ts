import {
  addDateOnlyDays,
  nextKstMidnight,
  splitDateWindows,
  toKstDateOnly,
} from '../src/common/kst-date';

describe('KST date utilities', () => {
  it('does not confuse UTC and the KST calendar date', () => {
    const instant = new Date('2026-09-02T16:00:00.000Z');
    expect(toKstDateOnly(instant)).toBe('2026-09-03');
  });

  it('splits backfills into windows of at most 90 days', () => {
    const windows = splitDateWindows('2026-01-01', '2026-04-15');
    expect(windows).toEqual([
      { start: '2026-01-01', end: '2026-03-31' },
      { start: '2026-04-01', end: '2026-04-15' },
    ]);
  });

  it('calculates the next KST day boundary', () => {
    expect(nextKstMidnight(new Date('2026-09-03T10:00:00Z')).toISOString()).toBe(
      '2026-09-03T15:00:00.000Z',
    );
    expect(addDateOnlyDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('rejects impossible calendar dates instead of normalizing them', () => {
    expect(() => addDateOnlyDays('2026-02-30', 1)).toThrow('Invalid calendar date');
    expect(() => splitDateWindows('2026-13-01', '2026-13-02')).toThrow('Invalid calendar date');
  });
});
