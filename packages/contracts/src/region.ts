import { z } from 'zod';

export const regionSchema = z.enum(['all', 'kr', 'us']).default('all');
export type Region = z.infer<typeof regionSchema>;

const regionMarkets = {
  kr: ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'],
  us: ['NASDAQ', 'NYSE', 'AMEX'],
} as const;

export function marketsForRegion(region: Region): readonly string[] {
  return region === 'all' ? [...regionMarkets.kr, ...regionMarkets.us] : regionMarkets[region];
}

export function companyRegion(market: string | null | undefined): Exclude<Region, 'all'> | null {
  if (regionMarkets.kr.some((item) => item === market)) return 'kr';
  if (regionMarkets.us.some((item) => item === market)) return 'us';
  return null;
}

export function matchesRegion(market: string | null | undefined, region: Region = 'all'): boolean {
  return region === 'all' || companyRegion(market) === region;
}
