import { lazy, Suspense, type ComponentProps } from 'react';
import { LoadingState } from './ui';
import './market-chart.css';

const Chart = lazy(() =>
  import('./market-chart').then((module) => ({ default: module.MarketChart })),
);

/** Load the chart engine only when a detail view has observations to display. */
export function MarketChart(props: ComponentProps<typeof Chart>) {
  return (
    <Suspense
      fallback={
        <div className="market-chart-loading">
          <LoadingState label="차트를 불러오는 중입니다." />
        </div>
      }
    >
      <Chart {...props} />
    </Suspense>
  );
}
