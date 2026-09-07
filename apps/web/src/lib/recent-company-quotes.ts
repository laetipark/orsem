import type { WatchlistGroupItem } from '../types';

export function recentCompanyPrice(
  _quote: undefined,
  market: string,
  unavailable = false,
): WatchlistGroupItem['displayPrice'] {
  return {
    price: null,
    currency: ['NASDAQ', 'NYSE', 'AMEX'].includes(market) ? 'USD' : 'KRW',
    status: unavailable ? 'UNAVAILABLE' : 'WAITING',
    basis: 'NONE',
    source: null,
    sessionDate: null,
    providerAt: null,
    referenceClose: null,
    referenceDate: null,
    change: null,
    changePercent: null,
  };
}
