import { expect, it } from 'vitest';
import { chronologicalNewsItems, newsItems } from './news-feed';
import { expireNews } from './news-cache';
import type { NaverNewsResultSet, SourceItem } from '../types';
const item = (id: string, date: string, url = id, expiresAt?: string) =>
  ({
    id,
    url: `https://news.test/${url}`,
    publishedAt: date,
    firstObservedAt: date,
    expiresAt,
    title: id,
  }) as SourceItem;
it('keeps stored pagination separate from provider results and deduplicates stored URLs', () => {
  const pages = [
    {
      items: [item('stored', '2026-09-05')],
      providerGroups: [[item('naver-first', '2026-09-06'), item('naver-second', '2026-09-07')]],
    },
    { items: [item('older', '2026-09-04'), item('duplicate', '2026-09-03', 'stored')] },
  ];
  expect(newsItems(pages).map((i) => i.id)).toEqual(['stored', 'older']);
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

const resultSet = (overrides: Partial<NaverNewsResultSet> = {}): NaverNewsResultSet => ({
  queryId: 'company:samsung',
  queryLabel: '삼성전자',
  region: 'kr',
  kind: 'COMPANY',
  fetchedAt: '2026-09-24T08:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  status: 'AVAILABLE',
  reason: null,
  total: 1,
  start: 1,
  display: 1,
  lastBuildDate: null,
  items: [
    {
      title: '<b>삼성전자</b> 뉴스',
      description: '원본 설명',
      originallink: 'https://news.test/same?utm_source=naver#top',
      link: 'https://news.naver.com/article/1',
      pubDate: 'Thu, 24 Sep 2026 16:00:00 +0900',
    },
  ],
  ...overrides,
});

it('merges watchlist news chronologically without changing provider text or raw responses', () => {
  const set = resultSet();
  const pages = [
    {
      items: [
        item('stored', '2026-09-24T06:00:00Z', 'same'),
        item('latest', '2026-09-24T09:00:00Z'),
      ],
      providerResultSets: [set],
    },
  ];
  const original = structuredClone(pages);
  const merged = chronologicalNewsItems(pages);
  expect(merged.map((row) => row.title)).toEqual(['latest', '<b>삼성전자</b> 뉴스']);
  expect(merged[1]).toMatchObject({
    publishedAt: '2026-09-24T07:00:00.000Z',
    rightsMode: 'LINK_ONLY',
    provenanceUrl: 'https://news.naver.com/article/1',
    providerOriginal: set.items[0],
  });
  expect(pages).toEqual(original);
});

it('restores stored duplicates when NAVER expires and ignores expired normalized copies', () => {
  const stored = item('stored', '2026-09-24T06:00:00Z', 'same');
  const expired = resultSet({ expiresAt: '2000-01-01T00:00:00Z' });
  expect(
    chronologicalNewsItems([
      {
        items: [stored],
        providerResultSets: [expired],
        providerGroups: [[item('naver', '2026-09-24T07:00:00Z', 'same', expired.expiresAt!)]],
      },
    ]),
  ).toEqual([stored]);
});

it('uses observation time for undated results and falls back to a safe NAVER link', () => {
  const set = resultSet();
  set.items[0] = { ...set.items[0]!, pubDate: '', originallink: 'javascript:alert(1)' };
  const merged = chronologicalNewsItems([
    {
      items: [item('older', '2026-09-24T07:00:00Z')],
      providerResultSets: [set],
    },
  ]);
  expect(merged[0]).toMatchObject({
    url: set.items[0].link,
    publishedAt: null,
    firstObservedAt: set.fetchedAt,
  });
  expect(merged[1]?.id).toBe('older');
});
