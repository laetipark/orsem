import type { Market, RightsMode } from './enums';
import type { Region } from './region';

/** Deliberately small guest projections; member data is never part of this contract. */
export interface PublicCompany {
  id: string;
  name: string;
  market: Market;
  symbol: string;
  region: 'kr' | 'us';
  canonicalPath: string;
  chartSymbol: string | null;
  sourceUrl: string;
  observedAt: string | null;
}

export interface PublicNewsItem {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  publisher: string;
  publishedAt: string | null;
  firstObservedAt: string;
  rightsMode: RightsMode;
  sourceUrl: string;
  translation?: { title: string; summary: string | null };
}

export interface PublicPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PublicCompanyFilters {
  q?: string;
  region?: Region;
  cursor?: string;
  limit?: number;
}

export interface PublicNewsFilters extends PublicCompanyFilters {
  companyId?: string;
}
