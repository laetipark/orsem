import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { mockMediaQuery } from '../test/media-query';
import type { PersonalFiling, Session, SourceItem } from '../types';
import { PersonalNews } from './personal-news';

type NewsResponse = Awaited<ReturnType<typeof api.personalNews>>;
const session: Session = {
  authenticated: true,
  canAccess: true,
  csrfToken: 'test',
  setupRequired: false,
  user: {
    id: 'viewer1',
    role: 'VIEWER',
    provider: 'LOCAL',
    status: 'APPROVED',
    email: null,
    displayName: '나',
    totpEnabled: false,
  },
};
const asOf = '2026-09-07T00:00:00Z';
function article(index: number): SourceItem {
  return {
    id: `article-${index}`,
    source: 'NEWS_RSS',
    sourceName: '공식 소식',
    externalId: `${index}`,
    title: `관심 뉴스 ${index}`,
    description: null,
    url: `https://publisher.example/news/${index}`,
    provenanceUrl: null,
    rightsMode: 'LINK_ONLY',
    author: null,
    publishedAt: new Date(Date.parse(asOf) - index * 60_000).toISOString(),
    firstObservedAt: asOf,
    processedAt: null,
    tickers: [],
    tags: [],
    contentState: 'UNAVAILABLE',
    contentSourceId: null,
    contentLanguage: 'ko',
    translated: false,
    displayMode: 'EXTERNAL_LINK',
  };
}
function newsResponse(count: number): NewsResponse {
  return {
    asOf,
    companyCount: 3,
    events: [],
    news: Array.from({ length: count }, (_, index) => article(index + 1)),
  };
}
function filing(index: number): PersonalFiling {
  return {
    id: `filing-${index}`,
    source: 'SEC',
    externalId: `${index}`,
    title: `관심 공시 ${index}`,
    filingDate: '2026-09-06',
    publishedAt: null,
    firstObservedAt: asOf,
    url: `/events/filing-${index}`,
    relatedCompanies: [],
  };
}
let client: QueryClient;
let media: ReturnType<typeof mockMediaQuery>;
function panel(actor = session) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={actor} />}>
            <Route path="/" element={<PersonalNews />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  media = mockMediaQuery(false);
  vi.spyOn(api, 'personalNews').mockResolvedValue(newsResponse(13));
  vi.spyOn(api, 'personalFilings').mockResolvedValue({
    asOf,
    companyCount: 3,
    items: Array.from({ length: 13 }, (_, index) => filing(index + 1)),
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it.each([
  [false, 6, '뉴스'],
  [true, 4, '뉴스'],
  [false, 6, '공시'],
  [true, 4, '공시'],
] as const)('shows %i compact, %i rows of %s with page boundaries', async (compact, size, tab) => {
  media.resize(compact);
  render(panel());
  if (tab === '공시') fireEvent.click(screen.getByRole('tab', { name: tab }));
  expect(await screen.findByText(`관심 ${tab} 1`)).toBeVisible();
  if (tab === '공시') {
    const link = screen.getByRole('link', { name: '관심 공시 1' });
    expect(link).toHaveAttribute('href', '/events/filing-1');
    expect(link).not.toHaveAttribute('target');
  }
  expect(screen.getAllByRole('listitem')).toHaveLength(size);
  expect(screen.getByText(`총 13건 · 1–${size}건`)).toBeVisible();
  expect(screen.getByRole('button', { name: '이전 소식' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  expect(screen.getByText(`관심 ${tab} ${size + 1}`)).toBeVisible();
  expect(screen.queryByText(`관심 ${tab} 1`)).toBeNull();
  while (!screen.getByRole('button', { name: '다음 소식' }).hasAttribute('disabled')) {
    fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  }
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText(`관심 ${tab} 13`)).toBeVisible();
  expect(screen.getByText('총 13건 · 13–13건')).toBeVisible();
  expect(api.personalNews).toHaveBeenCalledOnce();
  expect(api.personalFilings).toHaveBeenCalledTimes(tab === '공시' ? 1 : 0);
});

it('deduplicates the complete latest 20 candidates before creating pages', async () => {
  const response = newsResponse(23);
  response.providerGroups = [[{ ...article(1), id: 'provider-copy' }]];
  vi.mocked(api.personalNews).mockResolvedValue(response);
  render(panel());
  await screen.findByText('관심 뉴스 1');
  expect(screen.getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getByText('총 20건 · 1–6건')).toBeVisible();
  const seen: string[] = [];
  for (let page = 0; page < 4; page++) {
    seen.push(...screen.getAllByRole('listitem').map((item) => item.textContent ?? ''));
    if (page < 3) fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  }
  expect(seen).toHaveLength(20);
  expect(new Set(seen).size).toBe(20);
  expect(screen.getByText('관심 뉴스 20')).toBeVisible();
  expect(screen.queryByText('관심 뉴스 21')).toBeNull();
});

it('includes NAVER news in the same chronological list and pagination count', async () => {
  const response = newsResponse(6);
  response.providerResultSets = [
    {
      queryId: 'company:test',
      queryLabel: '관심 종목',
      region: 'kr',
      kind: 'COMPANY',
      fetchedAt: asOf,
      expiresAt: '2099-01-01T00:00:00Z',
      status: 'AVAILABLE',
      reason: null,
      total: 1,
      start: 1,
      display: 1,
      lastBuildDate: null,
      items: [
        {
          title: '네이버 최신 기사',
          description: '기사 설명',
          originallink: 'https://publisher.example/naver',
          link: 'https://news.naver.com/article/1',
          pubDate: asOf,
        },
      ],
    },
  ];
  vi.mocked(api.personalNews).mockResolvedValue(response);
  render(panel());
  await screen.findByText('네이버 최신 기사');
  expect(screen.getAllByRole('list')).toHaveLength(1);
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('네이버 최신 기사');
  expect(screen.getByText('총 7건 · 1–6건')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  expect(screen.getByText('관심 뉴스 6')).toBeVisible();
  expect(screen.queryByText('네이버 최신 기사')).toBeNull();
});

it('starts each tab at page one and keeps a valid page after breakpoint changes', async () => {
  render(panel());
  await screen.findByText('관심 뉴스 1');
  fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  fireEvent.click(screen.getByRole('tab', { name: '공시' }));
  await screen.findByText('관심 공시 1');
  fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  fireEvent.click(screen.getByRole('tab', { name: '뉴스' }));
  await screen.findByText('관심 뉴스 1');
  fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  act(() => media.resize(true));
  expect(screen.getByText('관심 뉴스 1')).toBeVisible();
  expect(screen.getAllByRole('listitem')).toHaveLength(4);
  for (let page = 0; page < 3; page++) {
    fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  }
  expect(screen.getByText('관심 뉴스 13')).toBeVisible();
  act(() => media.resize(false));
  expect(screen.getByText('관심 뉴스 1')).toBeVisible();
  expect(screen.getAllByRole('listitem')).toHaveLength(6);
});

it('clamps the current page when a refreshed result shrinks and hides empty pagination', async () => {
  render(panel());
  await screen.findByText('관심 뉴스 1');
  fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  act(() =>
    client.setQueryData(['watchlist-v2', 'MEMBER:viewer1', 'personal-news'], newsResponse(7)),
  );
  expect(await screen.findByText('관심 뉴스 7')).toBeVisible();
  expect(screen.getByText('총 7건 · 7–7건')).toBeVisible();
  act(() =>
    client.setQueryData(['watchlist-v2', 'MEMBER:viewer1', 'personal-news'], newsResponse(0)),
  );
  await screen.findByText('아직 연결된 소식이 없습니다');
  expect(screen.queryByRole('group', { name: '관심 소식 페이지' })).toBeNull();
});

it('removes prior-account items while a new account loads and resets its page', async () => {
  let resolveNext!: (data: NewsResponse) => void;
  vi.mocked(api.personalNews)
    .mockResolvedValueOnce(newsResponse(13))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        }),
    );
  const view = render(panel());
  await screen.findByText('관심 뉴스 1');
  fireEvent.click(screen.getByRole('button', { name: '다음 소식' }));
  const next: Session = { ...session, user: { ...session.user!, id: 'viewer2' } };
  view.rerender(panel(next));
  expect(screen.queryByText('관심 뉴스 7')).toBeNull();
  expect(screen.queryByRole('group', { name: '관심 소식 페이지' })).toBeNull();
  await waitFor(() => expect(resolveNext).toBeDefined());
  await act(async () => resolveNext({ ...newsResponse(13), news: [article(101)] }));
  expect(await screen.findByText('관심 뉴스 101')).toBeVisible();
  expect(screen.queryByText('관심 뉴스 7')).toBeNull();
  expect(screen.getByText('총 1건 · 1–1건')).toBeVisible();
  expect(client.getQueryData(['watchlist-v2', 'MEMBER:viewer1', 'personal-news'])).toBeUndefined();
});
