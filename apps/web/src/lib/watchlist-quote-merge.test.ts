import { expect, it } from 'vitest';
import type { CompanyQuote } from '../types';
import { mergeWatchlistQuotes, type WatchlistQuoteBatch } from './watchlist-quote-merge';

function quote(id = 'a', fields: Partial<CompanyQuote['displayPrice']> = {}): CompanyQuote {
  return {
    companyId: id,
    displayPrice: {
      price: '72000',
      currency: 'KRW',
      status: 'LIVE',
      basis: 'LIVE',
      source: 'TOSS_KR_INTEGRATED',
      sessionDate: '2026-09-08',
      providerAt: '2026-09-08T01:00:00.000Z',
      referenceClose: 70000,
      referenceDate: '2026-09-07',
      change: 2000,
      changePercent: 2.857,
      ...fields,
    },
  };
}

function batch(items: CompanyQuote[], asOf = '2026-09-08T01:00:01.000Z'): WatchlistQuoteBatch {
  return { asOf, items };
}

function stale(value: CompanyQuote): CompanyQuote {
  return {
    ...value,
    displayPrice: { ...value.displayPrice, status: 'STALE', basis: 'STALE' },
  };
}

function close(id = 'a', fields: Partial<CompanyQuote['displayPrice']> = {}): CompanyQuote {
  return quote(id, {
    price: '70000',
    basis: 'CLOSE',
    status: 'WAITING',
    providerAt: null,
    sessionDate: '2026-09-07',
    source: 'TOSS_KR',
    ...fields,
  });
}

it('updates valid companies atomically and retains missing or unavailable companies as stale', () => {
  const a = quote('a');
  const b = quote('b');
  const c = quote('c');
  const nextA = quote('a', {
    price: '72300',
    providerAt: '2026-09-08T01:00:02.000Z',
    change: 2300,
    changePercent: 3.286,
    source: 'TOSS_KR',
  });
  const unavailableB = quote('b', { price: null, basis: 'NONE', status: 'UNAVAILABLE' });
  const result = mergeWatchlistQuotes(
    batch([a, b, c]),
    batch([nextA, unavailableB], '2026-09-08T01:00:03.000Z'),
  );
  expect(result).toEqual(batch([nextA, stale(b), stale(c)], '2026-09-08T01:00:03.000Z'));
  expect(result.items[0]).toBe(nextA);
  expect(b.displayPrice.status).toBe('LIVE');
  expect(result.items[1]!.displayPrice.source).toBe(b.displayPrice.source);
});

it('recovers a previously unavailable company without dropping unaffected prices', () => {
  const a = quote('a');
  const waiting = quote('b', { price: null, status: 'WAITING', basis: 'NONE' });
  const first = mergeWatchlistQuotes(undefined, batch([a, waiting]));
  expect(first.items).toEqual([a]);
  const failed = mergeWatchlistQuotes(first, batch([], '2026-09-08T01:00:03.000Z'));
  expect(failed.items).toEqual([stale(a)]);
  const b = quote('b', { price: '110.2', currency: 'USD', source: 'TOSS_US' });
  const recovered = mergeWatchlistQuotes(failed, batch([b], '2026-09-08T01:00:05.000Z'));
  expect(recovered.items).toEqual([b, stale(a)]);
});

it.each(['NOT_CONFIGURED', 'UNAVAILABLE', 'WAITING'] as const)(
  'accepts a valid completed close even when connector status is %s',
  (status) => {
    const value = close('a', { status });
    expect(mergeWatchlistQuotes(undefined, batch([value])).items).toEqual([value]);
  },
);

it.each([
  { price: null },
  { price: '' },
  { price: 'NaN' },
  { price: 'Infinity' },
  { price: '0' },
  { price: '-1' },
  { currency: null },
  { basis: 'NONE' as const },
  { status: 'UNAVAILABLE' as const },
  { status: 'WAITING' as const },
  { providerAt: null },
  { providerAt: 'not-a-time' },
  { providerAt: '2026-02-30T01:00:00.000Z' },
  { sessionDate: null },
  { sessionDate: '2026-02-30' },
])('retains the last valid price when the next observation is invalid: %j', (fields) => {
  const previous = quote();
  const invalid = quote('a', fields);
  expect(mergeWatchlistQuotes(batch([previous]), batch([invalid])).items).toEqual([
    stale(previous),
  ]);
  expect(mergeWatchlistQuotes(undefined, batch([invalid])).items).toEqual([]);
});

it('seeds from valid group fallback data and preserves it when polling has no usable observation', () => {
  const fallback = quote();
  const invalidFallback = quote('b', { price: null, basis: 'NONE' });
  const unavailable = quote('a', { price: null, status: 'UNAVAILABLE', basis: 'NONE' });
  expect(
    mergeWatchlistQuotes(undefined, batch([unavailable]), [fallback, invalidFallback]).items,
  ).toEqual([stale(fallback)]);
});

