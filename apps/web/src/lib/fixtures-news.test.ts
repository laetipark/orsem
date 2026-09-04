import { expect, it } from 'vitest';
import type { CursorPage, NaverNewsSearchResult, SourceItem } from '../types';
import { fixtureRequest } from './fixtures';

it('수집 뉴스 fixture는 정렬된 커서 페이지를 중복 없이 반환한다', async () => {
  const first = await fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?limit=3');
  const second = await fixtureRequest<CursorPage<SourceItem>>(
    `/api/v1/news?limit=3&cursor=${first.nextCursor}`,
  );

  expect(first.items.map((item) => item.id)).toEqual([
    'fixture-news-etoday-market-01',
    'fixture-news-fed-release-01',
    'fixture-news-msft-ir-01',
  ]);
  expect(first.nextCursor).toBe('3');
  expect(second.items).toHaveLength(3);
  expect(second.items.map((item) => item.id)).not.toEqual(
    expect.arrayContaining(first.items.map((item) => item.id)),
  );
  expect(second.nextCursor).toBe('6');
});

it('수집 뉴스 fixture는 지역·출처·제공자·기업·번역 검색 필터를 적용한다', async () => {
  const [kr, us, publisher, company, translated] = await Promise.all([
    fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?region=kr&limit=100'),
    fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?region=us&limit=100'),
    fixtureRequest<CursorPage<SourceItem>>(
      '/api/v1/news?sourceKind=OFFICIAL_RELEASE&publisher=federal-reserve&q=policy',
    ),
    fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?companyId=company-samsung'),
    fixtureRequest<CursorPage<SourceItem>>(`/api/v1/news?q=${encodeURIComponent('클라우드')}`),
  ]);

  expect(
    kr.items.every((item) => item.marketRegion === 'kr' || item.marketRegion === 'global'),
  ).toBe(true);
  expect(
    us.items.every((item) => item.marketRegion === 'us' || item.marketRegion === 'global'),
  ).toBe(true);
  expect(kr.items.some((item) => item.marketRegion === 'global')).toBe(true);
  expect(us.items.some((item) => item.marketRegion === 'global')).toBe(true);
  expect(publisher.items.map((item) => item.id)).toEqual(['fixture-news-fed-release-01']);
  expect(company.items.map((item) => item.id)).toEqual(['fixture-news-etoday-market-01']);
  expect(translated.items.map((item) => item.id)).toEqual(['fixture-news-msft-ir-01']);
});

it('NAVER 검색 fixture는 헤더 입력을 안전하게 표시하고 20개 단위 페이지를 재현한다', async () => {
  const query = '<b>& 삼성전자';
  const headers = {
    'X-Orsem-News-Query': encodeURIComponent(query),
    'X-Orsem-News-Start': '21',
    'X-Orsem-News-Sort': 'sim',
  };
  const first = await fixtureRequest<NaverNewsSearchResult>('/api/v1/news-search/naver', {
    headers,
  });
  const repeated = await fixtureRequest<NaverNewsSearchResult>('/api/v1/news-search/naver', {
    headers,
  });
  const last = await fixtureRequest<NaverNewsSearchResult>('/api/v1/news-search/naver', {
    headers: { ...headers, 'X-Orsem-News-Start': '41' },
  });

  expect(first).toEqual(repeated);
  expect(first).toMatchObject({ provider: 'NAVER', total: 45, start: 21, display: 20 });
  expect(first.items[0]?.title).toContain('&lt;b&gt;&amp; 삼성전자');
  expect(first.items[0]?.title).not.toContain('<b><b>');
  expect(first.items.every((item) => new URL(item.link).hostname.endsWith('.example.test'))).toBe(
    true,
  );
  expect(first.items.every((item) => !item.link.includes(encodeURIComponent(query)))).toBe(true);
  expect(last).toMatchObject({ total: 45, start: 41, display: 5 });
});
