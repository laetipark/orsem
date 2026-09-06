import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './app';
import { ThemeProvider } from './theme';
import type { Session } from './types';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  config: vi.fn(),
  search: vi.fn(),
  sourceFreshness: vi.fn(),
  disconnectPush: vi.fn(),
  unsubscribeNotifications: vi.fn(),
}));
vi.mock('./lib/api', () => ({
  isFixtureMode: false,
  api: {
    session: mocks.session,
    login: mocks.login,
    logout: mocks.logout,
    kakaoConfig: mocks.config,
    search: mocks.search,
    sourceFreshness: mocks.sourceFreshness,
    unsubscribeNotifications: mocks.unsubscribeNotifications,
  },
}));
vi.mock('./lib/web-push', () => ({ disconnectPushOnLogout: mocks.disconnectPush }));
vi.mock('./pages/dashboard-page', () => ({ DashboardPage: () => <div>관측 대시보드</div> }));
vi.mock('./pages/event-detail-page', () => ({
  EventDetailPage: () => <div>알림으로 연 이벤트</div>,
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
  vi.restoreAllMocks();
});

it('logs out through the mounted App without losing its session subscription', async () => {
  const client = show();
  client.setQueryData(['operation-runs'], { private: true });
  sessionStorage.setItem('orsem-news-edit-v1:admin:article', 'private draft');
  expect(await screen.findByText('관측 대시보드')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
  expect(await screen.findByRole('button', { name: '카카오 로그인' })).toBeInTheDocument();
  expect(screen.queryByLabelText('관리자 이메일')).not.toBeInTheDocument();
  expect(screen.queryByText('관측 대시보드')).not.toBeInTheDocument();
  await waitFor(() => expect(client.getQueryData(['session'])).toEqual(anonymous));
  expect(client.getQueryData(['operation-runs'])).toBeUndefined();
  expect(sessionStorage.getItem('orsem-news-edit-v1:admin:article')).toBeNull();
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
  expect(screen.getByRole('link', { name: '관심기업' })).toBeInTheDocument();
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
