import { WatchlistNewsWorkspace } from '../components/watchlist-news-workspace';
import { ObservationDisclaimer } from '../components/disclaimer';

export function WatchlistPage() {
  return (
    <div className="page-stack">
      <WatchlistNewsWorkspace />
      <ObservationDisclaimer compact />
    </div>
  );
}
