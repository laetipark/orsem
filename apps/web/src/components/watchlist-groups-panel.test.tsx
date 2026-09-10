import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordRecentCompany } from '../lib/recent-companies';
import { ApiError, api } from '../lib/api';
import type { Session, WatchlistGroup, WatchlistGroupItem, WatchlistGroupPage } from '../types';
import { mockMediaQuery } from '../test/media-query';
import * as popout from '../lib/watchlist-popout';
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
function show(url = '/?region=kr&watchGroup=own', compact = false, floating = false) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route element={<Outlet context={session} />}>
            <Route
              path="/"
              element={
                <>
                  <WatchlistGroupsPanel compact={compact} floating={floating} />
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
  localStorage.clear();
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
it('saves a group name beside its row with the space revision', async () => {
  const save = vi.spyOn(api, 'saveWatchlistGroups').mockResolvedValue();
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.click(screen.getByRole('button', { name: '그룹 관리' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '반도체 이름 수정' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '반도체 이름 수정' }));
  fireEvent.change(screen.getByRole('textbox', { name: '그룹 이름' }), {
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
  expect(screen.queryByRole('button', { name: '그룹 관리' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '종목 설정' })).not.toBeInTheDocument();
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
  expect(screen.queryByRole('button', { name: '공유방 찾기·만들기' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: '공유방 선택' }), {
    target: { value: 'action:find-room' },
  });
  fireEvent.click(await screen.findByRole('button', { name: '참여 신청' }));
  await waitFor(() => expect(action).toHaveBeenCalledWith('room', '/requests', 'POST'));
  expect(screen.getByLabelText('URL')).toHaveTextContent('watchGroup=own');
  expect(screen.getByLabelText('URL')).not.toHaveTextContent('action:');
});
it('creates and selects a room from the space selector without using its action as a scope', async () => {
  vi.spyOn(api, 'watchlistRoomDirectory').mockResolvedValue({ items: [], nextOffset: null });
  const room = {
    id: 'new-room',
    name: '새 관심방',
    description: '공동 관심 목록',
    role: 'OWNER' as const,
    ownerLabel: '나',
    revision: 0,
    memberCount: 1,
    canManageGroups: true,
    canManageStocks: true,
    canManageMembers: true,
  };
  const create = vi.spyOn(api, 'createWatchlistRoom').mockImplementation(async () => {
    vi.mocked(api.watchlistRooms).mockResolvedValue({ items: [room] });
    return room;
  });
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.change(screen.getByRole('combobox', { name: '공유방 선택' }), {
    target: { value: 'action:create-room' },
  });
  expect(screen.getByLabelText('URL')).toHaveTextContent('watchGroup=own');
  expect(screen.getByRole('combobox', { name: '공유방 선택' })).toHaveValue('');
  expect(create).not.toHaveBeenCalled();
  fireEvent.change(await screen.findByRole('textbox', { name: '방 이름' }), {
    target: { value: ' 새 관심방 ' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '소개' }), {
    target: { value: '공동 관심 목록' },
  });
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith('새 관심방', '공동 관심 목록'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByLabelText('URL')).toHaveTextContent('watchRoom=new-room'));
  expect(screen.getByLabelText('URL')).toHaveTextContent('region=kr');
  expect(screen.getByLabelText('URL')).not.toHaveTextContent('watchGroup=own');
  await waitFor(() =>
    expect(api.watchlistGroups).toHaveBeenCalledWith(expect.any(AbortSignal), 'new-room'),
  );
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
  fireEvent.click(screen.getByRole('button', { name: '그룹 관리' }));
  fireEvent.click(await screen.findByRole('button', { name: '종목 설정' }));
  await screen.findByText('기업 21');
  fireEvent.keyDown(screen.getByRole('button', { name: '기업 21 순서 변경' }), { key: 'Home' });
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
  fireEvent.click(screen.getByRole('button', { name: '그룹 관리' }));
  fireEvent.click(await screen.findByRole('button', { name: '종목 설정' }));
  const position = await screen.findByRole('button', { name: '기업 21 순서 변경' });
  fireEvent.keyDown(position, { key: 'Home' });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('다른 참여자가 변경했습니다.');
  expect(save).toHaveBeenCalledWith('own', 3, [
    'company-21',
    ...items.slice(0, 21).map((c) => c.id),
  ]);
  expect(
    within(screen.getByRole('list', { name: '편집할 종목' })).getAllByRole('listitem')[0],
  ).toHaveTextContent('기업 21');
});
it('clears cached stock data after access is revoked and does not refetch in a loop', async () => {
  const items = vi.mocked(api.watchlistGroupItems);
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  items.mockRejectedValue(new ApiError(403, 'FORBIDDEN', '권한이 없습니다.'));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'full-items'] });
  });
  await screen.findByText(/접근 권한이 변경되어 목록을 비웠습니다/);
  expect(screen.queryByRole('link', { name: '삼성전자 종목 상세' })).not.toBeInTheDocument();
  expect(
    client
      .getQueryCache()
      .getAll()
      .some((q) => q.queryKey[2] === 'full-items' && q.state.data),
  ).toBe(false);
  expect(items).toHaveBeenCalledTimes(2);
});
it('recovers after a previously loaded room list loses access and refresh succeeds', async () => {
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  vi.mocked(api.watchlistRooms).mockRejectedValueOnce(
    new ApiError(403, 'FORBIDDEN', '권한이 없습니다.'),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'rooms'] });
  });
  await screen.findByText(/접근 권한이 변경되어 목록을 비웠습니다/);
  fireEvent.click(screen.getByRole('button', { name: '관심 종목 새로고침' }));
  expect(await screen.findByRole('link', { name: '삼성전자 종목 상세' })).toBeInTheDocument();
  expect(screen.queryByText(/접근 권한이 변경되어 목록을 비웠습니다/)).toBeNull();
});
it.each([true, false])('opens the selected card next to refresh (compact=%s)', async (compact) => {
  const open = vi.spyOn(popout, 'openWatchlistPopout').mockReturnValue(true);
  show('/?watchGroup=own&watchView=grid&watchPage=0', compact);
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  const button = screen.getByRole('button', { name: '관심 종목 새창으로 열기' });
  expect(button.previousElementSibling).toBe(
    screen.getByRole('button', { name: '관심 종목 새로고침' }),
  );
  expect(button).toHaveClass('button', 'button--ghost', 'button--sm');
  fireEvent.click(button);
  expect(open).toHaveBeenCalledOnce();
  const params = open.mock.calls[0]![0];
  expect(params.get('watchGroup')).toBe('own');
  expect(params.get('watchView')).toBe('grid');
  expect(params.get('watchContent')).toBe('stocks');
});

