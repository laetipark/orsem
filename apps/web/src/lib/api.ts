import type {
  Company,
  WatchPermissions,
  WatchRoom,
  WatchRoomDetail,
  WatchRoomDirectory,
  CompanyWatchlistMemberships,
  SaveCompanyWatchlistMemberships,
} from '@orsem/contracts';
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
  ParseIntegrityMetrics,
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
  NaverNewsSearchResult,
  NewsDetail,
  NewsSourceKind,
  NewsTranslationEdit,
  NewsTranslationEditInput,
  NaverNewsStatus,
  WatchlistGroup,
  WatchlistGroupPage,
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
  if (isFixtureMode) return (await import('./fixtures')).fixtureRequest<T>(url, init);

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

export interface NewsFilters {
  scope?: 'all' | 'market' | 'company';
  region?: Region;
  sourceKind?: NewsSourceKind;
  publisher?: string;
  q?: string;
  companyId?: string;
  cursor?: string | null;
  limit?: number;
}

export const api = {
  companyWatchlistMemberships: (companyId: string, signal?: AbortSignal) =>
    request<CompanyWatchlistMemberships>(
      `/watchlist-groups/company-memberships/${encodeURIComponent(companyId)}`,
      { signal, cache: 'no-store' },
    ),
  saveCompanyWatchlistMemberships: async (
    companyId: string,
    payload: SaveCompanyWatchlistMemberships,
  ) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await request<void>(
        `/watchlist-groups/company-memberships/${encodeURIComponent(companyId)}`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  },
  watchlistRooms: (signal?: AbortSignal) =>
    request<{ items: WatchRoom[] }>('/watchlist-rooms', { signal }),
  watchlistRoomDirectory: (offset = 0, signal?: AbortSignal) =>
    request<WatchRoomDirectory>(`/watchlist-rooms/directory${queryString({ offset })}`, { signal }),
  watchlistRoom: (id: string, signal?: AbortSignal) =>
    request<WatchRoomDetail>(`/watchlist-rooms/${id}`, { signal }),
  createWatchlistRoom: (name: string, description: string) =>
    request<WatchRoom>('/watchlist-rooms', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  roomAction: (id: string, path: string, method: string, body?: unknown) =>
    request<void>(`/watchlist-rooms/${encodeURIComponent(id)}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  orderWatchlistRooms: (ids: string[]) =>
    request<void>('/watchlist-rooms/order', { method: 'PATCH', body: JSON.stringify({ ids }) }),
  watchlistGroups: (signal?: AbortSignal, roomId?: string) =>
    request<{ items: WatchlistGroup[]; revision: number; permissions: WatchPermissions }>(
      `/watchlist-groups${queryString({ roomId })}`,
      { signal },
    ),
  watchlistGroupItems: (id: string, offset = 0, signal?: AbortSignal) =>
    request<WatchlistGroupPage>(
      `/watchlist-groups/${id}/items${queryString({ offset, limit: 21 })}`,
      { signal },
    ),
  createWatchlistGroup: (name: string, roomId?: string) =>
    request<WatchlistGroup>('/watchlist-groups', {
      method: 'POST',
      body: JSON.stringify({ name, roomId }),
    }),
  saveWatchlistGroups: (payload: {
    roomId?: string;
    revision: number;
    groups: Array<{ id: string; name: string }>;
  }) => request<void>('/watchlist-groups/edit', { method: 'PUT', body: JSON.stringify(payload) }),
  editWatchlistGroup: (id: string, signal?: AbortSignal) =>
    request<{ group: WatchlistGroup; revision: number; items: Company[] }>(
      `/watchlist-groups/${id}/edit`,
      { signal },
    ),
  saveWatchlistGroupItems: (id: string, revision: number, companyIds: string[]) =>
    request<void>(`/watchlist-groups/${id}/edit`, {
      method: 'PUT',
      body: JSON.stringify({ revision, companyIds }),
    }),
  copyWatchlistGroup: (id: string, roomId: string, revision: number) =>
    request<WatchlistGroup>(`/watchlist-groups/${id}/copy`, {
      method: 'POST',
      body: JSON.stringify({ roomId, revision }),
    }),
  addWatchlistGroupItem: (id: string, companyId: string, revision: number) =>
    request<void>(`/watchlist-groups/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({ companyId, revision }),
    }),
  naverNewsStatus: (signal?: AbortSignal) =>
    request<NaverNewsStatus>('/news-search/naver/status', { signal, cache: 'no-store' }),
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
  news: ({ limit = 20, ...filters }: NewsFilters = {}, signal?: AbortSignal) =>
    request<CursorPage<SourceItem>>(`/news${queryString({ ...filters, limit })}`, { signal }),
  newsDetail: (id: string, signal?: AbortSignal) =>
    request<NewsDetail>(`/news/${encodeURIComponent(id)}`, { signal }),
  newsTranslationEdit: (id: string, signal?: AbortSignal) =>
    request<NewsTranslationEdit>(`/news/${encodeURIComponent(id)}/translation-edit`, { signal }),
  saveNewsTranslation: (id: string, input: NewsTranslationEditInput) =>
    request<NewsTranslationEdit>(`/news/${encodeURIComponent(id)}/translation-edit`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  naverNewsSearch: (
    q: string,
    start = 1,
    sort: 'date' | 'sim' = 'date',
    signal?: AbortSignal,
    automatic = false,
  ) =>
    request<NaverNewsSearchResult>('/news-search/naver', {
      cache: 'no-store',
      headers: {
        'X-Orsem-News-Query': encodeURIComponent(q),
        'X-Orsem-News-Start': String(start),
        'X-Orsem-News-Sort': sort,
        ...(automatic ? { 'X-Orsem-News-Mode': 'automatic' } : {}),
      },
      signal,
    }),
  search: (q: string, limit = 5, region: Region = 'all', signal?: AbortSignal) =>
    request<SearchResults>(`/search${queryString({ q, limit, region })}`, { signal }),
  events: (filters: EventFilters, signal?: AbortSignal) =>
    request<CursorPage<EventSummary>>(`/events${queryString(filters)}`, { signal }),
  event: (id: string, signal?: AbortSignal) =>
    request<EventDetail>(`/events/${encodeURIComponent(id)}`, { signal }),
  companies: (q = '', region: Region = 'all') =>
    request<CursorPage<CompanySummary>>(`/companies${queryString({ q, limit: 20, region })}`),
  company: (id: string, signal?: AbortSignal) =>
    request<CompanyDetail>(`/companies/${encodeURIComponent(id)}`, { signal }),
  companyTimeline: (
    id: string,
    range: string,
    interval: '1d' | '1m' = '1d',
    signal?: AbortSignal,
  ) =>
    request<CompanyTimeline>(
      `/companies/${encodeURIComponent(id)}/timeline${queryString({ range, interval })}`,
      { signal },
    ),
  companyRecentActivity: (id: string, signal?: AbortSignal, limit = 3) =>
    request<
      import('../types').WatchlistGroupItem['recentActivity'] & {
        windowStartDate: string;
        windowEndDate: string;
      }
    >(`/companies/${encodeURIComponent(id)}/recent-activity${queryString({ limit })}`, { signal }),
  companyLivePrice: (id: string, signal?: AbortSignal) =>
    request<CompanyLivePrice>(`/companies/${encodeURIComponent(id)}/live-price`, { signal }),
  watchlist: (region: Region = 'all', cursor: string | null = null) =>
    request<CursorPage<WatchlistItem>>(`/watchlist${queryString({ region, cursor, limit: 21 })}`),
  watchlistQuotes: (ids: string[]) =>
    request<{ asOf: string; items: WatchlistQuote[] }>(
      `/watchlist/quotes${queryString({ ids: ids.join(',') })}`,
    ),
  sourceFreshness: () => request<{ asOf: string; items: SourceFreshness[] }>('/sources/freshness'),
  markets: (region: Region = 'all') =>
    request<{ asOf: string; items: MarketQuote[] }>(`/markets/overview${queryString({ region })}`),
  marketHistory: (id: string, range: '1m' | '3m' | '1y', signal?: AbortSignal) =>
    request<MarketHistory>(`/markets/${encodeURIComponent(id)}/history${queryString({ range })}`, {
      signal,
    }),
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
  reviews: (cursor?: string) =>
    request<CursorPage<ReviewItem>>(
      `/reviews${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  confirmReviewSource: (id: string, note: string | null) =>
    request<{ sourceReviewConfirmed: boolean; queued: false }>(`/reviews/${id}/source-review`, {
      method: 'POST',
      body: JSON.stringify({ confirmed: true, ...(note ? { note } : {}) }),
    }),
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
  parseIntegrity: () => request<ParseIntegrityMetrics>('/operations/parse-integrity'),
  operationQueues: () => request<CursorPage<QueueMetric>>('/operations/queues'),
};
