import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WatchlistNewsWorkspace } from './watchlist-news-workspace';

vi.mock('./watchlist-groups-panel', () => ({
  WatchlistGroupsPanel: ({ compact }: { compact: boolean }) => (
    <div aria-label="관심 그룹과 소식 전환">{compact ? <button>최근조회</button> : null}</div>
  ),
}));
afterEach(cleanup);
it('uses one my-stocks workspace and includes recent browsing only on the dashboard', () => {
  const view = render(<WatchlistNewsWorkspace compact />);
  const workspace = screen.getByRole('region', { name: '내 종목' });
  expect(workspace.children).toHaveLength(1);
  expect(screen.getByRole('button', { name: '최근조회' })).toBeVisible();
  expect(workspace.style.getPropertyValue('--watch-card-height')).toBe('');
  view.rerender(<WatchlistNewsWorkspace />);
  expect(screen.queryByRole('button', { name: '최근조회' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('관심 그룹과 소식 전환')).toBeVisible();
});
