import { describe, expect, it } from 'vitest';
import { formatDate, formatKst, formatMoney, formatPercent } from './format';

describe('KST formatting', () => {
  it('converts an instant to Korean Standard Time and labels it', () => {
    expect(formatKst('2026-09-03T00:00:00.000Z')).toContain('09:00');
    expect(formatKst('2026-09-03T00:00:00.000Z')).toContain('KST');
  });

  it('keeps a date-only source field as a calendar date', () => {
    expect(formatDate('2026-09-03')).toContain('2026');
    expect(formatDate('2026-09-03')).toContain('09');
  });
});

describe('financial formatting', () => {
  it('accepts precision-preserving decimal strings', () => {
    expect(formatMoney('725000000', 'KRW')).toContain('725,000,000');
  });

  it('makes positive return direction explicit', () => {
    expect(formatPercent(1.25)).toBe('+1.25%');
    expect(formatPercent(null)).toBe('—');
  });
});
