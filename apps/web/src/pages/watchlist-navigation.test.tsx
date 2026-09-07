import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MarketSelectionMembership } from '../components/market-selection';
import { MarketsPage } from './markets-page';

vi.mock('../components/market-overview', () => ({
  MarketOverview: ({ region }: { region: string }) => (
    <output aria-label="시장 지표 지역">{region}</output>
  ),
}));
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
      <MemoryRouter initialEntries={['/markets?region=kr&cursor=old']}>
        <Location />
        <Routes>
          <Route path="/markets" element={<MarketsPage />} />
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
  expect(screen.getByLabelText('현재 위치')).toHaveTextContent(
    '/markets?region=kr#market-leaders-kr',
  );
  expect(await screen.findByRole('list', { name: '국내 시가총액 순위' })).toBeInTheDocument();
  expect(screen.getByLabelText('시장 지표 지역')).toHaveTextContent('kr');
  expect(screen.queryByRole('region', { name: '미국 상위 20종목' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '미국' }));
  expect(screen.getByLabelText('시장 지표 지역')).toHaveTextContent('us');
  expect(screen.getByRole('region', { name: '미국 상위 20종목' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '국내 상위 20종목' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '다음' })).not.toBeInTheDocument();
  client.clear();
});
