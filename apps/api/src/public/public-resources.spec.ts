import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NEWS_RSS_FEEDS, RightsMode, type NewsRssFeedDefinition } from '@orsem/contracts';
import { SourceItemEntity } from '@orsem/database';
import type { AuthService } from '../auth/auth.service';
import type { MemberService } from '../auth/member.service';
import { AdminSessionGuard } from '../security/security';
import { CompaniesController } from '../resources/resource.controllers';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { PublicResourcesService } from './public-resources.service';
import {
  PublicResourcesController,
  publicCompanyQuerySchema,
  publicNewsQuerySchema,
} from './public-resources.controller';
import {
  mapPublicNews,
  publicNewsFeed,
  publicNewsFeeds,
  publicNewsSql,
} from './public-news-policy';
import {
  mapPublicCompany,
  PUBLIC_COMPANY_IDENTITY_SQL,
  PUBLIC_COMPANY_NAME_SQL,
} from './public-companies';

const now = new Date('2026-10-15T00:00:00.000Z');
const id = '10000000-0000-4000-8000-000000000001';

function news(overrides: Partial<SourceItemEntity> = {}): SourceItemEntity {
  const feed = NEWS_RSS_FEEDS['fed-press'];
  return Object.assign(new SourceItemEntity(), {
    id,
    source: 'NEWS_RSS',
    sourceKind: 'OFFICIAL_RELEASE',
    sourceName: feed.publisher,
    title: 'Federal Reserve announces a policy decision',
    url: 'https://www.federalreserve.gov/newsevents/pressreleases/example.htm',
    publishedAt: new Date('2026-10-14T15:00:00.000Z'),
    firstObservedAt: now,
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    sourcePolicyJson: { ...feed.policy },
    rawHash: 'a'.repeat(64),
    rawMetadataJson: {
      feedId: 'fed-press',
      feedUrl: feed.url,
      publisher: feed.publisher,
      publisherId: feed.publisherId,
      marketRegion: feed.marketRegion,
      rightsContext: feed.rightsContext,
      rightsPolicyUrl: feed.rightsPolicyUrl,
      description: 'Public summary',
      privateNote: 'never export',
    },
    rawObjectUri: 'private/path',
    author: 'Internal author',
    ...overrides,
  });
}

test('public news exposes a fixed safe projection and all five official feeds only', () => {
  assert.deepEqual(
    publicNewsFeeds().map(([feed]) => feed),
    ['fed-press', 'fed-speeches', 'bls-latest', 'eia-today', 'eia-press'],
  );
  const item = mapPublicNews(news(), now)!;
  assert.equal(item.summary, 'Public summary');
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      'id',
      'title',
      'summary',
      'url',
      'publisher',
      'publishedAt',
      'firstObservedAt',
      'rightsMode',
      'sourceUrl',
    ].sort(),
  );
  assert.doesNotMatch(JSON.stringify(item), /private|author|rawHash|eventId|sourcePolicy/u);
});

test('stored permission, provenance, feed identity, expiry and URL counterexamples fail closed', () => {
  const baseline = news();
  const failures: Partial<SourceItemEntity>[] = [
    { source: 'NAVER' },
    { source: 'IR' },
    { sourceKind: 'COMPANY_IR' },
    { sourceName: 'Other publisher' },
    { rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY },
    { sourcePolicyJson: null },
    { sourcePolicyJson: { ...baseline.sourcePolicyJson!, publicRedistributionAllowed: false } },
    { sourcePolicyJson: { ...baseline.sourcePolicyJson!, publicRedistributionAllowed: 'UNKNOWN' } },
    { sourcePolicyJson: { ...baseline.sourcePolicyJson!, displayAllowed: false } },
    { sourcePolicyJson: { ...baseline.sourcePolicyJson!, metadataStorageAllowed: null } },
    { sourcePolicyJson: { ...baseline.sourcePolicyJson!, policyUrl: 'https://attacker.invalid/' } },
    { sourcePolicyJson: { ...baseline.sourcePolicyJson!, policyVersion: 2 } },
    { rawMetadataJson: { ...baseline.rawMetadataJson, feedId: 'hankyung-finance-rss' } },
    { rawMetadataJson: { ...baseline.rawMetadataJson, feedUrl: 'https://attacker.invalid/rss' } },
    { rawMetadataJson: { ...baseline.rawMetadataJson, publisherId: 'samsung-global-newsroom' } },
    {
      rawMetadataJson: {
        ...baseline.rawMetadataJson,
        rightsPolicyUrl: 'https://attacker.invalid/rights',
      },
    },
    { rawMetadataJson: { ...baseline.rawMetadataJson, expiresAt: now.toISOString() } },
    { rawMetadataJson: { ...baseline.rawMetadataJson, expiresAt: 'not-a-date' } },
    { url: 'https://www.federalreserve.gov.attacker.invalid/story' },
    { url: 'https://www.federalreserve.gov@attacker.invalid/story' },
    { url: 'javascript:alert(1)' },
  ];
  for (const failure of failures)
    assert.equal(mapPublicNews(news(failure), now), null, JSON.stringify(failure));
  assert.ok(
    mapPublicNews(
      news({
        rawMetadataJson: { ...baseline.rawMetadataJson, expiresAt: '2026-10-16T00:00:00.000Z' },
      }),
      now,
    ),
  );
});

