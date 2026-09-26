import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { NaverNewsResultSet } from '../types';
import { NaverNewsResults } from './naver-news-results';
import { newsItems, newsResultSets } from '../lib/news-feed';

const set: NaverNewsResultSet = {
  queryId: 'topic:kr-equities',
  queryLabel: '국내 증시',
  kind: 'MARKET',
  region: 'kr',
  fetchedAt: '2026-09-24T08:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  status: 'AVAILABLE',
  reason: null,
  total: 3,
  start: 1,
  display: 3,
  lastBuildDate: '2026-09-24T08:00:00Z',
  items: [
    {
      title: '첫 번째 결과',
      description: '제공 설명',
      originallink: 'https://example.com/one',
      link: 'https://news.naver.com/one',
      pubDate: '2026-09-23T00:00:00Z',
    },
    {
      title: '중복 링크 두 번째 결과',
      description: '두 번째 설명',
      originallink: 'https://example.com/one',
      link: 'https://news.naver.com/two',
      pubDate: '2026-09-24T00:00:00Z',
    },
    {
      title: '<b>NEW</b> 일반 단어',
      description: '<script>alert(1)</script>',
      originallink: 'javascript:alert(1)',
      link: 'javascript:alert(2)',
      pubDate: '',
    },
  ],
};

describe('independent NAVER search responses', () => {
  it('preserves result order and duplicates, escapes unsafe text, and avoids company badges', () => {
    const { container } = render(<NaverNewsResults sets={[set]} />);
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('첫 번째 결과');
    expect(items[1]).toHaveTextContent('중복 링크 두 번째 결과');
    expect(items[2]).toHaveTextContent('NEW 일반 단어');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.queryByLabelText('관련 종목')).toBeNull();
  });
  it('drops expired result sets and does not merge provider articles into stored news', () => {
    expect(
      newsResultSets([{ providerResultSets: [{ ...set, expiresAt: '2000-01-01T00:00:00Z' }] }]),
    ).toEqual([]);
    expect(newsResultSets([{ providerResultSets: [set] }, { providerResultSets: [set] }])).toEqual([
      set,
    ]);
    expect(
      newsItems([
        {
          items: [],
          providerGroups: [{ id: 'provider', source: 'NAVER' } as never].map((item) => [item]),
        },
      ]),
    ).toEqual([]);
  });
});
