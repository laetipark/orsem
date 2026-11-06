import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types';
import { LoginPage } from './login-page';
import { AdminLoginPage } from './admin-login-page';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  login: vi.fn(),
  session: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  isFixtureMode: false,
  api: {
    kakaoConfig: mocks.config,
    login: mocks.login,
    session: mocks.session,
    logout: mocks.logout,
  },
}));
vi.mock('../components/theme-button', () => ({ ThemeButton: () => null }));

const anonymous: Session = {
  authenticated: false,
  canAccess: false,
  csrfToken: 'test',
  user: null,
  setupRequired: false,
};
const pending: Session = {
  ...anonymous,
  authenticated: true,
  user: {
    id: 'member-12345',
    email: null,
    displayName: null,
    provider: 'KAKAO',
    role: 'VIEWER',
    status: 'PENDING',
    totpEnabled: false,
  },
};

function show(session: Session, path = '/login') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginPage session={session} />} />
          <Route path="/admin/login" element={<AdminLoginPage session={session} />} />
          <Route path="/" element={<div>관측 화면</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ enabled: false, startUrl: null });
});
afterEach(cleanup);

describe('Kakao login access states', () => {
  it('offers a separate administrator page when Kakao is not configured', async () => {
    show(anonymous);
    expect(await screen.findByText(/카카오 로그인은 연결 준비 중/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '카카오 로그인' })).toBeDisabled();
    expect(screen.queryByLabelText('관리자 이메일')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('인증 코드')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '관리자 로그인' })).toHaveAttribute(
      'href',
      '/admin/login',
    );
    fireEvent.click(screen.getByRole('link', { name: '관리자 로그인' }));
    expect(await screen.findByLabelText('관리자 이메일')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '카카오 로그인' })).not.toBeInTheDocument();
  });

  it('enables Kakao sign-in when the connector is available', async () => {
    mocks.config.mockResolvedValue({ enabled: true, startUrl: '/api/auth/kakao/start' });
    show(anonymous);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '카카오 로그인' })).toBeEnabled(),
    );
    expect(screen.queryByLabelText('비밀번호')).not.toBeInTheDocument();
  });

  it('shows Kakao callback errors on the member login page', async () => {
    show(anonymous, '/login?kakao=error');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '카카오 로그인을 완료하지 못했습니다',
    );
  });

  it('keeps a pending member on the approval screen and refreshes status without requesting another login', async () => {
    const client = show(pending);
    mocks.session.mockResolvedValue(pending);
    expect(screen.getByText('가입 신청이 접수되었습니다')).toBeInTheDocument();
    expect(screen.queryByLabelText('관리자 이메일')).not.toBeInTheDocument();
    expect(screen.queryByText('관측 화면')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '승인 상태 확인' }));
    await waitFor(() => expect(client.getQueryData(['session'])).toEqual(pending));
    expect(mocks.config).not.toHaveBeenCalled();
    client.clear();
  });

  it('shows rejected access explicitly and only enters the app when canAccess is granted', async () => {
    show({ ...pending, user: { ...pending.user!, status: 'REJECTED' } });
    expect(screen.getByText('현재 관측 화면을 이용할 수 없습니다')).toBeInTheDocument();
    cleanup();
    show({ ...pending, canAccess: true, user: { ...pending.user!, status: 'APPROVED' } });
    expect(await screen.findByText('관측 화면')).toBeInTheDocument();
  });
});

describe('Administrator login', () => {
  it('opens directly without requesting Kakao configuration', () => {
    show(anonymous, '/admin/login');
    expect(screen.getByLabelText('관리자 이메일')).toBeInTheDocument();
    expect(screen.getByLabelText('인증 코드')).toBeRequired();
    expect(screen.queryByRole('button', { name: '카카오 로그인' })).not.toBeInTheDocument();
    expect(mocks.config).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: '회원 로그인으로 돌아가기' }));
    expect(screen.getByRole('button', { name: '카카오 로그인' })).toBeInTheDocument();
  });

  it.each(['totp', 'recovery'] as const)('submits the selected %s credential', async (method) => {
    mocks.login.mockRejectedValue(new Error('인증 정보를 확인해 주세요.'));
    show(anonymous, '/admin/login');
    fireEvent.change(screen.getByLabelText('관리자 이메일'), {
      target: { value: 'admin@example.test' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'test-password-123' },
    });
    fireEvent.change(screen.getByLabelText('인증 코드'), { target: { value: '123456' } });
    if (method === 'recovery') {
      fireEvent.click(screen.getByRole('button', { name: '복구 코드 사용' }));
      expect(screen.queryByLabelText('인증 코드')).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('복구 코드'), {
        target: { value: 'test-recovery-code' },
      });
    }
    fireEvent.click(screen.getByRole('button', { name: '관리자 로그인' }));
    await waitFor(() =>
      expect(mocks.login).toHaveBeenCalledWith({
        email: 'admin@example.test',
        password: 'test-password-123',
        ...(method === 'recovery'
          ? { recoveryCode: 'test-recovery-code' }
          : { totpCode: '123456' }),
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('인증 정보를 확인해 주세요.');
  });
});
