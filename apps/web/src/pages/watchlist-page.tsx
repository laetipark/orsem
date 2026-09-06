import { WatchlistNewsWorkspace } from '../components/watchlist-news-workspace';
import { MarketSelection } from '../components/market-selection';
import { ObservationDisclaimer } from '../components/disclaimer';

export function WatchlistPage() {
  return (
    <div className="page-stack">
      <WatchlistNewsWorkspace />
      <MarketSelection />
      <ObservationDisclaimer compact />
    </div>
  );
}
