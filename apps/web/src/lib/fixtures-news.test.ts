import { expect, it } from 'vitest';
import type { CursorPage, NaverNewsSearchResult, SearchResults, SourceItem } from '../types';
import { fixtureRequest } from './fixtures';

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

it('통합 검색 fixture도 본문과 영어 번역이 준비된 승인 뉴스만 내부 상세로 연결한다', async () => {
  const [approved, unapproved] = await Promise.all([
    fixtureRequest<SearchResults>('/api/v1/search?q=Samsung'),
    fixtureRequest<SearchResults>('/api/v1/search?q=Microsoft'),
  ]);
  expect(approved.news).toHaveLength(1);
  expect(approved.news[0]).toMatchObject({
    id: 'fixture-news-samsung-global-01',
    external: false,
    url: '/news/fixture-article-samsung-global-01',
  });
  expect(unapproved.news).toEqual([]);
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

it('translation-edit fixtures preserve the original, update displayed copies and reject stale revisions', async () => {
  const id = 'fixture-news-bls-release-01';
  const before = await fixtureRequest<import('../types').NewsDetail>(`/api/v1/news/${id}`);
  const edit = await fixtureRequest<import('../types').NewsTranslationEdit>(
    `/api/v1/news/${id}/translation-edit`,
  );
  const input = {
    revision: edit.revision,
    title: '편집 검증 제목',
    description: null,
    markdown: '## 수정 문단\n\n**수정** 본문',
  };
  const saved = await fixtureRequest<import('../types').NewsTranslationEdit>(
    `/api/v1/news/${id}/translation-edit`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  expect(saved.revision).not.toBe(edit.revision);
  const after = await fixtureRequest<import('../types').NewsDetail>(`/api/v1/news/${id}`);
  expect(after.content!.original).toEqual(before.content!.original);
  expect(after.title).toBe(before.title);
  expect(after.rightsMode).toBe(before.rightsMode);
  expect(after.translation).toMatchObject({
    title: input.title,
    description: null,
    editedAt: saved.editedAt,
  });
  expect(after.content!.translation).toMatchObject({ format: 'MARKDOWN' });
  await expect(
    fixtureRequest(`/api/v1/news/${id}/translation-edit`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const list = await fixtureRequest<CursorPage<SourceItem>>('/api/v1/news');
  expect(list.items.find((item) => item.id === id)?.translation?.title).toBe(input.title);
});
