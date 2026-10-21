// Deterministic illustrative values for the explicitly enabled development fixture mode only.
import { MARKET_INSTRUMENTS } from '@orsem/contracts';
import type { MarketHistory, MarketQuote, WatchlistItem, WatchlistQuote } from '../types';

export const marketFixtureTime = '2026-09-03T08:42:00.000Z';
const seeds: Array<
  Pick<
    MarketQuote,
    | 'id'
    | 'name'
    | 'region'
    | 'category'
    | 'currency'
    | 'unit'
    | 'provider'
    | 'symbol'
    | 'historyKind'
  > & { value: string }
> = [
  {
    id: 'kospi',
    name: '코스피',
    region: 'kr',
    category: 'INDEX',
    currency: null,
    unit: 'pt',
    provider: 'TOSS',
    symbol: 'KOSPI',
    historyKind: 'close',
    value: '2847.31',
  },
  {
    id: 'kosdaq',
    name: '코스닥',
    region: 'kr',
    category: 'INDEX',
    currency: null,
    unit: 'pt',
    provider: 'TOSS',
    symbol: 'KOSDAQ',
    historyKind: 'close',
    value: '894.62',
  },
  {
    id: 'usd-krw',
    name: '원/달러',
    region: 'kr',
    category: 'FX',
    currency: 'KRW',
    unit: 'KRW / USD',
    provider: 'TOSS',
    symbol: 'USD/KRW',
    historyKind: 'observed',
    value: '1348.20',
  },
  {
    id: 'sp500',
    name: 'S&P500 ETF · SPY',
    region: 'us',
    category: 'ETF',
    currency: 'USD',
    unit: 'USD/주',
    provider: 'TOSS',
    symbol: 'SPY',
    historyKind: 'close',
    value: '600.25',
  },
  {
    id: 'nasdaq',
    name: '나스닥종합 ETF · ONEQ',
    region: 'us',
    category: 'ETF',
    currency: 'USD',
    unit: 'USD/주',
    provider: 'TOSS',
    symbol: 'ONEQ',
    historyKind: 'close',
    value: '90.45',
  },
  {
    id: 'us2y',
    name: '미국 국채 2년',
    region: 'us',
    category: 'BOND',
    currency: null,
    unit: '%',
    provider: 'US_TREASURY',
    symbol: 'US2Y',
    historyKind: 'yield',
    value: '3.82',
  },
  {
    id: 'us10y',
    name: '미국 국채 10년',
    region: 'us',
    category: 'BOND',
    currency: null,
    unit: '%',
    provider: 'US_TREASURY',
    symbol: 'US10Y',
    historyKind: 'yield',
    value: '4.19',
  },
  {
    id: 'gold',
    name: '금',
    region: 'global',
    category: 'METAL',
    currency: 'USD',
    unit: 'USD / 트로이온스',
    provider: 'GOLD_API',
    symbol: 'XAU',
    historyKind: 'daily_average',
    value: '2840.60',
  },
  {
    id: 'silver',
    name: '은',
    region: 'global',
    category: 'METAL',
    currency: 'USD',
    unit: 'USD / 트로이온스',
    provider: 'GOLD_API',
    symbol: 'XAG',
    historyKind: 'daily_average',
    value: '31.42',
  },
  {
    id: 'wti',
    name: 'WTI 유가',
    region: 'global',
    category: 'ENERGY',
    currency: 'USD',
    unit: 'USD / 배럴',
    provider: 'EIA',
    symbol: 'WTI',
    historyKind: 'close',
    value: '74.16',
  },
  {
    id: 'btc',
    name: '비트코인',
    region: 'global',
    category: 'CRYPTO',
    currency: 'KRW',
    unit: 'KRW',
    provider: 'BITHUMB',
    symbol: 'KRW-BTC',
    historyKind: 'close',
    value: '118427000',
  },
  {
    id: 'eth',
    name: '이더리움',
    region: 'global',
    category: 'CRYPTO',
    currency: 'KRW',
    unit: 'KRW',
    provider: 'BITHUMB',
    symbol: 'KRW-ETH',
    historyKind: 'close',
    value: '4589000',
  },
];

