import type { MarketHistory } from '../types';
import './market-sparkline.css';

export function sparklineGeometry(points: MarketHistory['points']) {
  const rows = [
    ...new Map(
      points
        .filter((p) => p.value.trim() && Number.isFinite(Number(p.value)))
        .map((p) => [p.date, p]),
    ).values(),
  ].sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return null;
  const values = rows.map((p) => Number(p.value));
  const low = Math.min(...values),
    high = Math.max(...values);
  const first = Date.parse(rows[0]!.date),
    last = Date.parse(rows.at(-1)!.date);
  if (!Number.isFinite(first) || last <= first) return null;
  const coordinates = rows.map(
    (p, i) =>
      `${(4 + ((Date.parse(p.date) - first) / (last - first)) * 192).toFixed(2)},${(high === low ? 25 : 44 - ((values[i]! - low) / (high - low)) * 38).toFixed(2)}`,
  );
  return {
    line: `M${coordinates.join(' L')}`,
    area: `M4,50 L${coordinates.join(' L')} L196,50 Z`,
    rows,
    direction: values.at(-1)! > values[0]! ? 'up' : values.at(-1)! < values[0]! ? 'down' : 'flat',
  };
}

export function MarketSparkline({ history, name }: { history?: MarketHistory; name: string }) {
  const geometry = sparklineGeometry(history?.points ?? []);
  return (
    <div
      className="market-sparkline"
      data-direction={geometry?.direction}
      data-status={history?.status}
    >
      {geometry ? (
        <svg
          viewBox="0 0 200 52"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${name} 최근 1개월 추이 · ${geometry.rows[0]!.date}부터 ${geometry.rows.at(-1)!.date}까지 ${geometry.rows.length}개 관측값`}
        >
          <path d={geometry.area} fill="currentColor" opacity="0.07" />
          <path
            d={geometry.line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <span>{history?.status === 'NOT_CONFIGURED' ? '이력 연결 대기' : '수집된 이력 부족'}</span>
      )}
      {history?.status === 'STALE' && geometry ? <small>마지막 수집 이력</small> : null}
    </div>
  );
}
