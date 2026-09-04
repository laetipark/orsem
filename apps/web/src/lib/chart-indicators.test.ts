import { describe, expect, it } from 'vitest';
import { rsiSeries, smaSeries, volumeSeries } from './chart-indicators';
import type { PricePoint } from '../types';

function prices(closes: readonly number[]): PricePoint[] {
  return closes.map((close, index) => ({
    time: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    open: close,
    high: close,
    low: close,
    close,
    volume: index + 1,
    source: 'TOSS_KR',
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
  }));
}
function values(series: ReturnType<typeof smaSeries>): Array<number | null> {
  return series.map((point) => ('value' in point ? point.value : null));
}

describe('chart indicators', () => {
  it('warms up SMA fully and slides over observed candles without inventing calendar dates', () => {
    const input = prices([10, 12, 11, 13, 14]);
    input[3]!.time = '2026-01-10';
    input[4]!.time = '2026-01-11';
    expect(values(smaSeries(input, 3))).toEqual([null, null, 11, 12, 38 / 3]);
    expect(values(smaSeries(input, 1))).toEqual([10, 12, 11, 13, 14]);
    expect(smaSeries(input, 60).every((point) => !('value' in point))).toBe(true);
  });

  it('uses a simple initial gain/loss average then Wilder smoothing, not a sliding RSI', () => {
    const result = values(rsiSeries(prices([10, 12, 11, 13, 12, 14]), 3));
    expect(result.slice(0, 3)).toEqual([null, null, null]);
    expect(result[3]).toBeCloseTo(80, 10);
    expect(result[4]).toBeCloseTo(800 / 13, 10);
    expect(result[5]).toBeCloseTo(850 / 11, 10);
  });

  it('requires 15 closes for default RSI and handles rising, falling, and flat windows', () => {
    expect(
      values(rsiSeries(prices(Array.from({ length: 15 }, (_, i) => i + 1)))).slice(0, 14),
    ).toEqual(Array(14).fill(null));
    expect(values(rsiSeries(prices(Array.from({ length: 15 }, (_, i) => i + 1)))).at(-1)).toBe(100);
    expect(values(rsiSeries(prices(Array.from({ length: 15 }, (_, i) => 15 - i)))).at(-1)).toBe(0);
    expect(values(rsiSeries(prices(Array(15).fill(10))))).toEqual([...Array(14).fill(null), 50]);
  });

  it.each([
    { open: 0, high: 0, low: 0, close: 99, volume: 0 },
    { open: 0, high: 0, low: 0, close: 0, volume: 0 },
    { close: NaN },
    { high: 0 },
    { volume: -1 },
    { close: Infinity },
  ])('restarts warmup after an explicit no-trade or malformed row: %o', (patch) => {
    const input = prices([10, 11, 12, 13, 14, 15]);
    input[2] = { ...input[2]!, ...patch };
    expect(values(smaSeries(input, 2))).toEqual([null, 10.5, null, null, 13.5, 14.5]);
    expect(values(rsiSeries(input, 2))).toEqual([null, null, null, null, null, 100]);
  });

  it('resets on missing entries, changed sources, and invalid timestamps without emitting unsafe chart times', () => {
    const input = prices([10, 11, 12, 13, 14]);
    const missing = [input[0], input[1], undefined, input[3], input[4]];
    expect(values(smaSeries(missing, 2))).toEqual([null, 10.5, null, 13.5]);
    input[2]!.time = '2026-02-30';
    expect(values(smaSeries(input, 2))).toEqual([null, 10.5, null, 13.5]);
    const switched = prices([10, 11, 12, 13]);
    switched[2]!.source = switched[3]!.source = 'TOSS_US';
    expect(values(smaSeries(switched, 2))).toEqual([null, 10.5, null, 12.5]);
  });

  it('omits duplicate/out-of-order timestamps and uses the existing UTC conversion for minute bars', () => {
    const input = prices([10, 11, 12, 13]);
    input[2]!.time = input[1]!.time;
    expect(values(smaSeries(input, 2))).toEqual([null, 10.5, null]);
    const minute = prices([10, 11]).map((point, index) => ({
      ...point,
      time: `2026-01-01T09:0${index}:00+09:00`,
    }));
    expect(smaSeries(minute, 2)).toEqual([
      { time: Date.parse(minute[0]!.time) / 1000 },
      { time: Date.parse(minute[1]!.time) / 1000, value: 10.5 },
    ]);
  });

  it('preserves supplied volume, including explicit zero, and assigns candle-direction colors', () => {
    const input = prices([10, 11, 12, 13, 14]);
    input[0] = { ...input[0]!, open: 9, low: 9 };
    input[1] = { ...input[1]!, open: 12, high: 12 };
    input[3] = { ...input[3]!, open: 0, high: 0, low: 0, volume: 0 };
    input[4] = { ...input[4]!, volume: NaN };
    const snapshot = input.map((point) => ({ ...point }));
    const result = volumeSeries(input, { up: 'green', down: 'red', unchanged: 'gray' });
    expect(result).toEqual([
      { time: input[0]!.time, value: 1, color: 'green' },
      { time: input[1]!.time, value: 2, color: 'red' },
      { time: input[2]!.time, value: 3, color: 'gray' },
      { time: input[3]!.time, value: 0, color: 'gray' },
      { time: input[4]!.time },
    ]);
    expect(input).toEqual(snapshot);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid indicator period %s', (period) => {
    expect(() => smaSeries([], period)).toThrow(RangeError);
    expect(() => rsiSeries([], period)).toThrow(RangeError);
  });
});
