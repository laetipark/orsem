import { expect, it } from 'vitest';
import { marketFixtures, marketHistoryFixture } from './market-fixtures';
import { normalizeMarketHistory, normalizeMarketOverview } from './market-query';

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
