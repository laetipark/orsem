import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import type { NaverNewsResultSet, SourceItem, WatchlistNewsPage } from '../types';
import { WatchlistNewsFeed, type WatchlistNewsRefresh } from './watchlist-news-feed';

let client: QueryClient;
let refreshControl: WatchlistNewsRefresh | null;

function article(id: string, title: string, publishedAt: string): SourceItem {
  return {
    id,
    source: 'NEWS_RSS',
    sourceName: '회사 뉴스',
    externalId: id,
    title,
    description: `${title} 요약`,
    url: `https://publisher.example/${id}`,
    provenanceUrl: null,
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    author: null,
    publishedAt,
    firstObservedAt: '2026-09-24T08:00:00Z',
    processedAt: null,
    tickers: [],
    tags: [],
    contentState: 'UNAVAILABLE',
    contentSourceId: null,
    contentLanguage: 'ko',
    translated: false,
  };
}

function naverResults(
  items: NaverNewsResultSet['items'],
  queryId = 'company:samsung',
): NaverNewsResultSet {
  return {
    queryId,
    queryLabel: '삼성전자',
    kind: 'COMPANY',
    region: 'kr',
    fetchedAt: '2026-09-24T08:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    status: 'AVAILABLE',
    reason: null,
    total: items.length,
    start: 1,
    display: items.length,
    lastBuildDate: '2026-09-24T08:00:00Z',
    items,
  };
}

function naverArticle(id: string, title: string, pubDate: string) {
  return {
    title,
    description: `${title} 요약`,
    originallink: `https://publisher.example/${id}`,
    link: `https://news.naver.com/${id}`,
    pubDate,
  };
}

function page(patch: Partial<WatchlistNewsPage> = {}): WatchlistNewsPage {
  return {
    group: {
      id: 'own',
      name: '반도체',
      kind: 'PERSONAL',
      isShared: false,
      isFollowing: false,
      canEdit: true,
      itemCount: 1,
      ownerLabel: '나',
      updatedAt: '2026-09-24T08:00:00Z',
    },
    companies: [],
    companyCount: 1,
    asOf: '2026-09-24T08:00:00Z',
    items: [],
    nextCursor: null,
    ...patch,
  };
}

function panel(path = '/') {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <WatchlistNewsFeed
          actor="MEMBER:viewer1"
          groupId="own"
          enabled
          filterHost={null}
          onAccessLost={vi.fn()}
          onRefreshChange={(control) => {
            refreshControl = control;
          }}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function headlines() {
  return within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((item) => within(item).getByRole('link', { name: /기사 미리보기/ }).textContent);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  refreshControl = null;
  vi.spyOn(api, 'watchlistGroupNews').mockResolvedValue(page());
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it('combines company and unsorted Naver news in one list ordered by publication time', async () => {
  vi.mocked(api.watchlistGroupNews).mockResolvedValue(
    page({
      items: [article('company', '회사 중간 뉴스', '2026-09-24T03:00:00Z')],
      providerResultSets: [
        naverResults([
          naverArticle('naver-old', '네이버 이전 뉴스', 'Thu, 24 Sep 2026 11:00:00 +0900'),
          naverArticle('naver-new', '네이버 최신 뉴스', 'Thu, 24 Sep 2026 13:00:00 +0900'),
        ]),
      ],
    }),
  );

  render(panel());

  expect(await screen.findByText('회사 중간 뉴스')).toBeVisible();
  expect(screen.getAllByRole('list')).toHaveLength(1);
  expect(headlines()).toEqual([
    expect.stringContaining('네이버 최신 뉴스'),
    expect.stringContaining('회사 중간 뉴스'),
    expect.stringContaining('네이버 이전 뉴스'),
  ]);
  expect(screen.queryByRole('heading', { name: '네이버 뉴스 검색결과' })).toBeNull();
  expect(screen.getByRole('link', { name: /네이버 최신 뉴스.*기사 미리보기/ })).toHaveAttribute(
    'href',
    'https://publisher.example/naver-new',
  );
  expect(screen.queryByText(/네이버 검색 제공/)).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: /네이버 최신 뉴스.*기사 미리보기/ }));
  expect(await screen.findByRole('dialog')).toBeVisible();
  expect(screen.getByRole('link', { name: /자세히 보기/ })).toHaveAttribute(
    'href',
    'https://publisher.example/naver-new',
  );
});

it('keeps chronological order and removes duplicate URLs across sources and subsequent pages', async () => {
  const providerResultSets = [
    naverResults([
      naverArticle('shared', '중복 네이버 뉴스', '2026-09-24T03:00:00Z'),
      naverArticle('naver', '네이버 중간 뉴스', '2026-09-24T02:00:00Z'),
    ]),
  ];
  vi.mocked(api.watchlistGroupNews)
    .mockResolvedValueOnce(
      page({
        items: [article('stale', '갱신 전 뉴스', '2026-09-24T03:00:00Z')],
        nextCursor: 'stale-cursor',
      }),
    )
    .mockResolvedValueOnce(
      page({
        items: [article('shared', '회사 최신 뉴스', '2026-09-24T03:00:00Z')],
        providerResultSets,
        nextCursor: 'older-news',
      }),
    )
    .mockResolvedValueOnce(
      page({
        items: [
          article('older', '회사 이전 뉴스', '2026-09-24T01:00:00Z'),
          article('shared', '회사 최신 뉴스', '2026-09-24T03:00:00Z'),
        ],
        providerResultSets,
      }),
    );

  render(panel());
  await screen.findByText('갱신 전 뉴스');
  expect(screen.queryByRole('button', { name: '소식 더 보기' })).toBeNull();
  await act(async () => {
    await refreshControl!.refresh();
  });

  expect(await screen.findByText('회사 이전 뉴스')).toBeVisible();
  expect(headlines()).toEqual([
    expect.stringContaining('회사 최신 뉴스'),
    expect.stringContaining('네이버 중간 뉴스'),
    expect.stringContaining('회사 이전 뉴스'),
  ]);
  expect(screen.queryByText('중복 네이버 뉴스')).toBeNull();
  expect(screen.queryByText('갱신 전 뉴스')).toBeNull();
  expect(screen.getAllByText('네이버 중간 뉴스')).toHaveLength(1);
  expect(api.watchlistGroupNews).toHaveBeenLastCalledWith(
    'own',
    { companyId: undefined, limit: 20, cursor: 'older-news' },
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole('button', { name: '소식 더 보기' })).toBeNull();
});

it('preserves the selected company request and shows Naver-only news without an empty state', async () => {
  vi.mocked(api.watchlistGroupNews).mockResolvedValue(
    page({
      providerResultSets: [
        naverResults([naverArticle('samsung', '선택 종목 뉴스', '2026-09-24T04:00:00Z')]),
      ],
    }),
  );

  render(panel('/?watchCompany=samsung'));

  expect(await screen.findByText('선택 종목 뉴스')).toBeVisible();
  expect(api.watchlistGroupNews).toHaveBeenCalledWith(
    'own',
    { companyId: 'samsung', limit: 20, cursor: null },
    expect.any(AbortSignal),
  );
  expect(headlines()).toEqual([expect.stringContaining('선택 종목 뉴스')]);
  expect(screen.queryByText('아직 연결된 뉴스가 없습니다')).toBeNull();
});
