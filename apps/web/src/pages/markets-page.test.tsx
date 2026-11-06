import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { marketFixtures, marketFixtureTime, marketHistoryFixture } from '../lib/market-fixtures';
import { ThemeProvider } from '../theme';
import type { MarketHistory } from '../types';
import { MarketDetailPage } from './markets-page';

vi.mock('../components/market-chart', () => ({
  MarketChart: ({
    name,
    points,
    currency,
  }: {
    name: string;
    points: MarketHistory['points'];
    currency: string;
  }) => (
    <div
      role="img"
      aria-label={`${name} 자체 차트`}
      data-currency={currency}
      data-count={points.length}
    />
  ),
}));
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(marketFixtureTime));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['markets', 'all'], { asOf: marketFixtureTime, items: marketFixtures });
  vi.spyOn(api, 'marketHistory');
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function show(id: string) {
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/markets/${id}?range=3m`]}>
          <Routes>
            <Route path="/markets/:id" element={<MarketDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

it.each(['sp500', 'nasdaq'])(
  'shows %s ETF history with native range controls and Toss attribution',
  async (id) => {
    const item = marketFixtures.find((quote) => quote.id === id)!;
    client.setQueryData(['market-history', id, '1y'], marketHistoryFixture(id));
    vi.useRealTimers();
    const { container } = show(id);
    expect(screen.getByRole('heading', { name: item.name })).toBeInTheDocument();
    const chart = await screen.findByRole('img', { name: `${item.name} 자체 차트` });
    expect(chart).toHaveAttribute('data-currency', 'USD');
    const count = Number(chart.getAttribute('data-count'));
    expect(count).toBeGreaterThan(31);
    expect(screen.getByRole('button', { name: '3개월' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '1개월' }));
    expect(screen.getByRole('button', { name: '1개월' })).toHaveAttribute('aria-pressed', 'true');
    expect(Number(chart.getAttribute('data-count'))).toBeLessThan(count);
    expect(screen.getByRole('link', { name: item.attribution })).toHaveAttribute(
      'href',
      item.sourceUrl,
    );
    expect(container.querySelector('.market-widget, iframe, tv-mini-chart, script')).toBeNull();
  },
);

it.each(['sp500', 'nasdaq'])(
  'does not display stale widget values or history after %s changes to an ETF',
  (id) => {
    const current = marketFixtures.find((item) => item.id === id)!;
    const old = {
      ...current,
      provider: 'FRED',
      symbol: 'OLD_INDEX',
      displayKind: 'WIDGET' as const,
      value: '99999',
      currency: null,
      description: 'FRED 공식 그래프',
    };
    client.setQueryData(['markets', 'all'], { asOf: marketFixtureTime, items: [old] });
    client.setQueryData(['market-history', id, '1y'], {
      ...marketHistoryFixture(id),
      instrument: old,
    });
    const { container } = show(id);
    expect(screen.getByRole('heading', { name: current.name })).toBeInTheDocument();
    expect(screen.getByText('표시할 이력이 없습니다')).toBeInTheDocument();
    expect(screen.queryByText(/99,999|FRED 공식 그래프/)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('.market-widget, iframe, tv-mini-chart, script')).toBeNull();
  },
);
