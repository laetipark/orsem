import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { mockMediaQuery } from '../test/media-query';
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
    providerCount: 2,
    independentSourceCount: 1,
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
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    provenanceUrl: null,
    tickers: [],
    tags: [],
    ...patch,
  };
}

describe('market news presentation', () => {
  it('shows headline and summary in compact mode with an external original link', () => {
    render(
      <MemoryRouter>
        <MarketNewsList
          items={[newsItem({ rightsMode: 'OFFICIAL_PUBLIC_DATA', summaryLine: translation.title })]}
          headlineOnly
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(translation.title)).toBeVisible();
    expect(screen.getByText(translation.description!)).toBeVisible();
    expect(screen.getByText('자동 번역')).toBeVisible();
    expect(screen.getByText('수집 경로 2개')).toBeVisible();
    expect(screen.getByRole('link', { name: /원문 새 창에서 보기/ })).toHaveAttribute(
      'href',
      'https://publisher-one.example/story',
    );
  });

  it('shows a verified translation, unknown region, and each safe grouped source', () => {
    const { container } = render(
      <MemoryRouter>
        <MarketNewsList items={[newsItem()]} />
      </MemoryRouter>,
    );

    expect(screen.getByText(translation.title)).toHaveAttribute('lang', 'ko');
    expect(screen.getByText(translation.description!)).toHaveAttribute('lang', 'ko');
    expect(screen.queryByText('Company publishes its outlook')).not.toBeInTheDocument();
    expect(screen.queryByText('The original verified summary.')).not.toBeInTheDocument();
    expect(screen.getByText('자동 번역')).toBeVisible();
    expect(screen.getByText('지역 미확인')).toBeVisible();
    expect(screen.getByText('수집 경로 2개')).toBeVisible();

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
    expect(screen.getByRole('link', { name: /원문 새 창에서 보기/ })).toHaveAttribute(
      'href',
      'https://publisher-one.example/story',
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

    expect(screen.queryByRole('link', { name: /원문 새 창에서 보기/ })).toBeNull();
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

it('keeps metadata-only media in original-link cards with related companies and GDELT attribution', () => {
  const { container } = render(
    <MemoryRouter>
      <MarketNewsList
        items={[
          newsItem({
            source: 'GDELT',
            rightsMode: 'STORE_METADATA_ONLY',
            displayMode: 'EXTERNAL_LINK',
            sourceName: 'publisher-one.example',
            relatedCompanies: [
              {
                id: 'company-1',
                nameKo: '관련 기업',
                nameEn: 'Related',
                market: 'KRX',
                stockCode: '000000',
                ticker: null,
              },
            ],
          }),
        ]}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole('link', { name: /Company publishes its outlook.*원문 새 창에서 보기/ }),
  ).toHaveAttribute('href', 'https://publisher-one.example/story');
  expect(screen.queryByText(translation.title)).not.toBeInTheDocument();
  expect(screen.queryByText('The original verified summary.')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /뉴스 상세 보기/ })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '관련 기업' })).toHaveAttribute(
    'href',
    '/companies/company-1',
  );
  expect(screen.getByRole('link', { name: /데이터 제공 GDELT/ })).toHaveAttribute(
    'href',
    'https://www.gdeltproject.org/',
  );
  expect(container.querySelector('a a')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
});

it('keeps company navigation separate and adjusts the visible badge count after resize', () => {
  const { resize } = mockMediaQuery(false);
  const companies = ['삼성전자', 'SK하이닉스', '현대차'].map((nameKo, index) => ({
    id: `company-${index}`,
    nameKo,
    nameEn: null,
    market: 'KOSPI' as const,
    stockCode: ['005930', '000660', '005380'][index]!,
    ticker: null,
  }));
  const { container, unmount } = render(
    <MemoryRouter>
      <MarketNewsList items={[newsItem({ relatedCompanies: [...companies, companies[0]!] })]} />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: '삼성전자' })).toHaveAttribute(
    'href',
    '/companies/company-0',
  );
  expect(screen.getByRole('link', { name: 'SK하이닉스' })).toBeVisible();
  expect(screen.queryByRole('link', { name: '현대차' })).toBeNull();
  expect(screen.getByRole('button', { name: '관련 종목 1개 더 보기' })).toHaveTextContent('+1');
  act(() => resize(true));
  expect(screen.queryByRole('link', { name: 'SK하이닉스' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '관련 종목 2개 더 보기' }));
  expect(screen.getByRole('link', { name: '현대차' })).toBeVisible();
  expect(container.querySelector('a a, a button')).toBeNull();
  unmount();
  vi.restoreAllMocks();
});

it('omits OTHER and invalid stock identities from cached news without dropping the article', () => {
  const listed = {
    id: 'samsung',
    nameKo: '삼성전자',
    nameEn: null,
    market: 'KOSPI' as const,
    stockCode: '005930',
    ticker: null,
  };
  render(
    <MemoryRouter>
      <MarketNewsList
        items={[
          newsItem({
            relatedCompanies: [
              { ...listed, id: 'ordinary-word', nameKo: '자금', market: 'OTHER', stockCode: null },
              { ...listed, id: 'invalid-code', nameKo: '대해', stockCode: null },
              listed,
            ],
          }),
        ]}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /원문 새 창에서 보기/ })).toBeVisible();
  expect(screen.getByRole('link', { name: '삼성전자' })).toBeVisible();
  expect(screen.queryByRole('link', { name: '자금' })).toBeNull();
  expect(screen.queryByRole('link', { name: '대해' })).toBeNull();
  expect(screen.queryByRole('button', { name: /관련 종목 .*개 더 보기/ })).toBeNull();
});

it.each([
  ['PENDING', '원문 · 번역 대기'],
  ['FAILED', '원문 · 번역 실패'],
  ['UNAVAILABLE', '원문 · 번역 미제공'],
] as const)('shows original metadata with %s translation state', (translationStatus, label) => {
  render(
    <MemoryRouter>
      <MarketNewsList
        items={[
          newsItem({ translation: null, translated: false, translationStatus, description: null }),
        ]}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('Company publishes its outlook')).toBeVisible();
  expect(screen.getByText('요약 미제공')).toBeVisible();
  expect(screen.getByText(label)).toBeVisible();
});
