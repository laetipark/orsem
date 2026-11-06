import { MARKET_INSTRUMENTS } from '@orsem/contracts';
import { queryOptions } from '@tanstack/react-query';
import type { MarketHistory, MarketInstrument, MarketQuote, Region } from '../types';
import { api } from './api';

const etfs = MARKET_INSTRUMENTS.filter((item) => item.category === 'ETF');

function matchesInstrument(item: MarketInstrument, definition: MarketInstrument) {
  return (
    item.provider === definition.provider &&
    item.symbol === definition.symbol &&
    item.currency === definition.currency &&
    item.displayKind === definition.displayKind
  );
}

function normalizeMarketQuote(item: MarketQuote): MarketQuote {
  const definition = etfs.find((entry) => entry.id === item.id);
  if (!definition) return item;
  if (matchesInstrument(item, definition)) return { ...item, ...definition };
  // A cached index value must never become an ETF price just by relabeling it.
  return {
    ...item,
    ...definition,
    status: 'WAITING',
    value: null,
    change: null,
    changePercent: null,
    valueDate: null,
    providerAt: null,
    observedAt: null,
    referenceValue: null,
    referenceDate: null,
    convertedValue: null,
    conversionRate: null,
    conversionAt: null,
    message: 'ETF 시세 연결 후 첫 관측값을 기다리고 있습니다.',
  };
}

export function normalizeMarketHistory(history: MarketHistory): MarketHistory {
  const definition = etfs.find((entry) => entry.id === history.instrument.id);
  if (!definition || matchesInstrument(history.instrument, definition)) return history;
  return {
    ...history,
    instrument: definition,
    points: [],
    status: 'WAITING',
    message: 'ETF의 수집된 이력을 기다리고 있습니다.',
    sourceUrl: definition.sourceUrl,
  };
}

export function normalizeMarketOverview(data: Awaited<ReturnType<typeof api.markets>>) {
  return {
    ...data,
    items: data.items.map(normalizeMarketQuote),
    histories: data.histories
      ? Object.fromEntries(
          Object.entries(data.histories).map(([id, history]) => [
            id,
            normalizeMarketHistory(history),
          ]),
        )
      : undefined,
  };
}

export function marketOverviewQuery(region: Region) {
  return queryOptions({
    queryKey: ['markets', region],
    queryFn: ({ signal }) => api.markets(region, signal),
    select: normalizeMarketOverview,
    refetchInterval: 60_000,
  });
}
