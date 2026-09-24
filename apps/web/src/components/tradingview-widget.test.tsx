import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../theme';
import { TradingViewWidget } from './tradingview-widget';

const tickerScriptSelector = 'script[data-orsem-widget="tv-mini-chart"]';
class TickerStub extends HTMLElement {}
let defined = false;
let resolveDefinition: (constructor: CustomElementConstructor) => void;

beforeEach(() => {
  defined = false;
  window.localStorage.setItem('orsem-theme', 'dark');
  const definition = new Promise<CustomElementConstructor>((resolve) => {
    resolveDefinition = resolve;
  });
  vi.spyOn(window.customElements, 'get').mockImplementation(() =>
    defined ? TickerStub : undefined,
  );
  vi.spyOn(window.customElements, 'whenDefined').mockReturnValue(definition);
});

async function registerTicker() {
  await act(async () => {
    defined = true;
    resolveDefinition(TickerStub);
  });
}

afterEach(async () => {
  cleanup();
  await registerTicker();
  document.querySelectorAll(tickerScriptSelector).forEach((script) => script.remove());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('loads the official Web Component and keeps the source link when the script fails', async () => {
  const { container } = render(
    <ThemeProvider>
      <TradingViewWidget
        symbol="FRED:NDQCOM"
        name="나스닥종합"
        sourceUrl="https://www.tradingview.com/symbols/FRED-NDQCOM/"
      />
    </ThemeProvider>,
  );
  await waitFor(() => expect(document.querySelector(tickerScriptSelector)).not.toBeNull());
  const script = document.querySelector<HTMLScriptElement>(tickerScriptSelector)!;
  expect(script.type).toBe('module');
  expect(script.src).toBe('https://widgets.tradingview-widget.com/w/en/tv-mini-chart.js');
  expect(container.querySelector('tv-mini-chart')).toHaveAttribute('symbol', 'FRED:NDQCOM');
  expect(container.querySelector('iframe')).toBeNull();
  fireEvent.error(script);
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('현재 지수 위젯을 이용할 수 없습니다'),
  );
  expect(container.querySelector('tv-mini-chart')).toBeNull();
  expect(screen.getByRole('link', { name: '나스닥종합 by TradingView' })).toHaveAttribute(
    'href',
    'https://www.tradingview.com/symbols/FRED-NDQCOM/',
  );
});

it('shares one module across StrictMode, concurrent symbols and remounts while loading', async () => {
  const { unmount } = render(
    <StrictMode>
      <ThemeProvider>
        <TradingViewWidget
          symbol="FRED:NDQCOM"
          name="나스닥종합"
          sourceUrl="https://www.tradingview.com/symbols/FRED-NDQCOM/"
        />
        <TradingViewWidget
          symbol="FRED:NDQCOM"
          name="나스닥종합"
          sourceUrl="https://www.tradingview.com/symbols/FRED-NDQCOM/"
        />
      </ThemeProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(document.querySelectorAll(tickerScriptSelector)).toHaveLength(1));
  const script = document.querySelector(tickerScriptSelector);
  unmount();
  const { container } = render(
    <ThemeProvider>
      <TradingViewWidget
        compact
        symbol="FRED:NDQCOM"
        name="나스닥종합"
        sourceUrl="https://www.tradingview.com/symbols/FRED-NDQCOM/"
      />
    </ThemeProvider>,
  );
  await registerTicker();
  expect(document.querySelectorAll(tickerScriptSelector)).toHaveLength(1);
  expect(document.querySelector(tickerScriptSelector)).toBe(script);
  expect(container.querySelector('.market-widget--compact tv-mini-chart')).toHaveAttribute(
    'symbol',
    'FRED:NDQCOM',
  );
  expect(screen.queryByRole('status')).toBeNull();
  // The official component supplies attribution once defined; no duplicate is added.
  expect(container.querySelector('.market-widget__attribution')).toBeNull();
});

it('updates theme attributes without replacing the quote element or loading the module again', async () => {
  function ThemeToggle() {
    const { toggle } = useTheme();
    return <button onClick={toggle}>테마 전환</button>;
  }
  const { container } = render(
    <ThemeProvider>
      <ThemeToggle />
      <TradingViewWidget
        symbol="FRED:NDQCOM"
        name="나스닥종합"
        sourceUrl="https://www.tradingview.com/symbols/FRED-NDQCOM/"
      />
    </ThemeProvider>,
  );
  await waitFor(() => expect(document.querySelector(tickerScriptSelector)).not.toBeNull());
  await registerTicker();
  const ticker = container.querySelector('tv-mini-chart');
  expect(ticker).toHaveAttribute('theme', 'dark');
  expect(ticker).toHaveAttribute('transparent', '');
  expect(ticker).toHaveAttribute('time-frame', '3M');
  fireEvent.click(screen.getByRole('button', { name: '테마 전환' }));
  expect(container.querySelector('tv-mini-chart')).toBe(ticker);
  expect(ticker).toHaveAttribute('theme', 'light');
  expect(document.querySelectorAll(tickerScriptSelector)).toHaveLength(1);
});

it('shows a source fallback if the module never registers the element', async () => {
  vi.useFakeTimers();
  render(
    <ThemeProvider>
      <TradingViewWidget
        symbol="FRED:NDQCOM"
        name="나스닥종합"
        sourceUrl="https://www.tradingview.com/symbols/FRED-NDQCOM/"
      />
    </ThemeProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(screen.getByRole('status')).toHaveTextContent('현재 지수 위젯을 이용할 수 없습니다');
  expect(screen.getByRole('link', { name: '나스닥종합 by TradingView' })).toBeVisible();
  expect(document.querySelectorAll(tickerScriptSelector)).toHaveLength(1);
});

it('requests the Nasdaq Composite and selected chart period without allowing symbol substitution', async () => {
  const { container } = render(
    <ThemeProvider>
      <TradingViewWidget
        detail
        range="3m"
        symbol="NASDAQ:IXIC"
        name="나스닥종합"
        sourceUrl="https://www.tradingview.com/symbols/NASDAQ-IXIC/"
      />
    </ThemeProvider>,
  );
  await waitFor(() => expect(container.querySelector('script')).not.toBeNull());
  expect(JSON.parse(container.querySelector('script')!.textContent!)).toMatchObject({
    symbol: 'NASDAQ:IXIC',
    range: '3M',
    allow_symbol_change: false,
    timezone: 'Asia/Seoul',
  });
});

it('shows the explicit source fallback without requesting a widget known to restrict external display', () => {
  const { container } = render(
    <ThemeProvider>
      <TradingViewWidget
        restricted
        symbol="SP:SPX"
        name="S&P500"
        sourceUrl="https://www.tradingview.com/symbols/SP-SPX/"
      />
    </ThemeProvider>,
  );
  expect(container.querySelector('script')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('외부 위젯 표시 제한');
  expect(screen.getByRole('link', { name: 'S&P500 TradingView에서 지수 보기' })).toHaveAttribute(
    'href',
    'https://www.tradingview.com/symbols/SP-SPX/',
  );
});

it('keeps FRED daily indices on a supported daily interval without a range override', async () => {
  const { container } = render(
    <ThemeProvider>
      <TradingViewWidget
        detail
        range="1m"
        symbol="FRED:NDQCOM"
        name="나스닥종합"
        sourceUrl="https://www.tradingview.com/symbols/FRED-NDQCOM/"
      />
    </ThemeProvider>,
  );
  await waitFor(() => expect(container.querySelector('script')).not.toBeNull());
  const config = JSON.parse(container.querySelector('script')!.textContent!);
  expect(config).toMatchObject({ symbol: 'FRED:NDQCOM', interval: 'D' });
  expect(config).not.toHaveProperty('range');
});