it('provides a retry when opening the standalone card is blocked', async () => {
  const open = vi
    .spyOn(popout, 'openWatchlistPopout')
    .mockReturnValueOnce(false)
    .mockReturnValue(true);
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  fireEvent.click(screen.getByRole('button', { name: '관심 종목 새창으로 열기' }));
  expect(screen.getByRole('alert')).toHaveTextContent('새창이 차단되었습니다');
  fireEvent.click(screen.getByRole('button', { name: '다시 열기' }));
  expect(open).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('does not offer the desktop popout on touch-only devices', async () => {
  mockMediaQuery(true);
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  expect(screen.queryByRole('button', { name: '관심 종목 새창으로 열기' })).not.toBeInTheDocument();
});

it('does not poll floating prices for an empty group', async () => {
  vi.mocked(api.watchlistGroupItems).mockResolvedValue({ ...page(own), items: [], total: 0 });
  const quotes = vi.spyOn(api, 'watchlistGroupQuotes');
  show('/?watchGroup=own', false, true);
  await screen.findByText('아직 종목이 없습니다');
  expect(quotes).not.toHaveBeenCalled();
});

it('marks a previously live row stale when it is missing from the latest quote batch', async () => {
  vi.mocked(api.watchlistGroupItems).mockResolvedValue({
    ...page(own),
    items: [
      {
        ...stock,
        displayPrice: {
          ...stock.displayPrice,
          status: 'LIVE',
          basis: 'LIVE',
          providerAt: '2026-09-08T01:02:03Z',
        },
      },
    ],
  });
  vi.spyOn(api, 'watchlistGroupQuotes').mockResolvedValue({
    asOf: '2026-09-08T01:02:03Z',
    items: [],
  });
  show('/?watchGroup=own', false, true);
  await screen.findByText(/마지막 확인/);
  expect(screen.getByRole('link', { name: '삼성전자 종목 상세' })).toHaveTextContent('최근 체결');
  expect(screen.getByRole('link', { name: '삼성전자 종목 상세' })).not.toHaveTextContent('실시간');
});

it('pauses floating price polling in news mode and refetches when returning to stocks', async () => {
  vi.spyOn(api, 'watchlistGroupNews').mockResolvedValue({
    group: own,
    companies: [],
    companyCount: 1,
    asOf: '2026-09-08T01:02:03Z',
    items: [],
    nextCursor: null,
  });
  const quotes = vi.spyOn(api, 'watchlistGroupQuotes').mockResolvedValue({
    asOf: '2026-09-08T01:02:03Z',
    items: [{ companyId: stock.company.id, displayPrice: stock.displayPrice }],
  });
  show('/?watchGroup=own', false, true);
  await screen.findByText(/마지막 확인/);
  fireEvent.click(screen.getByRole('button', { name: '소식으로 전환' }));
  await screen.findByText('아직 연결된 뉴스가 없습니다');
  expect(screen.getByText(/시세 확인 일시 중지/)).toBeInTheDocument();
  const quoteEntry = client
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey[2] === 'quotes');
  expect(quoteEntry?.isActive()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '종목으로 전환' }));
  await waitFor(() => expect(quotes).toHaveBeenCalledTimes(2));
});

