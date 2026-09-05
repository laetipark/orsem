import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { NewsTranslation, SourceFreshness, SourceItem } from '../types';
import { MarketNewsList, safeNewsUrl, summarizeNewsFreshness } from './market-news';

const translation: NewsTranslation = {
  language: 'ko',
  title: '회사가 실적 전망을 발표했습니다',
  description: '검증된 번역 설명입니다.',
  translatedAt: '2026-09-05T00:01:00.000Z',
  provider: 'LOCAL',
  model: 'test-local-model',
};

function newsItem(patch: Partial<SourceItem> = {}): SourceItem {
  return {
    id: 'news-1',
    articleId: 'article-1',
    sourceCount: 2,
    contentState: 'AVAILABLE',
    contentSourceId: 'source-1',
    contentLanguage: 'en',
    translated: true,
    sourceKind: 'INDEPENDENT_MEDIA',
    publisherId: 'publisher-one',
    marketRegion: 'unknown',
    sources: [
      {
        id: 'source-1',
        source: 'NEWS_RSS',
        sourceName: '첫 번째 언론사',
        url: 'https://publisher-one.example/story',
      },
      {
        id: 'source-2',
        source: 'GDELT',
        sourceName: '두 번째 언론사',
        url: 'https://publisher-two.example/story',
      },
    ],
    source: 'NEWS_RSS',
    externalId: 'story-1',
    url: 'https://publisher-one.example/story',
    title: 'Company publishes its outlook',
    description: 'The original verified summary.',
    translation,
    sourceName: '첫 번째 언론사',
    author: null,
    publishedAt: '2026-09-05T00:00:00.000Z',
    firstObservedAt: '2026-09-05T00:02:00.000Z',
    processedAt: '2026-09-05T00:03:00.000Z',
    rightsMode: 'STORE_METADATA_ONLY',
    provenanceUrl: null,
    tickers: [],
    tags: [],
    ...patch,
  };
}

describe('market news presentation', () => {
  it('shows a verified translation, unknown region, and each safe grouped source', () => {
    const { container } = render(
      <MemoryRouter>
        <MarketNewsList items={[newsItem()]} />
      </MemoryRouter>,
    );

    expect(screen.getByText(translation.title)).toHaveAttribute('lang', 'ko');
    expect(screen.getByText(translation.description!)).toHaveAttribute('lang', 'ko');
    expect(screen.getByText('Company publishes its outlook')).toBeVisible();
    expect(screen.getByText('The original verified summary.')).toBeVisible();
    expect(screen.getByText('자동 번역')).toBeVisible();
    expect(screen.getByText('지역 미확인')).toBeVisible();
    expect(screen.getByText('2개 출처에서 확인')).toBeVisible();

    const sourceDetails = screen.getByText('연결된 원문 출처 2개').closest('details')!;
    fireEvent.click(within(sourceDetails).getByText('연결된 원문 출처 2개'));
    expect(within(sourceDetails).getByRole('link', { name: /첫 번째 언론사/ })).toHaveAttribute(
      'href',
      'https://publisher-one.example/story',
    );
    expect(within(sourceDetails).getByRole('link', { name: /두 번째 언론사/ })).toHaveAttribute(
      'href',
      'https://publisher-two.example/story',
    );
    expect(screen.getByRole('link', { name: /뉴스 상세 보기/ })).toHaveAttribute(
      'href',
      '/news/article-1',
    );
    expect(container.querySelector('a a')).toBeNull();
  });

  it('does not turn credentialed or non-http source values into links', () => {
    const { container } = render(
      <MemoryRouter>
        <MarketNewsList
          items={[
            newsItem({
              url: 'javascript:alert(1)',
              sources: [
                {
                  id: 'unsafe-1',
                  source: 'NEWS_RSS',
                  sourceName: '위험한 링크',
                  url: 'https://user:password@example.test/story',
                },
                {
                  id: 'safe-1',
                  source: 'NEWS_RSS',
                  sourceName: '검증된 링크',
                  url: 'https://safe.example/story',
                },
              ],
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /뉴스 상세 보기/ })).toHaveAttribute(
      'href',
      '/news/article-1',
    );
    expect(container.querySelector('a[href^="javascript:"], a[href*="password"]')).toBeNull();
    fireEvent.click(screen.getByText('연결된 원문 출처 1개'));
    expect(screen.getByRole('link', { name: /검증된 링크/ })).toHaveAttribute(
      'href',
      'https://safe.example/story',
    );
    expect(safeNewsUrl('data:text/html,unsafe')).toBeNull();
  });
});

describe('news freshness summary', () => {
  const source = (
    id: string,
    category: SourceFreshness['category'],
    status: SourceFreshness['status'],
    lastSuccessAt: string | null,
  ): SourceFreshness => ({
    id,
    name: id,
    category,
    status,
    lastSuccessAt,
    lagSeconds: null,
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    message: null,
  });

  it('includes official collection sources without hiding a healthy feed behind optional sources', () => {
    const result = summarizeNewsFreshness([
      source('opendart', 'OFFICIAL', 'UNCONFIGURED', null),
      source('news_rss', 'NEWS', 'HEALTHY', '2026-09-05T00:00:00.000Z'),
      source('naver', 'NEWS', 'FAILED', null),
      source('ai', 'OFFICIAL', 'FAILED', null),
      source('gold', 'MARKET', 'FAILED', null),
    ]);

    expect(result.sources.map((item) => item.id)).toEqual(['news_rss']);
    expect(result.status).toBe('HEALTHY');
    expect(result.latest).toBe('2026-09-05T00:00:00.000Z');
  });

  it('reports unconfigured and disabled states when no collection source is healthy', () => {
    expect(summarizeNewsFreshness([source('ir', 'OFFICIAL', 'UNCONFIGURED', null)]).status).toBe(
      'UNCONFIGURED',
    );
    expect(summarizeNewsFreshness([source('ir', 'OFFICIAL', 'DISABLED', null)]).status).toBe(
      'DISABLED',
    );
  });
});
