import { useLayoutEffect, useRef } from 'react';
import { WatchlistGroupsPanel } from './watchlist-groups-panel';
import { DashboardNews } from './market-news';
import { PersonalNews } from './personal-news';

export function WatchlistNewsWorkspace({ compact = false }: { compact?: boolean }) {
  const workspace = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = workspace.current;
    const watchCard = element?.querySelector<HTMLElement>('.watch-groups');
    if (!element || !watchCard) return;
    const measure = () => {
      const height = watchCard.getBoundingClientRect().height;
      if (height > 0 && Number.isFinite(height)) {
        const next = `${height}px`;
        if (element.style.getPropertyValue('--watch-card-height') !== next)
          element.style.setProperty('--watch-card-height', next);
      } else {
        element.style.removeProperty('--watch-card-height');
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(watchCard, { box: 'border-box' });
    if (!observer) window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      element.style.removeProperty('--watch-card-height');
    };
  }, [compact]);
  return (
    <section
      ref={workspace}
      className={`watchlist-news-workspace${compact ? ' watchlist-news-workspace--dashboard' : ''}`}
      aria-label="관심 그룹과 소식"
    >
      {compact ? <DashboardNews /> : null}
      <WatchlistGroupsPanel compact={compact} />
      <PersonalNews />
    </section>
  );
}