it('merges floating prices without replacing rows, charts or activities and marks fetch failures stale', async () => {
  const quotes = vi.spyOn(api, 'watchlistGroupQuotes').mockResolvedValue({
    asOf: '2026-09-08T01:02:03Z',
    items: [
      {
        companyId: stock.company.id,
        displayPrice: {
          ...stock.displayPrice,
          price: '72000',
          basis: 'LIVE',
          status: 'LIVE',
          sessionDate: '2026-09-08',
          providerAt: '2026-09-08T01:02:03Z',
        },
      },
    ],
  });
  show('/?watchGroup=own', false, true);
  await screen.findByText('₩72,000');
  const link = screen.getByRole('link', { name: '삼성전자 종목 상세' });
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveTextContent('실시간');
  expect(link.closest('.card')).toHaveClass('watch-groups--full');
  expect(screen.getByText('공시 2')).toBeInTheDocument();
  const chart = screen.getByRole('img', { name: /종가 추이/ });
  expect(screen.getByText(/마지막 확인 10:02:03 KST/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '관심 종목 새창으로 열기' })).not.toBeInTheDocument();
  quotes.mockRejectedValue(new ApiError(503, 'UNAVAILABLE', '연결 실패'));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'quotes'] });
  });
  await waitFor(() => expect(link).toHaveTextContent('최근 체결'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('₩72,000')).toBeInTheDocument();
  expect(link).not.toHaveTextContent('실시간');
  expect(link).toHaveTextContent('최근 체결');
  expect(screen.getByRole('link', { name: '삼성전자 종목 상세' })).toBe(link);
  expect(screen.getByRole('img', { name: /종가 추이/ })).toBe(chart);
  expect(api.watchlistGroupItems).toHaveBeenCalledOnce();
});

it('keeps an unavailable floating stock at its last price while another stock updates', async () => {
  const secondStock = {
    ...stock,
    company: { ...stock.company, id: 'hynix', nameKo: 'SK하이닉스', stockCode: '000660' },
    displayPrice: { ...stock.displayPrice, price: '150000' },
  };
  vi.mocked(api.watchlistGroupItems).mockResolvedValue({
    ...page(own),
    items: [stock, secondStock],
    total: 2,
  });
  const unavailablePrice = {
    ...secondStock.displayPrice,
    price: null,
    basis: 'NONE' as const,
    status: 'UNAVAILABLE' as const,
  };
  const quotes = vi.spyOn(api, 'watchlistGroupQuotes').mockResolvedValue({
    asOf: '2026-09-08T01:02:03Z',
    items: [
      { companyId: 'samsung', displayPrice: { ...stock.displayPrice, price: '72000' } },
      { companyId: 'hynix', displayPrice: unavailablePrice },
    ],
  });
  show('/?watchGroup=own', false, true);
  await screen.findByText('₩72,000');
  const unchanged = screen.getByRole('link', { name: 'SK하이닉스 종목 상세' });
  expect(unchanged).toHaveTextContent('₩150,000');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  quotes.mockResolvedValue({
    asOf: '2026-09-08T01:02:05Z',
    items: [
      { companyId: 'samsung', displayPrice: { ...unavailablePrice, currency: 'KRW' } },
      { companyId: 'hynix', displayPrice: { ...secondStock.displayPrice, price: '151000' } },
    ],
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'quotes'] });
  });
  await screen.findByText('₩151,000');
  expect(screen.getByText('₩72,000')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'SK하이닉스 종목 상세' })).toBe(unchanged);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('clears floating prices and private rows when the price endpoint revokes access', async () => {
  const quotes = vi.spyOn(api, 'watchlistGroupQuotes').mockResolvedValue({
    asOf: '2026-09-08T01:02:03Z',
    items: [{ companyId: stock.company.id, displayPrice: stock.displayPrice }],
  });
  show('/?watchGroup=own', false, true);
  await screen.findByText(/마지막 확인/);
  quotes.mockRejectedValue(new ApiError(404, 'WATCH_GROUP_NOT_FOUND', '그룹이 삭제되었습니다.'));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'quotes'] });
  });
  await screen.findByText(/접근 권한이 변경되어 목록을 비웠습니다/);
  expect(screen.queryByRole('link', { name: '삼성전자 종목 상세' })).not.toBeInTheDocument();
  expect(
    client
      .getQueryCache()
      .getAll()
      .filter(
        (query) => ['quotes', 'full-items'].includes(String(query.queryKey[2])) && query.state.data,
      ),
  ).toHaveLength(0);
  expect(quotes).toHaveBeenCalledTimes(2);
});

