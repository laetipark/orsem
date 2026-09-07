import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { newsAudienceSql } from './news-access';
import {
  metadataNewsSql,
  newsFilterParameters,
  newsFiltersSql,
  representativeNewsSql,
} from './news-query';
import { OrsemDataService } from './orsem-data.service';
import { NewsController } from './resource.controllers';

const ids = Array.from(
  { length: 201 },
  (_, n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
);
const request = { session: { memberId: ids[0] } } as Request;

test('a company set applies to both article representatives and linked-source visibility with bound IDs', () => {
  const filter = { companyIds: ids.slice(0, 2), audience: 'MEMBER_UI' as const };
  for (const sql of [newsFiltersSql('source', filter), representativeNewsSql(filter)]) {
    assert.match(sql, /selected_relevance.company_id IN \(:\.\.\.newsCompanyIds\)/);
    assert.match(sql, /selected_source.news_article_id=(source|duplicate).news_article_id/);
    assert.ok(sql.includes(newsAudienceSql('selected_source', 'MEMBER_UI')));
    assert.ok(sql.includes(metadataNewsSql('selected_source')));
    assert.ok(!sql.includes(ids[0]!));
  }
  assert.deepEqual(newsFilterParameters(filter).newsCompanyIds, ids.slice(0, 2));
  assert.match(newsFiltersSql('source', { companyIds: [] }), /1 = 0/);
});

test('public recent feeds validate 20 unique UUIDs, company scope and mutually exclusive filters', async () => {
  const requests: Record<string, unknown>[] = [];
  const provider: Record<string, unknown>[] = [];
  const controller = new NewsController(
    {
      listNews: async (query: Record<string, unknown>) => {
        requests.push(query);
        return { items: [], nextCursor: null, pageInfo: { nextCursor: null, hasMore: false } };
      },
    } as never,
    {
      feed: async (query: Record<string, unknown>) => {
        provider.push(query);
        return { groups: [], fetchedAt: null, status: 'PENDING', nextRequestAt: null };
      },
    } as never,
  );
  await controller.list({ scope: 'company', companyIds: ids.slice(0, 20).join(',') }, request);
  assert.deepEqual(requests[0]!.companyIds, ids.slice(0, 20));
  assert.equal(requests[0]!.audience, 'MEMBER_UI');
  assert.deepEqual(provider[0]!.companyIds, ids.slice(0, 20));
  for (const query of [
    { scope: 'company', companyIds: ids.slice(0, 21).join(',') },
    { scope: 'company', companyIds: `${ids[0]},${ids[0]}` },
    { scope: 'company', companyIds: 'bad' },
    { companyIds: ids[0] },
    { scope: 'market', companyIds: ids[0] },
    { scope: 'company', companyIds: ids[0], companyId: ids[0] },
    { scope: 'company', companyIds: ids[0], asset: 'gold' },
  ])
    await assert.rejects(() => controller.list(query, request), BadRequestException);
  assert.equal(requests.length, 1);
  const empty = await controller.list({ scope: 'company', companyIds: '' }, request);
  assert.deepEqual(requests[1]!.companyIds, []);
  assert.deepEqual(empty.providerGroups, []);
  assert.equal(provider.length, 1);
});

test('an empty set cannot fall through to the database or an unscoped fixture feed', async () => {
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
    { dataSource: null } as never,
    new FixtureStoreService(),
  );
  assert.deepEqual(await service.listNews({ companyIds: [], scope: 'company', limit: 20 }), {
    items: [],
    nextCursor: null,
    pageInfo: { nextCursor: null, hasMore: false },
  });
  await assert.rejects(() => service.listNews({ companyIds: ids, limit: 20 }), BadRequestException);
  assert.deepEqual((await service.filingsForCompanies([])).items, []);
});

test('fixture company arrays filter before pagination and do not include unrelated companies', async () => {
  const fixtures = new FixtureStoreService();
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {} as never,
    fixtures,
  );
  const company = fixtures.companies[0]!;
  const source = fixtures.sourceItems[0]!;
  Object.assign(source, {
    source: 'IR',
    sourceKind: 'COMPANY_IR',
    publisherId: 'samsung-global-newsroom',
    tickers: [company.stockCode ?? company.ticker!],
  });
  const selected = await service.listNews({
    companyIds: [company.id],
    scope: 'company',
    limit: 20,
  });
  assert.ok(selected.items.some((item) => item.id === source.id));
  const other = await service.listNews({
    companyIds: [fixtures.companies[1]!.id],
    scope: 'company',
    limit: 20,
  });
  assert.ok(other.items.every((item) => item.id !== source.id));
});
