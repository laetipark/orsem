import { useQuery } from '@tanstack/react-query';
import { marketGroupItems, marketGroups } from '../lib/market-display';
import { marketOverviewQuery } from '../lib/market-query';
import type { Region } from '../types';
import { ErrorState, LoadingState } from './ui';
import { MarketCard } from './market-card';
import { DashboardGlobalMarkets } from './dashboard-global-markets';
import './market-overview.css';

export function MarketOverview({
  region = 'all',
  dashboard = false,
  dashboardRegion,
}: {
  region?: Region;
  dashboard?: boolean;
  dashboardRegion?: 'kr' | 'us';
}) {
  const markets = useQuery({
    ...marketOverviewQuery(region),
    staleTime: 30_000,
  });
  if (markets.isPending) return <LoadingState label="시장 지표를 불러오는 중입니다." />;
  if (markets.isError)
    return <ErrorState message={markets.error.message} onRetry={() => void markets.refetch()} />;
  const globalItems = markets.data.items.filter((item) => item.region === 'global');
  return (
    <section
      className={`market-overview ${dashboard ? 'market-overview--dashboard' : 'market-overview--page'} ${region !== 'all' ? 'market-overview--filtered' : ''}`}
      aria-label="시장 요약"
    >
      {marketGroups.map((group) => {
        if (dashboard && group.region === 'global') return null;
        if (dashboardRegion && group.region !== 'global' && group.region !== dashboardRegion)
          return null;
        const items = marketGroupItems(markets.data.items, group);
        if (!items.length) return null;
        return (
          <section
            key={group.key}
            className={`market-group market-group--${group.key}${group.region === 'global' ? ' market-group--global' : ''}`}
            aria-label={`${group.label} 시장`}
          >
            {!dashboard ? (
              <div className="market-group__heading">
                <div>
                  <span>{group.english}</span>
                  <h2>{group.label}</h2>
                </div>
                <p>{group.description}</p>
              </div>
            ) : null}
            <div className="market-group__cards">
              {items.map((item) => (
                <MarketCard
                  key={item.id}
                  item={item}
                  history={markets.data.histories?.[item.id]}
                  compact={dashboard}
                />
              ))}
            </div>
          </section>
        );
      })}
      {dashboard && globalItems.length ? (
        <DashboardGlobalMarkets items={globalItems} histories={markets.data.histories} />
      ) : null}
      {!markets.data.items.length ? <p>이 지역에 표시할 시장 지표가 없습니다.</p> : null}
    </section>
  );
}