it('preserves recent selection on opening and shows its full list using only floating quote polling', async () => {
  recordRecentCompany('MEMBER:viewer1', stock.company);
  const quotes = vi.spyOn(api, 'companyQuotes').mockResolvedValue({
    asOf: '2026-09-08T01:02:03Z',
    items: [{ companyId: stock.company.id, displayPrice: stock.displayPrice }],
  });
  const groups = vi.spyOn(api, 'watchlistGroupQuotes');
  show('/?watchGroup=recent', false, true);
  const link = await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  await screen.findByText('₩71,000');
  expect(link).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('tab', { name: /최근조회/ })).toHaveAttribute('aria-selected', 'true');
  expect(quotes).toHaveBeenCalledOnce();
  expect(groups).not.toHaveBeenCalled();
  expect(api.watchlistGroupItems).not.toHaveBeenCalled();
});
it('canceling a group edit form never submits its draft', async () => {
  const save = vi.spyOn(api, 'saveWatchlistGroups').mockResolvedValue();
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.click(screen.getByRole('button', { name: '그룹 관리' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '반도체 이름 수정' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '반도체 이름 수정' }));
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(save).not.toHaveBeenCalled();
});

it('keeps the edit-start revision when automatic background refresh updates the group list', async () => {
  const save = vi
    .spyOn(api, 'saveWatchlistGroups')
    .mockRejectedValue(new ApiError(409, 'CONFLICT', '새 변경을 확인해 주세요.'));
  show();
  await screen.findByRole('tab', { name: /반도체/ });
  fireEvent.click(screen.getByRole('button', { name: '그룹 관리' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '반도체 이름 수정' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '반도체 이름 수정' }));
  fireEvent.change(screen.getByLabelText('그룹 이름'), { target: { value: '내 초안' } });
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    items: [{ ...own, name: '다른 사람 변경' }],
    revision: 5,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  });
  await client.invalidateQueries({ queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'groups'] });
  await screen.findByRole('tab', { name: /다른 사람 변경/ });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText(/다른 곳에서 그룹이 변경되었습니다/);
  expect(save).toHaveBeenCalledWith({
    roomId: undefined,
    revision: 0,
    groups: [{ id: 'own', name: '내 초안' }],
  });
  expect(screen.getByLabelText('그룹 이름')).toHaveValue('내 초안');
});

