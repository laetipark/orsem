import { expect, it } from 'vitest';
import { newsItems } from './news-feed';
import { expireNews } from './news-cache';
import type { SourceItem } from '../types';
const item = (id: string, date: string, url = id, expiresAt?: string) =>
  ({
    id,
    url: `https://news.test/${url}`,
    publishedAt: date,
    firstObservedAt: date,
    expiresAt,
    title: id,
  }) as SourceItem;
it('merges paginated articles with provider order and URL deduplication without losing stored rows', () => {
  const pages = [
    {
      items: [item('stored', '2026-09-05')],
      providerGroups: [[item('naver-first', '2026-09-06'), item('naver-second', '2026-09-07')]],
    },
    { items: [item('older', '2026-09-04'), item('duplicate', '2026-09-03', 'stored')] },
  ];
  expect(newsItems(pages).map((i) => i.id)).toEqual([
    'naver-first',
    'naver-second',
    'stored',
    'older',
  ]);
});
it('expires raw provider cache and restores a duplicate stored article', () => {
  const raw = {
    items: [item('stored', '2026-09-04', 'same')],
    providerGroups: [[item('naver', '2026-09-05', 'same', '2000-01-01T00:00:00Z')]],
  };
  expect(newsItems([raw]).map((i) => i.id)).toEqual(['stored']);
  const expired = expireNews(raw, Date.now()) as typeof raw;
  expect(expired.providerGroups[0]).toEqual([]);
  expect(expired.items).toBe(raw.items);
  expect(expireNews(expired, Date.now())).toBe(expired);
});
