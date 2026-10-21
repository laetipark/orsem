import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MARKET_INSTRUMENTS,
  marketHistorySchema,
  marketOverviewSchema,
  type PublicCompany,
  type PublicNewsItem,
} from '@orsem/contracts';
import { ThemeProvider } from '../theme';
import { GuestShell } from '../components/guest-shell';
import { api, ApiError } from '../lib/api';
import { publicApi } from '../lib/public-api';
import { marketFixtures, marketFixtureTime, marketHistoryFixture } from '../lib/market-fixtures';
import {
  GuestCompaniesPage,
  GuestCompanyPage,
  GuestHomePage,
  GuestMarketDetailPage,
  GuestMarketsPage,
  GuestNewsDetailPage,
  GuestNewsPage,
} from './guest-pages';

vi.mock('../components/market-card', () => ({
  MarketCard: ({ item }: { item: { id: string; name: string } }) => (
    <a href={`/markets/${item.id}`}>{item.name}</a>
  ),
}));
vi.mock('../components/market-chart', () => ({
  MarketChart: ({ name, points }: { name: string; points: unknown[] }) => (
    <div role="img" aria-label={`${name} 공개 이력`} data-count={points.length} />
  ),
}));

const company: PublicCompany = {
  id: 'apple-public',
  name: 'Apple',
  market: 'NASDAQ',
  symbol: 'AAPL',
  region: 'us',
  canonicalPath: '/companies/NASDAQ:AAPL',
  chartSymbol: 'NASDAQ:AAPL',
  sourceUrl: 'https://www.sec.gov/files/company_tickers_exchange.json',
  observedAt: '2026-10-15T00:00:00Z',
};
const news: PublicNewsItem = {
  id: 'official-news',
  title: 'Federal Reserve statement',
  summary: 'Official policy statement.',
  url: 'https://www.federalreserve.gov/newsevents/pressreleases/example.htm',
  publisher: 'Federal Reserve',
  publishedAt: '2026-10-15T00:00:00Z',
  firstObservedAt: '2026-10-15T01:00:00Z',
  rightsMode: 'OFFICIAL_PUBLIC_DATA',
  sourceUrl: 'https://www.federalreserve.gov/feeds/press_all.xml',
  translation: { title: '연방준비제도 공식 발표', summary: '공식 정책 발표입니다.' },
};
let client: QueryClient;
let privateCalls: Array<{ mock: { calls: unknown[][] } }>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  privateCalls = [
    vi.spyOn(api, 'company'),
    vi.spyOn(api, 'companyTimeline'),
    vi.spyOn(api, 'companyLivePrice'),
    vi.spyOn(api, 'companyLogo'),
    vi.spyOn(api, 'companyLogoPermit'),
    vi.spyOn(api, 'sourceFreshness'),
    vi.spyOn(api, 'news'),
    vi.spyOn(api, 'suggestions'),
    vi.spyOn(api, 'markets'),
    vi.spyOn(api, 'dashboard'),
    vi.spyOn(api, 'watchlistGroups'),
  ];
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.spyOn(publicApi, 'markets').mockResolvedValue(
    marketOverviewSchema.parse({
      asOf: marketFixtureTime,
      items: marketFixtures.map((item) => ({
        ...item,
        provider: MARKET_INSTRUMENTS.find((definition) => definition.id === item.id)!.provider,
      })),
    }),
  );
  vi.spyOn(publicApi, 'marketHistory').mockImplementation(async (id) => {
    const history = marketHistoryFixture(id);
    return marketHistorySchema.parse({
      ...history,
      instrument: {
        ...history.instrument,
        provider: MARKET_INSTRUMENTS.find((definition) => definition.id === id)!.provider,
      },
    });
  });
  vi.spyOn(publicApi, 'companies').mockResolvedValue({ items: [company], nextCursor: null });
  vi.spyOn(publicApi, 'company').mockResolvedValue(company);
  vi.spyOn(publicApi, 'news').mockResolvedValue({ items: [news], nextCursor: null });
  vi.spyOn(publicApi, 'newsDetail').mockResolvedValue(news);
});
afterEach(() => {
  for (const spy of privateCalls) expect(spy).not.toHaveBeenCalled();
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

function show(path = '/') {
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<GuestShell />}>
              <Route index element={<GuestHomePage />} />
              <Route path="markets" element={<GuestMarketsPage />} />
              <Route path="markets/:id" element={<GuestMarketDetailPage />} />
              <Route path="companies" element={<GuestCompaniesPage />} />
              <Route path="companies/:id" element={<GuestCompanyPage />} />
              <Route path="news" element={<GuestNewsPage />} />
              <Route path="news/:id" element={<GuestNewsDetailPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

it('shows public charts and official news at home without mounting private navigation or queries', async () => {
  show();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('시장의 흐름');
  expect(await screen.findByRole('link', { name: '연방준비제도 공식 발표' })).toBeVisible();
  for (const id of ['us2y', 'us10y', 'wti'])
    expect(
      screen.getByRole('link', { name: marketFixtures.find((item) => item.id === id)!.name }),
    ).toBeVisible();
  expect(
    screen.queryByRole('link', { name: marketFixtures.find((item) => item.id === 'btc')!.name }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '관심 종목' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '알림 설정' })).not.toBeInTheDocument();
  expect(
    client
      .getQueryCache()
      .getAll()
      .every((query) => query.queryKey[0] === 'public'),
  ).toBe(true);
});

it('renders only collected market observations, range controls, and source metadata', async () => {
  show('/markets/us10y?range=3m');
  const item = marketFixtures.find((entry) => entry.id === 'us10y')!;
  expect(await screen.findByRole('img', { name: `${item.name} 공개 이력` })).toBeVisible();
  expect(screen.getByRole('button', { name: '3개월' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '1개월' }));
  expect(screen.getByRole('button', { name: '1개월' })).toHaveAttribute('aria-pressed', 'true');
  expect(publicApi.marketHistory).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name: new RegExp(item.attribution) })).toHaveAttribute(
    'href',
    item.sourceUrl,
  );
});

