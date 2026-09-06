import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { CompanyNewsPanel } from './company-news-panel';

const visibility = vi.hoisted(() => ({ visible: true }));
const naver = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock('../lib/use-visible-panel', () => ({
  useVisiblePanel: () => ({ ref: { current: null }, visible: visibility.visible }),
}));
vi.mock('./company-naver-news', () => ({
  CompanyNaverNews: function NaverStub({ companyId }: { companyId: string }) {
    useEffect(() => {
      naver.mount(companyId);
      return () => naver.unmount(companyId);
    }, [companyId]);
    return <div>NAVER 별도 검색 결과</div>;
  },
}));

const activity = {
  windowStartDate: '2026-08-31',
  windowEndDate: '2026-09-06',
  filingCount: 0,
  eventCount: 0,
  items: [],
};
const news = { items: [], nextCursor: null };
let client: QueryClient;

beforeEach(() => {
  visibility.visible = true;
  naver.mount.mockClear();
  naver.unmount.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.spyOn(api, 'companyRecentActivity').mockResolvedValue(activity);
  vi.spyOn(api, 'news').mockResolvedValue(news);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function panel() {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CompanyNewsPanel companyId="company-1" companyName="테스트 회사" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

it('loads only the default activity tab with twenty items and an explicit empty state', async () => {
  render(panel());
  await screen.findByText('최근 7일 공시·이벤트가 없습니다.');
  expect(api.companyRecentActivity).toHaveBeenCalledOnce();
  expect(api.companyRecentActivity).toHaveBeenCalledWith('company-1', expect.any(AbortSignal), 20);
  expect(api.news).not.toHaveBeenCalled();
  expect(naver.mount).not.toHaveBeenCalled();
  expect(screen.getByRole('tab', { name: '공시·이벤트' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('공시·이벤트');
  expect(screen.getByRole('link', { name: '전체 보기' })).toHaveAttribute(
    'href',
    '/events?companyId=company-1',
  );
});

it('queries twenty company news entries only after selecting related news without mounting NAVER', async () => {
  render(panel());
  await screen.findByText('최근 7일 공시·이벤트가 없습니다.');
  fireEvent.click(screen.getByRole('tab', { name: '관련 뉴스' }));
  await screen.findByText('아직 연결된 기업 뉴스가 없습니다.');
  expect(api.news).toHaveBeenCalledOnce();
  expect(api.news).toHaveBeenCalledWith(
    { companyId: 'company-1', limit: 20, scope: 'company' },
    expect.any(AbortSignal),
  );
  expect(naver.mount).not.toHaveBeenCalled();
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('관련 뉴스');
  expect(screen.queryByText('최근 7일 공시·이벤트가 없습니다.')).toBeNull();
});

it('mounts the separate NAVER area only while its tab is selected', async () => {
  const { unmount } = render(panel());
  await screen.findByText('최근 7일 공시·이벤트가 없습니다.');
  expect(naver.mount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'NAVER' }));
  expect(screen.getByText('NAVER 별도 검색 결과')).toBeVisible();
  expect(naver.mount).toHaveBeenCalledExactlyOnceWith('company-1');
  fireEvent.click(screen.getByRole('tab', { name: '관련 뉴스' }));
  expect(naver.unmount).toHaveBeenCalledExactlyOnceWith('company-1');
  expect(screen.queryByText('NAVER 별도 검색 결과')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'NAVER' }));
  expect(naver.mount).toHaveBeenCalledTimes(2);
  unmount();
  expect(naver.unmount).toHaveBeenCalledTimes(2);
});

it('aborts in-flight activity and news requests when their tabs are left', async () => {
  let activitySignal: AbortSignal | undefined;
  let newsSignal: AbortSignal | undefined;
  vi.mocked(api.companyRecentActivity).mockImplementation(async (_id, signal) => {
    activitySignal = signal;
    return await new Promise(() => undefined);
  });
  vi.mocked(api.news).mockImplementation(async (_query, signal) => {
    newsSignal = signal;
    return await new Promise(() => undefined);
  });
  render(panel());
  await waitFor(() => expect(activitySignal).toBeDefined());
  expect(activitySignal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: '관련 뉴스' }));
  await waitFor(() => expect(newsSignal).toBeDefined());
  expect(activitySignal?.aborted).toBe(true);
  expect(newsSignal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'NAVER' }));
  expect(newsSignal?.aborted).toBe(true);
});

it('moves keyboard focus and selection together with arrows, Home and End', async () => {
  render(panel());
  await screen.findByText('최근 7일 공시·이벤트가 없습니다.');
  const activityTab = screen.getByRole('tab', { name: '공시·이벤트' });
  const newsTab = screen.getByRole('tab', { name: '관련 뉴스' });
  const naverTab = screen.getByRole('tab', { name: 'NAVER' });
  activityTab.focus();
  for (const [from, key, to] of [
    [activityTab, 'ArrowRight', newsTab],
    [newsTab, 'End', naverTab],
    [naverTab, 'Home', activityTab],
    [activityTab, 'ArrowLeft', naverTab],
    [naverTab, 'ArrowRight', activityTab],
  ] as const) {
    fireEvent.keyDown(from, { key });
    expect(to).toHaveFocus();
    expect(to).toHaveAttribute('aria-selected', 'true');
    expect(to).toHaveAttribute('tabindex', '0');
    expect(from).toHaveAttribute('tabindex', '-1');
    expect(screen.getAllByRole('tab', { selected: true })).toEqual([to]);
  }
});

it.each([
  {
    tab: '공시·이벤트',
    method: 'companyRecentActivity',
    error: '최근 소식을 불러오지 못했습니다.',
    empty: '최근 7일 공시·이벤트가 없습니다.',
  },
  {
    tab: '관련 뉴스',
    method: 'news',
    error: '관련 뉴스를 불러오지 못했습니다.',
    empty: '아직 연결된 기업 뉴스가 없습니다.',
  },
] as const)(
  'shows a compact $tab error and retries the active query',
  async ({ tab, method, error, empty }) => {
    vi.mocked(api[method]).mockRejectedValueOnce(new Error('Synthetic connection failure'));
    render(panel());
    if (tab === '관련 뉴스') fireEvent.click(screen.getByRole('tab', { name: tab }));
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
    expect(api[method]).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
    await screen.findByText(empty);
    expect(api[method]).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  },
);

it('requests and polls only the selected visible tab, pausing both activity and news when hidden', async () => {
  vi.useFakeTimers();
  visibility.visible = false;
  const view = render(panel());
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const setVisible = (visible: boolean) => {
    visibility.visible = visible;
    view.rerender(panel());
  };
  await advance(60_000);
  expect(api.companyRecentActivity).not.toHaveBeenCalled();
  expect(api.news).not.toHaveBeenCalled();
  setVisible(true);
  await advance(25);
  expect(api.companyRecentActivity).toHaveBeenCalledOnce();
  await advance(60_000);
  expect(api.companyRecentActivity).toHaveBeenCalledTimes(2);
  setVisible(false);
  await advance(120_000);
  expect(api.companyRecentActivity).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('tab', { name: '관련 뉴스' }));
  await advance(60_000);
  expect(api.news).not.toHaveBeenCalled();
  setVisible(true);
  await advance(25);
  expect(api.news).toHaveBeenCalledOnce();
  await advance(60_000);
  expect(api.news).toHaveBeenCalledTimes(2);
  expect(api.companyRecentActivity).toHaveBeenCalledTimes(2);
  setVisible(false);
  await advance(120_000);
  expect(api.news).toHaveBeenCalledTimes(2);
  expect(naver.mount).not.toHaveBeenCalled();
});
