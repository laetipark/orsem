import type { MarketQuote } from '../types';

const statusLabels: Record<MarketQuote['status'], { full: string | null; short: string | null }> = {
  AVAILABLE: { full: null, short: null },
  STALE: { full: '지연', short: '지연' },
  NOT_CONFIGURED: { full: '연결 미설정', short: '미설정' },
  WAITING: { full: '수집 대기', short: '대기' },
  UNAVAILABLE: { full: '이용 불가', short: '이용 불가' },
  EMBEDDED: { full: '일별 종가', short: '일별' },
};

export function marketStatusLabel(status: MarketQuote['status'], short = false): string | null {
  return statusLabels[status][short ? 'short' : 'full'];
}

export const marketHistoryLabels: Record<MarketQuote['historyKind'], string> = {
  close: '일별 종가',
  daily_average: '일평균',
  yield: '일별 수익률',
  observed: '수집 시점 관측값',
};

interface MarketGroupDefinition {
  key: string;
  region: MarketQuote['region'];
  label: string;
  english: string;
  description: string;
  categories?: readonly MarketQuote['category'][];
}

export const globalMarketGroups = [
  {
    key: 'commodities',
    region: 'global',
    label: '원자재·WTI',
    english: 'COMMODITIES',
    description: '금·은·WTI 현물',
    categories: ['METAL', 'ENERGY'],
    dashboardIds: ['gold', 'silver', 'wti'],
  },
  {
    key: 'crypto',
    region: 'global',
    label: '가상자산',
    english: 'CRYPTO',
    description: '빗썸 원화 시세와 달러 참고 환산',
    categories: ['CRYPTO'],
    dashboardIds: ['btc', 'eth'],
  },
] as const;

export const marketGroups: readonly MarketGroupDefinition[] = [
  {
    key: 'kr',
    region: 'kr',
    label: '국내',
    english: 'KOREA',
    description: '국내 지수와 원/달러',
  },
  {
    key: 'us',
    region: 'us',
    label: '미국',
    english: 'UNITED STATES',
    description: '미국 지수와 국채 수익률',
  },
  ...globalMarketGroups,
];

export function marketGroupItems(items: MarketQuote[], group: MarketGroupDefinition) {
  return items.filter(
    (item) =>
      item.region === group.region &&
      (!group.categories || group.categories.includes(item.category)),
  );
}
