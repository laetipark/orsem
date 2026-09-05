import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import type { NewsDetail } from '../types';
import { NewsDetailPage } from './news-detail-page';

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

afterEach(() => vi.restoreAllMocks());

describe('news detail page', () => {
  it('uses one content source, presents Korean first and keeps the English original collapsible', async () => {
    vi.spyOn(api, 'newsDetail').mockResolvedValue(detail);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/news/article-1']}>
          <Routes>
            <Route path="/news/:id" element={<NewsDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      '삼성전자, 사업 현황 발표',
    );
    expect(screen.getByText('한국어로 번역한 본문입니다.')).toBeVisible();
    expect(screen.getByRole('link', { name: /원문 사이트/ })).toHaveAttribute('href', detail.url);
    expect(screen.getByText(/발행.*KST/)).toBeVisible();
    const original = screen.getByText('영문 원문 펼치기').closest('details')!;
    fireEvent.click(within(original).getByText('영문 원문 펼치기'));
    expect(within(original).getByText('Original English body.')).toBeVisible();
    expect(screen.getByText('기업 IR')).toBeVisible();
    expect(screen.queryByText(/본문 출처 ID/)).not.toBeInTheDocument();
    expect(api.newsDetail).toHaveBeenCalledWith('article-1');
  });
});
