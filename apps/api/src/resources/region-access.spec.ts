import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { cursorQuerySchema, EventType, Market, type Region } from '@orsem/contracts';
import {
  CompanyEntity,
  EventClusterEntity,
  FilingEntity,
  SourceItemEntity,
  WatchlistItemEntity,
} from '@orsem/database';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import type { AuthService } from '../auth/auth.service';
import type { MemberService } from '../auth/member.service';
import { encodeCursor } from '../common/cursor';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { AdminSessionGuard } from '../security/security';
import { OrsemDataService } from './orsem-data.service';
import { NewsController, SourcesController, WatchlistController } from './resource.controllers';

function fixtureData() {
  const fixtures = new FixtureStoreService();
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {} as DatabaseRuntimeService,
    fixtures,
  );
  return { fixtures, data };
}

test('regional fixture pages filter before limiting, preserving cursors and unknown news only in all', async () => {
  const { fixtures, data } = fixtureData();
  const us = fixtures.companies.find((company) => company.market === Market.NASDAQ)!;
  fixtures.watchlist.push({ ...fixtures.watchlist[0]!, id: 'watch-us', company: us });
  fixtures.sourceItems.push(
    { ...fixtures.sourceItems[0]!, id: 'unknown-news', tickers: [] },
    { ...fixtures.sourceItems[0]!, id: 'sec', source: 'SEC', tickers: [] },
  );
  fixtures.events.push(
    {
      ...fixtures.events[0]!,
      id: 'event-us',
      company: us,
      filing: null,
      canonicalEventType: EventType.NEWS,
      sourceItems: [],
    },
    {
      ...fixtures.events[0]!,
      id: 'event-unknown',
      company: null,
      filing: null,
      canonicalEventType: EventType.NEWS,
      sourceItems: [],
    },
  );
  assert.equal(cursorQuerySchema.parse({}).region, 'all');
  assert.equal(cursorQuerySchema.safeParse({ region: 'eu' }).success, false);
  assert.deepEqual(
    (await data.listCompanies({ limit: 1, region: 'us' })).items.map((item) => item.id),
    [us.id],
  );
  const first = await data.listCompanies({ limit: 1, region: 'kr' });
  assert.equal(first.pageInfo.hasMore, true);
  const second = await data.listCompanies({ limit: 1, region: 'kr', cursor: first.nextCursor! });
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0]?.id, first.items[0]?.id);
  assert.deepEqual(
    (await data.listWatchlist({ limit: 1, region: 'us' })).items.map((item) => item.company.id),
    [us.id],
  );
  assert.deepEqual(
    (await data.listEvents({ limit: 1, region: 'us' })).items.map((item) => item.id),
    ['event-us'],
  );
  assert.equal((await data.listFilings({ limit: 1, region: 'us' })).items.length, 0);
  assert.equal(
    (await data.listNews({ limit: 100, region: 'kr' })).items.some(
      (item) => item.id === 'unknown-news',
    ),
    false,
  );
  assert.deepEqual(
    (await data.listNews({ limit: 100, region: 'us' })).items.map((item) => item.id),
    ['sec'],
  );
  assert.equal((await data.listNews({ limit: 100, region: 'all' })).items.length, 3);
});

