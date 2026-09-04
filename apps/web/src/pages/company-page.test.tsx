import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureRequest } from '../lib/fixtures';
import type { CompanyTimeline } from '../types';
import { CompanyPage } from './company-page';

const mocks = vi.hoisted(() => ({ timeline: vi.fn(), live: vi.fn() }));
vi.mock('../lib/api', () => ({
  api: {
    company: async () => ({
      id: 'test-company',
      nameKo: '삼성전자',
      nameEn: 'Samsung',
      market: 'KOSPI',
      stockCode: '005930',
      ticker: null,
      corpCode: null,
      cik: null,
      sector: '',
      priority: null,
      tags: [],
      recentEvents: [],
      provenance: [],
      isWatchlisted: true,
      thesis: null,
      lastEventAt: null,
    }),
    companyTimeline: mocks.timeline,
    companyLivePrice: mocks.live,
  },
}));
vi.mock('../components/company-chart', () => ({ CompanyChart: () => <div>차트</div> }));
afterEach(cleanup);

it('uses Toss only and keeps missing credentials explicit when switching to minute candles', async () => {
  mocks.timeline.mockImplementation(async (id: string, _range: string, interval: string) => ({
    companyId: id,
    currency: 'KRW',
    provider: 'toss',
    interval,
    status: 'NOT_CONFIGURED',
    prices: [],
    priceSources: [],
    markers: [],
    latestCloseAt: null,
    returns: { oneDay: null, oneMonth: null, sinceLatestEvent: null, benchmarkOneMonth: null },
  }));
  mocks.live.mockResolvedValue({
    companyId: 'test-company',
    provider: 'toss',
    status: 'NOT_CONFIGURED',
    quote: null,
    asOf: new Date().toISOString(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/companies/test-company']}>
        <Routes>
          <Route path="/companies/:id" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('토스증권 연결을 준비해 주세요')).toBeInTheDocument();
  expect(screen.queryByText('이전 기록')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '1분봉' }));
  await waitFor(() => expect(mocks.timeline).toHaveBeenCalledWith('test-company', '3M', '1m'));
  expect(await screen.findByRole('heading', { name: '1분봉과 현재가' })).toBeInTheDocument();
  expect(screen.getByText('토스 연결 필요')).toBeInTheDocument();
  view.unmount();
  client.clear();
});

it('translates application marker codes while preserving the event destination and source value', async () => {
  const timeline = await fixtureRequest<CompanyTimeline>(
    '/api/v1/companies/company-samsung/timeline?range=3M&interval=1d',
  );
  const marker = {
    ...timeline.markers.find((item) => item.kind === 'FILING')!,
    label: 'F · D002 공시',
  };
  mocks.timeline.mockResolvedValue({ ...timeline, markers: [marker] });
  mocks.live.mockResolvedValue({
    companyId: 'test-company',
    provider: 'toss',
    status: 'WAITING',
    quote: null,
    asOf: new Date().toISOString(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/companies/test-company']}>
        <Routes>
          <Route path="/companies/:id" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const label = await screen.findByText('F · 임원·주요주주 보유 공시');
  expect(label.closest('a')).toHaveAttribute('href', `/events/${marker.eventId}`);
  expect(screen.queryByText('F · D002 공시')).not.toBeInTheDocument();
  expect(marker.label).toBe('F · D002 공시');
  view.unmount();
  client.clear();
});
