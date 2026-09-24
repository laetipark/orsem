import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { marketFixtures, marketFixtureTime, marketHistoryFixture } from '../lib/market-fixtures';
import type { MarketHistory } from '../types';
import { MarketOverview } from './market-overview';
import { DashboardMarkets, useDashboardMarketRegion } from './dashboard-markets';

vi.mock('./market-widget', () => ({
  MarketWidget: ({
    symbol,
    name,
    sourceUrl,
  }: {
    symbol: string;
    name: string;
    sourceUrl: string;
  }) => (
    <div>
      <span>{symbol} 공식 위젯</span>
      <a href={sourceUrl}>{name} by TradingView</a>
    </div>
  ),
}));

function showMarkets(
  dashboard = true,
  items = marketFixtures,
  histories?: Record<string, MarketHistory>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['markets', 'all'], { asOf: marketFixtureTime, items, histories });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/?region=us']}>
        {dashboard ? <DashboardMarkets /> : <MarketOverview />}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function Harness() {
  const { region, selectRegion } = useDashboardMarketRegion();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output>
        {region} {location.search}
      </output>
      <button onClick={() => selectRegion('kr')}>국내</button>
      <button onClick={() => selectRegion('us')}>미국</button>
      <button onClick={() => void navigate(-1)}>뒤로</button>
      <button onClick={() => void navigate(1)}>앞으로</button>
    </>
  );
}
function show(path = '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T17:00:00+09:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('defaults to the scheduled region and preserves manual URL navigation until the boundary', () => {
  show('/?region=all&q=keep');
  expect(screen.getByRole('status')).toHaveTextContent('kr ?region=kr&q=keep');
  fireEvent.click(screen.getByRole('button', { name: '미국' }));
  expect(screen.getByRole('status')).toHaveTextContent('us ?region=us&q=keep');
  fireEvent.click(screen.getByRole('button', { name: '뒤로' }));
  expect(screen.getByRole('status')).toHaveTextContent('kr ?region=kr&q=keep');
  fireEvent.click(screen.getByRole('button', { name: '앞으로' }));
  expect(screen.getByRole('status')).toHaveTextContent('us ?region=us&q=keep');
  fireEvent.click(screen.getByRole('button', { name: '국내' }));
  act(() => vi.advanceTimersByTime(60 * 60_000));
  expect(screen.getByRole('status')).toHaveTextContent('us ?region=us&q=keep');
});
it('honors a direct URL within its current window and catches a missed boundary on resume', () => {
  show('/?region=us');
  expect(screen.getByRole('status')).toHaveTextContent('us ?region=us');
  act(() => window.dispatchEvent(new Event('focus')));
  expect(screen.getByRole('status')).toHaveTextContent('us ?region=us');
  fireEvent.click(screen.getByRole('button', { name: '국내' }));
  act(() => {
    vi.setSystemTime(new Date('2026-09-04T19:00:00+09:00'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(screen.getByRole('status')).toHaveTextContent('us ?region=us');
});

it('keeps two slim global rows visible while switching the selected regional market', () => {
  vi.useRealTimers();
  const view = showMarkets();
  expect(screen.getByRole('link', { name: 'S&P500 상세 차트' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '코스피 상세 차트' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '금 상세 차트' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '미국' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '시장 전체 보기' })).toHaveAttribute('href', '/markets');
  expect(screen.queryByRole('button', { name: /원자재.*가상자산/ })).not.toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: '원자재·WTI' })).getAllByRole('link'),
  ).toHaveLength(3);
  expect(
    within(screen.getByRole('region', { name: '가상자산' })).getAllByRole('link'),
  ).toHaveLength(2);
  expect(screen.getByRole('link', { name: '금 상세 차트' })).toHaveAccessibleDescription(
    expect.stringContaining('USD/트로이온스'),
  );
  expect(screen.getByRole('link', { name: 'WTI 유가 상세 차트' })).toHaveAccessibleDescription(
    expect.stringContaining('USD/배럴'),
  );
  fireEvent.click(screen.getByRole('button', { name: '국내' }));
  expect(screen.getByRole('link', { name: '코스피 상세 차트' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'S&P500 상세 차트' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '금 상세 차트' })).toBeInTheDocument();
  const timestamp = view.container.querySelector('.market-card--compact time');
  expect(timestamp).toHaveAttribute('dateTime', marketFixtureTime);
  expect(timestamp).toHaveAttribute('aria-label', expect.stringContaining('2026'));
  view.unmount();
  view.client.clear();
});

it('keeps delayed and missing global quotes explicit without inventing prices or USD conversions', () => {
  vi.useRealTimers();
  const items = marketFixtures.map((item) =>
    item.id === 'gold'
      ? { ...item, status: 'STALE' as const }
      : item.id === 'btc'
        ? { ...item, value: null, convertedValue: null, status: 'UNAVAILABLE' as const }
        : item,
  );
  const view = showMarkets(true, items);
  expect(
    within(screen.getByRole('link', { name: '금 상세 차트' })).getByText('지연'),
  ).toBeInTheDocument();
  const bitcoin = screen.getByRole('link', { name: '비트코인 상세 차트' });
  expect(within(bitcoin).getByText('이용 불가')).toBeInTheDocument();
  expect(bitcoin.querySelector('.dashboard-global-quote__value')).toHaveTextContent('—');
  expect(bitcoin.querySelector('.dashboard-global-quote__conversion')).toBeNull();
  expect(bitcoin).toHaveAccessibleDescription(expect.stringContaining('자료 기준'));
  view.unmount();
  view.client.clear();
});

