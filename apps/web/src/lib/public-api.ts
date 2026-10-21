import { queryOptions } from '@tanstack/react-query';
import type {
  MarketHistory,
  MarketOverview,
  PublicCompany,
  PublicNewsItem,
  PublicPage,
} from '@orsem/contracts';
import { API_BASE_URL, ApiError } from './api';

export type PublicRegion = 'all' | 'kr' | 'us';
export const publicMarketIds = new Set(['us2y', 'us10y', 'wti']);

export function publicExternalUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function queryString(values: Record<string, string | number | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.size ? `?${params}` : '';
}

/** Public reads never attach session cookies or invoke the fixture/collection paths. */
async function readPublic<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/public${path}`, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      0,
      'PUBLIC_NETWORK_ERROR',
      '공개 자료에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      'PUBLIC_REQUEST_FAILED',
      response.status === 404
        ? '공개된 자료를 찾을 수 없습니다.'
        : '공개 자료를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
    );
  return (await response.json()) as T;
}

export interface PublicListFilters {
  q?: string;
  region?: PublicRegion;
  cursor?: string | null;
  limit?: number;
}

export const publicApi = {
  markets: (region: PublicRegion = 'all', signal?: AbortSignal) =>
    readPublic<MarketOverview>(
      `/markets/overview${queryString({ region, historyRange: '1m' })}`,
      signal,
    ),
  marketHistory: (id: string, range: '1m' | '3m' | '1y', signal?: AbortSignal) =>
    readPublic<MarketHistory>(
      `/markets/${encodeURIComponent(id)}/history${queryString({ range })}`,
      signal,
    ),
  companies: (filters: PublicListFilters = {}, signal?: AbortSignal) =>
    readPublic<PublicPage<PublicCompany>>(`/companies${queryString({ ...filters })}`, signal),
  company: (id: string, signal?: AbortSignal) =>
    readPublic<PublicCompany>(`/companies/${encodeURIComponent(id)}`, signal),
  news: (filters: PublicListFilters & { companyId?: string } = {}, signal?: AbortSignal) =>
    readPublic<PublicPage<PublicNewsItem>>(`/news${queryString({ ...filters })}`, signal),
  newsDetail: (id: string, signal?: AbortSignal) =>
    readPublic<PublicNewsItem>(`/news/${encodeURIComponent(id)}`, signal),
};

export function publicMarketsQuery() {
  return queryOptions({
    queryKey: ['public', 'markets', 'all'],
    queryFn: ({ signal }) => publicApi.markets('all', signal),
    select: (data) => ({
      ...data,
      items: data.items.filter(
        (item) => publicMarketIds.has(item.id) && item.displayKind === 'NATIVE',
      ),
    }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}