test('resource SQL binds regional markets before limit and filters SEC/OpenDART by explicit origin', async () => {
  const entities = [
    CompanyEntity,
    EventClusterEntity,
    FilingEntity,
    SourceItemEntity,
    WatchlistItemEntity,
  ];
  const metadata = new DataSource({
    type: 'mysql',
    database: 'test',
    entities,
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const source = {
    getRepository(entity: EntityTarget<ObjectLiteral>) {
      return {
        createQueryBuilder(alias: string) {
          const qb = metadata.getRepository(entity).createQueryBuilder(alias);
          qb.getMany = async () => {
            const [sql, values] = qb.getQueryAndParameters();
            captured.push({ sql, values });
            return [];
          };
          return qb;
        },
      };
    },
  };
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    { dataSource: source } as unknown as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
  for (const region of ['kr', 'us'] as Region[]) {
    await data.listCompanies({ region, limit: 1 });
    await data.listEvents({ region, limit: 1 });
    await data.listNews({ region, limit: 1 });
    await data.listWatchlist({ region, limit: 1 });
    await data.listFilings({ region, limit: 1 });
  }
  assert.equal(captured.length, 10);
  captured.forEach(({ sql, values }, index) => {
    assert.match(sql, /LIMIT 2$/u);
    if (index % 5 === 4) {
      assert.match(sql, /`filing`\.`source` = \?/u);
      assert.ok(values.includes(index < 5 ? 'OPENDART' : 'SEC'));
    } else {
      assert.match(sql, /market.*IN/u);
      assert.ok(values.includes(index < 5 ? 'KOSPI' : 'NASDAQ'));
    }
  });
});

test('RSS news source filtering precedes limit and cursor in every fixture region', async () => {
  const { fixtures, data } = fixtureData();
  const original = fixtures.sourceItems[0]!;
  fixtures.sourceItems.splice(
    0,
    fixtures.sourceItems.length,
    ...[
      { id: 'naver-newest', source: 'NAVER', publishedAt: '2026-09-04T04:00:00.000Z' },
      { id: 'rss-newer', source: 'NEWS_RSS', publishedAt: '2026-09-04T03:00:00.000Z' },
      { id: 'ir-between', source: 'IR', publishedAt: '2026-09-04T02:00:00.000Z' },
      { id: 'rss-older', source: 'NEWS_RSS', publishedAt: '2026-09-04T01:00:00.000Z' },
    ].map((item) => ({ ...original, ...item, tickers: [] })),
  );
  const controller = new NewsController(data);
  for (const region of ['all', 'kr', 'us']) {
    const first = await controller.list({ source: 'NEWS_RSS', limit: '1', region });
    assert.deepEqual(
      first.items.map((item) => item.id),
      ['rss-newer'],
    );
    assert.equal(first.pageInfo.hasMore, true);
    assert.ok(first.nextCursor);
    const second = await controller.list({
      source: 'NEWS_RSS',
      limit: '1',
      region,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((item) => item.id),
      ['rss-older'],
    );
    assert.equal(second.nextCursor, null);
    assert.equal(second.pageInfo.hasMore, false);
    assert.ok([...first.items, ...second.items].every((item) => item.source === 'NEWS_RSS'));
  }
  assert.equal((await controller.list({ limit: 100 })).items.length, 4);
  for (const source of ['unknown', 'news_rss', ['NEWS_RSS', 'NAVER']]) {
    assert.throws(
      () => controller.list({ source }),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
    );
  }
});

test('RSS news SQL combines source, global feed region and cursor predicates before limiting', async () => {
  const metadata = new DataSource({
    type: 'mysql',
    database: 'test',
    entities: [CompanyEntity, SourceItemEntity],
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const source = {
    getRepository() {
      return {
        createQueryBuilder(alias: string) {
          const qb = metadata.getRepository(SourceItemEntity).createQueryBuilder(alias);
          qb.getMany = async () => {
            const [sql, values] = qb.getQueryAndParameters();
            captured.push({ sql, values });
            return [];
          };
          return qb;
        },
      };
    },
  };
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    { dataSource: source } as unknown as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
  const cursor = encodeCursor({ id: 'rss-cursor', sort: '2026-09-04T03:00:00.000Z' });
  for (const region of ['kr', 'us'] as const) {
    await data.listNews({ source: 'NEWS_RSS', region, limit: 6, cursor });
    const query = captured.at(-1)!;
    assert.match(query.sql, /WHERE `source`\.`source` = \? AND \(EXISTS/u);
    assert.match(query.sql, /`source`\.`source` = 'NEWS_RSS' AND JSON_UNQUOTE/u);
    assert.match(query.sql, /JSON_EXTRACT\(`source`\.`raw_metadata_json`, '\$\.marketRegion'\)/u);
    assert.match(query.sql, /IN \('global', \?\)/u);
    assert.match(query.sql, /`source`\.`id` < \?/u);
    assert.match(query.sql, /ORDER BY COALESCE.*DESC, `source`\.`id` DESC LIMIT 7$/u);
    assert.equal(query.values[0], 'NEWS_RSS');
    assert.ok(query.values.includes(region));
    assert.ok(query.values.includes(region === 'kr' ? 'KOSPI' : 'NASDAQ'));
    assert.ok(query.values.includes('rss-cursor'));
  }
});

test('common freshness returns saved status while omitting administrator diagnostics', async () => {
  const { data } = fixtureData();
  let reads = 0;
  data.connectorSourceViews = async () => {
    reads += 1;
    return [
      {
        id: 'naver',
        name: 'NAVER',
        category: 'NEWS',
        status: 'HEALTHY',
        lastSuccessAt: '2026-09-04T00:00:00.000Z',
        lagSeconds: 10,
        rightsMode: 'LINK_ONLY',
        checkedAt: '2026-09-04T00:00:00.000Z',
        message: 'Private operational path',
        metadataJson: { private: true },
      },
    ];
  };
  const result = await new SourcesController(data, {
    freshness: async () => [],
  } as unknown as ConstructorParameters<typeof SourcesController>[1]).freshness();
  assert.equal(reads, 1);
  assert.equal(result.items[0]?.status, 'HEALTHY');
  assert.equal(result.items[0]?.message, null);
  assert.equal('metadataJson' in result.items[0]!, false);
});

test('freshness and batch quotes admit approved members and admins but reject pending or anonymous access', async () => {
  let status = 'APPROVED';
  const guard = new AdminSessionGuard(
    new Reflector(),
    { getAdmin: async () => ({ id: 'admin' }) } as unknown as AuthService,
    { getMember: async () => ({ role: 'VIEWER', status }) } as unknown as MemberService,
  );
  for (const [controller, handler] of [
    [NewsController, NewsController.prototype.list],
    [SourcesController, SourcesController.prototype.freshness],
    [WatchlistController, WatchlistController.prototype.quotes],
  ] as const) {
    const context = (identity: Record<string, string>) =>
      ({
        getClass: () => controller,
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'GET',
            session: { ...identity, sessionStartedAt: new Date().toISOString() },
          }),
        }),
      }) as unknown as ExecutionContext;
    status = 'APPROVED';
    assert.equal(await guard.canActivate(context({ memberId: 'member' })), true);
    assert.equal(await guard.canActivate(context({ adminId: 'admin' })), true);
    await assert.rejects(
      () => guard.canActivate(context({})),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
    );
    status = 'PENDING';
    await assert.rejects(
      () => guard.canActivate(context({ memberId: 'member' })),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 403,
    );
  }
});
