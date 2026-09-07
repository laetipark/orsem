import { expect, it } from 'vitest';
import type { WatchRoom } from '@orsem/contracts';
import type {
  CompanyDetail,
  WatchlistFilings,
  WatchlistGroup,
  WatchlistGroupPage,
  WatchlistNewsPage,
  WatchlistGroupItem,
  CompanyTimeline,
} from '../types';
import { fixtureRequest } from './fixtures';
import { fixtureGroups } from './company-membership-fixtures';
import { watchlistWorkspaceFixture } from './watchlist-workspace-fixtures';

interface FixtureCompanyQuotes {
  asOf: string;
  items: Array<{ companyId: string; displayPrice: WatchlistGroupItem['displayPrice'] }>;
}

it('general quote fixtures accept unwatched companies, omit unknown IDs and retain the legacy watchlist contract', async () => {
  expect(fixtureGroups.every((group) => !group.companyIds.has('company-rainbow'))).toBe(true);
  const [quotes, timeline, legacy] = await Promise.all([
    fixtureRequest<FixtureCompanyQuotes>(
      '/api/v1/companies/quotes?ids=company-rainbow,missing-company,company-msft',
    ),
    fixtureRequest<CompanyTimeline>('/api/v1/companies/company-rainbow/timeline?interval=1m'),
    fixtureRequest<{ items: unknown[] }>('/api/v1/watchlist/quotes?ids=company-rainbow'),
  ]);
  expect(quotes.items.map((item) => item.companyId)).toEqual(['company-rainbow', 'company-msft']);
  expect(quotes.items[0]?.displayPrice).toMatchObject({
    price: String(timeline.prices.at(-1)?.close),
    currency: 'KRW',
    status: 'STALE',
    basis: 'STALE',
    source: '개발용 모의 데이터 · 실제 시세 아님',
    sessionDate: '2026-09-03',
    referenceDate: '2026-09-02',
  });
  expect(quotes.items[1]?.displayPrice).toMatchObject({
    currency: 'USD',
    sessionDate: '2026-09-02',
    referenceDate: '2026-09-01',
  });
  expect(quotes.items[0]?.displayPrice.changePercent).not.toBeNull();
  expect(legacy.items).toEqual([]);
});

it('general quote fixtures keep empty requests empty and reject oversized or duplicate ID batches', async () => {
  expect(await fixtureRequest('/api/v1/companies/quotes?ids=')).toMatchObject({ items: [] });
  for (const ids of [
    Array.from({ length: 21 }, (_, index) => `company-${index}`).join(','),
    'company-rainbow,company-rainbow',
  ]) {
    await expect(fixtureRequest(`/api/v1/companies/quotes?ids=${ids}`)).rejects.toMatchObject({
      statusCode: 400,
    });
  }
});

it('group news keeps all filter companies while filtering and paging within the selected group', async () => {
  const group = fixtureGroups.find((group) => group.id === 'fixture-personal-semiconductors')!;
  const original = new Set(group.companyIds);
  group.companyIds.add('company-msft');
  try {
    const page = await fixtureRequest<WatchlistNewsPage>(
      `/api/v1/watchlist-groups/${group.id}/news?limit=1`,
    );
    expect(page.group.id).toBe(group.id);
    expect(page.companyCount).toBe(2);
    expect(page.companies.map((company) => company.id)).toEqual([
      'company-samsung',
      'company-msft',
    ]);
    expect(page.items.map((item) => item.id)).toEqual(['fixture-news-samsung-global-01']);
    expect(page.items[0]).toMatchObject({
      displayMode: 'EXTERNAL_LINK',
      contentState: 'UNAVAILABLE',
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
      provenanceUrl: 'https://example.test/orsem/news/samsung-global-01',
    });
    const filtered = await fixtureRequest<WatchlistNewsPage>(
      `/api/v1/watchlist-groups/${group.id}/news?companyId=company-msft`,
    );
    expect(filtered.companyCount).toBe(1);
    expect(filtered.companies).toEqual(page.companies);
    expect(filtered.items).toEqual([]);
    const following = await fixtureRequest<WatchlistNewsPage>(
      `/api/v1/watchlist-groups/${group.id}/news?limit=1&cursor=1`,
    );
    expect(following.items).toEqual([]);
    expect(following.nextCursor).toBeNull();
  } finally {
    group.companyIds = original;
  }
});

