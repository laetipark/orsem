import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fixtureRequest } from '../lib/fixtures';
import type { CompanyLivePrice, CompanyTimeline } from '../types';
import { CompanyPage } from './company-page';

const mocks = vi.hoisted(() => ({ timeline: vi.fn(), live: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: {
    company: async () => ({
      id: 'test-company',
      nameKo: '삼성전자',
      nameEn: 'Samsung',
      market: 'KOSPI',
      stockCode: '005930',
      ticker: null,
      corpCode: null,
      cik: null,
      sector: '',
      priority: null,
      tags: [],
      recentEvents: [],
      provenance: [],
      isWatchlisted: true,
      thesis: null,
      lastEventAt: null,
    }),
    companyTimeline: mocks.timeline,
    companyLivePrice: mocks.live,
    news: async () => ({ items: [], nextCursor: null }),
    companyRecentActivity: async () => ({ filingCount: 0, eventCount: 0, items: [] }),
  },
}));
vi.mock('../components/company-chart', () => ({
  CompanyChart: ({
    livePrice,
    toolbar,
  }: {
    livePrice?: CompanyLivePrice | null;
    toolbar?: ReactNode;
  }) => (
    <div data-testid="company-chart" data-live-price={livePrice?.quote?.price}>
      {toolbar}
      차트
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('uses Toss only and keeps missing credentials explicit when switching to minute candles', async () => {
  mocks.timeline.mockImplementation(async (id: string, _range: string, interval: string) => ({
    companyId: id,
    currency: 'KRW',
    provider: 'toss',
    interval,
    status: 'NOT_CONFIGURED',
    prices: [],
    priceSources: [],
    markers: [],
    latestCloseAt: null,
    returns: { oneDay: null, oneMonth: null, sinceLatestEvent: null, benchmarkOneMonth: null },
  }));
  mocks.live.mockResolvedValue({
    companyId: 'test-company',
    provider: 'toss',
    status: 'NOT_CONFIGURED',
    quote: null,
    asOf: new Date().toISOString(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/companies/test-company']}>
        <Routes>
          <Route path="/companies/:id" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('시세 연결이 필요합니다')).toBeInTheDocument();
  expect(screen.queryByText('이전 기록')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '1분봉' }));
  await waitFor(() =>
    expect(mocks.timeline).toHaveBeenCalledWith(
      'test-company',
      '3M',
      '1m',
      expect.any(AbortSignal),
    ),
  );
  expect(await screen.findByRole('heading', { name: '주가 차트' })).toBeInTheDocument();
  expect(screen.getByText('시세 연결 필요')).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: '차트 기간' })).not.toBeInTheDocument();
  view.unmount();
  client.clear();
});

it('uses familiar period labels while retaining range values and daily returns in minute view', async () => {
  const input = await fixtureRequest<CompanyTimeline>(
    '/api/v1/companies/company-samsung/timeline?range=3M&interval=1d',
  );
  mocks.timeline.mockImplementation(async (_id: string, _range: string, interval: string) => ({
    ...input,
    interval,
    returns: {
      oneDay: interval === '1d' ? 1.23 : 8.76,
      oneMonth: 2.34,
      sinceLatestEvent: -3.45,
      benchmarkOneMonth: 4.56,
    },
  }));
  const now = new Date().toISOString();
  mocks.live.mockResolvedValue({
    companyId: 'test-company',
    provider: 'toss',
    status: 'LIVE',
    quote: {
      symbol: '005930',
      source: 'TOSS_KR_INTEGRATED',
      currency: 'KRW',
      price: '72100',
      providerAt: now,
      observedAt: now,
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
      lossy: true,
    },
    asOf: now,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/companies/test-company']}>
        <Routes>
          <Route path="/companies/:id" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const overview = await screen.findByRole('region', { name: '주가 요약' });
  expect(await within(overview).findByText('+1.23%')).toBeInTheDocument();
  expect(within(overview).getByText('₩72,100')).toBeInTheDocument();
  expect(within(overview).queryByText(/KRX·NXT 통합 체결/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '가격과 등락률 안내' }));
  const help = screen.getByRole('dialog');
  expect(within(help).getByText(/KRX·NXT 통합 체결/)).toBeInTheDocument();
  expect(within(help).getByText(/일봉 종가 기준/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '도움말 닫기' }));
  fireEvent.click(screen.getByRole('button', { name: '1개월' }));
  await waitFor(() =>
    expect(mocks.timeline).toHaveBeenCalledWith(
      'test-company',
      '1M',
      '1d',
      expect.any(AbortSignal),
    ),
  );
  expect(screen.getByRole('button', { name: '1개월' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '1분봉' }));
  await waitFor(() =>
    expect(mocks.timeline).toHaveBeenCalledWith(
      'test-company',
      '1M',
      '1m',
      expect.any(AbortSignal),
    ),
  );
  expect(within(overview).getByText('+1.23%')).toBeInTheDocument();
  expect(within(overview).queryByText('+8.76%')).not.toBeInTheDocument();
  expect(input.interval).toBe('1d');
  view.unmount();
  client.clear();
});

it('translates application marker codes while preserving the event destination and source value', async () => {
  const timeline = await fixtureRequest<CompanyTimeline>(
    '/api/v1/companies/company-samsung/timeline?range=3M&interval=1d',
  );
  const marker = {
    ...timeline.markers.find((item) => item.kind === 'FILING')!,
    label: 'F · D002 공시',
  };
  mocks.timeline.mockResolvedValue({ ...timeline, markers: [marker] });
  mocks.live.mockResolvedValue({
    companyId: 'test-company',
    provider: 'toss',
    status: 'WAITING',
    quote: null,
    asOf: new Date().toISOString(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/companies/test-company']}>
        <Routes>
          <Route path="/companies/:id" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const label = await screen.findByText('F · 임원·주요주주 보유 공시');
  expect(
    within(screen.getByRole('region', { name: '주가 요약' })).getByText('최근 공시 이후'),
  ).toBeInTheDocument();
  expect(label.closest('a')).toHaveAttribute('href', `/events/${marker.eventId}`);
  expect(screen.queryByText('F · D002 공시')).not.toBeInTheDocument();
  expect(marker.label).toBe('F · D002 공시');
  view.unmount();
  client.clear();
});

function renderCompanyPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/companies/test-company']}>
        <Routes>
          <Route path="/companies/:id" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => {
    view.unmount();
    client.clear();
  };
}

it.each(['missing', 'previous-day', 'today-stale'] as const)(
  'shows a dated domestic close only when today’s quote is missing (%s)',
  async (scenario) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-05T03:00:00Z'));
    const timeline = await fixtureRequest<CompanyTimeline>(
      '/api/v1/companies/company-samsung/timeline?range=3M&interval=1d',
    );
    mocks.timeline.mockResolvedValue(timeline);
    const live: CompanyLivePrice = {
      companyId: 'test-company',
      provider: 'toss',
      status: scenario === 'missing' ? 'WAITING' : 'STALE',
      quote:
        scenario === 'missing'
          ? null
          : {
              symbol: '005930',
              source: 'TOSS_KR_INTEGRATED',
              currency: 'KRW',
              price: '72100',
              providerAt:
                scenario === 'today-stale' ? '2026-09-05T00:00:00Z' : '2026-09-04T00:00:00Z',
              observedAt: '2026-09-05T00:00:00Z',
              rightsMode: 'PRIVATE_DISPLAY_ONLY',
              lossy: true,
            },
      fallbackClose: {
        price: '71000',
        currency: 'KRW',
        sessionDate: '2026-09-04',
        source: 'TOSS_KR',
      },
      asOf: '2026-09-05T03:00:00Z',
    };
    mocks.live.mockResolvedValue(live);
    const dispose = renderCompanyPage();
    const overview = await screen.findByRole('region', { name: '주가 요약' });
    if (scenario === 'today-stale') {
      expect(await within(overview).findByText('₩72,100')).toBeInTheDocument();
      expect(within(overview).getByText('최근 체결 · 수신 대기')).toBeInTheDocument();
      expect(within(overview).queryByText('최근 거래일 종가')).not.toBeInTheDocument();
    } else {
      expect(await within(overview).findByText('₩71,000')).toBeInTheDocument();
      expect(within(overview).getByText('최근 거래일 종가')).toBeInTheDocument();
      expect(within(overview).getByText('2026. 09. 04.')).toBeInTheDocument();
      expect(
        within(overview).queryByText(/KST|KRX·NXT 통합 체결|시세 수신 대기/),
      ).not.toBeInTheDocument();
      expect(overview.querySelector('.is-live')).toBeNull();
      expect(screen.getByTestId('company-chart')).not.toHaveAttribute('data-live-price');
    }
    dispose();
  },
);

it.each([21, 22])(
  'requires 22 daily prices for the approximate month return (%i provided)',
  async (count) => {
    const input = await fixtureRequest<CompanyTimeline>(
      '/api/v1/companies/company-samsung/timeline?range=3M&interval=1d',
    );
    const prices = input.prices.slice(0, count);
    expect(prices).toHaveLength(count);
    mocks.timeline.mockResolvedValue({
      ...input,
      prices,
      markers: [],
      returns: { oneDay: 1.23, oneMonth: 25.55, sinceLatestEvent: null, benchmarkOneMonth: 54.32 },
    });
    mocks.live.mockResolvedValue({ status: 'WAITING', quote: null });
    const dispose = renderCompanyPage();
    const overview = await screen.findByRole('region', { name: '주가 요약' });
    const monthly = within(overview).getByText('1개월').parentElement!;
    await waitFor(() => {
      if (count < 22) {
        expect(within(monthly).getByLabelText('조회 기간 부족')).toBeInTheDocument();
        expect(within(monthly).queryByText('+25.55%')).not.toBeInTheDocument();
      } else {
        expect(within(monthly).getByText('+25.55%')).toBeInTheDocument();
        expect(within(monthly).queryByLabelText('조회 기간 부족')).not.toBeInTheDocument();
      }
    });
    expect(screen.queryByText(/1개월은 21거래일/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '가격과 등락률 안내' }));
    expect(within(screen.getByRole('dialog')).getByText(/1개월은 21거래일/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '도움말 닫기' }));
    expect(within(overview).queryByText('시장 지수 · 1개월')).not.toBeInTheDocument();
    expect(within(overview).queryByText('+54.32%')).not.toBeInTheDocument();
    dispose();
  },
);

