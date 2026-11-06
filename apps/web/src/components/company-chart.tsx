import { useEffect, useState, type ReactNode } from 'react';
import { useMediaQuery } from '../lib/use-media-query';
import type { CompanyLivePrice, CompanyTimeline } from '../types';
import {
  chartPriceFormatter,
  chartTime,
  chartTimeLabel,
  isNoTradePrice,
} from '../lib/chart-prices';
import { loadChartSettings, indicatorStorageKey, smaColors } from '../lib/chart-settings';
import { useCompanyChart, type CompanyChartType } from '../lib/use-company-chart';
import { CompanyChartControls } from './company-chart-controls';
import './company-chart.css';

const volumeFormatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 });

export function CompanyChart({
  timeline,
  livePrice,
  toolbar,
  expanded = false,
  onExpand,
}: {
  expanded?: boolean;
  onExpand?: () => void;
  toolbar?: ReactNode;
  timeline: CompanyTimeline;
  livePrice?: CompanyLivePrice | null;
}) {
  const [chartType, setChartType] = useState<CompanyChartType>('candle');
  const [settings, setSettings] = useState(loadChartSettings);
  const compact = useMediaQuery('(max-width: 620px)');
  const minute = timeline.interval === '1m';

  useEffect(() => {
    try {
      localStorage.setItem(indicatorStorageKey, JSON.stringify(settings));
    } catch {
      /* 저장소가 비활성화되어도 차트 설정은 메모리에서 계속 동작합니다. */
    }
  }, [settings]);

  const {
    containerRef,
    selected,
    selectionIsLatest,
    latestVisible,
    selectedIndicators,
    rsiTop,
    selectWithKeyboard,
    showLatest,
    fitContent,
  } = useCompanyChart({ timeline, livePrice, settings, chartType, expanded });
  const noTrades = selected ? isNoTradePrice(selected) : false;
  const formatPrice = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value)
      ? '—'
      : chartPriceFormatter(timeline.currency).format(value);

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
      <dd>{selected ? volumeFormatter.format(selected.volume) : '—'}</dd>
    </dl>
  );

  return (
    <section className="chart-workspace" aria-label="차트와 보조지표">
      <CompanyChartControls
        toolbar={toolbar}
        chartType={chartType}
        onChartTypeChange={setChartType}
        settings={settings}
        setSettings={setSettings}
        compact={compact}
        minute={minute}
        expanded={expanded}
        onExpand={onExpand}
        latestDisabled={selectionIsLatest && latestVisible}
        onShowLatest={showLatest}
        onFitContent={fitContent}
      />
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
              {selectionIsLatest ? '최신 봉' : '선택한 봉'}
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
              <strong>{formatPrice(selectedIndicators.sma.get(period))}</strong>
            </span>
          ))}
          {!settings.sma.length ? <span>이동평균 표시 꺼짐</span> : null}
          {settings.rsi ? (
            <span>
              <span>RSI ({settings.rsiPeriod})</span>
              <strong>{selectedIndicators.rsi?.toFixed(2) ?? '—'}</strong>
            </span>
          ) : null}
        </div>
      </div>
      {selected &&
      (settings.sma.some((period) => selectedIndicators.sma.get(period) === undefined) ||
        (settings.rsi && selectedIndicators.rsi === undefined)) ? (
        <p className="chart-indicator-status" role="status">
          선택한 봉의 일부 지표는 계산에 필요한 연속 데이터가 부족합니다.
        </p>
      ) : null}
      <div className="chart-plot-wrap">
        <div
          className="company-chart"
          ref={containerRef}
          aria-label={minute ? '기업 1분봉 차트, 한국 시간' : '기업 일봉과 공시 이벤트 차트'}
        />
        {settings.rsi && rsiTop !== null ? (
          <div className="rsi-pane-legend" style={{ top: rsiTop + 5 }}>
            <span>RSI ({settings.rsiPeriod})</span>
            <strong>{selectedIndicators.rsi?.toFixed(2) ?? '—'}</strong>
          </div>
        ) : null}
      </div>
    </section>
  );
}
