import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { marketFixtures } from '../lib/market-fixtures';
import { ThemeProvider } from '../theme';
import { MarketDetailPage } from './markets-page';

let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-23T16:00:00Z'));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['markets', 'all'], {
    asOf: '2026-09-23T16:00:00Z',
    items: marketFixtures,
  });
  vi.spyOn(api, 'marketHistory');
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  ['1m', '1개월', '2026-08-24'],
  ['3m', '3개월', '2026-06-23'],
  ['1y', '1년', '2025-09-23'],
])('opens S&P500 at the requested %s range and lets the user change it', (range, label, start) => {
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/markets/sp500?range=${range}`]}>
          <Routes>
            <Route path="/markets/:id" element={<MarketDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  const params = () =>
    new URL(screen.getByTitle('S&P500 FRED 일별 종가 차트').getAttribute('src')!).searchParams;
  expect(params().get('cosd')).toBe(start);
  expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '3개월' }));
  expect(params().get('cosd')).toBe('2026-06-23');
  expect(screen.getByRole('button', { name: '3개월' })).toHaveAttribute('aria-pressed', 'true');
  expect(api.marketHistory).not.toHaveBeenCalled();
});
