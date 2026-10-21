import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './app';
import { ThemeProvider } from './theme';
import type { Session } from './types';
import { ApiError } from './lib/api';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  config: vi.fn(),
  suggestions: vi.fn(async () => ({ companies: [], news: [], filings: [], hasMore: {} })),
  search: vi.fn(),
  sourceFreshness: vi.fn(),
  disconnectPush: vi.fn(),
  unsubscribeNotifications: vi.fn(),
  companyLogoCredits: vi.fn(async () => ({ items: [] })),
}));
vi.mock('./lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api')>()),
  isFixtureMode: false,
  api: {
    session: mocks.session,
    login: mocks.login,
    logout: mocks.logout,
    kakaoConfig: mocks.config,
    suggestions: mocks.suggestions,
    search: mocks.search,
    sourceFreshness: mocks.sourceFreshness,
    unsubscribeNotifications: mocks.unsubscribeNotifications,
    companyLogoCredits: mocks.companyLogoCredits,
  },
}));
vi.mock('./lib/web-push', () => ({ disconnectPushOnLogout: mocks.disconnectPush }));
vi.mock('./pages/dashboard-page', () => ({ DashboardPage: () => <div>관측 대시보드</div> }));
vi.mock('./pages/event-detail-page', () => ({
  EventDetailPage: () => <div>알림으로 연 이벤트</div>,
}));
vi.mock('./pages/guest-pages', () => ({
  GuestHomePage: () => <div>공개 관측 홈</div>,
  GuestMarketsPage: () => <div>공개 시장 차트</div>,
  GuestMarketDetailPage: () => <div>공개 시장 상세</div>,
  GuestCompaniesPage: () => <div>공개 종목 검색</div>,
  GuestCompanyPage: () => <div>공개 종목 차트</div>,
  GuestNewsPage: () => <div>공개 뉴스 목록</div>,
  GuestNewsDetailPage: () => <div>공개 뉴스 상세</div>,
}));

const anonymous: Session = {
  authenticated: false,
  canAccess: false,
  csrfToken: 'test',
  user: null,
  setupRequired: false,
};
const administrator: Session = {
  ...anonymous,
  authenticated: true,
  canAccess: true,
  user: {
    id: 'admin',
    email: 'admin@example.test',
    displayName: null,
    provider: 'LOCAL',
    role: 'ADMIN',
    status: 'APPROVED',
    totpEnabled: true,
  },
};

function show(path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.disconnectPush.mockResolvedValue(undefined);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  mocks.session.mockResolvedValue(administrator);
  mocks.logout.mockImplementation(async () => {
    mocks.session.mockResolvedValue(anonymous);
    return anonymous;
  });
  mocks.config.mockResolvedValue({ enabled: false, startUrl: null });
  mocks.sourceFreshness.mockResolvedValue({
    asOf: '2026-09-04T00:00:00Z',
    items: [
      {
        id: 'naver',
        name: 'NAVER Cloud 뉴스검색',
        status: 'HEALTHY',
        lastSuccessAt: '2026-09-04T00:00:00Z',
        lagSeconds: 15,
        message: null,
      },
    ],
  });
  mocks.search.mockResolvedValue({
    query: 'AAPL',
    companies: [],
    news: [],
    filings: [],
    hasMore: { companies: false, news: false, filings: false },
  });
});
afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
});

it.each([
  new TypeError('Failed to fetch'),
  new ApiError(502, 'HTTP_ERROR', '요청을 처리하지 못했습니다.'),
  new ApiError(503, 'UNAVAILABLE', '일시적으로 연결할 수 없습니다.'),
])(
  'keeps the mounted authenticated page during a transient session check failure: %s',
  async (error) => {
    const client = show();
    const page = await screen.findByText('관측 대시보드');
    client.setQueryData(['news', 'private'], { title: 'cached news' });
    mocks.session.mockRejectedValue(error);
    await act(async () => client.refetchQueries({ queryKey: ['session'], exact: true }));

    expect(await screen.findByRole('button', { name: '연결 다시 확인' })).toBeInTheDocument();
    expect(screen.getByText('관측 대시보드')).toBe(page);
    expect(client.getQueryData(['session'])).toEqual(administrator);
    expect(client.getQueryData(['news', 'private'])).toEqual({ title: 'cached news' });
    expect(screen.queryByRole('button', { name: '카카오 로그인' })).not.toBeInTheDocument();

    mocks.session.mockResolvedValue(administrator);
    fireEvent.click(screen.getByRole('button', { name: '연결 다시 확인' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '연결 다시 확인' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('관측 대시보드')).toBe(page);
    client.clear();
  },
);

it('explains an initial outage in Korean and recovers the requested page without a reload', async () => {
  mocks.session.mockRejectedValue(new TypeError('Failed to fetch'));
  const client = show('/events/12345678-1234-4234-8234-123456789abc');
  expect(
    await screen.findByRole('heading', { name: '서버에 잠시 연결할 수 없습니다' }),
  ).toBeVisible();
  expect(screen.getByText('잠시 후 자동으로 다시 연결합니다.')).toBeVisible();
  expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '카카오 로그인' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '연결 다시 확인' })).not.toBeInTheDocument();

  mocks.session.mockResolvedValue(administrator);
  fireEvent.click(screen.getByRole('button', { name: '다시 연결' }));
  expect(await screen.findByText('알림으로 연 이벤트')).toBeVisible();
  client.clear();
});

