import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MarketSelectionMembership } from '../components/market-selection';
import { WatchlistPage } from './watchlist-page';

vi.mock('../components/watchlist-news-workspace', () => ({ WatchlistNewsWorkspace: () => null }));
vi.mock('../lib/api', () => ({
  api: {
    marketSelection: async () => ({
      asOf: '2026-09-07T00:00:00.000Z',
      regions: [
        {
          region: 'kr',
          status: 'AVAILABLE',
          basisDate: '2026-09-04',
          observedAt: null,
          sourceUrl: 'https://example.com/ranking',
          reason: null,
          updateNote: null,
          items: [
            {
              id: 'company-samsung',
              rank: 1,
              nameKo: '삼성전자',
              stockCode: '005930',
              market: 'KOSPI',
              marketCap: '420000000000000',
              canonicalPath: '/companies/005930',
            },
          ],
        },
      ],
    }),
  },
}));
afterEach(cleanup);
function Location() {
  const location = useLocation();
  return (
    <output aria-label="현재 위치">
      {location.pathname}
      {location.search}
      {location.hash}
    </output>
  );
}

it('opens a ranked company by public address and returns to its regional monthly list', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/watchlist?region=kr&cursor=old']}>
        <Location />
        <Routes>
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route
            path="/companies/005930"
            element={<MarketSelectionMembership companyId="company-samsung" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('link', { name: /삼성전자 KOSPI/ }));
  expect(screen.getByLabelText('현재 위치')).toHaveTextContent('/companies/005930');
  fireEvent.click(await screen.findByRole('link', { name: '국내 시총 1위' }));
  expect(screen.getByLabelText('현재 위치')).toHaveTextContent('/watchlist#market-leaders-kr');
  expect(await screen.findByRole('list', { name: '국내 시가총액 순위' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '다음' })).not.toBeInTheDocument();
  client.clear();
});
