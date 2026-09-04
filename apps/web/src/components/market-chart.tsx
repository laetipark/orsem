import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, createChart, type Time } from 'lightweight-charts';
import { useTheme } from '../theme';
import { formatDate } from '../lib/format';
import { marketAmount } from '../lib/market-format';

export function MarketChart({
  points,
  name,
  unit,
  currency,
}: {
  points: Array<{ date: string; value: string }>;
  name: string;
  unit: string;
  currency?: string | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  useEffect(() => {
    if (!container.current || !points.length) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: theme === 'dark' ? '#acbabc' : '#4e6368',
        fontFamily: 'inherit',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: theme === 'dark' ? '#26363a' : '#e7eeec' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false },
      localization: {
        locale: 'ko-KR',
        priceFormatter: (price: number) => marketAmount(String(price), currency),
      },
    });
    const series = chart.addSeries(LineSeries, {
      color: '#28b9a6',
      lineWidth: 2,
      priceLineVisible: false,
    });
    const unique = new Map(
      points
        .filter((p) => p.value !== '' && Number.isFinite(Number(p.value)))
        .map((p) => [p.date, p]),
    );
    series.setData(
      [...unique.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((point) => ({ time: point.date as Time, value: Number(point.value) })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, theme, currency]);
  return (
    <figure className="market-chart">
      <div
        ref={container}
        className="market-chart__canvas"
        role="img"
        aria-label={`${name} ${points.length}개 관측값 추이, 단위 ${unit}`}
      />
      <figcaption>
        {points.length
          ? `${formatDate(points[0]!.date)} – ${formatDate(points.at(-1)!.date)} · ${points.length}개 관측값 · ${unit}`
          : '수집된 이력이 없습니다.'}
      </figcaption>
      <details className="market-chart__data">
        <summary>차트 데이터 보기</summary>
        <div>
          <table>
            <thead>
              <tr>
                <th>날짜</th>
                <th>{unit}</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((point) => (
                <tr key={point.date}>
                  <td>{formatDate(point.date)}</td>
                  <td>{marketAmount(point.value, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
