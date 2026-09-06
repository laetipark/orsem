import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ColorType,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type MouseEventParams,
} from 'lightweight-charts';
import { useTheme } from '../theme';
import { formatDate } from '../lib/format';
import { marketAmount } from '../lib/market-format';
import './market-chart.css';

export function MarketChart({
  points,
  name,
  unit,
  currency,
  rangeKey,
}: {
  points: Array<{ date: string; value: string }>;
  name: string;
  unit: string;
  currency?: string | null;
  rangeKey?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const fittedIdentity = useRef<string | null>(null);
  const [showData, setShowData] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const { theme } = useTheme();
  const visiblePoints = useMemo(
    () =>
      [
        ...new Map(
          points
            .filter((point) => point.value !== '' && Number.isFinite(Number(point.value)))
            .map((point) => [point.date, point]),
        ).values(),
      ].sort((left, right) => left.date.localeCompare(right.date)),
    [points],
  );
  const hasPoints = visiblePoints.length > 0;
  const selected =
    visiblePoints.find((point) => point.date === selectedDate) ?? visiblePoints.at(-1);

  useEffect(() => {
    if (!container.current || !hasPoints) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        fontFamily: 'inherit',
      },
      grid: { vertLines: { visible: false } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addSeries(LineSeries, {
      color: '#28b9a6',
      lineWidth: 2,
      priceLineVisible: false,
    });
    const selectPoint = (event: MouseEventParams<Time>) => {
      if (event.time === undefined) return;
      const time = event.time;
      setSelectedDate(
        typeof time === 'object'
          ? `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`
          : String(time),
      );
    };
    chart.subscribeCrosshairMove(selectPoint);
    chart.subscribeClick(selectPoint);
    return () => {
      chart.unsubscribeCrosshairMove(selectPoint);
      chart.unsubscribeClick(selectPoint);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      fittedIdentity.current = null;
    };
  }, [hasPoints]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { textColor: theme === 'dark' ? '#acbabc' : '#4e6368' },
      grid: { horzLines: { color: theme === 'dark' ? '#26363a' : '#e7eeec' } },
      localization: {
        locale: 'ko-KR',
        priceFormatter: (price: number) => marketAmount(String(price), currency),
      },
    });
  }, [theme, currency, hasPoints]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const identity = JSON.stringify([name, unit, currency, rangeKey]);
    const range = chart.timeScale().getVisibleLogicalRange();
    series.setData(
      visiblePoints.map((point) => ({ time: point.date as Time, value: Number(point.value) })),
    );
    if (fittedIdentity.current !== identity) {
      chart.timeScale().fitContent();
      fittedIdentity.current = identity;
    } else if (range) {
      chart.timeScale().setVisibleLogicalRange(range);
    }
  }, [visiblePoints, name, unit, currency, rangeKey, hasPoints]);
  return (
    <figure className="market-chart">
      {selected ? (
        <div className="market-chart__readout">
          <label>
            기준일
            <select
              aria-label="시장 지표 기준일"
              value={selected.date}
              onChange={(event) => setSelectedDate(event.target.value)}
            >
              {[...visiblePoints].reverse().map((point) => (
                <option key={point.date} value={point.date}>
                  {formatDate(point.date)}
                </option>
              ))}
            </select>
          </label>
          <strong>
            {marketAmount(selected.value, currency)} <small>{unit}</small>
          </strong>
        </div>
      ) : null}
      <div
        ref={container}
        className="market-chart__canvas"
        role="img"
        aria-label={`${name} ${visiblePoints.length}개 관측값 추이, 단위 ${unit}`}
      />
      <figcaption>
        {visiblePoints.length
          ? `${formatDate(visiblePoints[0]!.date)} – ${formatDate(visiblePoints.at(-1)!.date)} · ${visiblePoints.length}개 관측값 · ${unit}`
          : '수집된 이력이 없습니다.'}
      </figcaption>
      <details
        className="market-chart__data"
        onToggle={(event) => setShowData(event.currentTarget.open)}
      >
        <summary>차트 데이터 보기</summary>
        {showData ? (
          <div>
            <table>
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>{unit}</th>
                </tr>
              </thead>
              <tbody>
                {[...visiblePoints].reverse().map((point) => (
                  <tr key={point.date}>
                    <td>{formatDate(point.date)}</td>
                    <td>{marketAmount(point.value, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </details>
    </figure>
  );
}
