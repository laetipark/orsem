import { Maximize } from 'lucide-react';
import { HelpPopover } from './help-popover';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
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
import { useMediaQuery } from '../lib/use-media-query';
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
  toolbar,
}: {
  toolbar?: ReactNode;
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
  const compact = useMediaQuery('(max-width: 620px)');
  const sizingRef = useRef(settings);
  sizingRef.current = settings;
  const resizeChartRef = useRef<(() => void) | null>(null);
  const [rsiTop, setRsiTop] = useState<number | null>(null);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const settingsPanelId = useId();
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
      height:
        container.clientWidth < 640
          ? sizingRef.current.rsi
            ? 400
            : 320
          : sizingRef.current.rsi
            ? 480
            : 420,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: dark ? '#aab9bd' : '#4f6268',
        fontSize: container.clientWidth < 640 ? 11 : 12,
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
    const resize = () => {
      const width = container.clientWidth,
        narrow = width < 640,
        setting = sizingRef.current;
      const height = narrow ? (setting.rsi ? 400 : 320) : setting.rsi ? 480 : 420;
      chart.applyOptions({
        width,
        height,
        layout: { fontSize: narrow ? 11 : 12 },
        rightPriceScale: { minimumWidth: narrow ? 64 : 76 },
      });
      volumeRef.current?.getPane().setHeight(narrow ? 50 : 60);
      rsiRef.current?.getPane().setHeight(narrow ? 80 : 90);
    };
    resizeChartRef.current = resize;
    const observer = new ResizeObserver(() => resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      resizeChartRef.current = null;
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
    resizeChartRef.current?.();
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

  const candleValues = (
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
          <dd>{formatPrice(noTrades && label !== '종가' ? undefined : value)}</dd>
        </div>
      ))}
    </dl>
  );
  const candleVolume = (
    <dl className="candle-volume">
      <dt>거래량 (주)</dt>
      <dd>
        {selected
          ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 }).format(selected.volume)
          : '—'}
      </dd>
    </dl>
  );

  return (
    <section className="chart-workspace" aria-label="차트와 보조지표">
      <div className="indicator-toolbar">
        {toolbar ? <div className="chart-primary-controls">{toolbar}</div> : null}
        <button
          type="button"
          className="chart-latest-button"
          aria-label="최신 봉 보기"
          disabled={selectedKey === null}
          onClick={() => setSelectedKey(null)}
        >
          최신 봉
        </button>
        <button
          type="button"
          className="indicator-settings-toggle"
          aria-expanded={settingsExpanded}
          aria-controls={settingsPanelId}
          onClick={() => setSettingsExpanded(!settingsExpanded)}
        >
          보조지표{' '}
          <span>{settings.sma.length + Number(settings.volume) + Number(settings.rsi)}개 사용</span>
        </button>
        <button
          type="button"
          className="chart-fit-button"
          aria-label="화면 맞춤"
          title="화면 맞춤"
          onClick={() => chartRef.current?.timeScale().fitContent()}
        >
          <Maximize size={16} aria-hidden="true" />
          <span>화면 맞춤</span>
        </button>
        <HelpPopover label="차트 조작·지표 안내">
          <p>
            {compact
              ? '터치로 봉 선택 · 두 손가락으로 확대'
              : '드래그로 이동 · 마우스 휠로 확대 · 범례에서 ← → 키로 봉 선택'}
          </p>
          <p className="indicator-note">
            {settings.volume ? '아래 막대: 거래량. ' : ''}
            {settings.rsi
              ? `RSI(${settings.rsiPeriod})는 0–100 범위이며 점선은 30·70 기준입니다. `
              : ''}
            조회 기간의 데이터가 부족한 지표는 —로 표시합니다.
          </p>
          <p>
            {minute
              ? '1분봉은 한국 시간(KST)으로 표시합니다. '
              : 'T 거래·변동일 · F 공시일 · N 뉴스·IR. 거래·변동일과 공시 발표일은 구분합니다. '}
            현재가와 차트는 2초마다 갱신하며 장중 가격은 바뀔 수 있습니다.
          </p>
        </HelpPopover>
        {settingsExpanded ? (
          <div className="indicator-settings__body" id={settingsPanelId}>
            <fieldset>
              <legend>이동평균선</legend>
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
                    {period}
                    {minute ? '분선' : '일선'}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>거래량·기술적 지표</legend>
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
                    aria-label="RSI"
                    checked={settings.rsi}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, rsi: event.target.checked }))
                    }
                  />
                  RSI (상대강도지수)
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
        ) : null}
      </div>
      <div
        className="candle-legend"
        role="group"
        aria-label="봉별 가격과 지표 범례"
        tabIndex={0}
        onKeyDown={selectWithKeyboard}
      >
        <div
          className="candle-legend__main legend-scroll"
          role="group"
          aria-label={compact ? '선택 시각과 거래량' : '선택 시각과 가격·거래량'}
          tabIndex={0}
        >
          <div className="candle-context">
            <strong className="candle-time">
              {selected ? chartTimeLabel(chartTime(selected.time)) : '—'}
              {minute ? ' KST' : ''}
            </strong>
            <span className="candle-selection">
              {selectedKey === null ? '최신 봉' : '선택한 봉'}
              {noTrades ? ' · 거래 없음' : ''}
            </span>
            <span className="candle-currency">{timeline.currency === 'USD' ? 'USD' : 'KRW'}</span>
          </div>
          {!compact ? candleValues : null}
          {candleVolume}
        </div>
        {compact ? (
          <div
            className="candle-price-row legend-scroll"
            role="group"
            aria-label="시가·고가·저가·종가"
            tabIndex={0}
          >
            {candleValues}
          </div>
        ) : null}
        <div
          className="indicator-legend legend-scroll"
          role="group"
          aria-label="이동평균 값"
          tabIndex={0}
        >
          {settings.sma.map((period) => (
            <span key={period}>
              <i style={{ background: smaColors[period] }} />
              <span className="indicator-legend__name">
                {period}
                {minute ? '분선' : '일선'}
              </span>
              <strong>{formatPrice(indicatorValue(indicators.sma.get(period)))}</strong>
            </span>
          ))}
          {!settings.sma.length ? <span>이동평균 표시 꺼짐</span> : null}
        </div>
      </div>
      <div className="chart-plot-wrap">
        <div
          className="company-chart"
          ref={containerRef}
          aria-label={minute ? '기업 1분봉 차트, 한국 시간' : '기업 일봉과 공시 이벤트 차트'}
        />
        {settings.rsi && rsiTop !== null ? (
          <div className="rsi-pane-legend" style={{ top: rsiTop + 5 }}>
            <span>RSI ({settings.rsiPeriod})</span>
            <strong>{indicatorValue(indicators.rsi)?.toFixed(2) ?? '—'}</strong>
          </div>
        ) : null}
      </div>
    </section>
  );
}
