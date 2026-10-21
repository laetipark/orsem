import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { marketFixtures, marketHistoryFixture } from '../lib/market-fixtures';
import { MarketCard } from './market-card';

afterEach(cleanup);

it.each([
  ['sp500', 'SPY', '$600.25'],
  ['nasdaq', 'ONEQ', '$90.45'],
])(
  'shows %s as a native Toss ETF quote and chart without external widgets',
  (id, symbol, price) => {
    const item = marketFixtures.find((quote) => quote.id === id)!;
    const { container } = render(
      <MemoryRouter>
        <MarketCard item={item} history={marketHistoryFixture(id)} compact />
      </MemoryRouter>,
    );
    expect(item).toMatchObject({
      provider: 'TOSS',
      category: 'ETF',
      symbol,
      currency: 'USD',
      displayKind: 'NATIVE',
      widgetSymbol: null,
    });
    expect(screen.getByRole('heading')).toHaveTextContent(`ETF · ${symbol}`);
    expect(screen.getByText(price)).toBeInTheDocument();
    expect(screen.getByText('/주')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /최근 1개월 추이/ })).toBeInTheDocument();
    expect(container.querySelector('.market-widget, iframe, tv-mini-chart, script')).toBeNull();
    expect(screen.queryByText(/TradingView|FRED/)).toBeNull();
  },
);

it.each(['sp500', 'nasdaq'])('keeps %s unavailable without inventing an ETF price', (id) => {
  const item = marketFixtures.find((quote) => quote.id === id)!;
  const { container } = render(
    <MemoryRouter>
      <MarketCard
        item={{
          ...item,
          status: 'NOT_CONFIGURED',
          value: null,
          change: null,
          changePercent: null,
          providerAt: null,
          observedAt: null,
        }}
        compact
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('연결 미설정')).toBeInTheDocument();
  expect(
    within(container.querySelector('.market-value__number') as HTMLElement).getByText('—'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();
  expect(container.querySelector('.market-widget, iframe, tv-mini-chart, script')).toBeNull();
});
