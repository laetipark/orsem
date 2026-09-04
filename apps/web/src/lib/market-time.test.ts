import { describe, expect, it } from 'vitest';
import type { MarketQuote } from '../types';
import { marketFixtures } from './market-fixtures';
import { formatDate, formatKst } from './format';
import { marketCardTime, marketCollectionTime, marketSourceTime } from './market-time';

const collected = '2026-09-04T15:05:00.000Z';
const providerAt = '2026-09-03T08:42:00.000Z';
const quote: MarketQuote = {
  ...marketFixtures[0]!,
  observedAt: collected,
  providerAt,
  valueDate: '2026-09-03',
};

describe('market provenance time display', () => {
  it('shows collection time on native cards and keeps the older provider time in the description', () => {
    const time = marketCardTime(quote);
    expect(time.text).toBe('09.05 00:05 KST');
    expect(time.dateTime).toBe(collected);
    expect(time.description).toBe(
      `수집 기준 시각 ${formatKst(collected)} · 자료 기준 ${formatKst(providerAt)} · 출처 TOSS`,
    );
    expect(marketCollectionTime(quote).description).toBe(time.description);
  });

  it('retains date-only source dates without treating them as collection instants', () => {
    const daily = { ...quote, observedAt: null, providerAt: null };
    expect(marketSourceTime(daily)).toBe(`자료 기준 ${formatDate('2026-09-03')}`);
    expect(marketCardTime(daily).text).toBeNull();
    expect(marketCardTime(daily).dateTime).toBeUndefined();
    expect(marketCollectionTime(daily).description).toBe(
      `수집 시각 확인 전 · 자료 기준 ${formatDate('2026-09-03')} · 출처 TOSS`,
    );
  });

  it('uses provider, date-only and observed fallback times in that order for embedded quotes', () => {
    const widget = { ...quote, displayKind: 'WIDGET' as const };
    expect(marketCardTime(widget)).toEqual({
      text: '09.03 17:42 KST',
      dateTime: providerAt,
      description: formatKst(providerAt),
    });
    expect(marketCardTime({ ...widget, providerAt: null })).toEqual({
      text: formatDate('2026-09-03'),
      dateTime: '2026-09-03',
      description: formatDate('2026-09-03'),
    });
    expect(marketCardTime({ ...widget, providerAt: null, valueDate: null })).toEqual({
      text: '관측 09.05 00:05 KST',
      dateTime: collected,
      description: `관측 ${formatKst(collected)}`,
    });
  });
});