it('creates the first group inside management and exposes group and stock editing in that dialog', async () => {
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    items: [],
    revision: 0,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  });
  const create = vi.spyOn(api, 'createWatchlistGroup').mockImplementation(async () => {
    vi.mocked(api.watchlistGroups).mockResolvedValue({
      items: [own],
      revision: 1,
      permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
    });
    return own;
  });
  show();
  fireEvent.click(await screen.findByRole('button', { name: '그룹 관리' }));
  fireEvent.change(await screen.findByRole('textbox', { name: '새 그룹 이름' }), {
    target: { value: '반도체' },
  });
  vi.spyOn(api, 'editWatchlistGroup').mockResolvedValue({ group: own, revision: 0, items: [] });
  fireEvent.click(screen.getByRole('button', { name: '그룹 추가' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith('반도체', undefined));
  expect(await screen.findByRole('combobox', { name: '추가할 종목 검색' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(await screen.findByRole('button', { name: '종목 설정' })).toBeVisible();
  expect(screen.getByRole('button', { name: '반도체 이름 수정' })).toBeVisible();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});

it.each(['grid', 'list'])(
  'keeps the same inert grid height baseline when starting in %s and switching views',
  async (initial) => {
    const rendered = show(`/?watchGroup=own&watchView=${initial}`, true);
    await screen.findByRole('link', { name: '삼성전자 종목 상세' });
    const baseline = rendered.container.querySelector('.watch-groups__grid-measure')!;
    expect(baseline).toHaveAttribute('aria-hidden', 'true');
    expect(baseline).toHaveAttribute('inert');
    expect(baseline).toHaveClass('watch-groups__stocks--grid');
    expect(baseline.querySelectorAll('.watch-group-stock')).toHaveLength(1);
    expect(baseline.querySelector('a,button,input,select,[tabindex],[id],img')).toBeNull();
    expect(screen.getAllByRole('link', { name: '삼성전자 종목 상세' })).toHaveLength(1);
    for (const label of ['목록 보기', '그리드 보기', '목록 보기']) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(rendered.container.querySelector('.watch-groups__grid-measure')).toBe(baseline);
      expect(baseline).toHaveClass('watch-groups__stocks--grid');
      expect(baseline).not.toHaveClass('watch-groups__stocks--list');
      expect(rendered.container.querySelector('.watch-groups__stocks--display')).toHaveClass(
        label === '그리드 보기' ? 'watch-groups__stocks--grid' : 'watch-groups__stocks--list',
      );
    }
    expect(api.watchlistGroupItems).toHaveBeenCalledOnce();
  },
);

it('updates the grid baseline from the same current page data while list mode is selected', async () => {
  const rendered = show('/?watchGroup=own&watchView=list', true);
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  const changed = {
    ...page(own),
    total: 2,
    items: [
      stock,
      { ...stock, company: { ...stock.company, id: 'second', nameKo: '두 번째 종목' } },
    ],
  };
  await act(async () => {
    client.setQueryData(
      ['watchlist-v2', 'MEMBER:viewer1', 'items', 'personal', 'own', 0, 6],
      changed,
    );
  });
  await screen.findByRole('link', { name: '두 번째 종목 종목 상세' });
  const baseline = rendered.container.querySelector('.watch-groups__grid-measure')!;
  expect(baseline.querySelectorAll('.watch-group-stock')).toHaveLength(2);
  expect(rendered.container.querySelector('.watch-groups__stocks--display')?.children).toHaveLength(
    2,
  );
  expect(rendered.container.querySelector('.watch-groups__stock-viewport')).toHaveAttribute(
    'data-view',
    'list',
  );
  expect(api.watchlistGroupItems).toHaveBeenCalledOnce();
});

it.each([
  [false, 6, 'grid'],
  [true, 3, 'list'],
] as const)(
  'keeps dashboard paging with compact layout %s and %i items per page',
  async (mobile, limit, view) => {
    mockMediaQuery(mobile);
    const group = { ...own, itemCount: 11 };
    const stocks = Array.from({ length: 11 }, (_, index) => ({
      ...stock,
      company: { ...stock.company, id: `stock-${index}`, nameKo: `종목 ${index + 1}` },
    }));
    vi.mocked(api.watchlistGroups).mockResolvedValue({
      items: [group],
      revision: 0,
      permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
    });

    vi.mocked(api.watchlistGroupItems).mockImplementation(
      async (_id, offset = 0, _signal, pageSize = 21) => ({
        ...page(group),
        items: stocks.slice(offset, offset + pageSize),
        total: stocks.length,
        nextOffset: offset + pageSize < stocks.length ? offset + pageSize : null,
      }),
    );
    const rendered = show('/?region=kr&watchGroup=own', true);
    await screen.findByRole('link', { name: '종목 1 종목 상세' });
    expect(rendered.container.querySelector('.watch-groups__stock-viewport')).toHaveAttribute(
      'data-view',
      view,
    );
    expect(screen.getAllByRole('link', { name: /종목 상세/ })).toHaveLength(limit);
    expect(api.watchlistGroupItems).toHaveBeenLastCalledWith(
      'own',
      0,
      expect.any(AbortSignal),
      limit,
    );
    expect(screen.getByRole('button', { name: '이전 관심 종목' })).toBeDisabled();
    const seen = new Set<string>();
    for (let i = 0; i < Math.ceil(stocks.length / limit); i++) {
      await screen.findByRole('link', { name: `종목 ${i * limit + 1} 종목 상세` });
      screen
        .getAllByRole('link', { name: /종목 상세/ })
        .forEach((link) => seen.add(link.getAttribute('aria-label')!));
      const next = screen.getByRole('button', { name: '다음 관심 종목' });
      if (i + 1 < Math.ceil(stocks.length / limit)) fireEvent.click(next);
      else expect(next).toBeDisabled();
    }
    expect(seen.size).toBe(11);
    expect(screen.getByLabelText('URL')).toHaveTextContent('region=kr');
  },
);

it('reaches newly added dashboard stocks when the group count cache is older than the items response', async () => {
  const cachedGroup = { ...own, itemCount: 6 };
  const stocks = Array.from({ length: 7 }, (_, index) => ({
    ...stock,
    company: { ...stock.company, id: `new-${index}`, nameKo: `관측 종목 ${index + 1}` },
  }));
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    items: [cachedGroup],
    revision: 0,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  });
  vi.mocked(api.watchlistGroupItems).mockImplementation(
    async (_id, offset = 0, _signal, limit = 21) => ({
      ...page({ ...cachedGroup, itemCount: 7 }),
      items: stocks.slice(offset, offset + limit),
      total: 7,
      nextOffset: offset + limit < 7 ? offset + limit : null,
    }),
  );
  show('/?region=kr&watchGroup=own', true);
  await screen.findByRole('link', { name: '관측 종목 1 종목 상세' });
  fireEvent.click(screen.getByRole('button', { name: '다음 관심 종목' }));
  await screen.findByRole('link', { name: '관측 종목 7 종목 상세' });
  expect(screen.getAllByRole('link', { name: /종목 상세/ })).toHaveLength(1);
  expect(screen.getByRole('button', { name: '다음 관심 종목' })).toBeDisabled();
});

