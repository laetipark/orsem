import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useOutletContext } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './app';
import * as popout from './lib/watchlist-popout';
import type { Session } from './types';

const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('./lib/watchlist-popout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/watchlist-popout')>()),
  watchlistPictureInPictureOwner: vi.fn(() => null),
  postWatchlistPopoutMessage: vi.fn(),
}));
vi.mock('./lib/api', () => ({ api: { session: mocks.session } }));
vi.mock('./components/app-shell', () => ({ AppShell: () => <div>기본 앱 내비게이션</div> }));
vi.mock('./pages/login-page', () => ({ LoginPage: () => <div>로그인이 필요합니다</div> }));
vi.mock('./pages/watchlist-popout-page', () => ({
  WatchlistPopoutPage: () => {
    const session = useOutletContext<Session>();
    return <div>독립 관심 종목 · {session.user?.id}</div>;
  },
}));
const member: Session = {
  authenticated: true,
  canAccess: true,
  csrfToken: 'test',
  setupRequired: false,
  user: {
    id: 'member',
    email: null,
    displayName: null,
    provider: 'KAKAO',
    role: 'VIEWER',
    status: 'APPROVED',
    totpEnabled: false,
  },
};
const anonymous: Session = { ...member, authenticated: false, canAccess: false, user: null };
const clients: QueryClient[] = [];
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/watchlist/popout?watchGroup=recent']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  mocks.session.mockResolvedValue(member);
  vi.mocked(popout.watchlistPictureInPictureOwner).mockReturnValue(null);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.clearAllMocks();
});

it('authenticates the standalone route and passes its session without mounting AppShell', async () => {
  show();
  expect(await screen.findByText('독립 관심 종목 · member')).toBeInTheDocument();
  expect(screen.queryByText('기본 앱 내비게이션')).not.toBeInTheDocument();
});

it('redirects anonymous users to login instead of rendering the standalone card', async () => {
  mocks.session.mockResolvedValue(anonymous);
  show();
  expect(await screen.findByText('로그인이 필요합니다')).toBeInTheDocument();
  expect(screen.queryByText(/독립 관심 종목/)).not.toBeInTheDocument();
  expect(sessionStorage.getItem('orsem-login-return-v1')).toContain('/watchlist/popout');
});

it('clears private queries on account changes and revocation without relying on AppShell', async () => {
  const client = show();
  await screen.findByText('독립 관심 종목 · member');
  client.setQueryData(['watchlist-v2', 'member'], { private: true });
  await act(async () =>
    client.setQueryData(['session'], { ...member, user: { ...member.user!, id: 'other' } }),
  );
  expect(await screen.findByText('독립 관심 종목 · other')).toBeInTheDocument();
  expect(client.getQueryData(['watchlist-v2', 'member'])).toBeUndefined();
  client.setQueryData(['watchlist-v2', 'other'], { private: true });
  await act(async () => client.setQueryData(['session'], anonymous));
  await screen.findByText('로그인이 필요합니다');
  await waitFor(() => expect(client.getQueryData(['watchlist-v2', 'other'])).toBeUndefined());
});

it('notifies the verified PiP owner on authorization loss instead of trapping login in the iframe', async () => {
  const owner = {} as Window;
  vi.mocked(popout.watchlistPictureInPictureOwner).mockReturnValue(owner);
  const client = show();
  await screen.findByText('독립 관심 종목 · member');
  expect(popout.postWatchlistPopoutMessage).not.toHaveBeenCalled();
  await act(async () => client.setQueryData(['session'], anonymous));
  await waitFor(() =>
    expect(popout.postWatchlistPopoutMessage).toHaveBeenCalledWith(
      owner,
      'session-ended',
      expect.any(URLSearchParams),
    ),
  );
});
