import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { MarketSelection, MarketSelectionMembership, marketCapLabel } from './market-selection';

const mocks = vi.hoisted(() => ({ selection: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { marketSelection: mocks.selection } }));
type Selection = Awaited<ReturnType<typeof api.marketSelection>>;
type Region = Selection['regions'][number];

function region(code: 'kr' | 'us', overrides: Partial<Region> = {}): Region {
  return {
    region: code,
    status: 'AVAILABLE',
    reason: null,
    basisDate: '2026-09-04',
    observedAt: '2026-09-06T21:00:00.000Z',
    sourceUrl: `https://example.com/${code}/ranking`,
    sourceName: `${code === 'kr' ? '국내' : '미국'} 원본 출처`,
    updateNote: null,
    currency: code === 'kr' ? 'KRW' : 'USD',
    selectionMonth: '2026-09',
    nextRefreshAt: '2026-09-30T15:00:00.000Z',
    refreshCadence: 'MONTHLY',
    providerScope: '보통주 시가총액 기준 · ETF 제외',
    items: Array.from({ length: 20 }, (_, index) => ({
      id: `${code}-${index + 1}`,
      rank: index + 1,
      nameKo: `${code === 'kr' ? '국내' : '미국'} 기업 ${index + 1}`,
      marketCap: String((20 - index) * 1_000_000_000_000),
      market: code === 'kr' ? 'KOSPI' : 'NASDAQ',
      stockCode: code === 'kr' ? String(index + 1).padStart(6, '0') : null,
      ticker: code === 'us' ? `US${index + 1}` : null,
      canonicalPath: `/companies/${code === 'kr' ? String(index + 1).padStart(6, '0') : `US${index + 1}`}`,
    })),
    ...overrides,
  };
}
const clients: QueryClient[] = [];
function show(content: ReactNode = <MarketSelection />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{content}</MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.selection.mockReset();
  mocks.selection.mockResolvedValue({
    asOf: '2026-09-07T00:00:00.000Z',
    regions: [region('kr'), region('us')],
  } satisfies Selection);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

it('shows two read-only lists with twenty real ranks, source links, currencies and KST dates', async () => {
  show();
  const korean = await screen.findByRole('list', { name: '국내 시가총액 순위' });
  const american = screen.getByRole('list', { name: '미국 시가총액 순위' });
  expect(within(korean).getAllByRole('listitem')).toHaveLength(20);
  expect(within(american).getAllByRole('listitem')).toHaveLength(20);
  expect(within(korean).getByRole('link', { name: /국내 기업 1 KOSPI/ })).toHaveAttribute(
    'href',
    '/companies/000001',
  );
  expect(within(american).getByRole('link', { name: /미국 기업 1 NASDAQ/ })).toHaveAttribute(
    'href',
    '/companies/US1',
  );
  expect(screen.getByText('시가총액 · KRW')).toBeInTheDocument();
  expect(screen.getByText('시가총액 · USD')).toBeInTheDocument();
  expect(screen.getAllByText('2026. 09. 04.')).toHaveLength(2);
  expect(screen.getAllByText('2026. 09. 07. 06:00 KST')).toHaveLength(2);
  expect(screen.getAllByText('2026. 10. 01. 00:00 KST')).toHaveLength(2);
  expect(screen.getByText('매월 1회 갱신')).toBeInTheDocument();
  expect(screen.getAllByText('보통주 시가총액 기준 · ETF 제외')).toHaveLength(2);
  expect(screen.getByRole('link', { name: '국내 원본 출처 새 창에서 보기' })).toHaveAttribute(
    'href',
    'https://example.com/kr/ranking',
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('keeps a previous verified list with its actual ranks and makes an unavailable region explicit', async () => {
  const kr = region('kr');
  mocks.selection.mockResolvedValue({
    asOf: '2026-09-07T00:00:00.000Z',
    regions: [
      region('kr', {
        status: 'STALE',
        reason: '이번 달 자료를 확인하지 못했습니다.',
        items: [kr.items[3]!, kr.items[1]!],
        sourceUrl: 'javascript:alert(1)',
      }),
    ],
  } satisfies Selection);
  show();
  const list = await screen.findByRole('list', { name: '국내 시가총액 순위' });
  expect(
    within(list)
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('value')),
  ).toEqual(['2', '4']);
  expect(screen.getByText('이전 목록 유지')).toBeInTheDocument();
  expect(screen.getByText('이번 달 자료를 확인하지 못했습니다.')).toBeInTheDocument();
  expect(screen.getByText('현재 확인된 2종목을 표시합니다.')).toBeInTheDocument();
  expect(screen.getByText('미국 선정 목록을 기다리고 있습니다')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /원본 출처/ })).not.toBeInTheDocument();
});

it('does not invent a list when the API fails and offers a retry', async () => {
  mocks.selection.mockRejectedValue(new Error('Unavailable'));
  show();
  expect(await screen.findByText('시가총액 선정 목록을 불러오지 못했습니다.')).toBeInTheDocument();
  expect(screen.getByRole('button')).toBeInTheDocument();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it('shows a company rank link only for membership in an actual top-twenty list', async () => {
  show(
    <>
      <MarketSelectionMembership companyId="us-2" />
      <MarketSelectionMembership companyId="outside" />
    </>,
  );
  expect(await screen.findByRole('link', { name: '미국 시총 2위' })).toHaveAttribute(
    'href',
    '/watchlist#market-leaders-us',
  );
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(mocks.selection).toHaveBeenCalledTimes(1);
});

it('formats each market in its native currency and leaves missing caps empty', () => {
  expect(marketCapLabel('420000000000000', 'KRW')).toContain('₩420조');
  expect(marketCapLabel('3200000000000', 'USD')).toContain('US$3.2조');
  expect(marketCapLabel('', 'KRW')).toBe('—');
  expect(marketCapLabel('invalid', 'USD')).toBe('—');
});
