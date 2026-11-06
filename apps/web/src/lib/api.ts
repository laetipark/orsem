import type {
  Company,
  CompanyNotificationSettings,
  WatchPermissions,
  WatchRoom,
  WatchRoomDetail,
  WatchRoomDirectory,
  CompanyWatchlistMemberships,
  SaveCompanyWatchlistMemberships,
  WatchlistGroupQuotes,
  CompanyLogoResponse,
  CompanyLogoProvider,
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
  NewsReviewSelection,
  Session,
  SourceFreshness,
  SourceItem,
  SearchResults,
  KakaoConfig,
  Member,
  Region,
  MarketQuote,
  MarketHistory,
  NotificationSettings,
  NotificationPreferences,
  BrowserSubscriptionInput,
  NewsDetail,
  NewsSourceKind,
  NaverNewsStatus,
  WatchlistGroup,
  WatchlistGroupPage,
  CompanyQuote,
  WatchlistNewsPage,
  WatchlistFilings,
  NewsFeedPage,
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

export function isTemporaryApiError(error: unknown): boolean {
  return (
    error != null &&
    (!(error instanceof ApiError) ||
      error.statusCode === 0 ||
      error.statusCode === 408 ||
      error.statusCode === 429 ||
      error.statusCode >= 500)
  );
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (isFixtureMode) return (await import('./fixtures')).fixtureRequest<T>(url, init);

  const method = init?.method?.toUpperCase() ?? 'GET';
  const changesState = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (changesState && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'include',
      headers,
    });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    if (error instanceof TypeError)
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      );
    throw error;
  }

  if (!response.ok) {
    const fallback = {
      statusCode: response.status,
      code: 'HTTP_ERROR',
      message:
        response.status >= 500
          ? '서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
          : '요청을 처리하지 못했습니다.',
    };
    const parsed: unknown = await response.json().catch(() => null);
    const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    throw new ApiError(
      response.status,
      typeof body.code === 'string' ? body.code : fallback.code,
      typeof body.message === 'string' ? body.message : fallback.message,
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
  companyId?: string;
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
  asset?: 'gold' | 'silver' | 'wti' | 'btc' | 'eth';
  region?: Region;
  sourceKind?: NewsSourceKind;
  publisher?: string;
  q?: string;
  companyId?: string;
  companyIds?: readonly string[];
  cursor?: string | null;
  limit?: number;
}

export const api = {
  companyLogoCredits: async (
    signal?: AbortSignal,
  ): Promise<{
    items: Array<{
      path: string;
      source: 'manual' | 'simple-icons' | 'wikimedia';
      sourceUrl: string;
      license: string;
      attribution: string;
    }>;
  }> => {
    if (isFixtureMode) return { items: [] };
    const response = await fetch(`${API_BASE_URL}/companies/logo-credits`, {
      signal,
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('로고 출처를 불러오지 못했습니다.');
    return response.json();
  },
  companyLogo: (companyId: string, signal?: AbortSignal) =>
    request<CompanyLogoResponse>(`/companies/${encodeURIComponent(companyId)}/logo`, { signal }),
  companyLogoPermit: (companyId: string, provider: CompanyLogoProvider, signal?: AbortSignal) =>
    request<{ allowed: boolean }>(`/companies/${encodeURIComponent(companyId)}/logo-permit`, {
      method: 'POST',
      body: JSON.stringify({ provider }),
      signal,
    }),
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
  watchlistGroupItems: (id: string, offset = 0, signal?: AbortSignal, limit = 21) =>
    request<WatchlistGroupPage>(`/watchlist-groups/${id}/items${queryString({ offset, limit })}`, {
      signal,
    }),
  watchlistGroupQuotes: (id: string, signal?: AbortSignal) =>
    request<WatchlistGroupQuotes>(`/watchlist-groups/${encodeURIComponent(id)}/quotes`, {
      signal,
      cache: 'no-store',
    }),
  companyQuotes: (ids: readonly string[], signal?: AbortSignal) =>
    ids.length === 0
      ? Promise.resolve<{ asOf: string; items: CompanyQuote[] }>({
          asOf: new Date().toISOString(),
          items: [],
        })
      : request<{ asOf: string; items: CompanyQuote[] }>(
          `/companies/quotes${queryString({ ids: ids.join(',') })}`,
          { signal, cache: 'no-store' },
        ),
  watchlistGroupNews: (
    id: string,
    filters: { companyId?: string; limit?: number; cursor?: string | null } = {},
    signal?: AbortSignal,
  ) =>
    request<WatchlistNewsPage>(
      `/watchlist-groups/${encodeURIComponent(id)}/news${queryString({ limit: 20, ...filters })}`,
      { signal, cache: 'no-store' },
    ),
  watchlistGroupFilings: (id: string, companyId?: string, signal?: AbortSignal) =>
    request<WatchlistFilings>(
      `/watchlist-groups/${encodeURIComponent(id)}/filings${queryString({ companyId })}`,
      { signal, cache: 'no-store' },
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
  companyNotificationSettings: (companyId: string, signal?: AbortSignal) =>
    request<CompanyNotificationSettings>(
      `/notifications/companies/${encodeURIComponent(companyId)}`,
      {
        signal,
        cache: 'no-store',
      },
    ),
  updateCompanyNotificationSettings: (companyId: string, payload: { enabled: boolean }) =>
    request<CompanyNotificationSettings>(
      `/notifications/companies/${encodeURIComponent(companyId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
        cache: 'no-store',
      },
    ),
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
  session: async (signal?: AbortSignal) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 15_000);
    try {
      const session = await request<Session>('/auth/session', {
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
        cache: 'no-store',
      });
      setCsrfToken(session.csrfToken);
      return session;
    } catch (error) {
      if (timeout.signal.aborted && !signal?.aborted)
        throw new ApiError(
          408,
          'REQUEST_TIMEOUT',
          '서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.',
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
  marketSelection: (signal?: AbortSignal) =>
    request<{
      asOf: string;
      regions: Array<{
        region: string;
        status: string;
        reason: string | null;
        basisDate: string | null;
        observedAt: string | null;
        sourceUrl: string | null;
        updateNote: string | null;
        currency?: 'KRW' | 'USD';
        sourceName?: string | null;
        selectionMonth?: string | null;
        nextRefreshAt?: string | null;
        refreshCadence?: 'MONTHLY';
        providerScope?: string | null;
        items: Array<{
          rank: number;
          id: string;
          nameKo: string;
          nameEn?: string | null;
          marketCap: string;
          market?: string;
          stockCode?: string | null;
          ticker?: string | null;
          canonicalPath?: string;
        }>;
      }>;
    }>('/dashboard/market-selection', { signal }),
  companyInformation: (id: string, signal?: AbortSignal) =>
    request<{
      asOf: string;
      status: string;
      fields: Array<{
        key: string;
        label: string;
        value: string | null;
        unit: string | null;
        basis: string;
        source: string;
        sourceUrl: string;
        observedAt: string | null;
      }>;
    }>(`/companies/${encodeURIComponent(id)}/information`, { signal }),
  dashboard: () => request<DashboardData>('/dashboard'),
  personalFilings: (signal?: AbortSignal) =>
    request<{ asOf: string; companyCount: number; items: import('../types').PersonalFiling[] }>(
      '/dashboard/personal-filings',
      { signal, cache: 'no-store' },
    ),
  personalNews: (signal?: AbortSignal) =>
    request<{
      asOf: string;
      companyCount: number;
      events: DashboardData['priorities']['P1'];
      news: SourceItem[];
      providerGroups?: SourceItem[][];
      providerResultSets?: import('../types').NaverNewsResultSet[];
      naver?: import('../types').NewsFeedPage['naver'];
    }>('/dashboard/personal-news', { signal }),
  news: ({ limit = 20, companyIds, ...filters }: NewsFilters = {}, signal?: AbortSignal) =>
    companyIds?.length === 0
      ? Promise.resolve<NewsFeedPage>({ items: [], nextCursor: null })
      : request<NewsFeedPage>(
          `/news${queryString({ ...filters, companyIds: companyIds?.join(','), limit })}`,
          { signal, cache: 'no-store' },
        ),
  newsDetail: (id: string, signal?: AbortSignal) =>
    request<NewsDetail>(`/news/${encodeURIComponent(id)}`, { signal, cache: 'no-store' }),
  suggestions: (
    q: string,
    filters: {
      kind?: 'all' | 'companies' | 'news' | 'events';
      region?: Region;
      scope?: 'all' | 'market' | 'company';
      sourceKind?: NewsSourceKind;
      publisher?: string;
      companyId?: string;
    } = {},
    signal?: AbortSignal,
  ) =>
    request<SearchResults>(`/search/suggestions${queryString({ ...filters, limit: 5 })}`, {
      signal,
      cache: 'no-store',
      headers: { 'X-Orsem-Search-Query': encodeURIComponent(q) },
    }),
  search: (q: string, limit = 5, region: Region = 'all', signal?: AbortSignal) =>
    request<SearchResults>(`/search${queryString({ q, limit, region })}`, { signal }),
  events: (filters: EventFilters, signal?: AbortSignal) =>
    request<CursorPage<EventSummary>>(`/events${queryString(filters)}`, { signal }),
  event: (id: string, signal?: AbortSignal) =>
    request<EventDetail>(`/events/${encodeURIComponent(id)}`, { signal }),
  companies: (q = '', region: Region = 'all', cursor?: string | null, signal?: AbortSignal) =>
    request<CursorPage<CompanySummary>>(
      `/companies${queryString({ q, limit: 20, region, cursor })}`,
      { signal },
    ),
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
  sourceFreshness: () => request<{ asOf: string; items: SourceFreshness[] }>('/sources/freshness'),
  markets: (region: Region = 'all', signal?: AbortSignal) =>
    request<{ asOf: string; items: MarketQuote[]; histories?: Record<string, MarketHistory> }>(
      `/markets/overview${queryString({ region, historyRange: '1m' })}`,
      { signal },
    ),
  marketHistory: (id: string, range: '1m' | '3m' | '1y', signal?: AbortSignal) =>
    request<MarketHistory>(`/markets/${encodeURIComponent(id)}/history${queryString({ range })}`, {
      signal,
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
    newsReview?: NewsReviewSelection,
  ) =>
    request<ReviewResolution>(`/reviews/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution, note, planExecutionMatchId, ...newsReview }),
    }),
  operationSources: () => request<CursorPage<SourceFreshness>>('/operations/sources'),
  operationRuns: () => request<CursorPage<OperationRun>>('/operations/runs'),
  parseIntegrity: () => request<ParseIntegrityMetrics>('/operations/parse-integrity'),
  operationQueues: () => request<CursorPage<QueueMetric>>('/operations/queues'),
};