it('gates a member-only market instead of requesting its history', async () => {
  show('/markets/btc');
  expect(screen.getByRole('heading', { name: '회원 시장 차트' })).toBeVisible();
  expect(publicApi.marketHistory).not.toHaveBeenCalled();
  expect(screen.getAllByRole('link', { name: '로그인' })[0]).toHaveAttribute(
    'href',
    '/login?returnTo=%2Fmarkets%2Fbtc',
  );
});

it('searches and paginates verified company identities through public endpoints only', async () => {
  vi.mocked(publicApi.companies).mockResolvedValue({ items: [company], nextCursor: 'page-two' });
  show('/companies');
  expect(await screen.findByRole('link', { name: /Apple/ })).toHaveAttribute(
    'href',
    '/companies/NASDAQ:AAPL',
  );
  fireEvent.change(screen.getByRole('searchbox', { name: '공개 종목 검색' }), {
    target: { value: 'AAPL' },
  });
  fireEvent.click(screen.getByRole('button', { name: '검색' }));
  await waitFor(() =>
    expect(publicApi.companies).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'AAPL' }),
      expect.any(AbortSignal),
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: '다음' }));
  await waitFor(() =>
    expect(publicApi.companies).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'AAPL', cursor: 'page-two' }),
      expect.any(AbortSignal),
    ),
  );
});

