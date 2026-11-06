import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartTime, chartTimeLabel, hasChartCandles, isNoTradePrice } from '../lib/chart-prices';
import type { CompanyTimeline, PricePoint } from '../types';
import { mockMediaQuery } from '../test/media-query';
import { CompanyChart } from './company-chart';

const chartMocks = vi.hoisted(() => ({
  createChart: vi.fn(),
  addSeries: vi.fn(),
  setData: vi.fn(),
  indicatorData: vi.fn(),
  closeData: vi.fn(),
  candleOptions: vi.fn(),
  closeOptions: vi.fn(),
  indicatorOptions: vi.fn(),
  thresholdOptions: vi.fn(),
  chartOptions: vi.fn(),
  theme: 'dark',
  remove: vi.fn(),
  fitContent: vi.fn(),
  setMarkers: vi.fn(),
  createPriceLine: vi.fn(),
  removePriceLine: vi.fn(),
  updatePriceLine: vi.fn(),
  subscribeCrosshairMove: vi.fn(),
  unsubscribeCrosshairMove: vi.fn(),
  subscribeClick: vi.fn(),
  unsubscribeClick: vi.fn(),
  removeSeries: vi.fn(),
  setVisibleLogicalRange: vi.fn(),
  getVisibleLogicalRange: vi.fn(),
  subscribeVisibleLogicalRangeChange: vi.fn(),
  unsubscribeVisibleLogicalRangeChange: vi.fn(),
}));

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: { type: 'candlestick' },
  LineSeries: { type: 'line' },
  HistogramSeries: { type: 'histogram' },
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  TickMarkType: { DayOfMonth: 2 },
  createChart: chartMocks.createChart,
  createSeriesMarkers: () => ({ setMarkers: chartMocks.setMarkers }),
}));

vi.mock('../theme', () => ({ useTheme: () => ({ theme: chartMocks.theme }) }));

const noTradePrice: PricePoint = Object.freeze({
  time: '2026-09-02',
  open: 0,
  high: 0,
  low: 0,
  close: 42000,
  volume: 0,
  source: 'KRX',
  rightsMode: 'PRIVATE_DISPLAY_ONLY',
});

function timeline(prices: PricePoint[]): CompanyTimeline {
  return {
    companyId: 'test-company',
    currency: 'KRW',
    prices,
    priceSources: [],
    markers: [],
    returns: { oneDay: null, oneMonth: null, sinceLatestEvent: null, benchmarkOneMonth: null },
    latestCloseAt: prices.at(-1)?.time ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  chartMocks.theme = 'dark';
  localStorage.clear();
  localStorage.setItem(
    'orsem-chart-indicators-v1',
    JSON.stringify({ volume: true, sma: [20], rsi: false, rsiPeriod: 14 }),
  );
  chartMocks.getVisibleLogicalRange.mockReturnValue({ from: 0, to: 40 });
  chartMocks.addSeries.mockImplementation((definition, options) => ({
    setData:
      definition.type === 'candlestick'
        ? chartMocks.setData
        : options.title === '종가'
          ? chartMocks.closeData
          : chartMocks.indicatorData,
    applyOptions:
      definition.type === 'candlestick'
        ? chartMocks.candleOptions
        : options.title === '종가'
          ? chartMocks.closeOptions
          : chartMocks.indicatorOptions,
    createPriceLine:
      definition.type === 'candlestick'
        ? chartMocks.createPriceLine
        : vi.fn(() => ({ applyOptions: chartMocks.thresholdOptions })),
    removePriceLine: chartMocks.removePriceLine,
    options: () => options,
    getPane: () => ({ setStretchFactor: vi.fn(), setHeight: vi.fn(), getHTMLElement: () => null }),
    priceScale: () => ({ applyOptions: vi.fn() }),
  }));
  chartMocks.createChart.mockReturnValue({
    addSeries: chartMocks.addSeries,
    timeScale: () => ({
      fitContent: chartMocks.fitContent,
      subscribeVisibleLogicalRangeChange: chartMocks.subscribeVisibleLogicalRangeChange,
      unsubscribeVisibleLogicalRangeChange: chartMocks.unsubscribeVisibleLogicalRangeChange,
      getVisibleLogicalRange: chartMocks.getVisibleLogicalRange,
      setVisibleLogicalRange: chartMocks.setVisibleLogicalRange,
    }),
    subscribeCrosshairMove: chartMocks.subscribeCrosshairMove,
    unsubscribeCrosshairMove: chartMocks.unsubscribeCrosshairMove,
    subscribeClick: chartMocks.subscribeClick,
    unsubscribeClick: chartMocks.unsubscribeClick,
    removeSeries: chartMocks.removeSeries,
    applyOptions: chartMocks.chartOptions,
    remove: chartMocks.remove,
  });
  chartMocks.createPriceLine.mockReturnValue({ applyOptions: chartMocks.updatePriceLine });
});

