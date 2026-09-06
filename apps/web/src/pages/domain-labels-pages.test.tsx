import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { DashboardPage } from './dashboard-page';
import { EventsPage } from './events-page';

vi.mock('../components/dashboard-markets', () => ({ DashboardMarkets: () => null }));
vi.mock('../components/market-news', () => ({ DashboardNews: () => null }));

const clients: QueryClient[] = [];
function TestShell() {
  const location = useLocation();
  return (
    <>
      <output aria-label="현재 경로">
        {location.pathname}
        {location.search}
      </output>
      <Outlet context={{ user: { role: 'VIEWER' } }} />
    </>
  );
}
function show(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<TestShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="events" element={<EventsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.spyOn(api, 'events').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'dashboard').mockResolvedValue({
    asOf: '2026-09-04T23:00:00Z',
    todayCounts: { D001: 6, D002: 23, D003: 1, D004: 2, D005: 2 },
    totalCounts: { D001: 126, D002: 245, D003: 8, D004: 3, D005: 18 },
    priorities: { P1: [], P2: [] },
    reviewPending: 0,
    parserFailures: 0,
    alertFailures: 0,
    sources: [],
    recentlyVerified: [],
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

it('labels dashboard sections and disclosure counts without changing their coded filter destinations', async () => {
  show('/');
  expect(await screen.findByRole('heading', { name: '중점 관찰' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '관심 종목' })).toBeInTheDocument();
  expect(
    screen.getAllByRole('link', { name: '전체 보기' }).map((link) => link.getAttribute('href')),
  ).toEqual(['/events?priority=P1', '/events?priority=P2']);
  const summary = screen.getByRole('region', { name: 'OpenDART 공시 건수' });
  const massive = within(summary).getByRole('link', { name: /대량보유 공시/ });
  expect(massive).toHaveAttribute('href', '/events?detailType=D001');
  expect(massive).toHaveTextContent('5% 이상 보유');
  expect(massive.querySelector('strong')).toHaveTextContent('6건');
  expect(massive.querySelector('.disclosure-stat__counts small')).toHaveTextContent(
    '전체 누적 126건',
  );
  expect(summary).toHaveTextContent('2026. 09. 05. KST 접수일 기준');
  expect(summary).toHaveTextContent('전체 기간 목록으로 이동합니다');
  expect(massive).toHaveAccessibleName(/전체 보기 · 오늘 접수 6건 · 전체 누적 126건/);
  expect(within(summary).getByRole('link', { name: /임원·주요주주 보유/ })).toHaveAttribute(
    'href',
    '/events?detailType=D002',
  );
  expect(within(summary).getByRole('link', { name: /의결권 위임 권유/ })).toHaveAttribute(
    'href',
    '/events?detailType=D003',
  );
  expect(within(summary).getByRole('link', { name: /공개매수/ })).toHaveAttribute(
    'href',
    '/events?detailType=D004',
  );
  expect(within(summary).getByRole('link', { name: /주식 거래계획/ })).toHaveAttribute(
    'href',
    '/events?detailType=D005',
  );
  expect(summary).not.toHaveTextContent(/D00[1-5]/);
});

it('keeps API and URL filter codes when choosing public names and clears the previous page cursor', async () => {
  show('/events?region=kr&cursor=old');
  expect(screen.getByRole('option', { name: '의결권 위임 권유' })).toHaveValue('D003');
  expect(screen.getByRole('option', { name: '공개매수' })).toHaveValue('D004');
  expect(screen.getByRole('option', { name: '대량보유 공시' })).toHaveValue('D001');
  expect(screen.getByRole('option', { name: '중점 관찰' })).toHaveValue('P1');
  expect(screen.getByRole('option', { name: '시장 동향' })).toHaveValue('P3');
  expect(screen.getByRole('option', { name: '일반 뉴스' })).toHaveValue('P4');
  fireEvent.change(screen.getByRole('combobox', { name: '공시 유형' }), {
    target: { value: 'D001' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: '우선순위' }), { target: { value: 'P1' } });
  await waitFor(() =>
    expect(api.events).toHaveBeenLastCalledWith(
      expect.objectContaining({
        region: 'kr',
        detailType: 'D001',
        priority: 'P1',
        cursor: null,
      }),
      expect.any(AbortSignal),
    ),
  );
  expect(screen.getByLabelText('현재 경로')).toHaveTextContent(
    '/events?region=kr&detailType=D001&priority=P1',
  );
});

it('keeps zero today counts prominent on a day with no receipts while showing nonzero totals separately', async () => {
  vi.mocked(api.dashboard).mockResolvedValue({
    asOf: '2026-09-04T15:00:00Z',
    todayCounts: { D001: 0, D002: 0, D003: 0, D004: 0, D005: 0 },
    totalCounts: { D001: 1260, D002: 245, D003: 8, D004: 3, D005: 18 },
    priorities: { P1: [], P2: [] },
    reviewPending: 0,
    parserFailures: 0,
    alertFailures: 0,
    sources: [],
    recentlyVerified: [],
  });
  show('/');
  const summary = await screen.findByRole('region', { name: 'OpenDART 공시 건수' });
  const cards = within(summary).getAllByRole('link');
  expect(cards).toHaveLength(5);
  for (const card of cards) expect(card.querySelector('strong')).toHaveTextContent(/^0건$/);
  expect(cards[0]?.querySelector('.disclosure-stat__counts small')).toHaveTextContent(
    '전체 누적 1,260건',
  );
  expect(cards[0]).toHaveAttribute('href', '/events?detailType=D001');
  expect(summary).toHaveTextContent('2026. 09. 05. KST 접수일 기준');
});

it('does not invent a zero total when an older API response has no totalCounts', async () => {
  vi.mocked(api.dashboard).mockResolvedValue({
    asOf: '2026-09-04T14:59:59Z',
    todayCounts: { D001: 6, D002: 23, D003: 0, D004: 0, D005: 2 },
    priorities: { P1: [], P2: [] },
    reviewPending: 0,
    parserFailures: 0,
    alertFailures: 0,
    sources: [],
    recentlyVerified: [],
  });
  show('/');
  const summary = await screen.findByRole('region', { name: 'OpenDART 공시 건수' });
  const card = within(summary).getAllByRole('link')[0]!;
  expect(card.querySelector('strong')).toHaveTextContent('6건');
  expect(card.querySelector('.disclosure-stat__counts small')).toHaveTextContent('전체 누적 —');
  expect(card).not.toHaveAccessibleName(/전체 누적 0건/);
  expect(summary).toHaveTextContent('2026. 09. 04. KST 접수일 기준');
});