it('makes recent browsing the first group tab on the dashboard and uses company news scope', async () => {
  recordRecentCompany('MEMBER:viewer1', { ...stock.company, canonicalPath: '/companies/005930' });
  vi.spyOn(api, 'companyQuotes').mockResolvedValue({ asOf: '2026-09-07T00:00:00Z', items: [] });
  const news = vi.spyOn(api, 'news').mockResolvedValue({ items: [], nextCursor: null });
  show('/?region=kr', true);
  const tabs = await screen.findAllByRole('tab');
  expect(tabs[0]).toHaveTextContent('최근조회');
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByRole('link', { name: '삼성전자 종목 상세' })).toHaveAttribute(
    'href',
    '/companies/005930',
  );
  expect(api.watchlistGroupItems).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '소식으로 전환' }));
  expect(await screen.findByRole('region', { name: '시장 뉴스' })).toBeVisible();
  await waitFor(() =>
    expect(news).toHaveBeenCalledWith(
      { scope: 'company', companyIds: ['samsung'], limit: 20, cursor: null },
      expect.any(AbortSignal),
    ),
  );
  expect(screen.queryByRole('link', { name: '삼성전자 종목 상세' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('URL')).toHaveTextContent('region=kr');
});

it('measures the stock content on direct dashboard news entry and keeps only news interactive', async () => {
  vi.spyOn(api, 'watchlistGroupNews').mockResolvedValue({
    group: own,
    companies: [],
    companyCount: 1,
    asOf: '2026-09-07T00:00:00Z',
    items: [],
    nextCursor: null,
  });
  const rendered = show('/?watchGroup=own&watchContent=news', true);
  const newsRegion = await screen.findByRole('region', { name: '관심 그룹 소식' });
  expect(newsRegion).toContainElement(screen.getByRole('group', { name: '관심 그룹 소식 종류' }));
  await waitFor(() =>
    expect(api.watchlistGroupItems).toHaveBeenCalledWith('own', 0, expect.any(AbortSignal), 6),
  );
  const layer = rendered.container.querySelector('.watch-groups__stock-layer');
  await waitFor(() => expect(layer?.querySelectorAll('a.watch-group-stock')).toHaveLength(1));
  expect(layer).toHaveAttribute('inert');
  expect(layer).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByRole('link', { name: '삼성전자 종목 상세' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '종목으로 전환' }));
  expect(await screen.findByRole('link', { name: '삼성전자 종목 상세' })).toBeVisible();
  expect(layer).not.toHaveAttribute('inert');
  expect(rendered.container.querySelector('.watch-groups__news-layer')).toBeNull();
});

