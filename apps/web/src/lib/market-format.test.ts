import { describe, expect, it } from 'vitest';
import {
  availableHistoryRanges,
  historyForRange,
  marketChange,
  marketChangeDirection,
  marketNumber,
} from './market-format';

describe('market display semantics', () => {
  it('keeps missing numeric values distinct from zero', () => {
    expect(marketNumber(null)).toBe('—');
    expect(marketNumber('')).toBe('—');
    expect(marketNumber('0')).toBe('0');
    expect(marketNumber('1500.25', 'KRW')).toBe('1,500.25');
  });
  it('uses basis points for yields and percent for price changes without computing a new reference', () => {
    expect(marketChange({ change: '3', changePercent: '0.6', changeUnit: 'bp' })).toBe('+3.00 bp');
    expect(marketChange({ change: '3', changePercent: '0.6', changeUnit: 'percent' })).toBe(
      '+0.60%',
    );
    expect(marketChange({ change: null, changePercent: null, changeUnit: 'percent' })).toBe('—');
    expect(marketChangeDirection({ change: '3', changePercent: '-0.6', changeUnit: 'bp' })).toBe(
      'up',
    );
    expect(
      marketChangeDirection({ change: '3', changePercent: '-0.6', changeUnit: 'percent' }),
    ).toBe('down');
    expect(marketChangeDirection({ change: null, changePercent: null, changeUnit: 'bp' })).toBe(
      'flat',
    );
  });
  it('offers longer history only when actual observations extend into that period', () => {
    const asOf = '2026-09-04T00:00:00Z';
    expect(availableHistoryRanges([], asOf)).toEqual([]);
    expect(availableHistoryRanges([{ date: '2026-09-03', value: '1' }], asOf)).toEqual(['1m']);
    expect(availableHistoryRanges([{ date: '2026-07-01', value: '1' }], asOf)).toEqual([
      '1m',
      '3m',
    ]);
    expect(availableHistoryRanges([{ date: '2026-01-01', value: '1' }], asOf)).toEqual([
      '1m',
      '3m',
      '1y',
    ]);
  });
  it('keeps observed dates without filling holiday or missing values', () => {
    expect(
      historyForRange(
        [
          { date: '2026-01-01', value: '1' },
          { date: '2026-09-01', value: '2' },
          { date: '2026-09-03', value: '3' },
        ],
        '1m',
        '2026-09-04T00:00:00Z',
      ),
    ).toEqual([
      { date: '2026-09-01', value: '2' },
      { date: '2026-09-03', value: '3' },
    ]);
  });
});
