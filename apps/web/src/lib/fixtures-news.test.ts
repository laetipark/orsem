import { expect, it } from 'vitest';
import type { CursorPage, SearchResults, SourceItem } from '../types';
import { fixtureRequest } from './fixtures';
import { fixtureGroups } from './company-membership-fixtures';

it('수집 뉴스 fixture는 정렬된 커서 페이지를 중복 없이 반환한다', async () => {
  const first = await fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?limit=2');
  const second = await fixtureRequest<CursorPage<SourceItem>>(
    `/api/v1/news?limit=2&cursor=${first.nextCursor}`,
  );

  expect(first.items.map((item) => item.id)).toEqual([
    'fixture-news-samsung-global-01',
    'fixture-news-fed-release-01',
  ]);
  expect(first.nextCursor).toBe('2');
  expect(second.items.map((item) => item.id)).toEqual(['fixture-news-bls-release-01']);
  expect(second.items.map((item) => item.id)).not.toEqual(
    expect.arrayContaining(first.items.map((item) => item.id)),
  );
  expect(second.nextCursor).toBeNull();
});

it('수집 뉴스 fixture는 지역·출처·제공자·기업·번역 검색 필터를 적용한다', async () => {
  const [kr, us, publisher, company, translated, unapproved] = await Promise.all([
    fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?region=kr&limit=100'),
    fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?region=us&limit=100'),
    fixtureRequest<CursorPage<SourceItem>>(
      '/api/v1/news?sourceKind=OFFICIAL_RELEASE&publisher=federal-reserve&q=policy',
    ),
    fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?companyId=company-samsung'),
    fixtureRequest<CursorPage<SourceItem>>(`/api/v1/news?q=${encodeURIComponent('반도체')}`),
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
  expect(company.items.map((item) => item.id)).toEqual(['fixture-news-samsung-global-01']);
  expect(translated.items.map((item) => item.id)).toEqual(['fixture-news-samsung-global-01']);
  expect(unapproved.items).toEqual([]);
});

it('통합 검색 fixture는 본문 없이 승인된 뉴스 요약과 원문 링크를 반환한다', async () => {
  const [approved, unapproved] = await Promise.all([
    fixtureRequest<SearchResults>('/api/v1/search?q=Samsung'),
    fixtureRequest<SearchResults>('/api/v1/search?q=Microsoft'),
  ]);
  expect(approved.news).toHaveLength(1);
  expect(approved.news[0]).toMatchObject({
    id: 'fixture-news-samsung-global-01',
    external: true,
    url: 'https://example.test/orsem/news/samsung-global-01',
    translationStatus: 'COMPLETED',
    relatedCompanies: [expect.objectContaining({ id: 'company-samsung', nameKo: '삼성전자' })],
  });
  expect(unapproved.news).toEqual([]);
});

it('legacy news detail exposes only metadata and both body editor methods return 410', async () => {
  const id = 'fixture-news-bls-release-01';
  const detail = await fixtureRequest<import('../types').NewsDetail>(`/api/v1/news/${id}`);
  expect(detail.content).toBeNull();
  expect(detail.contentSourceId).toBeNull();
  expect(detail.displayMode).toBe('EXTERNAL_LINK');
  expect(detail.url).toBe('https://example.test/orsem/news/bls-release-01');
  for (const method of ['GET', 'PATCH'])
    await expect(
      fixtureRequest(`/api/v1/news/${id}/translation-edit`, {
        method,
        ...(method === 'PATCH'
          ? { body: JSON.stringify({ markdown: 'outdated cached body' }) }
          : {}),
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
  const unchanged = await fixtureRequest<import('../types').NewsDetail>(`/api/v1/news/${id}`);
  expect(unchanged).toEqual(detail);
});

it('news scopes isolate common-market and related-company metadata while absent asset fixtures remain empty', async () => {
  const market = await fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?scope=market');
  expect(market.items.map((item) => item.publisherId)).toEqual(['federal-reserve', 'bls']);
  expect(market.items.every((item) => item.contentState === 'UNAVAILABLE')).toBe(true);
  const company = await fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?scope=company');
  expect(company.items.map((item) => item.id)).toEqual(['fixture-news-samsung-global-01']);
  expect(company.items[0]?.relatedCompanies?.[0]?.id).toBe('company-samsung');
  expect((await fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?asset=wti')).items).toEqual(
    [],
  );
  expect(
    (await fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?source=NEWS_RSS')).items.map(
      (item) => item.publisherId,
    ),
  ).toEqual(['federal-reserve', 'bls']);
  expect(
    (await fixtureRequest<SearchResults>('/api/v1/search?q=Samsung&scope=market')).news,
  ).toEqual([]);
  expect(
    (await fixtureRequest<SearchResults>('/api/v1/search?q=policy&scope=market')).news[0]?.external,
  ).toBe(true);
});

it('recent-company fixtures match related companies and never replace an empty selection with market news', async () => {
  const [recent, empty, unrelated] = await Promise.all([
    fixtureRequest<CursorPage<SourceItem>>(
      '/api/v1/news?scope=company&companyIds=company-samsung,company-msft',
    ),
    fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?scope=company&companyIds='),
    fixtureRequest<CursorPage<SourceItem>>('/api/v1/news?scope=company&companyIds=company-msft'),
  ]);
  expect(recent.items.map((item) => item.id)).toEqual(['fixture-news-samsung-global-01']);
  expect(
    recent.items.every((item) =>
      item.relatedCompanies?.some((company) => company.id === 'company-samsung'),
    ),
  ).toBe(true);
  expect(empty).toEqual({ items: [], nextCursor: null });
  expect(unrelated).toEqual({ items: [], nextCursor: null });
  const ids = Array.from({ length: 21 }, (_, index) => `company-${index}`).join(',');
  await expect(
    fixtureRequest(`/api/v1/news?scope=company&companyIds=${ids}`),
  ).rejects.toMatchObject({
    statusCode: 400,
  });
});

it('personal-news fixtures derive their companies from personal groups and hide them when signed out', async () => {
  const original = await fixtureRequest<{ companyCount: number; news: SourceItem[] }>(
    '/api/v1/dashboard/personal-news',
  );
  expect(original.companyCount).toBeGreaterThan(0);
  expect(
    original.news.every((item) =>
      item.relatedCompanies?.some((company) => company.id === 'company-samsung'),
    ),
  ).toBe(true);
  const personal = fixtureGroups.filter((group) => group.kind === 'PERSONAL');
  const originalIds = personal.map((group) => new Set(group.companyIds));
  try {
    personal.forEach((group) => {
      group.companyIds = new Set();
    });
    expect(await fixtureRequest('/api/v1/dashboard/personal-news')).toMatchObject({
      companyCount: 0,
      news: [],
      events: [],
    });
    await fixtureRequest('/api/v1/auth/logout', { method: 'POST' });
    expect(await fixtureRequest('/api/v1/dashboard/personal-news')).toMatchObject({
      companyCount: 0,
      news: [],
      events: [],
    });
  } finally {
    personal.forEach((group, index) => {
      group.companyIds = originalIds[index]!;
    });
    await fixtureRequest('/api/v1/auth/login', { method: 'POST' });
  }
});
