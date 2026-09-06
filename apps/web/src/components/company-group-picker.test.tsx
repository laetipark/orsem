import type { CompanyWatchlistMembership, CompanyWatchlistMemberships } from '@orsem/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import type { Session } from '../types';
import { CompanyGroupPicker } from './company-group-picker';

const group = (
  overrides: Partial<CompanyWatchlistMembership> = {},
): CompanyWatchlistMembership => ({
  id: 'semiconductors',
  name: '반도체',
  kind: 'PERSONAL',
  roomId: null,
  roomName: null,
  revision: 4,
  selected: true,
  itemCount: 30,
  canManageStocks: true,
  ...overrides,
});
const initial: CompanyWatchlistMemberships = {
  companyId: 'samsung',
  items: [
    group(),
    group({ id: 'growth', name: '성장주', selected: false, itemCount: 1, revision: 6 }),
    group({
      id: 'readonly',
      name: '우량주',
      kind: 'ROOM',
      roomId: 'room',
      roomName: '함께 보는 종목',
      canManageStocks: false,
    }),
  ],
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
function View({ companyId = 'samsung', actor = session }: { companyId?: string; actor?: Session }) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={actor} />}>
            <Route path="/" element={<CompanyGroupPicker companyId={companyId} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
async function open() {
  const trigger = await screen.findByRole('button', { name: '관심그룹 2' });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole('checkbox', { name: /반도체/ });
  return trigger;
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.spyOn(api, 'companyWatchlistMemberships').mockResolvedValue(structuredClone(initial));
  vi.spyOn(api, 'saveCompanyWatchlistMemberships').mockResolvedValue(undefined);
  vi.spyOn(api, 'watchlistGroupItems');
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it('loads full membership before opening and counts selected read-only groups', async () => {
  render(<View />);
  expect(screen.getByRole('button', { name: '관심그룹 확인 중' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '관심그룹 추가' })).not.toBeInTheDocument();
  await open();
  expect(api.companyWatchlistMemberships).toHaveBeenCalledWith('samsung', expect.any(AbortSignal));
  expect(api.watchlistGroupItems).not.toHaveBeenCalled();
  expect(screen.getByRole('checkbox', { name: /반도체/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /성장주/ })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /우량주/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /우량주/ })).toBeDisabled();
  expect(screen.getByRole('group', { name: '개인' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '함께 보는 종목' })).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toHaveClass('watch-dialog--mobile-sheet');
});

it('submits additions and removals together then verifies the response before closing', async () => {
  render(<View />);
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: /반도체/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /성장주/ }));
  vi.mocked(api.companyWatchlistMemberships).mockResolvedValue({
    ...initial,
    items: initial.items.map((g) => ({
      ...g,
      selected: g.id !== 'semiconductors',
      revision: g.revision + 1,
    })),
  });
  fireEvent.click(screen.getByRole('button', { name: /^저장$/ }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(api.saveCompanyWatchlistMemberships).toHaveBeenCalledExactlyOnceWith('samsung', {
    changes: [
      { groupId: 'semiconductors', revision: 4, selected: false },
      { groupId: 'growth', revision: 6, selected: true },
    ],
  });
  expect(api.companyWatchlistMemberships).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('button', { name: '관심그룹 2' })).toBeInTheDocument();
});

it('cancel and Escape discard selections and restore trigger focus', async () => {
  render(<View />);
  const trigger = await open();
  fireEvent.click(screen.getByRole('checkbox', { name: /성장주/ }));
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(trigger).toHaveFocus();
  await open();
  expect(screen.getByRole('checkbox', { name: /성장주/ })).not.toBeChecked();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(api.saveCompanyWatchlistMemberships).not.toHaveBeenCalled();
});

it('refreshes a conflict and requires review instead of automatically resubmitting', async () => {
  render(<View />);
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: /성장주/ }));
  vi.mocked(api.saveCompanyWatchlistMemberships).mockRejectedValue(
    new ApiError(409, 'CONFLICT', '충돌'),
  );
  vi.mocked(api.companyWatchlistMemberships).mockResolvedValue({
    ...initial,
    items: initial.items.map((g) => ({ ...g, revision: 9, selected: true })),
  });
  fireEvent.click(screen.getByRole('button', { name: /^저장$/ }));
  await screen.findByText('그룹이 변경되었습니다. 최신 선택을 확인한 뒤 다시 저장해 주세요.');
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /성장주/ })).toBeChecked());
  expect(screen.getByRole('button', { name: /^저장$/ })).toBeDisabled();
  expect(api.saveCompanyWatchlistMemberships).toHaveBeenCalledTimes(1);
});