it.each(['before', 'first', 'inside'] as const)(
  'only shows event returns when its baseline is covered by the daily query (%s)',
  async (position) => {
    const input = await fixtureRequest<CompanyTimeline>(
      '/api/v1/companies/company-samsung/timeline?range=3M&interval=1d',
    );
    const marker = {
      ...input.markers.find((item) => item.kind === 'FILING')!,
      time:
        position === 'before'
          ? new Date(Date.parse(input.prices[0]!.time) - 86_400_000).toISOString().slice(0, 10)
          : input.prices[position === 'first' ? 0 : 1]!.time,
      returnWindows: { pre1d: 7.01, post1d: 7.02, post5d: 7.03, post20d: 7.04 },
    };
    mocks.timeline.mockResolvedValue({
      ...input,
      markers: [marker],
      returns: { ...input.returns, sinceLatestEvent: 9.87 },
    });
    mocks.live.mockResolvedValue({ status: 'WAITING', quote: null });
    const dispose = renderCompanyPage();
    const overview = await screen.findByRole('region', { name: '주가 요약' });
    const latest = (await within(overview).findByText('최근 공시 이후')).parentElement!;
    const eventLink = screen.queryByText('전일 대비');
    if (position === 'before') {
      expect(within(latest).getByLabelText('조회 기간 부족')).toBeInTheDocument();
      expect(within(latest).queryByText('+9.87%')).not.toBeInTheDocument();
      expect(screen.queryByText('+7.02%')).not.toBeInTheDocument();
      expect(eventLink).toBeNull();
      expect(screen.getByText('조회 기간 부족')).toBeInTheDocument();
    } else {
      expect(within(latest).getByText('+9.87%')).toBeInTheDocument();
      expect(eventLink).toBeInTheDocument();
      expect(screen.getByText('+7.02%')).toBeInTheDocument();
      expect(screen.getByText('1거래일 후')).toBeInTheDocument();
      expect(screen.getByText('5거래일 후')).toBeInTheDocument();
      expect(screen.getByText('20거래일 후')).toBeInTheDocument();
    }
    expect(screen.queryByText(/이벤트 당일 또는 이후 첫 일봉의 종가/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '이벤트 등락률 계산 안내' }));
    expect(
      within(screen.getByRole('dialog')).getByText(/이벤트 당일 또는 이후 첫 일봉의 종가/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '도움말 닫기' }));
    expect(
      screen.getByRole('link', {
        name: new RegExp(position === 'before' ? '조회 기간 부족' : '1거래일 후'),
      }),
    ).toHaveAttribute('href', `/events/${marker.eventId}`);
    expect(marker.returnWindows.post1d).toBe(7.02);
    dispose();
  },
);