it('switches a group between stocks and news in the same panel and excludes recent on the full page', async () => {
  const company = {
    ...stock.company,
    market: 'KRX' as const,
    corpCode: null,
    cik: null,
    isListed: true,
    updatedAt: '2026-09-07T00:00:00Z',
  };
  const news = vi.spyOn(api, 'watchlistGroupNews').mockResolvedValue({
    group: own,
    companies: [company],
    companyCount: 1,
    asOf: '2026-09-07T00:00:00Z',
    items: [],
    nextCursor: null,
  });
  vi.spyOn(api, 'watchlistGroupFilings').mockResolvedValue({
    group: own,
    companies: [company],
    companyCount: 1,
    asOf: '2026-09-07T00:00:00Z',
    items: [],
  });
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  expect(screen.queryByRole('tab', { name: /최근조회/ })).not.toBeInTheDocument();
  const contentToggle = screen.getByRole('button', { name: '소식으로 전환' });
  expect(contentToggle).toHaveTextContent('종목');
  fireEvent.click(screen.getByRole('button', { name: '목록 보기' }));
  fireEvent.click(contentToggle);
  expect(screen.getByRole('button', { name: '종목으로 전환' })).toBe(contentToggle);
  expect(contentToggle).toHaveTextContent('소식');
  expect(screen.queryByRole('group', { name: '관심 종목 보기 방식' })).not.toBeInTheDocument();
  await screen.findByRole('option', { name: '삼성전자' });
  expect(screen.getByRole('option', { name: '전체' })).toHaveValue('');
  const newsTabs = screen.getByRole('group', { name: '관심 그룹 소식 종류' });
  const newsTools = newsTabs.closest('.watch-groups__tools');
  expect(newsTools).toContainElement(screen.getByRole('combobox', { name: '소식 종목 필터' }));
  expect(screen.getByRole('region', { name: '관심 그룹 소식' })).not.toContainElement(newsTabs);
  expect(news).toHaveBeenCalledWith(
    'own',
    { companyId: undefined, limit: 20, cursor: null },
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole('link', { name: '삼성전자 종목 상세' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('소식 종목 필터'), { target: { value: 'samsung' } });
  await waitFor(() =>
    expect(news).toHaveBeenCalledWith(
      'own',
      { companyId: 'samsung', limit: 20, cursor: null },
      expect.any(AbortSignal),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '공시' }));
  expect(screen.getByRole('button', { name: '공시' })).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() =>
    expect(api.watchlistGroupFilings).toHaveBeenCalledWith(
      'own',
      'samsung',
      expect.any(AbortSignal),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '종목으로 전환' }));
  expect(await screen.findByRole('link', { name: '삼성전자 종목 상세' })).toBeVisible();
  expect(screen.queryByRole('group', { name: '관심 그룹 소식 종류' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: '소식 종목 필터' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '소식으로 전환' })).toBe(contentToggle);
  expect(contentToggle).toHaveTextContent('종목');
  expect(screen.getByRole('button', { name: '목록 보기' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('tab', { name: /반도체/ })).toHaveAttribute('aria-selected', 'true');
});

it.each(['news', 'filings'] as const)(
  'keeps the selected group and stocks available when the %s endpoint is missing',
  async (feed) => {
    const method = feed === 'news' ? 'watchlistGroupNews' : 'watchlistGroupFilings';
    vi.spyOn(api, method).mockRejectedValue(
      new ApiError(404, 'HTTP_ERROR', `Cannot GET /api/v1/watchlist-groups/own/${feed}`),
    );
    show(`/?watchGroup=own&watchNewsType=${feed}`);
    await screen.findByRole('link', { name: '삼성전자 종목 상세' });
    fireEvent.click(screen.getByRole('button', { name: '소식으로 전환' }));
    await screen.findByText('소식을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    expect(screen.queryByText(/접근 권한이 변경되어 목록을 비웠습니다/)).toBeNull();
    expect(screen.getByRole('tab', { name: /반도체/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: '종목으로 전환' }));
    expect(await screen.findByRole('link', { name: '삼성전자 종목 상세' })).toBeVisible();
  },
);

it.each([
  new ApiError(403, 'FORBIDDEN', '권한 없음'),
  new ApiError(404, 'WATCH_GROUP_NOT_FOUND', '접근 가능한 그룹을 찾을 수 없습니다.'),
])('clears the group news after access is revoked: %s', async (error) => {
  vi.spyOn(api, 'watchlistGroupNews').mockRejectedValue(error);
  show('/?watchGroup=own&watchContent=news');
  await screen.findByText(/접근 권한이 변경되어 목록을 비웠습니다/);
  expect(screen.queryByRole('region', { name: '관심 그룹 소식' })).not.toBeInTheDocument();
  expect(api.watchlistGroupNews).toHaveBeenCalledTimes(1);
});

it('clears mounted group content when the sidebar observes lost access first', async () => {
  show();
  await screen.findByRole('link', { name: '삼성전자 종목 상세' });
  await act(async () => {
    await client
      .fetchQuery({
        queryKey: ['watchlist-v2', 'MEMBER:viewer1', 'sidebar-items', 'personal', 'own', 20],
        queryFn: async () => {
          throw new ApiError(403, 'FORBIDDEN', '권한 없음');
        },
        retry: false,
      })
      .catch(() => undefined);
  });
  expect(await screen.findByText(/접근 권한이 변경되어 목록을 비웠습니다/)).toBeVisible();
  expect(screen.queryByRole('link', { name: '삼성전자 종목 상세' })).not.toBeInTheDocument();
});

function fullGroupStocks(count: number) {
  const stocks = Array.from({ length: count }, (_, index) => ({
    ...stock,
    company: { ...stock.company, id: `full-${index}`, nameKo: `전체 종목 ${index + 1}` },
  }));
  const nextGroup = { ...own, id: 'other', name: '다른 그룹' };
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    items: [{ ...own, itemCount: count }, nextGroup],
    revision: 0,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  });
  vi.mocked(api.watchlistGroupItems).mockImplementation(
    async (id, offset = 0, _signal, limit = 21) =>
      id === 'other'
        ? {
            ...page(nextGroup),
            items: [
              {
                ...stock,
                company: { ...stock.company, id: 'other-company', nameKo: '다른 그룹 종목' },
              },
            ],
          }
        : {
            ...page(own),
            items: stocks.slice(offset, offset + limit),
            total: count,
            nextOffset: offset + limit < count ? offset + limit : null,
          },
  );
  return stocks;
}

function scrollFullList(viewport: HTMLElement, top: number) {
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 2000 },
    scrollTop: { configurable: true, writable: true, value: top },
  });
  fireEvent.scroll(viewport);
}

