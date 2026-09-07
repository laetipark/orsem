import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { recordRecentCompany } from '../lib/recent-companies';
import { mockMediaQuery } from '../test/media-query';
import type { Session, WatchlistGroup, WatchlistGroupItem, WatchlistGroupPage } from '../types';
import { StockSidebar } from './stock-sidebar';

const session: Session = {
  authenticated: true,
  canAccess: true,
  csrfToken: 'test',
  setupRequired: false,
  user: {
    id: 'sidebar',
    role: 'VIEWER',
    provider: 'LOCAL',
    status: 'APPROVED',
    email: null,
    displayName: '나',
    totpEnabled: false,
  },
};
const actor = 'MEMBER:sidebar';
const group: WatchlistGroup = {
  id: 'own',
  name: '내 그룹',
  kind: 'PERSONAL',
  isShared: false,
  isFollowing: false,
  canEdit: true,
  canManageGroups: true,
  canManageStocks: true,
  itemCount: 1,
  ownerLabel: '나',
  updatedAt: '2026-09-07T00:00:00Z',
};
const stock: WatchlistGroupItem = {
  company: {
    id: 'samsung',
    nameKo: '삼성전자',
    nameEn: null,
    market: 'KRX',
    stockCode: '005930',
    ticker: null,
  },
  displayPrice: {
    price: '71000',
    currency: 'KRW',
    status: 'STALE',
    basis: 'CLOSE',
    source: 'TOSS_KR',
    sessionDate: '2026-09-04',
    providerAt: null,
    referenceClose: 70000,
    referenceDate: '2026-09-03',
    change: 1000,
    changePercent: 1.4286,
  },
  sparkline: [],
  recentActivity: { filingCount: 0, eventCount: 0, items: [] },
};
const page = (items = [stock], nextOffset: number | null = null): WatchlistGroupPage => ({
  group,
  items,
  total: nextOffset ? 21 : items.length,
  nextOffset,
  asOf: '2026-09-07T00:00:00Z',
  windowStartDate: '2026-09-01',
  windowEndDate: '2026-09-07',
});
let client: QueryClient;
const expanded = vi.fn();
function show() {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StockSidebar session={session} onExpandedChange={expanded} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  expanded.mockClear();
  mockMediaQuery(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  vi.spyOn(api, 'watchlistRooms').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'watchlistGroups').mockResolvedValue({
    items: [group],
    revision: 0,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  });
  vi.spyOn(api, 'watchlistGroupItems').mockResolvedValue(page());
  vi.spyOn(api, 'companyQuotes').mockResolvedValue({ asOf: '2026-09-07T00:00:00Z', items: [] });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it('defaults to a collapsed rail and fetches interests only when opened', async () => {
  show();
  expect(api.watchlistRooms).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: '관심 종목 목록' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '관심 종목 사이드바' }));
  expect(await screen.findByText('삼성전자')).toBeInTheDocument();
  expect(api.watchlistGroupItems).toHaveBeenCalledWith('own', 0, expect.any(AbortSignal), 20);
  expect(expanded).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: '종목 사이드바 접기' }));
  expect(screen.queryByText('삼성전자')).toBeNull();
  expect(expanded).toHaveBeenLastCalledWith(false);
});

it('loads further groups items in pages of twenty', async () => {
  vi.mocked(api.watchlistGroupItems)
    .mockResolvedValueOnce(page([stock], 20))
    .mockResolvedValueOnce(
      page([{ ...stock, company: { ...stock.company, id: 'second', nameKo: '다음 종목' } }]),
    );
  show();
  fireEvent.click(screen.getByRole('button', { name: '관심 종목 사이드바' }));
  fireEvent.click(await screen.findByRole('button', { name: '종목 더 보기' }));
  expect(await screen.findByText('다음 종목')).toBeInTheDocument();
  expect(api.watchlistGroupItems).toHaveBeenLastCalledWith('own', 20, expect.any(AbortSignal), 20);
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
});

it('uses recent history and quote batches without loading private groups', async () => {
  recordRecentCompany(actor, stock.company);
  show();
  fireEvent.click(screen.getByRole('button', { name: '최근 본 종목 사이드바' }));
  expect(await screen.findByText('삼성전자')).toBeInTheDocument();
  await waitFor(() =>
    expect(api.companyQuotes).toHaveBeenCalledWith(['samsung'], expect.any(AbortSignal)),
  );
  expect(api.watchlistGroups).not.toHaveBeenCalled();
});

it('clears rendered stocks when group access is lost', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: '관심 종목 사이드바' }));
  await screen.findByText('삼성전자');
  vi.mocked(api.watchlistGroupItems).mockRejectedValue(
    new ApiError(403, 'FORBIDDEN', '접근 권한 변경'),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['watchlist-v2', actor, 'sidebar-items'] });
  });
  await waitFor(() => expect(screen.queryByText('삼성전자')).toBeNull());
  expect(screen.getByRole('alert')).toHaveTextContent('접근 권한이 변경');
  expect(screen.queryByRole('button', { name: '종목 추가·삭제' })).toBeNull();
});

it('keeps loaded interests when the news feed returns an unknown 404', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: '관심 종목 사이드바' }));
  await screen.findByText('삼성전자');
  await act(async () => {
    await client
      .fetchQuery({
        queryKey: ['watchlist-v2', actor, 'group-news', 'personal', 'own'],
        queryFn: async () => {
          throw new ApiError(404, 'HTTP_ERROR', 'Cannot GET /api/v1/watchlist-groups/own/news');
        },
        retry: false,
      })
      .catch(() => undefined);
  });
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '종목 추가·삭제' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('has no sidebar or requests on mobile', () => {
  vi.mocked(window.matchMedia).mockReturnValue({ ...window.matchMedia(''), matches: false });
  show();
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(api.watchlistRooms).not.toHaveBeenCalled();
});

it('recovers from a room-list access error when a deliberate retry succeeds', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: '관심 종목 사이드바' }));
  await screen.findByText('삼성전자');
  vi.mocked(api.watchlistRooms).mockRejectedValueOnce(
    new ApiError(403, 'FORBIDDEN', '접근 권한 변경'),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['watchlist-v2', actor, 'rooms'] });
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('접근 권한이 변경');
  fireEvent.click(screen.getByRole('button', { name: '다시 확인' }));
  expect(await screen.findByText('삼성전자')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('preserves selected panel and stops refetching while the document is hidden', async () => {
  const view = show();
  fireEvent.click(screen.getByRole('button', { name: '관심 종목 사이드바' }));
  await screen.findByText('삼성전자');
  act(() => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const calls = vi.mocked(api.watchlistGroupItems).mock.calls.length;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['watchlist-v2', actor, 'sidebar-items'] });
  });
  expect(api.watchlistGroupItems).toHaveBeenCalledTimes(calls);
  view.unmount();
  expect(JSON.parse(localStorage.getItem(`orsem-stock-sidebar-v1:${actor}`) ?? '{}')).toMatchObject(
    { open: true, tab: 'interests' },
  );
});
