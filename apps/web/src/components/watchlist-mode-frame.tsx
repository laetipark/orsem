import type { ReactNode } from 'react';
import './watchlist-mode-frame.css';

export function WatchlistModeFrame({
  compact,
  showNews,
  stocks,
  news,
  newsKey,
}: {
  compact: boolean;
  showNews: boolean;
  stocks: ReactNode;
  news: ReactNode;
  newsKey: string;
}) {
  if (!compact) return showNews ? news : stocks;
  return (
    <div className={`watch-groups__mode-frame${showNews ? ' is-news' : ''}`}>
      <div className="watch-groups__stock-layer" inert={showNews} aria-hidden={showNews}>
        {stocks}
      </div>
      {showNews ? (
        <div className="watch-groups__news-layer" key={newsKey}>
          {news}
        </div>
      ) : null}
    </div>
  );
}