it.each([401, 403])(
  'hides the authenticated page after an explicit %i session rejection',
  async (status) => {
    const client = show();
    await screen.findByText('관측 대시보드');
    mocks.session.mockRejectedValue(
      new ApiError(status, 'ACCESS_DENIED', '로그인 권한이 없습니다.'),
    );
    await act(async () => client.refetchQueries({ queryKey: ['session'], exact: true }));

    expect(await screen.findByText('로그인 권한이 없습니다.')).toBeInTheDocument();
    expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
    expect(await screen.findByText('공개 관측 홈')).toBeVisible();

    mocks.session.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => client.refetchQueries({ queryKey: ['session'], exact: true }));
    expect(await screen.findByText(/공개 차트와 뉴스는 계속 이용할 수 있습니다/)).toBeVisible();
    expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
    expect(screen.getByText('공개 관측 홈')).toBeVisible();
    client.clear();
  },
);

it('preserves the account approval screen when its session recheck loses connection', async () => {
  mocks.session.mockResolvedValue({
    ...administrator,
    canAccess: false,
    user: { ...administrator.user!, provider: 'KAKAO', role: 'VIEWER', status: 'PENDING' },
  });
  const client = show('/login');
  const account = await screen.findByText('가입 신청이 접수되었습니다');
  mocks.session.mockRejectedValue(
    new ApiError(503, 'UNAVAILABLE', '일시적으로 연결할 수 없습니다.'),
  );
  await act(async () => client.refetchQueries({ queryKey: ['session'], exact: true }));
  expect(await screen.findByRole('button', { name: '연결 다시 확인' })).toBeVisible();
  expect(screen.getByText('가입 신청이 접수되었습니다')).toBe(account);
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  client.clear();
});

it('recovers active transient page failures after session recovery without retrying access denial', async () => {
  const client = show();
  await screen.findByText('관측 대시보드');
  const unavailable = new ApiError(502, 'HTTP_ERROR', '일시적인 서버 오류');
  const loadPage = vi.fn().mockRejectedValue(unavailable);
  const deniedPage = vi.fn().mockRejectedValue(new ApiError(403, 'DENIED', '권한 없음'));
  const inactivePage = vi.fn().mockRejectedValue(unavailable);
  const pageObserver = new QueryObserver(client, { queryKey: ['outage-page'], queryFn: loadPage });
  const deniedObserver = new QueryObserver(client, {
    queryKey: ['denied-page'],
    queryFn: deniedPage,
  });
  const stopPage = pageObserver.subscribe(() => undefined);
  const stopDenied = deniedObserver.subscribe(() => undefined);
  await client
    .fetchQuery({ queryKey: ['inactive-page'], queryFn: inactivePage })
    .catch(() => undefined);
  await waitFor(() => expect(pageObserver.getCurrentResult().isError).toBe(true));
  mocks.session.mockRejectedValue(unavailable);
  await act(async () => client.refetchQueries({ queryKey: ['session'], exact: true }));
  await screen.findByRole('button', { name: '연결 다시 확인' });

  loadPage.mockResolvedValue({ recovered: true });
  mocks.session.mockResolvedValue(administrator);
  fireEvent.click(screen.getByRole('button', { name: '연결 다시 확인' }));
  await waitFor(() => expect(client.getQueryData(['outage-page'])).toEqual({ recovered: true }));
  expect(loadPage).toHaveBeenCalledTimes(2);
  expect(deniedPage).toHaveBeenCalledOnce();
  expect(inactivePage).toHaveBeenCalledOnce();
  stopPage();
  stopDenied();
  client.clear();
});