it('uses fallback data only when newer than the previous cached observation', () => {
  const previous = quote();
  const sameTime = quote('a', { price: '72001' });
  const older = quote('a', { providerAt: '2026-09-08T00:59:59.000Z' });
  const newer = quote('a', { providerAt: '2026-09-08T01:00:03.000Z' });
  expect(mergeWatchlistQuotes(batch([previous]), batch([]), [sameTime]).items).toEqual([
    stale(previous),
  ]);
  expect(mergeWatchlistQuotes(batch([previous]), batch([]), [older]).items).toEqual([
    stale(previous),
  ]);
  expect(mergeWatchlistQuotes(batch([previous]), batch([]), [newer]).items).toEqual([stale(newer)]);
});

it('rejects older trades while allowing corrections at the same provider timestamp', () => {
  const previous = quote();
  const older = quote('a', { price: '1', providerAt: '2026-09-08T00:59:59.999Z' });
  const correction = quote('a', { price: '72001', change: 2001, changePercent: 2.859 });
  expect(mergeWatchlistQuotes(batch([previous]), batch([older])).items).toEqual([stale(previous)]);
  expect(mergeWatchlistQuotes(batch([previous]), batch([correction])).items).toEqual([correction]);
});

it('never replaces a newer-session trade with an older-session close', () => {
  const previous = quote();
  expect(mergeWatchlistQuotes(batch([previous]), batch([close()])).items).toEqual([
    stale(previous),
  ]);
});

it('allows a completed close to replace a trade in that session and rejects delayed same-session trades', () => {
  const previous = quote();
  const completed = close('a', { sessionDate: '2026-09-08' });
  expect(mergeWatchlistQuotes(batch([previous]), batch([completed])).items).toEqual([completed]);
  expect(mergeWatchlistQuotes(batch([completed]), batch([previous])).items).toEqual([completed]);
  const nextSession = quote('a', {
    sessionDate: '2026-09-09',
    providerAt: '2026-09-09T01:00:00.000Z',
  });
  expect(mergeWatchlistQuotes(batch([completed]), batch([nextSession])).items).toEqual([
    nextSession,
  ]);
});

it('accepts a corrected same-session close and a later completed close', () => {
  const previous = close();
  const corrected = close('a', { price: '70100' });
  const newer = close('a', { sessionDate: '2026-09-08' });
  expect(mergeWatchlistQuotes(batch([previous]), batch([corrected])).items).toEqual([corrected]);
  expect(mergeWatchlistQuotes(batch([previous]), batch([newer])).items).toEqual([newer]);
  expect(mergeWatchlistQuotes(batch([newer]), batch([previous])).items).toEqual([newer]);
});

it('rejects a currency change for a known company including its fallback baseline', () => {
  const previous = quote();
  const usd = quote('a', {
    currency: 'USD',
    price: '100',
    providerAt: '2026-09-08T01:00:03.000Z',
  });
  expect(mergeWatchlistQuotes(batch([previous]), batch([usd]), [usd]).items).toEqual([
    stale(previous),
  ]);
  const waiting = quote('a', { price: null, basis: 'NONE', status: 'WAITING' });
  expect(mergeWatchlistQuotes(undefined, batch([usd]), [waiting]).items).toEqual([]);
});

it('uses the latest valid server response timestamp without inventing a replacement', () => {
  const previous = batch([quote()], '2026-09-08T01:00:05.000Z');
  expect(mergeWatchlistQuotes(previous, batch([])).asOf).toBe(previous.asOf);
  expect(mergeWatchlistQuotes(previous, batch([], 'invalid')).asOf).toBe(previous.asOf);
  const next = batch([], '2026-09-08T01:00:07.000Z');
  expect(mergeWatchlistQuotes(previous, next).asOf).toBe(next.asOf);
  expect(mergeWatchlistQuotes(batch([], 'invalid'), next).asOf).toBe(next.asOf);
  expect(() => mergeWatchlistQuotes(undefined, batch([], 'invalid'))).toThrow(TypeError);
});

it('limits stored quotes to 200 companies and filters strictly to the current membership', () => {
  const values = Array.from({ length: 210 }, (_, index) => quote(String(index)));
  const result = mergeWatchlistQuotes(undefined, batch(values));
  expect(result.items).toHaveLength(200);
  expect(result.items.at(-1)!.companyId).toBe('199');
  const filtered = mergeWatchlistQuotes(
    batch(values),
    batch([]),
    [quote('fallback')],
    ['209', 'fallback', '209', 'missing'],
  );
  expect(filtered.items.map((item) => item.companyId)).toEqual(['209', 'fallback']);
  expect(mergeWatchlistQuotes(batch(values), batch(values), values, []).items).toEqual([]);
});

it('has no retained state after the query cache supplies no previous data', () => {
  const previous = batch([quote()]);
  expect(mergeWatchlistQuotes(previous, batch([])).items).toHaveLength(1);
  expect(mergeWatchlistQuotes(undefined, batch([])).items).toEqual([]);
});
