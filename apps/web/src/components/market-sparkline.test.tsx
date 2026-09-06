import { expect, it } from 'vitest';
import { sparklineGeometry } from './market-sparkline';
import type { MarketHistory } from '../types';
const points = (values: Array<[string, string]>) =>
  values.map(([date, value]) => ({ date, value })) as MarketHistory['points'];
it('requires actual observations and places irregular dates by elapsed time', () => {
  expect(sparklineGeometry([])).toBeNull();
  expect(sparklineGeometry(points([['2026-09-01', '4']]))).toBeNull();
  expect(
    sparklineGeometry(
      points([
        ['2026-09-01', '0'],
        ['2026-09-02', '0'],
        ['2026-09-05', '0'],
      ]),
    )?.line,
  ).toBe('M4.00,25.00 L52.00,25.00 L196.00,25.00');
});
it('deduplicates dates and rejects empty or nonfinite values', () => {
  const result = sparklineGeometry(
    points([
      ['2026-09-02', '2'],
      ['2026-09-01', '1'],
      ['2026-09-02', '3'],
      ['2026-09-03', 'NaN'],
    ]),
  );
  expect(result?.rows).toHaveLength(2);
  expect(result?.direction).toBe('up');
});