it('appends full-page stocks with more controls while letting the card grow without inner scroll handling', async () => {
  fullGroupStocks(45);
  const rendered = show('/?region=kr&watchGroup=own&watchPage=4&watchView=list');
  await screen.findByRole('link', { name: '전체 종목 20 종목 상세' });
  expect(screen.getByRole('heading', { name: '관심 종목' })).toBeVisible();
  expect(screen.getAllByRole('link', { name: /종목 상세/ })).toHaveLength(20);
  expect(api.watchlistGroupItems).toHaveBeenCalledOnce();
  expect(api.watchlistGroupItems).toHaveBeenLastCalledWith('own', 0, expect.any(AbortSignal), 20);
  expect(screen.queryByRole('button', { name: '다음 관심 종목' })).not.toBeInTheDocument();
  expect(rendered.container.querySelector('.watch-groups__grid-measure')).toBeNull();
  const viewport = screen.getByRole('region', { name: '관심 종목 전체 목록' });
  expect(viewport).toHaveClass('watch-groups__stock-viewport--full');
  expect(viewport.closest('.observation-card')).toHaveClass('watch-groups--full');
  expect(viewport).not.toHaveAttribute('tabindex');
  expect(viewport.querySelector('[inert]')).toBeNull();
  scrollFullList(viewport, 400);
  expect(api.watchlistGroupItems).toHaveBeenCalledOnce();
  scrollFullList(viewport, 1550);
  expect(api.watchlistGroupItems).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '종목 더 보기' }));
  await screen.findByRole('link', { name: '전체 종목 40 종목 상세' });
  expect(screen.getAllByRole('link', { name: /종목 상세/ })).toHaveLength(40);
  expect(screen.getByRole('link', { name: '전체 종목 1 종목 상세' })).toBeVisible();
  expect(viewport.scrollTop).toBe(1550);
  fireEvent.click(screen.getByRole('button', { name: '종목 더 보기' }));
  await screen.findByRole('link', { name: '전체 종목 45 종목 상세' });
  expect(screen.getAllByRole('link', { name: /종목 상세/ })).toHaveLength(45);
  expect(screen.queryByRole('button', { name: '종목 더 보기' })).not.toBeInTheDocument();
  expect(api.watchlistGroupItems).toHaveBeenCalledTimes(3);
  expect(screen.getByLabelText('URL')).toHaveTextContent('region=kr');
  expect(screen.getByLabelText('URL')).toHaveTextContent('watchPage=4');
});

it('starts a newly selected group at the top and returns to only the first batch of the previous group', async () => {
  fullGroupStocks(45);
  show('/?watchGroup=own&watchView=list');
  const viewport = await screen.findByRole('region', { name: '관심 종목 전체 목록' });
  fireEvent.click(screen.getByRole('button', { name: '종목 더 보기' }));
  await screen.findByRole('link', { name: '전체 종목 40 종목 상세' });
  fireEvent.click(screen.getByRole('tab', { name: /다른 그룹/ }));
  await screen.findByRole('link', { name: '다른 그룹 종목 종목 상세' });
  const otherViewport = screen.getByRole('region', { name: '관심 종목 전체 목록' });
  expect(otherViewport).not.toBe(viewport);
  expect(otherViewport.scrollTop).toBe(0);
  expect(screen.queryByRole('link', { name: '전체 종목 1 종목 상세' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: /반도체/ }));
  await screen.findByRole('link', { name: '전체 종목 20 종목 상세' });
  expect(screen.getAllByRole('link', { name: /종목 상세/ })).toHaveLength(20);
  expect(screen.getByRole('region', { name: '관심 종목 전체 목록' }).scrollTop).toBe(0);
  expect(screen.queryByRole('link', { name: '다른 그룹 종목 종목 상세' })).not.toBeInTheDocument();
});

it('keeps already loaded full-page rows visible after an append error and retries the failed offset', async () => {
  fullGroupStocks(40);
  const implementation = vi.mocked(api.watchlistGroupItems).getMockImplementation()!;
  let fail = true;
  vi.mocked(api.watchlistGroupItems).mockImplementation(async (...args) => {
    if (args[1] === 20 && fail) throw new Error('Temporary network error');
    return implementation(...args);
  });
  show();
  await screen.findByRole('link', { name: '전체 종목 20 종목 상세' });
  fireEvent.click(screen.getByRole('button', { name: '종목 더 보기' }));
  await screen.findByText('추가 종목을 불러오지 못했습니다.');
  expect(screen.getAllByRole('link', { name: /종목 상세/ })).toHaveLength(20);
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByRole('link', { name: '전체 종목 40 종목 상세' });
  expect(api.watchlistGroupItems).toHaveBeenLastCalledWith('own', 20, expect.any(AbortSignal), 20);
  expect(screen.getAllByRole('link', { name: /종목 상세/ })).toHaveLength(40);
});

it('leaves wheel events on full-page stock content available for native page scrolling', async () => {
  mockMediaQuery(true);
  show();
  const viewport = await screen.findByRole('region', { name: '관심 종목 전체 목록' });
  expect(viewport).toHaveClass('watch-groups__stock-viewport--full');
  for (const [top, deltaY] of [
    [0, -100],
    [1600, 100],
  ] as const) {
    scrollFullList(viewport, top);
    const wheel = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
    act(() => {
      viewport.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(false);
  }
  expect(api.watchlistGroupItems).toHaveBeenCalledOnce();
});