test('a permissive stored snapshot cannot override revoked or disabled current policy', () => {
  for (const patch of [
    { enabled: false },
    { policy: { ...NEWS_RSS_FEEDS['fed-press'].policy, publicRedistributionAllowed: false } },
  ]) {
    const feed: NewsRssFeedDefinition = { ...NEWS_RSS_FEEDS['fed-press'], ...patch };
    assert.equal(publicNewsFeed(news(), now, [['fed-press', feed]]), null);
  }
});

test('summary and translation retain their separate permissions and verified source hash', () => {
  const row = news({
    translationJson: {
      version: 1,
      status: 'COMPLETED',
      inputHash: 'a'.repeat(64),
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      provider: 'LOCAL',
      model: 'test',
      title: '연방준비제도 발표',
      description: '공개 요약',
      translatedAt: now.toISOString(),
      attemptedAt: now.toISOString(),
      attempts: 1,
      nextAttemptAt: null,
    },
  });
  assert.deepEqual(mapPublicNews(row, now)?.translation, {
    title: '연방준비제도 발표',
    summary: '공개 요약',
  });
  row.sourcePolicyJson = { ...row.sourcePolicyJson!, summaryStorageAllowed: false };
  assert.equal(mapPublicNews(row, now)?.summary, null);
  assert.equal(mapPublicNews(row, now)?.translation?.summary, null);
  row.sourcePolicyJson = { ...row.sourcePolicyJson, translationAllowed: false };
  assert.equal(mapPublicNews(row, now)?.translation, undefined);
  row.sourcePolicyJson = { ...row.sourcePolicyJson, translationAllowed: true };
  row.rawHash = 'b'.repeat(64);
  assert.equal(mapPublicNews(row, now)?.translation, undefined);
});

test('public query schema rejects private filters and unbounded requests', () => {
  assert.deepEqual(publicCompanyQuerySchema.parse({}), { region: 'all', limit: 20 });
  for (const query of [{ limit: 51 }, { limit: 0 }, { audience: 'ADMIN_UI' }, { region: 'global' }])
    assert.equal(publicNewsQuerySchema.safeParse(query).success, false);
  assert.equal(publicNewsQuerySchema.safeParse({ companyId: 'private-company' }).success, false);
});

test('public controllers bypass only their own route guard while member controllers remain protected', async () => {
  const fail = () => {
    throw new Error('public access must not query accounts');
  };
  const guard = new AdminSessionGuard(
    new Reflector(),
    { getAdmin: fail } as unknown as AuthService,
    { getMember: fail } as unknown as MemberService,
  );
  const context = (handler: object, controller: object) =>
    ({
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ method: 'GET', session: {} }) }),
    }) as unknown as ExecutionContext;
  for (const method of ['companies', 'company', 'news', 'newsItem'] as const)
    assert.equal(
      await guard.canActivate(
        context(PublicResourcesController.prototype[method], PublicResourcesController),
      ),
      true,
    );
  await assert.rejects(
    () => guard.canActivate(context(CompaniesController.prototype.list, CompaniesController)),
    UnauthorizedException,
  );
  assert.equal(Reflect.getMetadata('orsem:public', PublicResourcesController), undefined);
});

