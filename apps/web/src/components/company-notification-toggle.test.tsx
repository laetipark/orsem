import type { CompanyNotificationSettings } from '@orsem/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import type { Session } from '../types';
import { CompanyNotificationToggle } from './company-notification-toggle';

const state: CompanyNotificationSettings = {
  companyId: '00000000-0000-4000-8000-000000000001',
  enabled: false,
  inherited: true,
  globalEnabled: true,
  pushConfigured: true,
  hasActiveSubscription: true,
};
const session: Session = {
  authenticated: true,
  canAccess: true,
  csrfToken: 'fixture',
  setupRequired: false,
  user: {
    id: 'viewer1',
    role: 'VIEWER',
    provider: 'LOCAL',
    status: 'APPROVED',
    email: null,
    displayName: '나',
    totpEnabled: false,
  },
};
let client: QueryClient;
function View({
  actor = session,
  companyId = state.companyId,
}: {
  actor?: Session;
  companyId?: string;
}) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={actor} />}>
            <Route path="/" element={<CompanyNotificationToggle companyId={companyId} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.spyOn(api, 'companyNotificationSettings').mockResolvedValue({ ...state });
  vi.spyOn(api, 'updateCompanyNotificationSettings').mockResolvedValue({
    ...state,
    enabled: true,
    inherited: false,
  });
  vi.spyOn(api, 'saveCompanyWatchlistMemberships');
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it('toggles only this account and company without changing group membership', async () => {
  render(<View />);
  const button = await screen.findByRole('button', { name: '이 종목 알림 켜기' });
  expect(button).toHaveTextContent('');
  expect(button).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(button);
  expect(await screen.findByRole('button', { name: '이 종목 알림 끄기' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(api.updateCompanyNotificationSettings).toHaveBeenCalledExactlyOnceWith(state.companyId, {
    enabled: true,
  });
  expect(api.saveCompanyWatchlistMemberships).not.toHaveBeenCalled();
});

it('retains the saved company choice while the global master is off', async () => {
  vi.mocked(api.companyNotificationSettings).mockResolvedValue({
    ...state,
    enabled: true,
    globalEnabled: false,
  });
  render(<View />);
  const button = await screen.findByRole('button', { name: '이 종목 알림 끄기' });
  expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(button).toHaveAttribute('title', expect.stringContaining('전체 알림이 꺼져'));
  expect(screen.getByRole('link', { name: '알림 설정', hidden: true })).toHaveAttribute(
    'href',
    '/settings/notifications',
  );
});

it('reconciles a lost write response without repeating the mutation', async () => {
  render(<View />);
  const button = await screen.findByRole('button', { name: '이 종목 알림 켜기' });
  vi.mocked(api.updateCompanyNotificationSettings).mockRejectedValue(new TypeError('offline'));
  vi.mocked(api.companyNotificationSettings).mockResolvedValue({
    ...state,
    enabled: true,
    inherited: false,
  });
  fireEvent.click(button);
  await screen.findByRole('button', { name: '이 종목 알림 끄기' });
  expect(api.updateCompanyNotificationSettings).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status')).toHaveTextContent('현재 알림 상태');
});

it('blocks editing and clears the own cache after an access failure', async () => {
  render(<View />);
  const button = await screen.findByRole('button', { name: '이 종목 알림 켜기' });
  vi.mocked(api.updateCompanyNotificationSettings).mockRejectedValue(
    new ApiError(403, 'FORBIDDEN', 'denied'),
  );
  fireEvent.click(button);
  expect(
    await screen.findByRole('button', { name: '종목 알림 접근 권한 확인 필요' }),
  ).toBeDisabled();
  expect(
    client.getQueryData(['company-notifications', 'MEMBER:viewer1', state.companyId]),
  ).toBeUndefined();
});

it('isolates cache and discards late mutation results after an account change', async () => {
  let complete!: (value: CompanyNotificationSettings) => void;
  vi.mocked(api.updateCompanyNotificationSettings).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const view = render(<View />);
  fireEvent.click(await screen.findByRole('button', { name: '이 종목 알림 켜기' }));
  view.rerender(<View actor={{ ...session, user: { ...session.user!, id: 'viewer2' } }} />);
  await screen.findByRole('button', { name: '이 종목 알림 켜기' });
  complete({ ...state, enabled: true });
  await waitFor(() =>
    expect(
      client.getQueryData(['company-notifications', 'MEMBER:viewer1', state.companyId]),
    ).toBeUndefined(),
  );
  expect(screen.getByRole('button', { name: '이 종목 알림 켜기' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
