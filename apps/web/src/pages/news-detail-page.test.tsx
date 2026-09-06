import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { replaceWithNewsOriginal } from '../lib/news-navigation';
import type { NewsDetail } from '../types';
import { NewsDetailPage } from './news-detail-page';

vi.mock('../lib/news-navigation', () => ({ replaceWithNewsOriginal: vi.fn() }));
const detail: NewsDetail = {
  id: 'source-1',
  articleId: 'article-1',
  sourceCount: 1,
  contentState: 'AVAILABLE',
  contentSourceId: 'source-1',
  contentLanguage: 'en',
  translated: true,
  sourceKind: 'COMPANY_IR',
  publisherId: 'samsung-global-newsroom',
  marketRegion: 'global',
  source: 'IR',
  externalId: 'release-1',
  url: 'https://news.samsung.com/global/example',
  title: 'Samsung shares a business update',
  description: 'Original summary',
  translation: {
    language: 'ko',
    title: '삼성전자, 사업 현황 발표',
    description: '번역 요약',
    translatedAt: '2026-09-05T00:04:00.000Z',
    provider: 'LOCAL',
    model: 'fixture-model',
  },
  sourceName: 'Samsung Global Newsroom',
  author: 'Samsung Newsroom',
  publishedAt: '2026-09-05T00:00:00.000Z',
  firstObservedAt: '2026-09-05T00:02:00.000Z',
  processedAt: '2026-09-05T00:03:00.000Z',
  rightsMode: 'PRIVATE_DISPLAY_ONLY',
  provenanceUrl: 'https://news.samsung.com/global/example',
  tickers: ['005930'],
  tags: ['IR'],
  content: {
    sourceItemId: 'source-1',
    original: {
      language: 'en',
      blocks: [
        { type: 'HEADING', level: 2, text: 'Original section' },
        { type: 'PARAGRAPH', text: 'Original English body.' },
      ],
      fetchedAt: '2026-09-05T00:03:00.000Z',
    },
    translation: {
      language: 'ko',
      blocks: [
        { type: 'HEADING', level: 2, text: '번역 문단' },
        { type: 'PARAGRAPH', text: '한국어로 번역한 본문입니다.' },
      ],
      translatedAt: '2026-09-05T00:04:00.000Z',
      provider: 'LOCAL',
      model: 'fixture-model',
    },
  },
};

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/news/article-1']}>
        <Routes>
          <Route path="/news/:id" element={<NewsDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it('resolves an old article bookmark to its original URL without rendering cached body or editing controls', async () => {
  vi.spyOn(api, 'newsDetail').mockResolvedValue(detail);
  show();
  await waitFor(() => expect(replaceWithNewsOriginal).toHaveBeenCalledWith(detail.url));
  expect(screen.getByRole('link', { name: /원문 새 창에서 보기/ })).toHaveAttribute(
    'href',
    detail.url,
  );
  expect(screen.queryByText('Original English body.')).not.toBeInTheDocument();
  expect(screen.queryByText('한국어로 번역한 본문입니다.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /번역/ })).not.toBeInTheDocument();
});
it('redirects metadata-only news with no content row', async () => {
  vi.spyOn(api, 'newsDetail').mockResolvedValue({
    ...detail,
    content: null,
    contentState: 'UNAVAILABLE',
  });
  show();
  await waitFor(() => expect(replaceWithNewsOriginal).toHaveBeenCalledWith(detail.url));
});
it.each(['javascript:alert(1)', 'https://user:password@example.com/article', '/news/article-1'])(
  'does not navigate to an unsafe source: %s',
  async (url) => {
    vi.spyOn(api, 'newsDetail').mockResolvedValue({ ...detail, url, content: null });
    show();
    expect(await screen.findByText('안전한 기사 원문 링크를 찾을 수 없습니다.')).toBeVisible();
    expect(replaceWithNewsOriginal).not.toHaveBeenCalled();
  },
);
it('keeps unavailable metadata on the ordinary error path', async () => {
  vi.spyOn(api, 'newsDetail').mockRejectedValue(
    new ApiError(404, 'NOT_FOUND', '뉴스를 찾을 수 없습니다.'),
  );
  show();
  expect(await screen.findByText('뉴스를 찾을 수 없습니다.')).toBeVisible();
  expect(replaceWithNewsOriginal).not.toHaveBeenCalled();
});
