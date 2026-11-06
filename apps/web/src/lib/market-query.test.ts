import { QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { marketFixtures, marketHistoryFixture } from './market-fixtures';
import {
  marketOverviewQuery,
  normalizeMarketHistory,
  normalizeMarketOverview,
} from './market-query';
import { createQueryClient } from './query-client';

afterEach(() => vi.unstubAllGlobals());

it('keeps a shared market request until its final viewer leaves, then aborts the fetch', () => {
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  });
  vi.stubGlobal('fetch', fetch);
  const client = createQueryClient();
  const first = new QueryObserver(client, marketOverviewQuery('all'));
  const second = new QueryObserver(client, marketOverviewQuery('all'));
  const leaveFirst = first.subscribe(() => undefined);
  const leaveSecond = second.subscribe(() => undefined);
  expect(fetch).toHaveBeenCalledOnce();
  expect(signal?.aborted).toBe(false);
  leaveFirst();
  expect(signal?.aborted).toBe(false);
  leaveSecond();
  expect(signal?.aborted).toBe(true);
  expect(client.getQueryData(['markets', 'all'])).toBeUndefined();
  client.clear();
});

it.each([
  ['sp500', 'FRED', 'SP500'],
  ['nasdaq', 'TRADINGVIEW', 'FRED:NDQCOM'],
])(
  'discards cached index prices and history instead of relabeling them as %s ETF prices',
  (id, provider, symbol) => {
    const current = marketFixtures.find((quote) => quote.id === id)!;
    const old = {
      ...current,
      provider,
      symbol,
      currency: null,
      displayKind: 'WIDGET' as const,
      value: '6000',
    };
    const history = {
      ...marketHistoryFixture(id),
      instrument: old,
      points: [{ date: '2026-09-02', value: '6000' }],
    };
    const result = normalizeMarketOverview({
      asOf: history.asOf,
      items: [old],
      histories: { [id]: history },
    });
    expect(result.items[0]).toMatchObject({
      name: current.name,
      provider: 'TOSS',
      symbol: current.symbol,
      currency: 'USD',
      displayKind: 'NATIVE',
      status: 'WAITING',
      value: null,
      change: null,
      changePercent: null,
      providerAt: null,
      observedAt: null,
      referenceValue: null,
    });
    expect(result.histories?.[id]).toMatchObject({
      points: [],
      status: 'WAITING',
      instrument: { symbol: current.symbol },
    });
    expect(normalizeMarketHistory(history).points).toEqual([]);
    // The cached original remains intact; only the selected display data changes.
    expect(old.value).toBe('6000');
    expect(history.points).toHaveLength(1);
  },
);

it('preserves actual Toss ETF values, provenance timestamps and unrelated instruments', () => {
  const histories = Object.fromEntries(
    ['sp500', 'nasdaq'].map((id) => [id, marketHistoryFixture(id)]),
  );
  const result = normalizeMarketOverview({
    asOf: histories.sp500!.asOf,
    items: marketFixtures,
    histories,
  });
  expect(result.items).toEqual(marketFixtures);
  expect(result.histories).toEqual(histories);
});
