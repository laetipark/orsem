import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { CursorPage, EventDetail, EventSummary, SearchResults } from '../types';
import { EventCompactRow, EventMobileCard } from '../components/event-row';
import { fixtureRequest } from '../lib/fixtures';
import { SearchPage } from './search-page';
import { EventsPage } from './events-page';
import { EventDetailPage } from './event-detail-page';

const mocks = vi.hoisted(() => ({ events: vi.fn(), event: vi.fn(), search: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mocks }));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.clearAllMocks();
});

async function news() {
  return fixtureRequest<EventDetail>('/api/v1/events/evt-msft-news-translation-01');
}

function show(path: string, route: string, page: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={page} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('SEC 접수 상세는 날짜와 원문을 보이고 거래 분석이나 파싱 대기로 표시하지 않는다', async () => {
  const data = {
    ...(await news()),
    detailType: 'SEC' as const,
    title: 'Form 4/A',
    rceptDate: '2026-09-03',
    eventAt: null,
    transactions: [],
    translation: null,
  };
  mocks.event.mockResolvedValue(data);
  show(`/events/${data.id}`, '/events/:id', <EventDetailPage />);
  expect(await screen.findByText('SEC 공시 접수 기록입니다.')).toBeVisible();
  expect(screen.getByText('SEC가 제공하는 공시 접수 날짜')).toBeVisible();
  expect(screen.queryByText('원문 거래 내역')).not.toBeInTheDocument();
  expect(screen.queryByText('실제 사건일')).not.toBeInTheDocument();
  expect(screen.queryByText('구조화된 거래 행이 없습니다.')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /공식 원문/ })).toHaveAttribute('href', data.officialUrl);
});

it('검색 뉴스는 준비된 번역과 내부 상세 링크를 표시하고 공시의 원문 제목을 유지한다', async () => {
  const newsResult = await fixtureRequest<SearchResults>('/api/v1/search?q=Samsung');
  const filingResult = await fixtureRequest<SearchResults>('/api/v1/search?q=Microsoft');
  const translated = newsResult.news[0]!;
  const filing = filingResult.filings.find((item) => item.title === 'Form 8-K')!;
  filing.translation = translated.translation;
  const result = { ...newsResult, filings: [filing] };
  mocks.search.mockResolvedValue(result);
  const { container } = show('/search?q=Microsoft', '/search', <SearchPage />);
  expect(await screen.findByText(translated.translation!.title)).toBeVisible();
  expect(screen.getByText(translated.title)).toBeVisible();
  expect(screen.getByText('Form 8-K')).toBeVisible();
  expect(screen.getAllByText('자동 번역')).toHaveLength(1);
  expect(container.querySelector('a button, a summary, a details')).toBeNull();
  const originalLink = screen.getByText(translated.title).closest('a');
  expect(originalLink).toHaveAttribute('href', translated.url);
  expect(originalLink).not.toHaveAttribute('target');
});

it('이벤트 탐색 표와 모바일 카드가 한국어 번역과 원문을 함께 표시한다', async () => {
  const event = await news();
  mocks.events.mockResolvedValue({
    items: [event],
    nextCursor: null,
  } satisfies CursorPage<EventSummary>);
  const { container } = show('/events', '/events', <EventsPage />);
  expect(await screen.findAllByText(event.translation!.title)).toHaveLength(2);
  expect(screen.getAllByText(event.title)).toHaveLength(2);
  expect(screen.getAllByText('자동 번역')).toHaveLength(2);
  expect(container.querySelector('a button, a summary, a details')).toBeNull();
});

it('compact와 모바일 이벤트는 뉴스에만 번역을 적용한다', async () => {
  const event = await news();
  render(
    <MemoryRouter>
      <EventCompactRow event={event} />
      <EventMobileCard
        event={{ ...event, detailType: 'SEC', title: 'Form 8-K', summary: 'SEC 원문 설명' }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText(event.translation!.title)).toBeVisible();
  expect(screen.getByText(event.title)).toBeVisible();
  expect(screen.getByText('SEC 원문 설명')).toBeVisible();
  expect(screen.getAllByText('자동 번역')).toHaveLength(1);
});

it('상세 제목과 출처에서 번역 원문을 펼칠 수 있고 권리 안내를 보존한다', async () => {
  const event = await news();
  mocks.event.mockResolvedValue(event);
  const { container } = show(`/events/${event.id}`, '/events/:id', <EventDetailPage />);
  expect(await screen.findByRole('heading', { name: event.translation!.title })).toBeVisible();
  expect(screen.getAllByText('원문 보기')).toHaveLength(2);
  const evidence = container.querySelector('.evidence-item') as HTMLElement;
  expect(within(evidence).getByText(event.translation!.title)).toBeVisible();
  expect(within(evidence).getByText(event.evidence[0]!.excerpt!)).toBeVisible();
  expect(within(evidence).getByText(event.sourceName)).toBeVisible();
});