it('removes private content when a recovered session check confirms logout', async () => {
  const client = show();
  await screen.findByText('관측 대시보드');
  client.setQueryData(['news', 'private'], { title: 'cached news' });
  mocks.session.mockRejectedValue(new TypeError('Failed to fetch'));
  await act(async () => client.refetchQueries({ queryKey: ['session'], exact: true }));
  await screen.findByRole('button', { name: '연결 다시 확인' });

  mocks.session.mockResolvedValue(anonymous);
  fireEvent.click(screen.getByRole('button', { name: '연결 다시 확인' }));
  expect(await screen.findByText('공개 관측 홈')).toBeVisible();
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  expect(client.getQueryData(['news', 'private'])).toBeUndefined();
  client.clear();
});

it('rechecks the session when the application returns to the foreground', async () => {
  const client = show();
  await screen.findByText('관측 대시보드');
  act(() => focusManager.setFocused(false));
  mocks.session.mockResolvedValue(anonymous);
  act(() => focusManager.setFocused(true));

  expect(await screen.findByText('공개 관측 홈')).toBeVisible();
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  client.clear();
});

it('serves public logo attribution without requiring a session or a working authentication API', async () => {
  mocks.session.mockRejectedValue(new Error('session unavailable'));
  const client = show('/logo-sources');
  expect(await screen.findByRole('heading', { name: '로고 출처·이용 안내' })).toBeVisible();
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.sourceFreshness).not.toHaveBeenCalled();
  for (const link of screen.getAllByRole('link', { name: 'Logos provided by Logo.dev' })) {
    expect(link).toHaveAttribute('href', 'https://logo.dev');
    expect(link).toHaveAttribute('rel', 'noopener');
    expect(link).toHaveAttribute('referrerpolicy', 'origin');
  }
  expect(screen.getByRole('link', { name: 'Brandfetch' })).toHaveAttribute(
    'href',
    'https://brandfetch.com',
  );
  expect(screen.getByText(/운용사 로고는 개별 ETF의/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Simple Icons 이용 안내' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Wikimedia Commons 재사용 안내' })).toBeVisible();
  expect(screen.queryByText(/AllInvestView|Finnhub/)).not.toBeInTheDocument();
  client.clear();
});

it('logs out through the mounted App without losing its session subscription', async () => {
  const client = show();
  client.setQueryData(['operation-runs'], { private: true });
  client.setQueryData(['public', 'news', 'latest'], { items: [], nextCursor: null });
  sessionStorage.setItem('orsem-news-edit-v1:admin:article', 'private draft');
  expect(await screen.findByText('관측 대시보드')).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '로그아웃' })));
  expect(await screen.findByText('공개 관측 홈')).toBeVisible();
  expect(screen.queryByLabelText('관리자 이메일')).not.toBeInTheDocument();
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  await waitFor(() => expect(client.getQueryData(['session'])).toEqual(anonymous));
  expect(client.getQueryData(['operation-runs'])).toBeUndefined();
  expect(client.getQueryData(['public', 'news', 'latest'])).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(sessionStorage.getItem('orsem-news-edit-v1:admin:article')).toBeNull();
  client.clear();
});

it('removes administrator news cached before a refreshed session changes audience', async () => {
  const client = show();
  expect(await screen.findByText('관측 대시보드')).toBeInTheDocument();
  client.setQueryData(['news', 'private'], { title: 'administrator-only news' });
  const member: Session = {
    ...administrator,
    user: { ...administrator.user!, id: 'member', provider: 'KAKAO', role: 'VIEWER' },
  };
  mocks.session.mockResolvedValue(member);
  await act(async () => {
    client.setQueryData(['session'], member);
  });
  await waitFor(() => expect(client.getQueryData(['news', 'private'])).toBeUndefined());
  expect(client.getQueryData(['session'])).toEqual(member);
  client.clear();
});

it('routes anonymous users between separate member and administrator pages', async () => {
  mocks.session.mockResolvedValue(anonymous);
  const client = show('/admin/login');
  expect(await screen.findByLabelText('관리자 이메일')).toBeInTheDocument();
  expect(mocks.config).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: '회원 로그인으로 돌아가기' }));
  expect(await screen.findByRole('button', { name: '카카오 로그인' })).toBeInTheDocument();
  expect(screen.queryByLabelText('관리자 이메일')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: '관리자 로그인' }));
  expect(await screen.findByLabelText('관리자 이메일')).toBeInTheDocument();
  client.clear();
});

