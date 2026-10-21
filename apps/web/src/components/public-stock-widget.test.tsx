import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PublicCompany } from '@orsem/contracts';
import { ThemeProvider } from '../theme';
import { PublicStockWidget } from './public-stock-widget';

const company: PublicCompany = {
  id: 'company-a',
  name: 'Apple',
  market: 'NASDAQ',
  symbol: 'AAPL',
  region: 'us',
  canonicalPath: '/companies/NASDAQ:AAPL',
  chartSymbol: 'NASDAQ:AAPL',
  sourceUrl: 'https://www.sec.gov/files/company_tickers_exchange.json',
  observedAt: null,
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function show(value = company) {
  return render(
    <StrictMode>
      <ThemeProvider>
        <PublicStockWidget company={value} />
      </ThemeProvider>
    </StrictMode>,
  );
}

it('embeds exactly one official widget with Korean, KST, and a fixed verified symbol', async () => {
  const { container } = show();
  await act(async () => undefined);
  const scripts = container.querySelectorAll('script');
  expect(scripts).toHaveLength(1);
  expect(scripts[0]!.src).toBe(
    'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
  );
  expect(JSON.parse(scripts[0]!.textContent!)).toMatchObject({
    symbol: 'NASDAQ:AAPL',
    locale: 'kr',
    timezone: 'Asia/Seoul',
    allow_symbol_change: false,
  });
  expect(screen.getByRole('link', { name: /Apple 차트 · TradingView/ })).toHaveAttribute(
    'href',
    'https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL',
  );
  expect(screen.getByText(/지연될 수 있습니다/)).toBeVisible();
});

it.each([
  { ...company, chartSymbol: null },
  { ...company, chartSymbol: 'NYSE:AAPL' },
  { ...company, chartSymbol: 'NASDAQ:OTHER' },
  {
    ...company,
    region: 'kr' as const,
    market: 'KOSPI' as const,
    symbol: '005930',
    chartSymbol: 'KRX:005930',
  },
])('does not guess or embed an unverified symbol: $chartSymbol', async (value) => {
  const { container } = show(value);
  await act(async () => undefined);
  expect(container.querySelector('script')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('확인되지 않았습니다');
});

it('offers the source link after a 15 second load failure and removes scripts on unmount', async () => {
  const { container, unmount } = show();
  await act(async () => undefined);
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(screen.getByRole('status')).toHaveTextContent('차트를 불러오지 못했습니다');
  expect(screen.getByRole('link', { name: /TradingView/ })).toBeVisible();
  unmount();
  expect(container.querySelector('script')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('shows a fallback immediately when the official script errors', async () => {
  const { container } = show();
  await act(async () => undefined);
  fireEvent.error(container.querySelector('script')!);
  expect(screen.getByRole('status')).toHaveTextContent('차트를 불러오지 못했습니다');
});

it('labels the inserted frame and does not report a timeout after it appears', async () => {
  const { container } = show();
  await act(async () => undefined);
  const frame = document.createElement('iframe');
  await act(async () => {
    container.querySelector('.public-stock-widget__host')!.append(frame);
  });
  expect(frame.title).toBe('Apple TradingView 차트');
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
