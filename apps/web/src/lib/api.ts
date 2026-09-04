import { fixtureRequest } from './fixtures';
import type {
  CompanyDetail,
  CompanySummary,
  CompanyTimeline,
  CompanyLivePrice,
  CursorPage,
  DashboardData,
  EventDetail,
  EventSummary,
  OperationRun,
  QueueMetric,
  ReviewItem,
  ReviewResolution,
  Session,
  SourceFreshness,
  SourceItem,
  SearchResults,
  WatchlistItem,
  KakaoConfig,
  Member,
  Region,
  WatchlistQuote,
  MarketQuote,
  MarketHistory,
  NotificationSettings,
  NotificationPreferences,
  BrowserSubscriptionInput,
} from '../types';

const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/$/, '');
export const API_BASE_URL = configuredBase || '/api/v1';
export const isFixtureMode = import.meta.env.DEV && import.meta.env.VITE_FIXTURE_MODE === 'true';
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null | undefined) {
  csrfToken = token ?? null;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (isFixtureMode) return fixtureRequest<T>(url, init);

  const method = init?.method?.toUpperCase() ?? 'GET';
  const changesState = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (changesState && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    const fallback = {
      statusCode: response.status,
      code: 'HTTP_ERROR',
      message: '요청을 처리하지 못했습니다.',
    };
    const body = (await response.json().catch(() => fallback)) as Partial<typeof fallback> & {
      details?: unknown;
    };
    throw new ApiError(
      body.statusCode ?? response.status,
      body.code ?? fallback.code,
      body.message ?? fallback.message,
      body.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function queryString<T extends object>(values: T): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values) as Array<
    [string, string | number | null | undefined]
  >) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

export interface EventFilters {
  region?: Region;
  q?: string;
  detailType?: string;
  priority?: string;
  classificationStatus?: string;
  cursor?: string | null;
  limit?: number;
}

export const api = {
  notificationSettings: () => request<NotificationSettings>('/notifications/settings'),
  updateNotificationSettings: (payload: NotificationPreferences) =>
    request<NotificationSettings>('/notifications/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  subscribeNotifications: (payload: BrowserSubscriptionInput) =>
    request<{ id: string }>('/notifications/subscriptions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  unsubscribeNotifications: (id: string) =>
    request<void>(`/notifications/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testNotification: (subscriptionId: string) =>
    request<{ queued: true; simulated?: boolean }>('/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ subscriptionId }),
    }),

  kakaoConfig: () =>
    isFixtureMode
      ? Promise.resolve<KakaoConfig>({ enabled: false, startUrl: null })
      : request<KakaoConfig>('/auth/kakao/config'),
  members: (status: Member['status']) =>
    isFixtureMode
      ? Promise.resolve<CursorPage<Member>>({ items: [], nextCursor: null })
      : request<CursorPage<Member>>(`/auth/members${queryString({ status })}`),
  reviewMember: (id: string, status: 'APPROVED' | 'REJECTED') =>
    request<Member>(`/auth/members/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  session: async () => {
    const session = await request<Session>('/auth/session');
    setCsrfToken(session.csrfToken);
    return session;
  },
  login: async (payload: {
    email: string;
    password: string;
    totpCode?: string;
    recoveryCode?: string;
  }) => {
    const session = await request<Session>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setCsrfToken(session.csrfToken);
    return session;
  },
  logout: async () => {
    const session = await request<Session>('/auth/logout', { method: 'POST' });
    setCsrfToken(session.csrfToken);
    return session;
  },
  dashboard: () => request<DashboardData>('/dashboard'),
  news: ({ limit = 20, cursor }: { limit?: number; cursor?: string | null } = {}) =>
    request<CursorPage<SourceItem>>(`/news${queryString({ source: 'NEWS_RSS', limit, cursor })}`),
  search: (q: string, limit = 5, region: Region = 'all') =>
    request<SearchResults>(`/search${queryString({ q, limit, region })}`),
  events: (filters: EventFilters) =>
    request<CursorPage<EventSummary>>(`/events${queryString(filters)}`),
  event: (id: string) => request<EventDetail>(`/events/${encodeURIComponent(id)}`),
  companies: (q = '', region: Region = 'all') =>
    request<CursorPage<CompanySummary>>(`/companies${queryString({ q, limit: 20, region })}`),
  company: (id: string) => request<CompanyDetail>(`/companies/${encodeURIComponent(id)}`),
  companyTimeline: (id: string, range: string, interval: '1d' | '1m' = '1d') =>
    request<CompanyTimeline>(
      `/companies/${encodeURIComponent(id)}/timeline${queryString({ range, interval })}`,
    ),
  companyLivePrice: (id: string) =>
    request<CompanyLivePrice>(`/companies/${encodeURIComponent(id)}/live-price`),
  watchlist: (region: Region = 'all', cursor: string | null = null) =>
    request<CursorPage<WatchlistItem>>(`/watchlist${queryString({ region, cursor, limit: 21 })}`),
  watchlistQuotes: (ids: string[]) =>
    request<{ asOf: string; items: WatchlistQuote[] }>(
      `/watchlist/quotes${queryString({ ids: ids.join(',') })}`,
    ),
  sourceFreshness: () => request<{ asOf: string; items: SourceFreshness[] }>('/sources/freshness'),
  markets: (region: Region = 'all') =>
    request<{ asOf: string; items: MarketQuote[] }>(`/markets/overview${queryString({ region })}`),
  marketHistory: (id: string, range: '1m' | '3m' | '1y') =>
    request<MarketHistory>(`/markets/${encodeURIComponent(id)}/history${queryString({ range })}`),
  addWatchlist: (payload: {
    companyId: string;
    priority: 'P1' | 'P2';
    realtimeAlerts: boolean;
    digestAlerts: boolean;
    note?: string;
  }) =>
    request<WatchlistItem>('/watchlist', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateWatchlist: (
    id: string,
    payload: Partial<Pick<WatchlistItem, 'priority' | 'realtimeAlerts' | 'digestAlerts' | 'note'>>,
  ) =>
    request<WatchlistItem>(`/watchlist/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  removeWatchlist: (companyId: string) =>
    request<void>(`/watchlist/${encodeURIComponent(companyId)}`, {
      method: 'DELETE',
    }),
  reviews: () => request<CursorPage<ReviewItem>>('/reviews'),
  resolveReview: (
    id: string,
    resolution: ReviewResolution['resolution'],
    note: string | null,
    planExecutionMatchId?: string,
  ) =>
    request<ReviewResolution>(`/reviews/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution, note, planExecutionMatchId }),
    }),
  operationSources: () => request<CursorPage<SourceFreshness>>('/operations/sources'),
  operationRuns: () => request<CursorPage<OperationRun>>('/operations/runs'),
  operationQueues: () => request<CursorPage<QueueMetric>>('/operations/queues'),
};