it('group filings retain source dates and return only official documents for the selected company', async () => {
  const group = fixtureGroups.find((group) => group.id === 'fixture-personal-semiconductors')!;
  const original = new Set(group.companyIds);
  group.companyIds.add('company-msft');
  try {
    const result = await fixtureRequest<WatchlistFilings>(
      `/api/v1/watchlist-groups/${group.id}/filings?companyId=company-msft`,
    );
    expect(result.companyCount).toBe(1);
    expect(result.companies).toHaveLength(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      source: 'SEC',
      title: 'Form 8-K',
      filingDate: null,
      publishedAt: '2026-09-02T22:31:00.000Z',
      firstObservedAt: '2026-09-02T22:32:05.000Z',
      relatedCompanies: [expect.objectContaining({ id: 'company-msft' })],
    });
    const dart = await fixtureRequest<WatchlistFilings>(
      `/api/v1/watchlist-groups/${group.id}/filings?companyId=company-samsung`,
    );
    expect(dart.items[0]).toMatchObject({
      source: 'OPENDART',
      externalId: '20260903000001',
      filingDate: '2026-09-03',
      publishedAt: null,
      firstObservedAt: '2026-09-03T06:12:18.000Z',
      url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260903000001',
    });
  } finally {
    group.companyIds = original;
  }
});

it('readonly shared fixture rooms remain readable and reject stock edits', async () => {
  const rooms = await fixtureRequest<{ items: WatchRoom[] }>('/api/v1/watchlist-rooms');
  expect(rooms.items).toContainEqual(
    expect.objectContaining({ id: 'fixture-readonly-room', canManageStocks: false }),
  );
  const groups = await fixtureRequest<{ items: WatchlistGroup[] }>(
    '/api/v1/watchlist-groups?roomId=fixture-readonly-room',
  );
  expect(groups.items).toHaveLength(1);
  expect(groups.items[0]).toMatchObject({
    id: 'fixture-room-stable',
    canManageStocks: false,
    canEdit: false,
    isShared: true,
  });
  const news = await fixtureRequest<WatchlistNewsPage>(
    '/api/v1/watchlist-groups/fixture-room-stable/news',
  );
  const filings = await fixtureRequest<WatchlistFilings>(
    '/api/v1/watchlist-groups/fixture-room-stable/filings',
  );
  expect(news.items).toHaveLength(1);
  expect(filings.items.length).toBeGreaterThan(0);
  await expect(
    fixtureRequest('/api/v1/watchlist-groups/fixture-room-stable/edit', {
      method: 'PUT',
      body: JSON.stringify({ revision: 2, companyIds: [] }),
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
});

it('empty, missing and inaccessible scopes never return other groups or broad news', async () => {
  const group = fixtureGroups.find((group) => group.id === 'fixture-personal-semiconductors')!;
  const original = new Set(group.companyIds);
  group.companyIds = new Set();
  try {
    for (const endpoint of ['news', 'filings']) {
      const empty = await fixtureRequest(`/api/v1/watchlist-groups/${group.id}/${endpoint}`);
      expect(empty).toMatchObject({ companyCount: 0, companies: [], items: [] });
      await expect(
        fixtureRequest(`/api/v1/watchlist-groups/${group.id}/${endpoint}?companyId=company-msft`),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        fixtureRequest(`/api/v1/watchlist-groups/missing/${endpoint}`),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    await fixtureRequest('/api/v1/auth/logout', { method: 'POST' });
    await expect(fixtureRequest(`/api/v1/watchlist-groups/${group.id}/news`)).rejects.toMatchObject(
      { statusCode: 401 },
    );
  } finally {
    group.companyIds = original;
    await fixtureRequest('/api/v1/auth/login', { method: 'POST' });
  }
});

it('fixture stock pages honor default twenty, compact limits and offsets without losing total counts', async () => {
  const template = await fixtureRequest<CompanyDetail>('/api/v1/companies/company-samsung');
  const companies = Array.from({ length: 25 }, (_, index) => ({
    ...template,
    id: `fixture-page-company-${index}`,
  }));
  const group = {
    ...fixtureGroups[0]!,
    id: 'fixture-paged-group',
    companyIds: new Set(companies.map((company) => company.id)),
  };
  fixtureGroups.push(group);
  const page = (query = '') =>
    watchlistWorkspaceFixture(
      `/watchlist-groups/${group.id}/items`,
      'GET',
      null,
      companies,
      '2026-09-03T08:42:00.000Z',
      {
        searchParams: new URLSearchParams(query),
        authenticated: true,
        news: () => ({ items: [], nextCursor: null }),
        filings: () => [],
      },
    ).value as WatchlistGroupPage;
  try {
    expect(page()).toMatchObject({ total: 25, nextOffset: 20 });
    expect(page().items).toHaveLength(20);
    for (const limit of [3, 6, 20]) {
      const first = page(`limit=${limit}`);
      const second = page(`limit=${limit}&offset=${first.nextOffset}`);
      expect(first.items).toHaveLength(limit);
      expect(second.items[0]?.company.id).toBe(companies[limit]?.id);
      expect(new Set([...first.items, ...second.items].map((item) => item.company.id)).size).toBe(
        first.items.length + second.items.length,
      );
      expect(second.total).toBe(25);
    }
    expect(page('limit=20&offset=20')).toMatchObject({ total: 25, nextOffset: null });
    expect(page('offset=25').items).toEqual([]);
  } finally {
    fixtureGroups.splice(fixtureGroups.indexOf(group), 1);
  }
});