it('restores a notification event after an anonymous user signs in on the separate admin page', async () => {
  mocks.session.mockResolvedValue(anonymous);
  mocks.login.mockImplementation(async () => {
    mocks.session.mockResolvedValue(administrator);
    return administrator;
  });
  const client = show('/events/12345678-1234-4234-8234-123456789abc');
  expect(await screen.findByRole('button', { name: '카카오 로그인' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: '관리자 로그인' }));
  fireEvent.change(await screen.findByLabelText('관리자 이메일'), {
    target: { value: 'admin@example.test' },
  });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password-123' } });
  fireEvent.change(screen.getByLabelText('인증 코드'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '관리자 로그인' }));
  expect(await screen.findByText('알림으로 연 이벤트')).toBeInTheDocument();
  expect(sessionStorage.getItem('orsem-login-return-v1')).toBeNull();
  client.clear();
});

it.each(['PENDING', 'APPROVED'] as const)(
  'allows a %s member to authenticate as administrator and removes the previous account cache',
  async (status) => {
    mocks.session.mockResolvedValue({
      ...administrator,
      canAccess: status === 'APPROVED',
      user: {
        ...administrator.user!,
        id: 'member',
        provider: 'KAKAO',
        role: 'VIEWER',
        status,
        totpEnabled: false,
      },
    });
    mocks.login.mockImplementation(async () => {
      mocks.session.mockResolvedValue(administrator);
      return administrator;
    });
    const client = show('/admin/login');
    client.setQueryData(['watchlists'], { owner: 'member' });
    expect(await screen.findByLabelText('관리자 이메일')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('관리자 이메일'), {
      target: { value: 'admin@example.test' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'test-password-123' },
    });
    fireEvent.change(screen.getByLabelText('인증 코드'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '관리자 로그인' }));
    await waitFor(() => expect(screen.getByText('관측 대시보드')).toBeInTheDocument());
    await waitFor(() => expect(client.getQueryData(['session'])).toEqual(administrator));
    expect(client.getQueryData(['watchlists'])).toBeUndefined();
    expect(screen.getByRole('link', { name: '운영' })).toBeInTheDocument();
    client.clear();
  },
);

it('redirects an authenticated administrator from the administrator login page', async () => {
  const client = show('/admin/login');
  expect(await screen.findByText('관측 대시보드')).toBeInTheDocument();
  expect(screen.queryByLabelText('관리자 이메일')).not.toBeInTheDocument();
  client.clear();
});

it('keeps the current member session when its push connection cannot be revoked before an account switch', async () => {
  mocks.session.mockResolvedValue({
    ...administrator,
    user: { ...administrator.user!, id: 'member', role: 'VIEWER', provider: 'KAKAO' },
  });
  mocks.disconnectPush.mockRejectedValue(new Error('알림 연결 해제 후 다시 시도해 주세요.'));
  const client = show('/admin/login');
  fireEvent.change(await screen.findByLabelText('관리자 이메일'), {
    target: { value: 'admin@example.test' },
  });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password-123' } });
  fireEvent.change(screen.getByLabelText('인증 코드'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '관리자 로그인' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '알림 연결 해제 후 다시 시도해 주세요.',
  );
  expect(mocks.disconnectPush).toHaveBeenCalledWith('member', mocks.unsubscribeNotifications);
  expect(mocks.login).not.toHaveBeenCalled();
  client.clear();
});

it('allows viewer observation navigation while redirecting administrator routes', async () => {
  mocks.session.mockResolvedValue({
    ...administrator,
    user: { ...administrator.user!, provider: 'KAKAO', role: 'VIEWER', totpEnabled: false },
  });
  const client = show('/operations');
  expect(await screen.findByText('관측 대시보드')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '운영' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '검토함' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '관심 종목' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '데이터 출처·신선도' })).toHaveAttribute(
    'href',
    '/sources',
  );
  expect(mocks.sourceFreshness).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: '운영 상세 보기' })).not.toBeInTheDocument();
  client.clear();
});

it('keeps an identified pending member outside the application shell', async () => {
  mocks.session.mockResolvedValue({
    ...administrator,
    canAccess: false,
    user: { ...administrator.user!, provider: 'KAKAO', role: 'VIEWER', status: 'PENDING' },
  });
  const client = show('/events');
  expect(await screen.findByText('가입 신청이 접수되었습니다')).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: '주 메뉴' })).not.toBeInTheDocument();
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  client.clear();
});

