import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import type { Session, WatchlistGroup, WatchlistGroupItem, WatchlistGroupPage } from '../types';
import {
  movedIds,
  StockSparkline,
  WatchlistGroupsPanel,
  WatchlistGroupStock,
} from './watchlist-groups-panel';

const own: WatchlistGroup = {
  id: 'own',
  name: '반도체',
  kind: 'PERSONAL',
  isShared: false,
  isFollowing: false,
  canEdit: true,
  canManageGroups: true,
  canManageStocks: true,
  canManageMembers: false,
  revision: 0,
  itemCount: 1,
  ownerLabel: '나',
  updatedAt: '2026-09-05T12:00:00Z',
};
const shared: WatchlistGroup = {
  ...own,
  id: 'shared',
  name: '공유 배당주',
  canEdit: false,
  canManageGroups: false,
  canManageStocks: false,
  canManageMembers: false,
  isShared: true,
  isFollowing: true,
  ownerLabel: '다른 회원',
};
const stock: WatchlistGroupItem = {
  company: {
    id: 'samsung',
    market: 'KRX',
    nameKo: '삼성전자',
    nameEn: 'Samsung',
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
  sparkline: [
    { sessionDate: '2026-09-03', close: 70000 },
    { sessionDate: '2026-09-04', close: 71000 },
  ],
  recentActivity: {
    filingCount: 2,
    eventCount: 1,
    items: [
      {
        id: 'filing',
        kind: 'FILING',
        title: '주요사항 보고서',
        date: '2026-09-04',
        url: 'https://dart.fss.or.kr/report',
      },
      {
        id: 'event',
        kind: 'EVENT',
        title: '지분변동 공시',
        date: '2026-09-04',
        url: '/events/event',
      },
      {
        id: 'unsafe',
        kind: 'EVENT',
        title: '잘못된 링크',
        date: '2026-09-03',
        url: 'javascript:alert(1)',
      },
    ],
  },
};
const page = (group: WatchlistGroup): WatchlistGroupPage => ({
  group,
  items: [stock],
  total: 1,
  nextOffset: null,
  asOf: '2026-09-06T00:00:00Z',
  windowStartDate: '2026-08-31',
  windowEndDate: '2026-09-06',
});
let client: QueryClient;
const session: Session = {
  authenticated: true,
  canAccess: true,
  csrfToken: 'test',
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
function Location() {
  const location = useLocation();
  return <output aria-label="URL">{location.search}</output>;
}
function show(url = '/?region=kr&watchGroup=own') {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route element={<Outlet context={session} />}>
            <Route
              path="/"
              element={
                <>
                  <WatchlistGroupsPanel />
                  <Location />
                </>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, 'watchlistRooms').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'watchlistGroups').mockResolvedValue({
    items: [own],
    revision: 0,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  });
  vi.spyOn(api, 'watchlistGroupItems').mockResolvedValue(page(own));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('makes the entire compact card a company link and shows only separate activity counts', () => {
  render(
    <MemoryRouter>
      <WatchlistGroupStock item={stock} />
    </MemoryRouter>,
  );
  const card = screen.getByRole('link', { name: '삼성전자 종목 상세' });
  expect(card).toHaveAttribute('href', '/companies/samsung');
  expect(screen.getByText('₩71,000')).toBeInTheDocument();
  expect(screen.getByText('+₩1,000')).toBeInTheDocument();
  expect(screen.getByText('공시 2')).toBeInTheDocument();
  expect(screen.getByText('이벤트 1')).toBeInTheDocument();
  expect(screen.queryByText('주요사항 보고서')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('renders missing prices and insufficient sparkline honestly', () => {
  render(
    <MemoryRouter>
      <WatchlistGroupStock
        item={{
          ...stock,
          displayPrice: {
            ...stock.displayPrice,
            price: null,
            currency: null,
            change: null,
            changePercent: null,
            basis: 'NONE',
          },
          sparkline: [],
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('종가 기록 부족')).toBeInTheDocument();
  expect(screen.getByText(/시세 대기/)).toBeInTheDocument();
});
it('keeps grid/list and group choice in URL without deleting unrelated filters', async () => {
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  fireEvent.click(screen.getByRole('button', { name: '목록 보기' }));
  expect(screen.getByLabelText('URL')).toHaveTextContent('region=kr');
  expect(screen.getByLabelText('URL')).toHaveTextContent('watchView=list');
  expect(screen.getByRole('button', { name: '목록 보기' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText('팔로우')).not.toBeInTheDocument();
  expect(screen.queryByText('운영 관심목록')).not.toBeInTheDocument();
});
it('saves group names with the space revision in a separate editor', async () => {
  const save = vi.spyOn(api, 'saveWatchlistGroups').mockResolvedValue();
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.click(screen.getByRole('button', { name: '그룹 편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '1번 그룹 이름' }), {
    target: { value: 'AI 기업' },
  });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      roomId: undefined,
      revision: 0,
      groups: [{ id: 'own', name: 'AI 기업' }],
    }),
  );
});
it('hides edits from viewers even though they are approved service users', async () => {
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    items: [shared],
    revision: 0,
    permissions: { canManageGroups: false, canManageStocks: false, canManageMembers: false },
  });
  vi.mocked(api.watchlistGroupItems).mockResolvedValue(page(shared));
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  expect(screen.queryByRole('button', { name: '그룹 편집' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '종목 편집' })).not.toBeInTheDocument();
});
it('opens room directory and requests membership instead of following', async () => {
  vi.spyOn(api, 'watchlistRoomDirectory').mockResolvedValue({
    items: [
      {
        id: 'room',
        name: '반도체 연구',
        description: '공동 관심목록',
        ownerLabel: '운영자',
        requestStatus: null,
      },
    ],
    nextOffset: null,
  });
  const action = vi.spyOn(api, 'roomAction').mockResolvedValue();
  show();
  fireEvent.click(screen.getByRole('button', { name: '공유방 찾기·만들기' }));
  fireEvent.click(await screen.findByRole('button', { name: '참여 신청' }));
  await waitFor(() => expect(action).toHaveBeenCalledWith('room', '/requests', 'POST'));
});
it('edits all 22 stocks and cancels without saving', async () => {
  const items = Array.from({ length: 22 }, (_, i) => ({
    ...stock.company,
    market: 'KRX' as const,
    id: `company-${i}`,
    nameKo: `기업 ${i}`,
    corpCode: null,
    cik: null,
    isListed: true,
    updatedAt: '2026-09-06T00:00:00Z',
  }));
  vi.spyOn(api, 'editWatchlistGroup').mockResolvedValue({ group: own, revision: 3, items });
  const save = vi.spyOn(api, 'saveWatchlistGroupItems').mockResolvedValue();
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.click(screen.getByRole('button', { name: '종목 편집' }));
  await screen.findByText('기업 21');
  fireEvent.change(screen.getByLabelText('기업 21 위치'), { target: { value: 1 } });
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(save).not.toHaveBeenCalled();
});
it('keeps cache identities separate for different account kinds and users', async () => {
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  expect(
    client
      .getQueryCache()
      .getAll()
      .filter((q) => q.queryKey[0] === 'watchlist-v2')
      .every((q) => q.queryKey[1] === 'MEMBER:viewer1'),
  ).toBe(true);
});
it('renders twenty finite flat closes and moves positions without changing original order', () => {
  const points = Array.from({ length: 30 }, (_, i) => ({
    sessionDate: `2026-08-${String(i + 1).padStart(2, '0')}`,
    close: 100,
  }));
  render(<StockSparkline points={points} />);
  expect(screen.getByRole('img')).toHaveAttribute(
    'aria-label',
    expect.stringContaining('20거래일'),
  );
  expect(screen.getByRole('img').innerHTML).not.toContain('NaN');
  const ids = ['a', 'b', 'c'];
  expect(movedIds(ids, 2, -1)).toEqual(['a', 'c', 'b']);
  expect(ids).toEqual(['a', 'b', 'c']);
});

it('saves ordering across the 21-stock page boundary and preserves a conflicting draft', async () => {
  const items = Array.from({ length: 22 }, (_, i) => ({
    ...stock.company,
    market: 'KRX' as const,
    id: `company-${i}`,
    nameKo: `기업 ${i}`,
    corpCode: null,
    cik: null,
    isListed: true,
    updatedAt: '2026-09-06T00:00:00Z',
  }));
  vi.spyOn(api, 'editWatchlistGroup').mockResolvedValue({ group: own, revision: 3, items });
  const save = vi
    .spyOn(api, 'saveWatchlistGroupItems')
    .mockRejectedValue(new ApiError(409, 'CONFLICT', '다른 참여자가 변경했습니다.'));
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.click(screen.getByRole('button', { name: '종목 편집' }));
  const position = await screen.findByLabelText('기업 21 위치');
  fireEvent.change(position, { target: { value: 1 } });
  fireEvent.blur(position);
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('다른 참여자가 변경했습니다.');
  expect(save).toHaveBeenCalledWith('own', 3, [
    'company-21',
    ...items.slice(0, 21).map((c) => c.id),
  ]);
  expect(screen.getByLabelText('기업 21 위치')).toHaveValue(1);
});
it('clears cached stock data after access is revoked and does not refetch in a loop', async () => {
  const items = vi.mocked(api.watchlistGroupItems);
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  items.mockRejectedValue(new ApiError(403, 'FORBIDDEN', '권한이 없습니다.'));
  await client.invalidateQueries({ queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'items'] });
  await screen.findByText(/접근 권한이 변경되어 목록을 비웠습니다/);
  expect(screen.queryByRole('link', { name: '삼성전자 종목 상세' })).not.toBeInTheDocument();
  expect(
    client
      .getQueryCache()
      .getAll()
      .some((q) => q.queryKey[2] === 'items' && q.state.data),
  ).toBe(false);
  expect(items).toHaveBeenCalledTimes(2);
});
it('canceling a group edit form never submits its draft', async () => {
  const save = vi.spyOn(api, 'saveWatchlistGroups').mockResolvedValue();
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.click(screen.getByRole('button', { name: '그룹 편집' }));
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(save).not.toHaveBeenCalled();
});

it('keeps the edit-start revision when automatic background refresh updates the group list', async () => {
  const save = vi
    .spyOn(api, 'saveWatchlistGroups')
    .mockRejectedValue(new ApiError(409, 'CONFLICT', '새 변경을 확인해 주세요.'));
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.click(screen.getByRole('button', { name: '그룹 편집' }));
  fireEvent.change(screen.getByLabelText('1번 그룹 이름'), { target: { value: '내 초안' } });
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    items: [{ ...own, name: '다른 사람 변경' }],
    revision: 5,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  });
  await client.invalidateQueries({ queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'groups'] });
  await screen.findByRole('tab', { name: /다른 사람 변경/ });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('새 변경을 확인해 주세요.');
  expect(save).toHaveBeenCalledWith({
    roomId: undefined,
    revision: 0,
    groups: [{ id: 'own', name: '내 초안' }],
  });
  expect(screen.getByLabelText('1번 그룹 이름')).toHaveValue('내 초안');
});