it('orders the full market screen by Korea, US, commodities and crypto with separate complete asset rows', () => {
  vi.useRealTimers();
  const view = showMarkets(false);
  expect(
    screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
  ).toEqual(['국내', '미국', '원자재·WTI', '가상자산']);
  const commodities = view.container.querySelector('.market-group--commodities');
  const crypto = view.container.querySelector('.market-group--crypto');
  expect(commodities).toHaveClass('market-group--global');
  expect(crypto).toHaveClass('market-group--global');
  expect(
    [...commodities!.querySelectorAll('.market-card__heading')].map((link) =>
      link.getAttribute('href'),
    ),
  ).toEqual(['/markets/gold', '/markets/silver', '/markets/wti']);
  expect(
    [...crypto!.querySelectorAll('.market-card__heading')].map((link) => link.getAttribute('href')),
  ).toEqual(['/markets/btc', '/markets/eth']);
  expect(view.container.querySelectorAll('.market-card')).toHaveLength(marketFixtures.length);
  expect(view.container.querySelector('.market-card--compact')).toBeNull();
  expect(view.container.querySelector('.dashboard-global-strips')).toBeNull();
  expect(screen.queryByRole('button', { name: /원자재.*가상자산/ })).not.toBeInTheDocument();
  view.unmount();
  view.client.clear();
});

it('shows a compact basis date and time beside native names and retains official TradingView attribution', () => {
  vi.useRealTimers();
  const view = showMarkets(false);
  for (const item of marketFixtures) {
    const card = screen.getByRole('link', { name: `${item.name} 상세 차트` }).closest('article')!;
    const time = card.querySelector('.market-card__heading time');
    if (item.region === 'us' && item.category === 'INDEX') {
      expect(time).toBeNull();
      expect(card.querySelector('.market-card__meta')).toBeNull();
      expect(within(card).getByText(`${item.widgetSymbol} 공식 위젯`)).toBeInTheDocument();
      expect(
        within(card).getByRole('link', { name: `${item.name} by TradingView` }),
      ).toHaveAttribute('href', item.sourceUrl);
    } else {
      expect(time).toHaveTextContent('09.03 17:42');
      expect(time).toHaveAttribute('dateTime', marketFixtureTime);
      expect(time).toHaveAttribute('title', expect.stringContaining('2026. 09. 03. 17:42 KST'));
      expect(time).toHaveAccessibleName(expect.stringContaining('출처'));
      expect(card.querySelector('.market-card__meta time')).toBeNull();
    }
  }
  view.unmount();
  view.client.clear();
});

it('pairs native values with real history in each card while keeping missing history explicit', () => {
  vi.useRealTimers();
  const view = showMarkets(false, marketFixtures, {
    us2y: marketHistoryFixture('us2y'),
  });
  for (const item of marketFixtures.filter((quote) => quote.displayKind === 'NATIVE')) {
    const card = screen.getByRole('link', { name: `${item.name} 상세 차트` }).closest('article')!;
    const body = card.querySelector('.market-card__body');
    expect(body?.querySelector('.market-value')).toBeInTheDocument();
    expect(body?.querySelector('.market-sparkline')).toBeInTheDocument();
    expect(card.querySelector('.market-card__heading time')).toBeInTheDocument();
    if (item.id === 'us2y')
      expect(body?.querySelector('.market-sparkline svg')).toBeInTheDocument();
    else expect(body?.querySelector('.market-sparkline svg')).toBeNull();
  }
  view.unmount();
  view.client.clear();
});

it('preserves date-only and observed-time provenance in headings without adding a widget time hint', () => {
  vi.useRealTimers();
  const items = marketFixtures.map((item) =>
    item.id === 'us2y'
      ? { ...item, providerAt: null, valueDate: '2026-09-02' }
      : item.id === 'sp500'
        ? { ...item, providerAt: marketFixtureTime }
        : item.id === 'gold'
          ? { ...item, providerAt: null, valueDate: null, observedAt: '2026-09-04T15:05:00.000Z' }
          : item,
  );
  const view = showMarkets(true, items);
  const bond = screen.getByRole('link', { name: '미국 국채 2년 상세 차트' });
  expect(bond.querySelector('time')).toHaveTextContent('09.02');
  expect(bond.querySelector('time')).toHaveAttribute('dateTime', '2026-09-02');
  expect(
    screen.getByRole('link', { name: 'S&P500 상세 차트' }).querySelector('time'),
  ).toHaveTextContent('09.03 17:42');
  expect(
    screen.getByRole('link', { name: '나스닥종합 상세 차트' }).querySelector('time'),
  ).toBeNull();
  const gold = screen.getByRole('link', { name: '금 상세 차트' });
  const observed = gold.querySelector('.dashboard-global-quote__heading time');
  expect(observed).toHaveTextContent('09.05 00:05');
  expect(observed).toHaveAttribute('title', expect.stringContaining('공급자 기준 시각 미확인'));
  expect(observed).toHaveAccessibleName(expect.stringContaining('2026. 09. 05. 00:05 KST'));
  expect(gold.querySelector('.dashboard-global-quote__detail time')).toBeNull();
  view.unmount();
  view.client.clear();
});
