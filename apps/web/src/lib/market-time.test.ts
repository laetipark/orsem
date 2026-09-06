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
  it('shows the value basis on native cards and retains the later collection time in the description', () => {
    const time = marketCardTime(quote);
    expect(time.text).toBe('09.03 17:42');
    expect(time.dateTime).toBe(providerAt);
    expect(time.description).toBe(
      `수집 기준 시각 ${formatKst(collected)} · 자료 기준 ${formatKst(providerAt)} · 출처 TOSS`,
    );
    expect(marketCollectionTime(quote).description).toBe(time.description);
  });

  it('retains WTI and Treasury date-only basis dates without inventing a publication time', () => {
    const daily = { ...quote, observedAt: collected, providerAt: null };
    expect(marketSourceTime(daily)).toBe(`자료 기준 ${formatDate('2026-09-03')}`);
    expect(marketCardTime(daily).text).toBe('09.03');
    expect(marketCardTime(daily).dateTime).toBe('2026-09-03');
    expect(marketCardTime({ ...daily, observedAt: null }).text).toBe('09.03');
  });

  it('uses source time then source date for embedded quotes as well', () => {
    const widget = { ...quote, displayKind: 'WIDGET' as const };
    expect(marketCardTime(widget).text).toBe('09.03 17:42');
    expect(marketCardTime({ ...widget, providerAt: null }).dateTime).toBe('2026-09-03');
  });

  it('keeps observation fallback explicit in the description while showing just date and time', () => {
    const item = { ...quote, providerAt: null, valueDate: null };
    expect(marketCardTime(item).text).toBe('09.05 00:05');
    expect(marketCardTime(item).description).toContain('공급자 기준 시각 미확인');
    expect(marketCardTime({ ...item, observedAt: null }).text).toBeNull();
  });

  it('uses the KST date across midnight and preserves the full year in the description', () => {
    const atNewYear = { ...quote, providerAt: '2026-12-31T15:05:00.000Z' };
    expect(marketCardTime(atNewYear).text).toBe('01.01 00:05');
    expect(marketCardTime(atNewYear).description).toContain('2027. 01. 01. 00:05 KST');
  });

  it('does not fabricate a time for an embedded quote without any supplied timestamp or date', () => {
    const widget = {
      ...quote,
      displayKind: 'WIDGET' as const,
      providerAt: null,
      valueDate: null,
      observedAt: null,
    };
    expect(marketCardTime(widget).text).toBeNull();
    expect(marketCardTime(widget).dateTime).toBeUndefined();
  });
});