export const marketFixtures: MarketQuote[] = seeds.map((seed, index) => {
  const widget = seed.provider === 'TRADINGVIEW';
  const definition =
    seed.category === 'ETF' ? MARKET_INSTRUMENTS.find((item) => item.id === seed.id) : undefined;
  const value = Number(seed.value);
  return {
    ...seed,
    value: widget ? null : seed.value,
    sourceUrl:
      definition?.sourceUrl ??
      (widget
        ? `https://www.tradingview.com/symbols/${seed.symbol.replace(':', '-')}/`
        : 'https://example.com/development-fixture'),
    attribution:
      definition?.attribution ?? (widget ? seed.provider : `${seed.provider} · 개발용 예시`),
    rightsMode: widget ? 'LINK_ONLY' : 'PRIVATE_DISPLAY_ONLY',
    displayKind: widget ? 'WIDGET' : 'NATIVE',
    widgetSymbol: widget ? seed.symbol : null,
    description:
      definition?.description ??
      (seed.id === 'wti' ? 'Cushing WTI 현물 · 일별 관측' : `${seed.name} 개발용 모의 데이터`),
    status: widget ? 'EMBEDDED' : seed.id === 'silver' ? 'STALE' : 'AVAILABLE',
    change: widget ? null : seed.category === 'BOND' ? '-3' : String(value * 0.01),
    changePercent: widget ? null : index % 2 === 0 ? '1.02' : '-0.48',
    changeUnit: seed.category === 'BOND' ? 'bp' : 'percent',
    changeLabel: seed.category === 'BOND' ? '전 관측일 대비' : '전일 종가 대비',
    valueDate: seed.category === 'BOND' || seed.id === 'wti' ? '2026-09-02' : null,
    providerAt: widget ? null : marketFixtureTime,
    observedAt: widget ? null : marketFixtureTime,
    referenceValue: widget ? null : String(value / 1.01),
    referenceDate: widget ? null : '2026-09-02',
    convertedValue: seed.category === 'CRYPTO' ? String(value / 1348.2) : null,
    conversionRate: seed.category === 'CRYPTO' ? '1348.2' : null,
    conversionAt: seed.category === 'CRYPTO' ? marketFixtureTime : null,
    message: seed.id === 'silver' ? '최근 수집이 지연되어 마지막 관측값을 표시합니다.' : null,
  };
});

export function marketHistoryFixture(id: string): MarketHistory {
  const instrument = marketFixtures.find((item) => item.id === id);
  if (!instrument) throw new Error('개발용 지표를 찾을 수 없습니다.');
  const count = id === 'usd-krw' ? 12 : 250;
  const points = Array.from({ length: count }, (_, index) => {
    const date = new Date(marketFixtureTime);
    date.setUTCDate(date.getUTCDate() - count + index + 1);
    return {
      date: date.toISOString().slice(0, 10),
      value: (
        Number(instrument.value) *
        (0.9 + (0.1 * index) / count + 0.02 * Math.sin(index / 9))
      ).toFixed(instrument.currency === 'KRW' ? 0 : 3),
    };
  });
  return {
    asOf: marketFixtureTime,
    instrument,
    range: '1y',
    points,
    historyKind: instrument.historyKind,
    status: 'AVAILABLE',
    message: null,
    sourceUrl: instrument.sourceUrl,
  };
}

export function watchlistQuoteFixtures(items: WatchlistItem[], ids: string[]): WatchlistQuote[] {
  return items
    .filter((item) => ids.includes(item.id))
    .map((item, index) => {
      const currency = item.market === 'NASDAQ' ? ('USD' as const) : ('KRW' as const);
      const price = currency === 'USD' ? '423.18' : String(72400 + index * 34800);
      return {
        companyId: item.id,
        status: index === 2 ? 'STALE' : 'LIVE',
        quote: {
          symbol: item.stockCode ?? item.ticker ?? '',
          source: 'TOSS',
          currency,
          price,
          providerAt: marketFixtureTime,
          observedAt: marketFixtureTime,
          rightsMode: 'PRIVATE_DISPLAY_ONLY',
          lossy: true,
        },
        previousClose: index === 1 ? null : Number(price) / 1.024,
        change: index === 1 ? null : Number(price) * 0.024,
        changePercent: index === 1 ? null : 2.4,
        referenceDate: index === 1 ? null : '2026-09-02',
      };
    });
}
