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
  chartTime,
  chartTimeLabel,
  hasChartCandles,
  isNoTradePrice,
} from '../lib/chart-prices';
import { smaSeries, rsiSeries, volumeSeries } from '../lib/chart-indicators';
import {
  defaultChartSettings,
  loadChartSettings,
  indicatorStorageKey,
  smaPeriods,
  rsiPeriods,
} from '../lib/chart-settings';
import './company-chart.css';

const markerStyle = {
  TRADE: { color: '#28b9a6', shape: 'arrowUp' as const, position: 'belowBar' as const },
  FILING: { color: '#f39a45', shape: 'circle' as const, position: 'aboveBar' as const },
  NEWS: { color: '#6f93ff', shape: 'square' as const, position: 'aboveBar' as const },
};
const smaColors: Record<number, string> = {
  5: '#c57c23',
  20: '#6289e9',
  60: '#b477ce',
  120: '#429986',
};
const timeKey = (time: Time) => (typeof time === 'object' ? chartTimeLabel(time) : String(time));

export function CompanyChart({
  timeline,
  livePrice,
}: {
  timeline: CompanyTimeline;
  livePrice?: CompanyLivePrice | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const smaRefs = useRef(new Map<number, ISeriesApi<'Line'>>());
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const rsiRef = useRef<ISeriesApi<'Line'> | null>(null);
  const fittedRef = useRef(false);
  const [settings, setSettings] = useState(loadChartSettings);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { theme } = useTheme();
  const hasCandles = hasChartCandles(timeline.prices);
  const minute = timeline.interval === '1m';
  const indicators = useMemo(
    () => ({
      sma: new Map(settings.sma.map((period) => [period, smaSeries(timeline.prices, period)])),
      volume: volumeSeries(timeline.prices, {
        up: '#28b9a680',
        down: '#d76d5d80',
        unchanged: '#89979a80',
      }),
      rsi: settings.rsi ? rsiSeries(timeline.prices, settings.rsiPeriod) : [],
    }),
    [timeline.prices, settings],
  );
  const priceIndex = useMemo(
    () => new Map(timeline.prices.map((price, index) => [timeKey(chartTime(price.time)), index])),
    [timeline.prices],
  );
  const selectedIndex =
    selectedKey === null
      ? timeline.prices.length - 1
      : (priceIndex.get(selectedKey) ?? timeline.prices.length - 1);
  const selected = timeline.prices[selectedIndex];
  const noTrades = selected ? isNoTradePrice(selected) : false;
  const formatPrice = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value)
      ? '—'
      : new Intl.NumberFormat('ko-KR', {
          minimumFractionDigits: timeline.currency === 'USD' ? 2 : 0,
          maximumFractionDigits: timeline.currency === 'USD' ? 4 : 0,
        }).format(value);
  const indicatorValue = (rows: Array<{ time: Time; value?: number }> | undefined) =>
    selected
      ? rows?.find((row) => timeKey(row.time) === timeKey(chartTime(selected.time)))?.value
      : undefined;

  useEffect(() => {
    try {
      localStorage.setItem(indicatorStorageKey, JSON.stringify(settings));
    } catch {
      /* 저장소가 비활성화되어도 차트 설정은 메모리에서 계속 동작합니다. */
    }
  }, [settings]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasCandles) return;
    const dark = theme === 'dark';
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientWidth < 640 ? 440 : 530,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: dark ? '#aab9bd' : '#4f6268',
        fontSize: 12,
        attributionLogo: false,
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
        minimumWidth: 76,
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
      priceFormat:
        timeline.currency === 'USD'
          ? {
              type: 'custom',
              minMove: 0.0001,
              formatter: (value: number) =>
                new Intl.NumberFormat('ko-KR', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 4,
                }).format(value),
            }
          : {
              type: 'custom',
              minMove: 1,
              formatter: (value: number) =>
                new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(value),
            },
    });
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
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.width < 640 ? 440 : 530,
        });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(selectBar);
      chart.unsubscribeClick(selectBar);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      priceLineRef.current = null;
      smaRefs.current.clear();
      volumeRef.current = null;
      rsiRef.current = null;
    };
  }, [theme, timeline.companyId, timeline.currency, timeline.provider, minute, hasCandles]);

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
          color: theme === 'dark' ? '#c69bea' : '#8351ad',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          title: `RSI ${settings.rsiPeriod}`,
          priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
          autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
        },
        settings.volume ? 2 : 1,
      );
      for (const price of [30, 70])
        rsiRef.current.createPriceLine({
          price,
          color: theme === 'dark' ? '#738087' : '#87979f',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: '',
        });
      rsiRef.current.getPane().setStretchFactor(1.25);
    }
    candles.getPane().setStretchFactor(4);
    if (visible) chart.timeScale().setVisibleLogicalRange(visible);
  }, [
    settings,
    theme,
    timeline.companyId,
    timeline.currency,
    timeline.provider,
    minute,
    hasCandles,
  ]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    series.setData(chartPriceData(timeline.prices));
    for (const [period, data] of indicators.sma) smaRefs.current.get(period)?.setData(data);
    volumeRef.current?.setData(indicators.volume);
    rsiRef.current?.setData(indicators.rsi);
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
    if (!fittedRef.current) {
      chart.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [timeline, indicators, minute, hasCandles, theme]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const quote = livePrice?.status === 'LIVE' ? livePrice.quote : null;
    const price = Number(quote?.price);
    if (!quote || quote.currency !== timeline.currency || !Number.isFinite(price) || price <= 0) {
      if (priceLineRef.current) series.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
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
  }, [
    livePrice,
    theme,
    timeline.companyId,
    timeline.currency,
    timeline.provider,
    minute,
    hasCandles,
  ]);

  function selectWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
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

  return (
    <section className="chart-workspace" aria-label="차트와 보조지표">
      <div className="indicator-toolbar">
        <details className="indicator-settings">
          <summary>
            지표 설정{' '}
            <span>
              {settings.sma.length + Number(settings.volume) + Number(settings.rsi)}개 사용
            </span>
          </summary>
          <div className="indicator-settings__body">
            <fieldset>
              <legend>이동평균선 · SMA</legend>
              <div className="indicator-options">
                {smaPeriods.map((period) => (
                  <label key={period}>
                    <input
                      type="checkbox"
                      checked={settings.sma.includes(period)}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          sma: event.target.checked
                            ? [...current.sma, period].sort((a, b) => a - b)
                            : current.sma.filter((value) => value !== period),
                        }))
                      }
                    />
                    <i style={{ background: smaColors[period] }} />
                    {period}봉
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>보조 패널</legend>
              <div className="indicator-options">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.volume}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, volume: event.target.checked }))
                    }
                  />
                  거래량
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.rsi}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, rsi: event.target.checked }))
                    }
                  />
                  RSI
                </label>
                <label className="rsi-period">
                  기간
                  <select
                    aria-label="RSI 계산 기간"
                    value={settings.rsiPeriod}
                    disabled={!settings.rsi}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        rsiPeriod: Number(event.target.value),
                      }))
                    }
                  >
                    {rsiPeriods.map((period) => (
                      <option key={period} value={period}>
                        {period}봉
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </fieldset>
            <div className="indicator-settings__footer">
              <small>설정은 이 브라우저에 저장됩니다.</small>
              <button type="button" onClick={() => setSettings(defaultChartSettings())}>
                기본값 복원
              </button>
            </div>
          </div>
        </details>
        <button
          type="button"
          className="chart-fit-button"
          onClick={() => chartRef.current?.timeScale().fitContent()}
        >
          차트 맞춤
        </button>
      </div>
      <div
        className="candle-legend"
        role="group"
        aria-label="봉별 가격과 지표 범례"
        tabIndex={0}
        onKeyDown={selectWithKeyboard}
      >
        <div className="candle-legend__heading">
          <strong>
            {selected ? chartTimeLabel(chartTime(selected.time)) : '—'}
            {minute ? ' KST' : ''}
          </strong>
          <span className="candle-selection">
            {selectedKey === null ? '최신 봉' : '선택한 봉'}
            {noTrades ? ' · 거래 없음' : ''}
          </span>
          <span className="candle-currency">
            {timeline.currency === 'USD' ? '미국 달러 (USD)' : '원 (KRW)'}
          </span>
          <button
            type="button"
            onClick={() => setSelectedKey(null)}
            disabled={selectedKey === null}
          >
            최신 봉 보기
          </button>
        </div>
        <dl className="candle-values">
          {(
            [
              ['시가', selected?.open],
              ['고가', selected?.high],
              ['저가', selected?.low],
              ['종가', selected?.close],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={formatPrice(noTrades && label !== '종가' ? undefined : value)}>
                {formatPrice(noTrades && label !== '종가' ? undefined : value)}
              </dd>
            </div>
          ))}
          <div>
            <dt>거래량 (주)</dt>
            <dd
              title={
                selected
                  ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 }).format(
                      selected.volume,
                    )
                  : '—'
              }
            >
              {selected
                ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 }).format(
                    selected.volume,
                  )
                : '—'}
            </dd>
          </div>
        </dl>
        <div className="indicator-legend">
          {settings.sma.map((period) => (
            <span key={period}>
              <i style={{ background: smaColors[period] }} />
              <span className="indicator-legend__name">SMA {period}</span>
              <strong title={formatPrice(indicatorValue(indicators.sma.get(period)))}>
                {formatPrice(indicatorValue(indicators.sma.get(period)))}
              </strong>
            </span>
          ))}
          {settings.rsi ? (
            <span>
              <i className="rsi-swatch" />
              <span className="indicator-legend__name">RSI {settings.rsiPeriod}</span>
              <strong title={indicatorValue(indicators.rsi)?.toFixed(2) ?? '—'}>
                {indicatorValue(indicators.rsi)?.toFixed(2) ?? '—'}
              </strong>
            </span>
          ) : null}
          <small>봉 위에 마우스를 올리거나 범례에서 ← → 키로 확인</small>
        </div>
      </div>
      <div
        className="company-chart"
        ref={containerRef}
        aria-label={minute ? '기업 1분봉 차트, 한국 시간' : '기업 일봉과 공시 이벤트 차트'}
      />
      <p className="indicator-note">
        {settings.volume ? '아래 막대: 거래량. ' : ''}
        {settings.rsi
          ? `RSI(${settings.rsiPeriod})는 0–100 범위이며 점선은 30·70 기준입니다. `
          : ''}
        지표는 조회된 봉으로 계산하며, 계산에 필요한 봉이 부족하면 —로 표시합니다.
      </p>
    </section>
  );
}