describe('Toss chart updates', () => {
  it('renders Toss no-trade dates as gaps without inventing zero-price candles', () => {
    expect(hasChartCandles([{ ...noTradePrice, source: 'TOSS_KR' }])).toBe(false);
    expect(hasChartCandles([{ ...noTradePrice, source: 'TOSS_US' }])).toBe(false);
  });
  const price: PricePoint = {
    ...noTradePrice,
    time: '2026-09-04T00:30:00Z',
    source: 'TOSS_US',
    open: 100.25,
    high: 102.5,
    low: 99.75,
    close: 101.25,
    volume: 234,
  };

  it('converts intraday instants to UTC chart time and labels them in KST', () => {
    expect(chartTime(price.time)).toBe(Date.parse(price.time) / 1000);
    expect(chartTimeLabel(chartTime(price.time), true)).toBe('09:30');
    expect(chartTime('2026-09-04')).toBe('2026-09-04');
  });

  it('preserves zoom on refresh, USD cents, and daily marker semantics', () => {
    const input: CompanyTimeline = {
      ...timeline([price]),
      currency: 'USD',
      interval: '1m',
      provider: 'toss',
    };
    const { rerender } = render(<CompanyChart timeline={input} />);
    const format = chartMocks.addSeries.mock.calls[0]?.[1].priceFormat.formatter;
    expect(format(0.1234)).toBe('0.1234');
    expect(format(101.25)).toBe('101.25');
    expect(chartMocks.setData).toHaveBeenLastCalledWith([
      { time: Date.parse(price.time) / 1000, open: 100.25, high: 102.5, low: 99.75, close: 101.25 },
    ]);
    expect(chartMocks.setMarkers).toHaveBeenLastCalledWith([]);
    rerender(<CompanyChart timeline={{ ...input, prices: [{ ...price, close: 101.75 }] }} />);
    expect(chartMocks.createChart).toHaveBeenCalledOnce();
    expect(chartMocks.fitContent).toHaveBeenCalledOnce();
    expect(chartMocks.setData).toHaveBeenCalledTimes(2);
  });

  it('keeps the live quote separate from official OHLC and removes a stale price line', () => {
    const input: CompanyTimeline = {
      ...timeline([price]),
      currency: 'USD',
      interval: '1m',
      provider: 'toss',
    };
    const live = {
      companyId: input.companyId,
      provider: 'toss' as const,
      status: 'LIVE' as const,
      quote: {
        symbol: 'NVDA',
        source: 'TOSS_US',
        currency: 'USD' as const,
        price: '102.34',
        providerAt: price.time,
        observedAt: price.time,
        rightsMode: 'PRIVATE_DISPLAY_ONLY' as const,
        lossy: true as const,
      },
      asOf: price.time,
    };
    const { rerender } = render(<CompanyChart timeline={input} livePrice={live} />);
    expect(chartMocks.createPriceLine).toHaveBeenCalledWith(
      expect.objectContaining({ price: 102.34 }),
    );
    expect(input.prices[0]?.close).toBe(101.25);
    rerender(<CompanyChart timeline={input} livePrice={{ ...live, status: 'STALE' }} />);
    // Both the candle and close-line series must remove the stale quote.
    expect(chartMocks.removePriceLine).toHaveBeenCalledTimes(2);
  });

  it('updates only changed chart data and skips metadata-only polling responses', () => {
    const input = timeline([{ ...price, time: '2026-09-04' }]);
    const view = render(<CompanyChart timeline={input} />);
    const indicatorWrites = chartMocks.indicatorData.mock.calls.length;
    const markerWrites = chartMocks.setMarkers.mock.calls.length;

    view.rerender(
      <CompanyChart timeline={{ ...input, returns: { ...input.returns, oneDay: 1.2 } }} />,
    );
    expect(chartMocks.setData).toHaveBeenCalledTimes(1);
    expect(chartMocks.closeData).toHaveBeenCalledTimes(1);
    expect(chartMocks.indicatorData).toHaveBeenCalledTimes(indicatorWrites);
    expect(chartMocks.setMarkers).toHaveBeenCalledTimes(markerWrites);

    const updated = { ...input, prices: [{ ...input.prices[0]!, close: 101.75 }] };
    view.rerender(<CompanyChart timeline={updated} />);
    expect(chartMocks.setData).toHaveBeenCalledTimes(2);
    expect(chartMocks.indicatorData).toHaveBeenCalledTimes(indicatorWrites * 2);
    expect(chartMocks.setMarkers).toHaveBeenCalledTimes(markerWrites);

    view.rerender(
      <CompanyChart
        timeline={{
          ...updated,
          markers: [
            {
              time: '2026-09-04',
              kind: 'FILING',
              eventId: 'filing-1',
              label: '공시',
              detailType: 'D002',
              returnWindows: { pre1d: null, post1d: null, post5d: null, post20d: null },
            },
          ],
        }}
      />,
    );
    expect(chartMocks.setData).toHaveBeenCalledTimes(2);
    expect(chartMocks.indicatorData).toHaveBeenCalledTimes(indicatorWrites * 2);
    expect(chartMocks.setMarkers).toHaveBeenLastCalledWith([
      expect.objectContaining({ time: '2026-09-04', text: 'F' }),
    ]);
    expect(chartMocks.fitContent).toHaveBeenCalledOnce();
  });

  it('fills replacement charts even when the new company shares the same price arrays', () => {
    const input = timeline([price]);
    const view = render(<CompanyChart timeline={input} />);
    const indicatorWrites = chartMocks.indicatorData.mock.calls.length;
    const markerWrites = chartMocks.setMarkers.mock.calls.length;
    view.rerender(<CompanyChart timeline={{ ...input, companyId: 'other-company' }} />);
    expect(chartMocks.createChart).toHaveBeenCalledTimes(2);
    expect(chartMocks.setData).toHaveBeenCalledTimes(2);
    expect(chartMocks.indicatorData).toHaveBeenCalledTimes(indicatorWrites * 2);
    expect(chartMocks.setMarkers).toHaveBeenCalledTimes(markerWrites * 2);
    expect(chartMocks.fitContent).toHaveBeenCalledTimes(2);
  });

  it('changes theme without rebuilding charts, resetting zoom or losing candle selection', () => {
    localStorage.setItem(
      'orsem-chart-indicators-v1',
      JSON.stringify({ volume: true, sma: [20], rsi: true, rsiPeriod: 14 }),
    );
    const input = timeline([
      { ...price, time: '2026-09-01', close: 100.75 },
      { ...price, time: '2026-09-02', close: 101.25 },
    ]);
    const view = render(<CompanyChart timeline={{ ...input, currency: 'USD' }} />);
    const legend = screen.getByRole('group', { name: '봉별 가격과 지표 범례' });
    fireEvent.keyDown(legend, { key: 'ArrowLeft' });
    const seriesCount = chartMocks.addSeries.mock.calls.length;
    const indicatorWrites = chartMocks.indicatorData.mock.calls.length;
    chartMocks.setVisibleLogicalRange.mockClear();
    chartMocks.theme = 'light';
    view.rerender(<CompanyChart timeline={{ ...input, currency: 'USD' }} />);

    expect(chartMocks.createChart).toHaveBeenCalledOnce();
    expect(chartMocks.remove).not.toHaveBeenCalled();
    expect(chartMocks.addSeries).toHaveBeenCalledTimes(seriesCount);
    expect(chartMocks.fitContent).toHaveBeenCalledOnce();
    expect(chartMocks.setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(chartMocks.setData).toHaveBeenCalledOnce();
    expect(chartMocks.indicatorData).toHaveBeenCalledTimes(indicatorWrites);
    expect(within(legend).getByText('100.75')).toBeInTheDocument();
    expect(chartMocks.chartOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ layout: expect.objectContaining({ textColor: '#4f6268' }) }),
    );
    expect(chartMocks.indicatorOptions).toHaveBeenLastCalledWith({ color: '#8351ad' });
    expect(chartMocks.thresholdOptions).toHaveBeenLastCalledWith({ color: '#87979f' });
  });

  it('shows the pointed candle values and preserves selection when fresh data arrives', () => {
    const first = { ...price, time: '2026-09-01', close: 100.75 };
    const last = { ...price, time: '2026-09-02', close: 101.25 };
    const input = { ...timeline([first, last]), currency: 'USD' as const };
    const view = render(<CompanyChart timeline={input} />);
    const legend = screen.getByRole('group', { name: '봉별 가격과 지표 범례' });
    const latestButton = screen.getByRole('button', { name: '최신 봉 보기' });
    expect(latestButton).toBeDisabled();
    expect(within(legend).queryByRole('button', { name: '최신 봉 보기' })).not.toBeInTheDocument();
    expect(within(legend).getByText('101.25')).toBeInTheDocument();
    act(() =>
      chartMocks.subscribeCrosshairMove.mock.calls[0]![0]({
        time: first.time,
        point: { x: 30, y: 40 },
      }),
    );
    expect(within(legend).getByText('100.75')).toBeInTheDocument();
    expect(latestButton).toBeEnabled();
    view.rerender(
      <CompanyChart timeline={{ ...input, prices: [first, { ...last, close: 101.5 }] }} />,
    );
    expect(within(legend).getByText('100.75')).toBeInTheDocument();
    fireEvent.keyDown(legend, { key: 'ArrowRight' });
    expect(within(legend).getByText('101.50')).toBeInTheDocument();
    fireEvent.click(latestButton);
    expect(within(legend).getByText('최신 봉')).toBeInTheDocument();
    expect(latestButton).toBeDisabled();
    view.unmount();
    expect(chartMocks.unsubscribeCrosshairMove).toHaveBeenCalledWith(
      chartMocks.subscribeCrosshairMove.mock.calls[0]![0],
    );
  });

  it('toggles indicator panes without rebuilding the chart and saves browser settings', () => {
    render(<CompanyChart timeline={timeline([price])} />);
    fireEvent.click(screen.getByRole('button', { name: /보조지표/ }));
    fireEvent.click(screen.getByLabelText('RSI', { exact: true }));
    expect(chartMocks.addSeries).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'line' }),
      expect.objectContaining({ title: 'RSI 14' }),
      2,
    );
    fireEvent.click(screen.getByLabelText('거래량', { exact: true }));
    expect(chartMocks.addSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'line' }),
      expect.objectContaining({ title: 'RSI 14' }),
      1,
    );
    expect(chartMocks.createChart).toHaveBeenCalledOnce();
    expect(chartMocks.fitContent).toHaveBeenCalledOnce();
    expect(chartMocks.setData).toHaveBeenCalledOnce();
    expect(chartMocks.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 40 });
    expect(JSON.parse(localStorage.getItem('orsem-chart-indicators-v1')!)).toMatchObject({
      volume: false,
      rsi: true,
      rsiPeriod: 14,
    });
    fireEvent.click(screen.getByRole('button', { name: /보조지표/ }));
    expect(screen.queryByLabelText('RSI', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /보조지표/ }));
    expect(screen.getByLabelText('RSI', { exact: true })).toBeChecked();
    expect(screen.getByLabelText('거래량', { exact: true })).not.toBeChecked();
    expect(chartMocks.createChart).toHaveBeenCalledOnce();
  });

  it('always shows compact OHLC on mobile and retains touch selection across data updates', () => {
    const media = mockMediaQuery(true);
    const first = { ...price, time: '2026-09-01', close: 100.75 },
      last = { ...price, time: '2026-09-02', close: 101.25 };
    const input = { ...timeline([first, last]), currency: 'USD' as const };
    const view = render(<CompanyChart timeline={input} />),
      legend = screen.getByRole('group', { name: '봉별 가격과 지표 범례' });
    expect(within(legend).getByText('시가')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '가격·지표 상세' })).not.toBeInTheDocument();
    act(() =>
      chartMocks.subscribeClick.mock.calls[0]![0]({ time: first.time, point: { x: 30, y: 40 } }),
    );
    expect(within(legend).getByText('100.75')).toBeInTheDocument();
    view.rerender(
      <CompanyChart timeline={{ ...input, prices: [first, { ...last, close: 102 }] }} />,
    );
    act(() => media.resize(false));
    expect(within(legend).getByText('100.75')).toBeInTheDocument();
    expect(within(legend).getByText('시가')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '최신 봉 보기' }));
    expect(within(legend).getByText('102.00')).toBeInTheDocument();
    expect(chartMocks.createChart).toHaveBeenCalledOnce();
    expect(chartMocks.fitContent).toHaveBeenCalledOnce();
  });
  it('lets the keyboard scroll compact legend rows without changing the selected candle', () => {
    mockMediaQuery(true);
    const first = { ...price, time: '2026-09-01', close: 100.75 },
      last = { ...price, time: '2026-09-02', close: 101.25 };
    render(<CompanyChart timeline={{ ...timeline([first, last]), currency: 'USD' }} />);
    const legend = screen.getByRole('group', { name: '봉별 가격과 지표 범례' });
    const priceRow = screen.getByRole('group', { name: '시가·고가·저가·종가' });
    expect(priceRow).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('group', { name: '이동평균 값' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('group', { name: '선택 시각과 거래량' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    fireEvent.keyDown(priceRow, { key: 'ArrowLeft' });
    expect(within(legend).getByText('101.25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '최신 봉 보기' })).toBeDisabled();
    fireEvent.keyDown(legend, { key: 'ArrowLeft' });
    expect(within(legend).getByText('100.75')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '최신 봉 보기' })).toBeEnabled();
  });
  it('uses the new first-use profile without overwriting saved indicator choices', () => {
    localStorage.clear();
    render(<CompanyChart timeline={timeline([price])} />);
    expect(JSON.parse(localStorage.getItem('orsem-chart-indicators-v1')!)).toEqual({
      volume: true,
      sma: [5, 20, 60],
      rsi: true,
      rsiPeriod: 14,
    });
    expect(chartMocks.addSeries).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'line' }),
      expect.objectContaining({ title: 'RSI 14' }),
      2,
    );
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('company chart KRX no-trade days', () => {
  it('passes no-trade days as whitespace and preserves traded OHLC and official source closes', () => {
    const tradedPrice: PricePoint = Object.freeze({
      ...noTradePrice,
      time: '2026-09-03',
      open: 42000,
      high: 43000,
      low: 41000,
      close: 42500,
      volume: 1234,
    });
    const input = timeline([noTradePrice, tradedPrice]);
    const { unmount } = render(<CompanyChart timeline={input} />);

    expect(chartMocks.setData).toHaveBeenCalledWith([
      { time: '2026-09-02' },
      { time: '2026-09-03', open: 42000, high: 43000, low: 41000, close: 42500 },
    ]);
    expect(input.prices[0]).toEqual(noTradePrice);
    expect(input.prices[0]?.close).toBe(42000);
    expect(hasChartCandles(input.prices)).toBe(true);

    unmount();
    expect(chartMocks.remove).toHaveBeenCalledOnce();
  });

  it('recognizes all-no-trade periods as having no candles and skips chart creation', () => {
    const prices = [noTradePrice, { ...noTradePrice, time: '2026-09-03', close: 0 }];
    render(<CompanyChart timeline={timeline(prices)} />);

    expect(hasChartCandles(prices)).toBe(false);
    expect(hasChartCandles([])).toBe(false);
    expect(chartMocks.createChart).not.toHaveBeenCalled();
  });

  it.each([
    { source: 'ALPACA_IEX_RAW' },
    { open: 42000 },
    { high: 42000 },
    { low: 42000 },
    { close: -1 },
    { volume: 1 },
  ])('does not treat a different source or price pattern as a KRX no-trade day: %o', (patch) => {
    expect(isNoTradePrice({ ...noTradePrice, ...patch })).toBe(false);
  });
});

describe('indicator warmup data', () => {
  it('calculates 120-day SMA from older candles without expanding the visible chart range', () => {
    localStorage.setItem(
      'orsem-chart-indicators-v1',
      JSON.stringify({ volume: false, sma: [120], rsi: false, rsiPeriod: 14 }),
    );
    const prices: PricePoint[] = Array.from({ length: 120 }, (_, index) => ({
      time: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      open: index + 1,
      high: index + 1,
      low: index + 1,
      close: index + 1,
      volume: 1,
      source: 'TOSS_KR',
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
    }));
    const visible = prices.slice(-1);
    render(
      <CompanyChart
        timeline={{ ...timeline(visible), indicatorWarmupPrices: prices.slice(0, -1) }}
      />,
    );
    expect(chartMocks.setData).toHaveBeenLastCalledWith([
      { time: visible[0]!.time, open: 120, high: 120, low: 120, close: 120 },
    ]);
    expect(chartMocks.indicatorData).toHaveBeenLastCalledWith([
      { time: visible[0]!.time, value: 60.5 },
    ]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('explains insufficient history rather than displaying a fabricated indicator', () => {
    render(
      <CompanyChart
        timeline={timeline([
          { ...noTradePrice, source: 'TOSS_KR', open: 10, high: 10, low: 10, close: 10, volume: 1 },
        ])}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('연속 데이터가 부족');
  });
});

it('latest candle button follows the viewport and preserves the zoom width when returning', () => {
  const prices = Array.from({ length: 60 }, (_, index) => ({
    ...noTradePrice,
    time: new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10),
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 100,
    source: 'TOSS_KR',
  }));
  render(<CompanyChart timeline={timeline(prices)} />);
  const changed = chartMocks.subscribeVisibleLogicalRangeChange.mock.calls[0]![0] as () => void;
  chartMocks.getVisibleLogicalRange.mockReturnValue({ from: 5, to: 25 });
  act(changed);
  const latest = screen.getByRole('button', { name: '최신 봉 보기' });
  expect(latest).toBeEnabled();
  fireEvent.click(latest);
  expect(chartMocks.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 39, to: 59 });
  chartMocks.getVisibleLogicalRange.mockReturnValue({ from: 39, to: 59 });
  act(changed);
  expect(latest).toBeDisabled();
});

it('switches candle and close line without rebuilding or fitting the time range; quick MA uses shared settings', () => {
  const prices = [
    {
      ...noTradePrice,
      source: 'TOSS_KR' as const,
      open: 40000,
      high: 43000,
      low: 39000,
      close: 42000,
      volume: 100,
    },
  ];
  render(<CompanyChart timeline={timeline(prices)} />);
  const creates = chartMocks.createChart.mock.calls.length,
    fits = chartMocks.fitContent.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: '라인' }));
  expect(chartMocks.closeOptions).toHaveBeenLastCalledWith({ visible: true });
  expect(chartMocks.candleOptions).toHaveBeenLastCalledWith({ visible: false });
  expect(chartMocks.closeData).toHaveBeenLastCalledWith([
    { time: chartTime(prices[0]!.time), value: 42000 },
  ]);
  fireEvent.click(screen.getByRole('button', { name: '캔들' }));
  expect(chartMocks.createChart).toHaveBeenCalledTimes(creates);
  expect(chartMocks.fitContent).toHaveBeenCalledTimes(fits);
  fireEvent.click(screen.getByRole('button', { name: '이동평균 120' }));
  fireEvent.click(screen.getByRole('button', { name: /보조지표/ }));
  expect(screen.getByRole('checkbox', { name: '120일선' })).toBeChecked();
});
