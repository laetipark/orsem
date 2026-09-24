import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewsPage, parseNewsSourceKind } from './news-page';

const mocks = vi.hoisted(() => ({ news: vi.fn(), sourceFreshness: vi.fn(), company: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mocks }));

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.news.mockResolvedValue({ items: [], nextCursor: null });
  mocks.sourceFreshness.mockResolvedValue({ asOf: '2026-09-05T00:00:00.000Z', items: [] });
  mocks.company.mockResolvedValue({ id: 'samsung', nameKo: '삼성전자' });
});

it('keeps the selected company on every full-feed cursor request', async () => {
  const item = (id: string) => ({
    id,
    title: `회사 뉴스 ${id}`,
    source: 'IR',
    url: `https://example.com/${id}`,
    firstObservedAt: '2026-09-06T00:00:00Z',
  });
  mocks.news.mockImplementation(async (filters) =>
    filters.cursor
      ? { items: [item('older')], nextCursor: null }
      : { items: [item('newer')], nextCursor: 'next-company-page' },
  );
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/news?companyId=samsung']}>
        <NewsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: '삼성전자 관련 뉴스 전체' });
  await screen.findByText('회사 뉴스 newer');
  fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
  await screen.findByText('회사 뉴스 older');
  expect(screen.getByText('회사 뉴스 newer')).toBeVisible();
  expect(mocks.news).toHaveBeenLastCalledWith(
    expect.objectContaining({
      companyId: 'samsung',
      scope: 'company',
      cursor: 'next-company-page',
    }),
    expect.any(AbortSignal),
  );
});

it('lists persisted NAVER and company news together in publication order', async () => {
  mocks.news.mockResolvedValue({
    items: [
      {
        id: 'company',
        title: '회사 발표',
        source: 'IR',
        url: 'https://example.com/company',
        publishedAt: '2026-09-24T01:00:00Z',
        firstObservedAt: '2026-09-25T00:00:00Z',
      },
      {
        id: 'naver',
        title: '네이버 최신 기사',
        source: 'NAVER',
        url: 'https://example.com/naver',
        publishedAt: '2026-09-24T03:00:00Z',
        firstObservedAt: '2026-09-24T04:00:00Z',
      },
    ],
    nextCursor: null,
    providerGroups: [],
    providerResultSets: [],
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/news']}>
        <NewsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText('네이버 최신 기사');
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    expect.stringContaining('네이버 최신 기사'),
    expect.stringContaining('회사 발표'),
  ]);
  expect(screen.queryByRole('heading', { name: '네이버 뉴스 검색결과' })).toBeNull();
  expect(screen.queryByText('네이버 검색 제공')).toBeNull();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.clearAllMocks();
});

it('normalizes an invalid source kind and offers approved content and external-link source filters', async () => {
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
      expect.any(AbortSignal),
    ),
  );
  expect(screen.getByRole('combobox', { name: '출처 유형' })).toHaveValue('');
  expect(screen.queryByRole('option', { name: '출처 유형 미확인' })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name: /독립 언론 · 원문 링크/ })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /이투데이/ })).not.toBeInTheDocument();

  fireEvent.change(screen.getByRole('combobox', { name: '출처 유형' }), {
    target: { value: 'COMPANY_IR' },
  });
  await waitFor(() =>
    expect(mocks.news).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceKind: 'COMPANY_IR', cursor: null }),
      expect.any(AbortSignal),
    ),
  );
  fireEvent.change(screen.getByRole('combobox', { name: '뉴스 범위' }), {
    target: { value: 'market' },
  });
  await waitFor(() =>
    expect(mocks.news).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'market', sourceKind: 'COMPANY_IR' }),
      expect.any(AbortSignal),
    ),
  );
  expect(parseNewsSourceKind('INDEPENDENT_MEDIA')).toBe('INDEPENDENT_MEDIA');
  expect(parseNewsSourceKind('COMPANY_IR')).toBe('COMPANY_IR');
  expect(parseNewsSourceKind('UNKNOWN')).toBeUndefined();
  expect(parseNewsSourceKind('NOT_A_KIND')).toBeUndefined();
});