it('keeps domestic charts behind login and preserves the requested company tab', async () => {
  vi.mocked(publicApi.company).mockResolvedValue({
    ...company,
    id: 'kr-public',
    name: '삼성전자',
    market: 'KOSPI',
    symbol: '005930',
    region: 'kr',
    chartSymbol: null,
    canonicalPath: '/companies/KOSPI:005930',
    sourceUrl: 'https://www.krx.co.kr/',
  });
  const { container } = show('/companies/KOSPI:005930?tab=events');
  expect(
    await screen.findByRole('heading', {
      name: '국내 종목 차트는 로그인과 승인 후 볼 수 있습니다',
    }),
  ).toBeVisible();
  expect(screen.getByRole('link', { name: '로그인하고 종목 상세 보기' })).toHaveAttribute(
    'href',
    '/login?returnTo=%2Fcompanies%2FKOSPI%3A005930%3Ftab%3Devents',
  );
  expect(container.querySelector('script, iframe')).toBeNull();
  expect(screen.getByRole('link', { name: '공식 출처에서 종목 보기' })).toHaveAttribute(
    'href',
    'https://www.krx.co.kr/',
  );
  expect(screen.getByRole('link', { name: /TradingView에서 차트 보기/ })).toHaveAttribute(
    'href',
    'https://www.tradingview.com/chart/?symbol=KRX%3A005930',
  );
  expect(await screen.findByRole('link', { name: '연방준비제도 공식 발표' })).toBeVisible();
  expect(publicApi.news).toHaveBeenCalledWith(
    { companyId: 'kr-public', limit: 6 },
    expect.any(AbortSignal),
  );
});

it('shows an honest empty result without falling back to member data', async () => {
  vi.mocked(publicApi.companies).mockResolvedValue({ items: [], nextCursor: null });
  show('/companies?q=missing');
  expect(await screen.findByText('일치하는 공개 종목이 없습니다')).toBeVisible();
});

it('shows official news metadata, KST, source and permitted translation', async () => {
  show('/news/official-news');
  expect(await screen.findByRole('heading', { name: '연방준비제도 공식 발표' })).toBeVisible();
  expect(screen.getByText('공식 정책 발표입니다.')).toBeVisible();
  expect(screen.getByText(/발행.*09:00/)).toBeVisible();
  expect(screen.getByText(/최초 확인.*10:00/)).toBeVisible();
  expect(screen.getByRole('link', { name: /기관 원문에서 자세히 보기/ })).toHaveAttribute(
    'href',
    news.url,
  );
});

it('does not display a restricted article even if a malformed public response contains it', async () => {
  vi.mocked(publicApi.newsDetail).mockResolvedValue({ ...news, rightsMode: 'NO_REDISTRIBUTION' });
  show('/news/official-news');
  expect(await screen.findByText('공개된 발표를 찾을 수 없습니다')).toBeVisible();
  expect(screen.queryByText('공식 정책 발표입니다.')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '연방준비제도 공식 발표' })).not.toBeInTheDocument();
});

it('removes the previous article when a refresh revokes public visibility', async () => {
  show('/news/official-news');
  await screen.findByRole('heading', { name: '연방준비제도 공식 발표' });
  vi.mocked(publicApi.newsDetail).mockRejectedValue(
    new ApiError(404, 'NOT_FOUND', '공개된 자료를 찾을 수 없습니다.'),
  );
  await act(async () =>
    client.refetchQueries({ queryKey: ['public', 'news-detail', 'official-news'] }),
  );
  expect(await screen.findByText('공개된 자료를 찾을 수 없습니다.')).toBeVisible();
  expect(screen.queryByRole('heading', { name: '연방준비제도 공식 발표' })).not.toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: '회원 기능 안내' })).toBeVisible();
});

it('shows the real empty related-news state without replacing it with other stories', async () => {
  vi.mocked(publicApi.news).mockResolvedValue({ items: [], nextCursor: null });
  show('/companies/NASDAQ:AAPL');
  expect(await screen.findByText('연결된 공식 발표가 아직 없습니다')).toBeVisible();
  expect(screen.getByRole('link', { name: '전체 보기' })).toHaveAttribute(
    'href',
    '/news?companyId=apple-public',
  );
  expect(screen.queryByText('연방준비제도 공식 발표')).not.toBeInTheDocument();
});
