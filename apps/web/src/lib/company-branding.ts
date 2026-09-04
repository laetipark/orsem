import type { CompanySummary } from '../types';

export interface CompanyBrand {
  iconUrl: string;
  sourceUrl: string;
  verifiedAt: string;
}

export const logoAttributionUrl = 'https://www.allinvestview.com/tools/ticker-logos/';

// 토스에는 로고 필드가 없어 별도 제공자의 응답과 기업 식별을 확인한 항목만 연결합니다.
// 시장별 키로 동명이인·동일 티커를 구분하며, 새 항목은 실제 로고를 확인한 뒤 추가합니다.
export const companyBrands: Readonly<Record<string, CompanyBrand>> = {
  'KR:005930': {
    iconUrl: 'https://cdn.tickerlogos.com/samsung.com',
    sourceUrl: logoAttributionUrl,
    verifiedAt: '2026-09-04',
  },
  'US:NVDA': {
    iconUrl: 'https://cdn.tickerlogos.com/nvidia.com',
    sourceUrl: logoAttributionUrl,
    verifiedAt: '2026-09-04',
  },
};

export function companyBrand(
  company: Pick<CompanySummary, 'stockCode' | 'ticker' | 'market'>,
): CompanyBrand | undefined {
  const key =
    company.stockCode && ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(company.market)
      ? `KR:${company.stockCode}`
      : company.ticker && ['NASDAQ', 'NYSE', 'AMEX'].includes(company.market)
        ? `US:${company.ticker.toUpperCase()}`
        : '';
  return companyBrands[key];
}
