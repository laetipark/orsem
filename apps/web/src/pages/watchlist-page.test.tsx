import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WatchlistPage } from './watchlist-page';

vi.mock('../components/watchlist-news-workspace', () => ({
  WatchlistNewsWorkspace: ({ compact = false }: { compact?: boolean }) => (
    <section aria-label="개인·공유 관심 종목" data-compact={compact} />
  ),
}));
vi.mock('../components/market-selection', () => ({
  MarketSelection: () => <section aria-label="월간 시가총액 순위" />,
}));

it('keeps personal and room groups before read-only monthly rankings without manual operations UI', () => {
  const { container } = render(<WatchlistPage />);
  const groups = screen.getByRole('region', { name: '개인·공유 관심 종목' });
  const rankings = screen.getByRole('region', { name: '월간 시가총액 순위' });
  expect(groups).toHaveAttribute('data-compact', 'false');
  expect([...container.firstElementChild!.children].slice(0, 2)).toEqual([groups, rankings]);
  expect(
    screen.queryByText(/운영 관심|관심기업 찾기|관심 추가|추가 우선순위/),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
});
