import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { WatchlistPage } from './watchlist-page';

const mocks = vi.hoisted(() => ({ watchlist: vi.fn(), quotes: vi.fn() }));
vi.mock('../lib/api', () => ({
  api: {
    watchlist: mocks.watchlist,
    watchlistQuotes: mocks.quotes,
    companies: vi.fn(),
    addWatchlist: vi.fn(),
    removeWatchlist: vi.fn(),
    updateWatchlist: vi.fn(),
  },
}));
afterEach(cleanup);
function NavigationHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => void navigate(-1)}>브라우저 뒤로</button>
      <WatchlistPage />
    </>
  );
}
it('restores regional pagination on browser back and clears old cursors when changing region', async () => {
  mocks.watchlist.mockImplementation(async (_region: string, cursor: string | null) => ({
    items: [],
    nextCursor: cursor === 'page3' ? null : cursor === 'page2' ? 'page3' : 'page2',
  }));
  mocks.quotes.mockResolvedValue({ asOf: '2026-09-03T00:00:00Z', items: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/watchlist?region=kr']}>
        <NavigationHarness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(mocks.watchlist).toHaveBeenLastCalledWith('kr', null));
  await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).toBeEnabled());
  fireEvent.click(await screen.findByRole('button', { name: '다음' }));
  await waitFor(() => expect(mocks.watchlist).toHaveBeenLastCalledWith('kr', 'page2'));
  fireEvent.click(await screen.findByRole('button', { name: '다음' }));
  await waitFor(() => expect(mocks.watchlist).toHaveBeenLastCalledWith('kr', 'page3'));
  fireEvent.click(screen.getByRole('button', { name: '브라우저 뒤로' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '이전' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '이전' })).toBeDisabled());
  fireEvent.click(await screen.findByRole('button', { name: '다음' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '이전' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '미국' }));
  await waitFor(() => expect(mocks.watchlist).toHaveBeenLastCalledWith('us', null));
  expect(await screen.findByRole('button', { name: '이전' })).toBeDisabled();
  client.clear();
});
