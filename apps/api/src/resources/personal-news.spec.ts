import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { OrsemDataService } from './orsem-data.service';
import { DashboardController } from './resource.controllers';
import { newsFiltersSql, newsFilterParameters, representativeNewsSql } from './news-query';

test('personal dashboard derives the actor from the session and rejects ambiguous identity', async () => {
  let received = '';
  const controller = new DashboardController(
    {
      personalNews: async (actor: string) => {
        received = actor;
        return { news: [] };
      },
    } as unknown as OrsemDataService,
    {} as never,
    { feed: async () => ({ groups: [] }) } as never,
  );
  await controller.personalNews({ session: { memberId: 'member-one' } } as Request);
  assert.equal(received, 'MEMBER:member-one');
  await controller.personalNews({ session: { adminId: 'admin-one' } } as Request);
  assert.equal(received, 'ADMIN:admin-one');
  await assert.rejects(() =>
    controller.personalNews({ session: { memberId: 'm', adminId: 'a' } } as Request),
  );
  await assert.rejects(() => controller.personalNews({ session: {} } as Request));
});

test('an empty personal group never falls back to global P2; both feeds share the owner scope', async () => {
  let count = 0;
  const database = {
    dataSource: {
      query: async (sql: string, params: string[]) => {
        assert.match(sql, /g.room_id IS NULL AND g.owner_key=\?/);
        assert.deepEqual(params, ['MEMBER:mine']);
        return [{ companyCount: count }];
      },
    },
  } as unknown as DatabaseRuntimeService;
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
    database,
    new FixtureStoreService(),
  );
  const scopes: unknown[] = [];
  service.listEventViews = async (query) => {
    scopes.push(query);
    return { items: [], nextCursor: null, pageInfo: { nextCursor: null, hasMore: false } };
  };
  service.listNews = async (query) => {
    scopes.push(query);
    return { items: [], nextCursor: null, pageInfo: { nextCursor: null, hasMore: false } };
  };
  assert.equal((await service.personalNews('MEMBER:mine')).companyCount, 0);
  assert.equal(scopes.length, 0);
  count = 2;
  await service.personalNews('MEMBER:mine');
  assert.deepEqual(scopes, [
    { audience: 'MEMBER_UI', personalActorKey: 'MEMBER:mine', limit: 3 },
    { audience: 'MEMBER_UI', personalActorKey: 'MEMBER:mine', scope: 'company', limit: 3 },
  ]);
  const query = { personalActorKey: 'MEMBER:mine' };
  for (const sql of [newsFiltersSql('source', query), representativeNewsSql(query)]) {
    assert.match(
      sql,
      /personal_group.room_id IS NULL AND personal_group.owner_key=:personalActorKey/,
    );
    assert.doesNotMatch(sql, /MEMBER:mine/);
  }
  assert.equal(newsFilterParameters(query).personalActorKey, 'MEMBER:mine');
});

test('personal event queries include multi-class SEC relations inside the same owner scope', async () => {
  const conditions: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const qb = {
    andWhere(sql: string, params?: Record<string, unknown>) {
      conditions.push({ sql, params });
      return this;
    },
    orderBy() {
      return this;
    },
    addOrderBy() {
      return this;
    },
    take() {
      return this;
    },
    async getMany() {
      return [];
    },
  };
  const database = {
    dataSource: { getRepository: () => ({ createQueryBuilder: () => qb }) },
  } as unknown as DatabaseRuntimeService;
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
    database,
    new FixtureStoreService(),
  );
  await service.listEvents({ personalActorKey: 'MEMBER:mine', limit: 3 });
  const personal = conditions.find((entry) => entry.params?.personalActorKey);
  assert.ok(personal);
  assert.match(personal.sql, /personal_item.company_id=event.company_id OR/);
  assert.match(
    personal.sql,
    /JSON_CONTAINS.*relatedCompanyIds.*JSON_QUOTE\(personal_item.company_id\)/,
  );
  assert.match(personal.sql, /personal_group.room_id IS NULL/);
  assert.match(personal.sql, /personal_group.owner_key=:personalActorKey/);
  assert.equal(personal.params?.personalActorKey, 'MEMBER:mine');
});

test('personal filings use session identity and exclude unparsed official sources', async () => {
  let received = '';
  const controller = new DashboardController(
    {
      personalFilings: async (actor: string) => {
        received = actor;
        return {};
      },
    } as unknown as OrsemDataService,
    {} as never,
    { feed: async () => ({ groups: [] }) } as never,
  );
  await controller.personalFilings({
    session: { memberId: 'mine' },
    query: { ownerKey: 'MEMBER:other' },
  } as unknown as Request);
  assert.equal(received, 'MEMBER:mine');
  assert.throws(() => controller.personalFilings({ session: {} } as Request));
  assert.throws(() =>
    controller.personalFilings({ session: { memberId: 'm', adminId: 'a' } } as Request),
  );
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
    {
      dataSource: {
        query: async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes('SELECT DISTINCT c.id')) return [{ id: 'mine', nameKo: '내 기업' }];
          if (sql.includes('FROM filings f'))
            return [
              {
                id: 'dart',
                companyId: 'mine',
                externalId: '20260905000001',
                title: '분석 전 원본',
                filingDate: '2026-09-05',
                firstObservedAt: '2026-09-06T00:00:00Z',
              },
            ];
          if (sql.includes('FROM source_items s'))
            return [0, 1].map(() => ({
              id: 'sec',
              companyId: null,
              externalId: 'accession-1',
              title: 'SEC 원본',
              filingDate: '2026-09-04',
              publishedAt: null,
              firstObservedAt: '2026-09-06T01:00:00Z',
              url: 'https://www.sec.gov/Archives/edgar/data/1/a.htm',
            }));
          return [
            { sourceId: 'sec', companyId: 'mine' },
            { sourceId: 'sec', companyId: 'other' },
          ];
        },
      },
    } as unknown as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
  const result = await service.personalFilings('MEMBER:mine');
  assert.deepEqual(result.items, []);
  const dart = calls.find((call) => call.sql.includes('FROM filings f'))!;
  const sec = calls.find((call) => call.sql.includes('FROM source_items s'))!;
  const scope = calls.find((call) => call.sql.includes('SELECT DISTINCT c.id'))!;
  assert.match(scope.sql, /g.room_id IS NULL AND g.owner_key=\?/);
  assert.deepEqual(scope.params, ['MEMBER:mine']);
  assert.deepEqual(dart.params, ['mine', 0]);
  assert.deepEqual(sec.params, ['mine', 'mine', 0]);
  assert.match(dart.sql, /p.id=f.active_parse_run_id/);
  assert.match(dart.sql, /p.status='SUCCEEDED'/);
  assert.match(dart.sql, /f.effective_state='ACTIVE'/);
  assert.match(dart.sql, /review.status='OPEN'/);
  assert.match(dart.sql, /relation.review_decision NOT IN/);
  assert.match(sec.sql, /s.company_id IN/);
  assert.match(sec.sql, /news_source_companies/);
  for (const call of [dart, sec]) {
    assert.match(call.sql, /company_id IN \(\?\)/);
    assert.match(call.sql, /e.state='VERIFIED'/);
  }
});
