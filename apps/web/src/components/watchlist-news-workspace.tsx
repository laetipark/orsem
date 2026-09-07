import { WatchlistGroupsPanel } from './watchlist-groups-panel';

export function WatchlistNewsWorkspace({ compact = false }: { compact?: boolean }) {
  return (
    <section className="watchlist-news-workspace" aria-label="내 종목">
      <WatchlistGroupsPanel compact={compact} />
    </section>
  );
}
