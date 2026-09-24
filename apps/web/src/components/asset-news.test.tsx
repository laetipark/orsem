import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import type { CursorPage, SourceItem, NewsFeedPage } from '../types';
import { AssetNews, type NewsAsset } from './asset-news';

let client: QueryClient;
const empty: CursorPage<SourceItem> = { items: [], nextCursor: null };
function article(asset: NewsAsset): SourceItem {
  return {
    id: `${asset}-article`,
    source: 'NAVER',
    sourceName: '네이버 뉴스',
    externalId: asset,
    title: `${asset} 관련 제목`,
    description: `${asset} 관련 요약`,
    url: `https://publisher.example/${asset}`,
    provenanceUrl: null,
    rightsMode: 'LINK_ONLY',
    author: null,
    publishedAt: '2026-09-06T00:00:00Z',
    firstObservedAt: '2026-09-06T00:00:00Z',
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
function providerPage(asset: NewsAsset): NewsFeedPage {
  const value = article(asset);
  return {
    items: [],
    nextCursor: null,
    providerResultSets: [
      {
        queryId: asset,
        queryLabel: asset,
        kind: 'ASSET',
        region: 'global',
        fetchedAt: '2026-09-06T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        status: 'AVAILABLE',
        reason: null,
        total: 1,
        start: 1,
        display: 1,
        lastBuildDate: null,
        items: [
          {
            title: value.title,
            description: value.description ?? '',
            originallink: value.url,
            link: `https://news.naver.com/${asset}`,
            pubDate: value.publishedAt!,
          },
        ],
      },
    ],
  };
}
function panel(asset: NewsAsset) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AssetNews asset={asset} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, 'news').mockResolvedValue(empty);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it.each([
  ['gold', '금'],
  ['silver', '은'],
  ['wti', 'WTI'],
  ['btc', '비트코인'],
  ['eth', '이더리움'],
] as const)(
  'requests only the selected %s asset filter with its accessible section title',
  async (asset, name) => {
    render(panel(asset));
    expect(screen.getByRole('heading', { name: `${name} 관련 뉴스` })).toBeVisible();
    await screen.findByText('아직 관련 뉴스가 없습니다');
    expect(api.news).toHaveBeenCalledOnce();
    expect(api.news).toHaveBeenCalledWith(
      { scope: 'market', asset, limit: 20 },
      expect.any(AbortSignal),
    );
  },
);

it('removes the prior asset immediately while the next asset is pending and shows only its original links', async () => {
  let resolveNext!: (page: CursorPage<SourceItem>) => void;
  vi.mocked(api.news)
    .mockResolvedValueOnce(providerPage('gold'))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        }),
    );
  const view = render(panel('gold'));
  expect(await screen.findByText('gold 관련 제목')).toBeVisible();
  view.rerender(panel('wti'));
  expect(screen.queryByText('gold 관련 제목')).toBeNull();
  expect(screen.queryByText('gold 관련 요약')).toBeNull();
  expect(screen.getByText('관련 뉴스를 불러오는 중입니다.')).toBeVisible();
  await waitFor(() => expect(resolveNext).toBeDefined());
  await act(async () => {
    resolveNext(providerPage('wti'));
  });
  expect(await screen.findByText('wti 관련 제목')).toBeVisible();
  expect(screen.queryByText('wti 관련 요약')).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: /wti 관련 제목.*기사 미리보기/ }));
  expect(screen.getByText('wti 관련 요약')).toBeVisible();
  expect(screen.queryByText('gold 관련 제목')).toBeNull();
  expect(screen.getByRole('link', { name: /자세히 보기/ })).toHaveAttribute(
    'href',
    'https://publisher.example/wti',
  );
});

it('aborts an old asset request and does not display its late response under the new asset', async () => {
  let oldSignal: AbortSignal | undefined;
  let resolveOld!: (page: CursorPage<SourceItem>) => void;
  vi.mocked(api.news)
    .mockImplementationOnce((_input, signal) => {
      oldSignal = signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    })
    .mockResolvedValueOnce(providerPage('btc'));
  const view = render(panel('eth'));
  await waitFor(() => expect(oldSignal).toBeDefined());
  view.rerender(panel('btc'));
  expect(oldSignal?.aborted).toBe(true);
  expect(await screen.findByText('btc 관련 제목')).toBeVisible();
  await act(async () => {
    resolveOld(providerPage('eth'));
  });
  expect(screen.queryByText('eth 관련 제목')).toBeNull();
  expect(screen.getByRole('heading', { name: '비트코인 관련 뉴스' })).toBeVisible();
});
