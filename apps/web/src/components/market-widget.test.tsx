import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { marketFixtures } from '../lib/market-fixtures';
import { ThemeProvider } from '../theme';
import { MarketWidget } from './market-widget';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('shows the original S&P500 daily series through the official FRED embed, including old cached metadata', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T16:00:00.000Z'));
  const { container } = render(
    <ThemeProvider>
      <MarketWidget
        symbol="FRED:SP500"
        name="S&P500"
        sourceUrl="https://www.tradingview.com/symbols/FRED-SP500/"
      />
    </ThemeProvider>,
  );
  const frame = screen.getByTitle('S&P500 FRED 일별 종가 차트');
  const url = new URL(frame.getAttribute('src')!);
  expect(url.origin).toBe('https://fred.stlouisfed.org');
  expect(url.pathname).toBe('/graph/graph-landing.php');
  expect(url.searchParams.get('id')).toBe('SP500');
  expect(url.searchParams.get('cosd')).toBe('2026-06-23');
  expect(url.searchParams.get('coed')).toBe('2026-09-24');
  expect(container.querySelector('tv-mini-chart, script')).toBeNull();
  expect(
    screen.getByRole('link', { name: 'S&P500 · FRED · S&P Dow Jones Indices' }),
  ).toHaveAttribute('href', 'https://fred.stlouisfed.org/series/SP500');
  expect(screen.getByRole('link')).toBeVisible();
});

it('uses the S&P500 instrument ID when a cached response has an obsolete TradingView symbol', () => {
  const { container } = render(
    <ThemeProvider>
      <MarketWidget
        instrumentId="sp500"
        symbol="SP:SPX"
        name="S&P500"
        sourceUrl="https://www.tradingview.com/symbols/SP-SPX/"
      />
    </ThemeProvider>,
  );
  expect(screen.getByTitle('S&P500 FRED 일별 종가 차트')).toHaveAttribute(
    'src',
    expect.stringContaining('fred.stlouisfed.org/graph/graph-landing.php'),
  );
  expect(container.querySelector('tv-mini-chart, script')).toBeNull();
  expect(screen.getByRole('link')).toHaveAttribute(
    'href',
    'https://fred.stlouisfed.org/series/SP500',
  );
});

it('fits the official graph to narrow cards and updates the requested detail range', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T16:00:00.000Z'));
  let resize: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  let width = 280;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width }) as DOMRect,
  );
  const show = (range: '1m' | '1y') => (
    <ThemeProvider>
      <MarketWidget
        symbol="FRED:SP500"
        name="S&P500"
        sourceUrl="https://fred.stlouisfed.org/series/SP500"
        detail
        range={range}
      />
    </ThemeProvider>
  );
  const { rerender, unmount } = render(show('1m'));
  const params = () =>
    new URL(screen.getByTitle('S&P500 FRED 일별 종가 차트').getAttribute('src')!).searchParams;
  expect(params().get('width')).toBe('264');
  expect(params().get('cosd')).toBe('2026-08-24');
  expect(screen.getByTitle('S&P500 FRED 일별 종가 차트')).toHaveAttribute('height', '460');
  width = 190;
  act(() => resize());
  expect(params().get('width')).toBe('174');
  rerender(show('1y'));
  expect(params().get('cosd')).toBe('2025-09-23');
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('keeps fixture S&P500 values empty and identifies the actual embedded provider', () => {
  expect(marketFixtures.find((item) => item.id === 'sp500')).toMatchObject({
    provider: 'FRED',
    symbol: 'SP500',
    widgetSymbol: 'FRED:SP500',
    sourceUrl: 'https://fred.stlouisfed.org/series/SP500',
    displayKind: 'WIDGET',
    value: null,
  });
});