function databaseHarness(rows: SourceItemEntity[] = []) {
  const calls: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const method of [
    'select',
    'leftJoin',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'take',
    'limit',
  ])
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  builder.getMany = async () => {
    calls.push(['getMany']);
    return rows;
  };
  builder.getOne = async () => {
    calls.push(['getOne']);
    return rows[0] ?? null;
  };
  builder.getRawMany = async () => [];
  const dataSource = { getRepository: () => ({ createQueryBuilder: () => builder }) };
  const database = { requireDataSource: () => dataSource } as unknown as DatabaseRuntimeService;
  const service = new PublicResourcesService(
    database,
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
    new FixtureStoreService(),
  );
  return { service, calls };
}

test('list and detail apply public SQL before limiting and never select article bodies or member data', async () => {
  const { service, calls } = databaseHarness([
    news(),
    news({ id: '10000000-0000-4000-8000-000000000002' }),
  ]);
  const page = await service.news({ limit: 1, q: '%private_' });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const where = String(calls.find(([name]) => name === 'where')?.[1]);
  assert.equal(where, publicNewsSql('source').sql);
  assert.match(where, /publicRedistributionAllowed/u);
  assert.match(where, /expiresAt/u);
  assert.ok(
    calls.findIndex(([name]) => name === 'where') < calls.findIndex(([name]) => name === 'take'),
  );
  const search = calls.find(([name, sql]) => name === 'andWhere' && String(sql).includes('LIKE'));
  assert.deepEqual(search?.[2], { publicQuery: '%!%private!_%' });
  const selection = String(calls.find(([name]) => name === 'select')?.[1]);
  assert.doesNotMatch(selection, /rawObjectUri|body|author|companyId|newsArticleId/u);
  calls.length = 0;
  assert.equal((await service.newsItem(id)).id, id);
  assert.equal(calls.find(([name]) => name === 'where')?.[1], where);
});

test('fixtures do not bypass missing policy evidence and reads never require a database', async () => {
  const fixtures = new FixtureStoreService();
  const service = new PublicResourcesService(
    {
      requireDataSource: () => {
        throw new Error('no db');
      },
    } as unknown as DatabaseRuntimeService,
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    fixtures,
  );
  assert.deepEqual(await service.companies({}), { items: [], nextCursor: null });
  assert.deepEqual(await service.news({}), { items: [], nextCursor: null });
  await assert.rejects(() => service.newsItem(fixtures.sourceItems[0]!.id), /공개된 뉴스/u);
});

test('public company identity requires official proof and never displays vendor names or guessed chart symbols', () => {
  assert.match(PUBLIC_COMPANY_IDENTITY_SQL, /source_updated_date IS NOT NULL/u);
  assert.match(PUBLIC_COMPANY_IDENTITY_SQL, /appliedCik/u);
  assert.match(PUBLIC_COMPANY_IDENTITY_SQL, /provenanceUrl/u);
  assert.match(PUBLIC_COMPANY_IDENTITY_SQL, /rawPayload\[0\]\.cik/u);
  assert.match(PUBLIC_COMPANY_NAME_SQL, /ELSE JSON_UNQUOTE.*rawPayload\[0\]\.name/u);
  assert.doesNotMatch(PUBLIC_COMPANY_NAME_SQL, /name_en|alias|TOSS|ALPACA/u);
  const base = {
    id,
    name: 'SEC company name',
    market: 'NYSE' as const,
    symbol: 'BRK-B',
    verifiedTicker: 'BRK.B',
    observedAt: now,
  };
  assert.equal(mapPublicCompany(base).chartSymbol, null);
  assert.equal(
    mapPublicCompany({ ...base, symbol: 'ABC', verifiedTicker: 'ABC' }).chartSymbol,
    'NYSE:ABC',
  );
  const item = mapPublicCompany({
    ...base,
    market: 'KOSPI',
    symbol: '005930',
    verifiedTicker: null,
  });
  assert.equal(item.region, 'kr');
  assert.equal(item.chartSymbol, null);
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      'id',
      'name',
      'market',
      'symbol',
      'region',
      'canonicalPath',
      'chartSymbol',
      'sourceUrl',
      'observedAt',
    ].sort(),
  );
});