it.each([
  ['/', '공개 관측 홈'],
  ['/markets', '공개 시장 차트'],
  ['/markets/us2y', '공개 시장 상세'],
  ['/companies?q=삼성', '공개 종목 검색'],
  ['/companies/NASDAQ:AAPL', '공개 종목 차트'],
  ['/news', '공개 뉴스 목록'],
  ['/news/12345678-1234-4234-8234-123456789abc', '공개 뉴스 상세'],
])('opens the public route %s without mounting private services', async (path, label) => {
  mocks.session.mockResolvedValue(anonymous);
  const client = show(path);
  expect(await screen.findByText(label)).toBeVisible();
  expect(mocks.suggestions).not.toHaveBeenCalled();
  expect(mocks.sourceFreshness).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '로그아웃' })).not.toBeInTheDocument();
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  client.clear();
});

it('allows public browsing before the session responds and during an initial outage', async () => {
  mocks.session.mockImplementation(() => new Promise(() => undefined));
  const client = show('/news');
  expect(await screen.findByText('공개 뉴스 목록')).toBeVisible();
  cleanup();
  client.clear();
  mocks.session.mockRejectedValue(new TypeError('Failed to fetch'));
  const unavailable = show('/markets');
  expect(await screen.findByText('공개 시장 차트')).toBeVisible();
  expect(await screen.findByText(/공개 차트와 뉴스는 계속 이용할 수 있습니다/)).toBeVisible();
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  unavailable.clear();
});

it.each(['PENDING', 'REJECTED'] as const)(
  'lets a %s account browse public pages',
  async (status) => {
    mocks.session.mockResolvedValue({
      ...administrator,
      canAccess: false,
      user: { ...administrator.user!, provider: 'KAKAO', role: 'VIEWER', status },
    });
    const client = show('/companies');
    expect(await screen.findByText('공개 종목 검색')).toBeVisible();
    expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
    client.clear();
  },
);

it.each(['/analysis', '/watchlist', '/settings/notifications', '/news/naver'])(
  'requires authentication for %s and remembers the destination',
  async (path) => {
    mocks.session.mockResolvedValue(anonymous);
    const client = show(path);
    expect(await screen.findByRole('button', { name: '카카오 로그인' })).toBeVisible();
    expect(sessionStorage.getItem('orsem-login-return-v1')).toContain(path);
    expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
    client.clear();
  },
);

it('cancels pending private responses on revocation while retaining public cache', async () => {
  const client = show();
  await screen.findByText('관측 대시보드');
  let resolvePrivate!: (value: unknown) => void;
  let privateSignal!: AbortSignal;
  const pending = client
    .fetchQuery({
      queryKey: ['private-company'],
      queryFn: ({ signal }) => {
        privateSignal = signal;
        return new Promise((resolve) => {
          resolvePrivate = resolve;
        });
      },
    })
    .catch(() => undefined);
  client.setQueryData(['public', 'news'], { items: [{ title: '공개 자료' }] });
  mocks.session.mockResolvedValue(anonymous);
  await act(async () => client.setQueryData(['session'], anonymous));
  expect(await screen.findByText('공개 관측 홈')).toBeVisible();
  expect(privateSignal.aborted).toBe(true);
  resolvePrivate({ title: '회원 전용 자료' });
  await pending;
  expect(client.getQueryData(['private-company'])).toBeUndefined();
  expect(client.getQueryData(['public', 'news'])).toEqual({ items: [{ title: '공개 자료' }] });
  client.clear();
});

it('searches from the header and keeps administrator links in the footer', async () => {
  const client = show();
  expect(await screen.findByText('관측 대시보드')).toBeInTheDocument();
  expect(
    within(screen.getByRole('banner')).queryByRole('link', { name: '운영' }),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole('contentinfo')).getByRole('link', { name: '운영' }),
  ).toHaveAttribute('href', '/operations');
  fireEvent.change(screen.getByRole('combobox', { name: '종목·뉴스·공시 검색어' }), {
    target: { value: ' AAPL ' },
  });
  fireEvent.click(screen.getByRole('button', { name: '통합 검색 실행' }));
  // Wait for the real lazy route import, independently of the UI assertion timeout.
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(await screen.findByRole('heading', { name: '‘AAPL’ 검색 결과' })).toBeInTheDocument();
  await waitFor(() =>
    expect(mocks.search).toHaveBeenCalledWith('AAPL', 5, 'all', expect.any(AbortSignal)),
  );
  client.clear();
});
