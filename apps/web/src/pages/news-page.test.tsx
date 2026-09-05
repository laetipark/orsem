import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewsPage, parseNewsSourceKind } from './news-page';

const mocks = vi.hoisted(() => ({ news: vi.fn(), sourceFreshness: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mocks }));

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.news.mockResolvedValue({ items: [], nextCursor: null });
  mocks.sourceFreshness.mockResolvedValue({ asOf: '2026-09-05T00:00:00.000Z', items: [] });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.clearAllMocks();
});

it('normalizes an invalid source kind and offers only approved content source filters', async () => {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/news?sourceKind=NOT_A_KIND']}>
        <NewsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await waitFor(() =>
    expect(mocks.news).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: undefined, cursor: null }),
    ),
  );
  expect(screen.getByRole('combobox', { name: '출처 유형' })).toHaveValue('');
  expect(screen.queryByRole('option', { name: '출처 유형 미확인' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /독립 언론/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /이투데이/ })).not.toBeInTheDocument();

  fireEvent.change(screen.getByRole('combobox', { name: '출처 유형' }), {
    target: { value: 'COMPANY_IR' },
  });
  await waitFor(() =>
    expect(mocks.news).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceKind: 'COMPANY_IR', cursor: null }),
    ),
  );
  expect(parseNewsSourceKind('COMPANY_IR')).toBe('COMPANY_IR');
  expect(parseNewsSourceKind('UNKNOWN')).toBeUndefined();
  expect(parseNewsSourceKind('NOT_A_KIND')).toBeUndefined();
});