it('reconciles an ambiguous write from a fresh read without retrying PUT', async () => {
  render(<View />);
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: /성장주/ }));
  vi.mocked(api.saveCompanyWatchlistMemberships).mockRejectedValue(new TypeError('network lost'));
  vi.mocked(api.companyWatchlistMemberships).mockResolvedValue({
    ...initial,
    items: initial.items.map((g) => ({ ...g, selected: true, revision: 8 })),
  });
  fireEvent.click(screen.getByRole('button', { name: /^저장$/ }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /성장주/ })).toBeChecked());
  expect(screen.getByRole('alert')).toHaveTextContent('현재 등록 상태를 다시 확인');
  expect(screen.getByRole('button', { name: /^저장$/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: '관심그룹 3' })).toBeInTheDocument();
  expect(api.saveCompanyWatchlistMemberships).toHaveBeenCalledTimes(1);
});

it('hides stale choices when write reconciliation cannot confirm the server state', async () => {
  render(<View />);
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: /성장주/ }));
  vi.mocked(api.saveCompanyWatchlistMemberships).mockRejectedValue(new TypeError('network lost'));
  vi.mocked(api.companyWatchlistMemberships).mockRejectedValue(new TypeError('still offline'));
  fireEvent.click(screen.getByRole('button', { name: /^저장$/ }));
  await screen.findByRole('button', { name: '다시 확인' });
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '관심그룹 상태 확인 필요' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '관심그룹 추가' })).not.toBeInTheDocument();
  expect(api.saveCompanyWatchlistMemberships).toHaveBeenCalledTimes(1);
});

it('clears only the affected actor cache on access loss and blocks stale editing', async () => {
  client.setQueryData(['watchlist-v2', 'MEMBER:viewer1', 'private'], { secret: true });
  client.setQueryData(['watchlist-v2', 'MEMBER:someone-else'], { retained: true });
  render(<View />);
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: /성장주/ }));
  vi.mocked(api.saveCompanyWatchlistMemberships).mockRejectedValue(
    new ApiError(403, 'FORBIDDEN', '거부'),
  );
  fireEvent.click(screen.getByRole('button', { name: /^저장$/ }));
  await screen.findByRole('button', { name: '다시 확인' });
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(client.getQueryData(['watchlist-v2', 'MEMBER:viewer1', 'private'])).toBeUndefined();
  expect(client.getQueryData(['watchlist-v2', 'MEMBER:someone-else'])).toEqual({ retained: true });
});

it('resets the dialog, draft and actor cache when the account or company changes', async () => {
  const view = render(<View />);
  await open();
  fireEvent.click(screen.getByRole('checkbox', { name: /성장주/ }));
  vi.mocked(api.companyWatchlistMemberships).mockResolvedValue({ companyId: 'msft', items: [] });
  view.rerender(
    <View companyId="msft" actor={{ ...session, user: { ...session.user!, id: 'viewer2' } }} />,
  );
  await screen.findByRole('button', { name: '관심그룹 추가' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(
    client.getQueryData(['company-group-picker', 'MEMBER:viewer1', 'samsung']),
  ).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: '관심그룹 추가' }));
  expect(await screen.findByRole('button', { name: '그룹 관리' })).toBeEnabled();
  expect(api.saveCompanyWatchlistMemberships).not.toHaveBeenCalled();
});

it('allows Escape during a slow read and a late response never reopens the sheet', async () => {
  render(<View />);
  const trigger = await screen.findByRole('button', { name: '관심그룹 2' });
  let resolveRead!: (value: CompanyWatchlistMemberships) => void;
  vi.mocked(api.companyWatchlistMemberships).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('button', { name: '닫기' })).toBeEnabled();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  resolveRead(initial);
  await waitFor(() =>
    expect(
      client.getQueryState(['company-group-picker', 'MEMBER:viewer1', 'samsung'])?.fetchStatus,
    ).toBe('idle'),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
