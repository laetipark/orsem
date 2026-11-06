import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { useTheme } from '../theme';
import type { CompanyLivePrice, CompanyTimeline } from '../types';
import {
  chartPriceData,
  chartPriceFormatter,
  chartTime,
  chartTimeLabel,
  hasChartCandles,
  isNoTradePrice,
} from './chart-prices';
import { smaSeries, rsiSeries, volumeSeries } from './chart-indicators';
import { smaColors, type ChartSettings } from './chart-settings';

const markerStyle = {
  TRADE: { color: '#28b9a6', shape: 'arrowUp' as const, position: 'belowBar' as const },
  FILING: { color: '#f39a45', shape: 'circle' as const, position: 'aboveBar' as const },
  NEWS: { color: '#6f93ff', shape: 'square' as const, position: 'aboveBar' as const },
};
const timeKey = (time: Time) => (typeof time === 'object' ? chartTimeLabel(time) : String(time));

export type CompanyChartType = 'candle' | 'line';

function chartHeight(narrow: boolean, rsi: boolean) {
  if (narrow) return rsi ? 400 : 320;
  return rsi ? 480 : 420;
}

/** Owns the chart instance, subscriptions and series without exposing them to the view. */
export function useCompanyChart({
  timeline,
  livePrice,
  settings,
  chartType,
  expanded,
}: {
  timeline: CompanyTimeline;
  livePrice?: CompanyLivePrice | null;
  settings: ChartSettings;
  chartType: CompanyChartType;
  expanded: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const closeRef = useRef<ISeriesApi<'Line'> | null>(null);
  const closeMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const closePriceLineRef = useRef<IPriceLine | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const smaRefs = useRef(new Map<number, ISeriesApi<'Line'>>());
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const rsiRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiThresholdRefs = useRef<IPriceLine[]>([]);
  const fittedRef = useRef(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [latestVisible, setLatestVisible] = useState(true);
  const latestIndexRef = useRef(timeline.prices.length - 1);
  latestIndexRef.current = timeline.prices.length - 1;
  const sizingRef = useRef(settings);
  sizingRef.current = settings;
  const resizeChartRef = useRef<(() => void) | null>(null);
  const [rsiTop, setRsiTop] = useState<number | null>(null);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const hasCandles = useMemo(() => hasChartCandles(timeline.prices), [timeline.prices]);
  const minute = timeline.interval === '1m';
  const indicators = useMemo(() => {
    const prices = [...(timeline.indicatorWarmupPrices ?? []), ...timeline.prices];
    const visibleTimes = new Set(timeline.prices.map((price) => timeKey(chartTime(price.time))));
    const visible = <T extends { time: Time }>(rows: T[]) =>
      rows.filter((row) => visibleTimes.has(timeKey(row.time)));
    return {
      sma: new Map(settings.sma.map((period) => [period, visible(smaSeries(prices, period))])),
      volume: volumeSeries(timeline.prices, {
        up: '#28b9a680',
        down: '#d76d5d80',
        unchanged: '#89979a80',
      }),
      rsi: settings.rsi ? visible(rsiSeries(prices, settings.rsiPeriod)) : [],
    };
  }, [timeline.prices, timeline.indicatorWarmupPrices, settings]);
  const priceIndex = useMemo(
    () => new Map(timeline.prices.map((price, index) => [timeKey(chartTime(price.time)), index])),
    [timeline.prices],
  );
  const selectedIndex =
    selectedKey === null
      ? timeline.prices.length - 1
      : (priceIndex.get(selectedKey) ?? timeline.prices.length - 1);
  const selected = timeline.prices[selectedIndex];
  const indicatorValues = useMemo(() => {
    const index = (rows: Array<{ time: Time; value?: number }>) =>
      new Map(rows.map((row) => [timeKey(row.time), row.value]));
    return {
      sma: new Map([...indicators.sma].map(([period, rows]) => [period, index(rows)])),
      rsi: index(indicators.rsi),
    };
  }, [indicators]);
  const selectedTime = selected ? timeKey(chartTime(selected.time)) : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasCandles) return;
    const dark = themeRef.current === 'dark';
    const chart = createChart(container, {
      width: container.clientWidth,
      height: chartHeight(container.clientWidth < 640, sizingRef.current.rsi),
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: dark ? '#aab9bd' : '#4f6268',
        fontSize: container.clientWidth < 640 ? 11 : 12,
        attributionLogo: true,
        panes: {
          separatorColor: dark ? '#34454b' : '#d6e0df',
          separatorHoverColor: dark ? '#496169' : '#b4c8c5',
          enableResize: true,
        },
      },
      grid: { vertLines: { visible: false }, horzLines: { color: dark ? '#203035' : '#e7eceb' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: dark ? '#34454b' : '#dbe2e0',
        minimumWidth: container.clientWidth < 640 ? 64 : 76,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: dark ? '#34454b' : '#dbe2e0',
        timeVisible: minute,
        secondsVisible: false,
        // 전체 봉이 들어온 뒤에는 더 축소하거나 데이터 양끝 밖으로 이동하지 않습니다.
        rightOffset: 0,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
        ...(minute
          ? {
              tickMarkFormatter: (time: Time, type: TickMarkType) =>
                type <= TickMarkType.DayOfMonth ? chartTimeLabel(time) : chartTimeLabel(time, true),
            }
          : {}),
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: {
        locale: 'ko-KR',
        ...(minute ? { timeFormatter: (time: Time) => `${chartTimeLabel(time)} KST` } : {}),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#28b9a6',
      downColor: '#d76d5d',
      borderVisible: false,
      wickUpColor: '#28b9a6',
      wickDownColor: '#d76d5d',
      priceFormat: {
        type: 'custom',
        minMove: timeline.currency === 'USD' ? 0.0001 : 1,
        formatter: chartPriceFormatter(timeline.currency).format,
      },
    });
    const close = chart.addSeries(LineSeries, {
      color: '#5d8cf5',
      lineWidth: 2,
      visible: false,
      title: '종가',
      priceFormat: series.options().priceFormat,
    });
    closeRef.current = close;
    closeMarkersRef.current = createSeriesMarkers(close, []);
    const selectBar = (event: MouseEventParams<Time>) =>
      setSelectedKey(
        event.time === undefined || !event.point || event.point.x < 0 || event.point.y < 0
          ? null
          : timeKey(event.time),
      );
    chart.subscribeCrosshairMove(selectBar);
    chart.subscribeClick(selectBar);
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    fittedRef.current = false;
    const trackVisibleRange = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      const latest = latestIndexRef.current;
      setLatestVisible(Boolean(range && latest >= range.from && latest <= range.to));
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(trackVisibleRange);
    const resize = () => {
      const width = container.clientWidth,
        narrow = width < 640,
        setting = sizingRef.current;
      const fullscreen =
        document.fullscreenElement?.contains(container) || container.closest('.is-expanded');
      const height = fullscreen
        ? Math.max(260, window.innerHeight - (narrow ? 310 : 220))
        : chartHeight(narrow, setting.rsi);
      if (width <= 0) return;
      const visibleRange = chart.timeScale().getVisibleLogicalRange();
      chart.applyOptions({
        width,
        height,
        layout: { fontSize: narrow ? 11 : 12 },
        rightPriceScale: { minimumWidth: narrow ? 64 : 76 },
      });
      volumeRef.current?.getPane().setHeight(narrow ? 50 : 60);
      rsiRef.current?.getPane().setHeight(narrow ? 80 : 90);
      if (visibleRange) chart.timeScale().setVisibleLogicalRange(visibleRange);
      trackVisibleRange();
    };
    resizeChartRef.current = resize;
    const observer = new ResizeObserver(() => resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      resizeChartRef.current = null;
      chart.unsubscribeCrosshairMove(selectBar);
      chart.unsubscribeClick(selectBar);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(trackVisibleRange);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      closeRef.current = null;
      closeMarkersRef.current = null;
      closePriceLineRef.current = null;
      markersRef.current = null;
      priceLineRef.current = null;
      smaRefs.current.clear();
      volumeRef.current = null;
      rsiRef.current = null;
      rsiThresholdRefs.current = [];
    };
  }, [timeline.companyId, timeline.currency, timeline.provider, minute, hasCandles]);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = seriesRef.current;
    if (!chart || !candles) return;
    const visible = chart.timeScale().getVisibleLogicalRange();
    // 마지막 시리즈를 제거하면 패널도 사라지므로 아래쪽 패널부터 제거합니다.
    if (rsiRef.current) chart.removeSeries(rsiRef.current);
    if (volumeRef.current) chart.removeSeries(volumeRef.current);
    for (const series of smaRefs.current.values()) chart.removeSeries(series);
    smaRefs.current.clear();
    rsiRef.current = null;
    rsiThresholdRefs.current = [];
    volumeRef.current = null;
    for (const period of settings.sma) {
      smaRefs.current.set(
        period,
        chart.addSeries(
          LineSeries,
          {
            color: smaColors[period],
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: true,
            priceFormat: candles.options().priceFormat,
          },
          0,
        ),
      );
    }
    if (settings.volume) {
      volumeRef.current = chart.addSeries(
        HistogramSeries,
        {
          priceFormat: { type: 'volume' },
          priceLineVisible: false,
          lastValueVisible: false,
          title: '거래량',
        },
        1,
      );
      volumeRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } });
      volumeRef.current.getPane().setStretchFactor(1);
    }
    if (settings.rsi) {
      rsiRef.current = chart.addSeries(
        LineSeries,
        {
          color: themeRef.current === 'dark' ? '#c69bea' : '#8351ad',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          title: `RSI ${settings.rsiPeriod}`,
          priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
          autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
        },
        settings.volume ? 2 : 1,
      );
      const rsi = rsiRef.current;
      rsiThresholdRefs.current = [30, 70].map((price) =>
        rsi.createPriceLine({
          price,
          color: themeRef.current === 'dark' ? '#738087' : '#87979f',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: '',
        }),
      );
      rsiRef.current.getPane().setStretchFactor(1.25);
    }
    candles.getPane().setStretchFactor(4);
    resizeChartRef.current?.();
    if (visible) chart.timeScale().setVisibleLogicalRange(visible);
  }, [settings, timeline.companyId, timeline.currency, timeline.provider, minute, hasCandles]);

  useEffect(() => {
    const dark = theme === 'dark';
    chartRef.current?.applyOptions({
      layout: {
        textColor: dark ? '#aab9bd' : '#4f6268',
        panes: {
          separatorColor: dark ? '#34454b' : '#d6e0df',
          separatorHoverColor: dark ? '#496169' : '#b4c8c5',
        },
      },
      grid: { horzLines: { color: dark ? '#203035' : '#e7eceb' } },
      rightPriceScale: { borderColor: dark ? '#34454b' : '#dbe2e0' },
      timeScale: { borderColor: dark ? '#34454b' : '#dbe2e0' },
    });
    rsiRef.current?.applyOptions({ color: dark ? '#c69bea' : '#8351ad' });
    for (const line of rsiThresholdRefs.current)
      line.applyOptions({ color: dark ? '#738087' : '#87979f' });
  }, [
    theme,
    settings,
    timeline.companyId,
    timeline.currency,
    timeline.provider,
    minute,
    hasCandles,
  ]);

  useEffect(() => {
    if (!settings.rsi || !containerRef.current || !rsiRef.current) {
      setRsiTop(null);
      return;
    }
    const container = containerRef.current;
    let observedPane: HTMLElement | null = null;
    let frame = 0;
    let attempts = 0;
    const measure = () => {
      const pane = rsiRef.current?.getPane().getHTMLElement();
      // The chart creates pane elements on its next paint, after the series is added.
      if (!pane) {
        if (attempts++ < 10) frame = requestAnimationFrame(measure);
        return;
      }
      if (pane !== observedPane) {
        if (observedPane) observer.unobserve(observedPane);
        observer.observe(pane);
        observedPane = pane;
      }
      setRsiTop(
        Math.max(0, pane.getBoundingClientRect().top - container.getBoundingClientRect().top),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    frame = requestAnimationFrame(measure);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [settings, timeline.companyId, timeline.currency, timeline.provider, minute, hasCandles]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    series.setData(chartPriceData(timeline.prices));
    closeRef.current?.setData(
      timeline.prices.map((price) =>
        isNoTradePrice(price)
          ? { time: chartTime(price.time) }
          : { time: chartTime(price.time), value: price.close },
      ),
    );
    if (!fittedRef.current) {
      chart.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [
    timeline.prices,
    timeline.companyId,
    timeline.currency,
    timeline.provider,
    minute,
    hasCandles,
  ]);

  useEffect(() => {
    for (const [period, data] of indicators.sma) smaRefs.current.get(period)?.setData(data);
    volumeRef.current?.setData(indicators.volume);
    rsiRef.current?.setData(indicators.rsi);
  }, [indicators, timeline.companyId, timeline.currency, timeline.provider, minute, hasCandles]);

  useEffect(() => {
    // 날짜만 있는 공시 이벤트는 일봉 차트에 표시하며, 분 단위 시각을 만들어내지 않습니다.
    const markers: Array<SeriesMarker<Time>> = minute
      ? []
      : timeline.markers.map((marker) => ({
          time: marker.time as Time,
          ...markerStyle[marker.kind],
          text: marker.kind[0],
          size: 1.2,
        }));
    markersRef.current?.setMarkers(markers);
    closeMarkersRef.current?.setMarkers(markers);
  }, [
    timeline.markers,
    timeline.companyId,
    timeline.currency,
    timeline.provider,
    minute,
    hasCandles,
  ]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const quote = livePrice?.status === 'LIVE' ? livePrice.quote : null;
    const price = Number(quote?.price);
    if (!quote || quote.currency !== timeline.currency || !Number.isFinite(price) || price <= 0) {
      if (priceLineRef.current) series.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
      if (closePriceLineRef.current) closeRef.current?.removePriceLine(closePriceLineRef.current);
      closePriceLineRef.current = null;
      return;
    }
    const options = {
      price,
      color: '#6f93ff',
      lineWidth: 1 as const,
      lineStyle: 2,
      axisLabelVisible: true,
      title: '현재가',
    };
    if (priceLineRef.current) priceLineRef.current.applyOptions(options);
    else priceLineRef.current = series.createPriceLine(options);
    if (closePriceLineRef.current) closePriceLineRef.current.applyOptions(options);
    else closePriceLineRef.current = closeRef.current?.createPriceLine(options) ?? null;
  }, [livePrice, timeline.companyId, timeline.currency, timeline.provider, minute, hasCandles]);

  useEffect(() => {
    seriesRef.current?.applyOptions({ visible: chartType === 'candle' });
    closeRef.current?.applyOptions({ visible: chartType === 'line' });
  }, [chartType, timeline.companyId, timeline.currency, timeline.provider, minute, hasCandles]);
  useEffect(() => {
    resizeChartRef.current?.();
  }, [expanded]);
  function selectWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    // Focused overflow rows keep native keyboard scrolling; the outer legend selects candles.
    if (event.target !== event.currentTarget) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'End' || event.key === 'Escape') {
      setSelectedKey(null);
      return;
    }
    const index =
      event.key === 'Home'
        ? 0
        : Math.max(
            0,
            Math.min(
              timeline.prices.length - 1,
              selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1),
            ),
          );
    const price = timeline.prices[index];
    if (price) setSelectedKey(timeKey(chartTime(price.time)));
  }

  function showLatest() {
    setSelectedKey(null);
    const scale = chartRef.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();
    if (scale && range) {
      const last = latestIndexRef.current;
      scale.setVisibleLogicalRange({
        from: Math.max(0, last - (range.to - range.from)),
        to: last,
      });
    }
  }

  return {
    containerRef,
    selected,
    selectionIsLatest: selectedKey === null,
    latestVisible,
    selectedIndicators: {
      sma: new Map(
        settings.sma.map((period) => [
          period,
          selectedTime === null ? undefined : indicatorValues.sma.get(period)?.get(selectedTime),
        ]),
      ),
      rsi: selectedTime === null ? undefined : indicatorValues.rsi.get(selectedTime),
    },
    rsiTop,
    selectWithKeyboard,
    showLatest,
    fitContent: () => chartRef.current?.timeScale().fitContent(),
  };
}
