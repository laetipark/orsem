import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { fixtureRequest } from '../lib/fixtures';
import { SearchPage } from '../pages/search-page';
import type { SearchResults, WatchlistFilings } from '../types';
import { WatchlistNewsFeed } from './watchlist-news-feed';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['search', 'watchlist', 'popout'] as const)(
  '%s disclosure links open the service detail route in the current page',
  async (surface) => {
    const search = await fixtureRequest<SearchResults>('/api/v1/search?q=Samsung');
    const filings = await fixtureRequest<WatchlistFilings>(
      '/api/v1/watchlist-groups/fixture-personal-semiconductors/filings',
    );
    vi.spyOn(api, 'search').mockResolvedValue(search);
    vi.spyOn(api, 'watchlistGroupFilings').mockResolvedValue(filings);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const path = surface === 'search' ? '/?q=Samsung&type=filings' : '/?watchNewsType=filings';
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/"
              element={
                surface === 'search' ? (
                  <SearchPage />
                ) : (
                  <WatchlistNewsFeed
                    actor="MEMBER:test"
                    groupId="fixture-personal-semiconductors"
                    enabled
                    onAccessLost={vi.fn()}
                    filterHost={null}
                    externalCompanies={surface === 'popout'}
                  />
                )
              }
            />
            <Route path="/events/:id" element={<p>서비스 공시 상세</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const title = surface === 'search' ? search.filings[0]!.title : filings.items[0]!.title;
    const link = (await screen.findByText(title)).closest('a')!;
    expect(link).toHaveAttribute('href', expect.stringMatching(/^\/events\//));
    expect(link).not.toHaveAttribute('target');
    fireEvent.click(link);
    expect(await screen.findByText('서비스 공시 상세')).toBeVisible();
    client.clear();
  },
);
