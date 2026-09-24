import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityManager } from 'typeorm';
import { NAVER_NEWS_METADATA_POLICY, newsPolicyAllowsAudience } from '@orsem/contracts';
import {
  CompanyEntity,
  NewsArticleEntity,
  NewsItemEntity,
  NewsSourceCompanyEntity,
  SourceItemEntity,
} from '@orsem/database';
import { loadAppConfig } from '../config/app-config';
import { mapSourceItem } from '../resources/resource-mappers';
import { newsAudienceAllows } from '../resources/news-access';
import { NewsController } from '../resources/resource.controllers';
import type { Request } from 'express';
import { NaverNewsPersistenceService } from './naver-news-persistence.service';
import type { NaverNewsSearchResult } from './naver-news-search.service';

const company = Object.assign(new CompanyEntity(), {
  id: '11111111-1111-4111-a111-111111111111',
  nameKo: '삼성전자',
  nameEn: 'Samsung Electronics',
  stockCode: '005930',
  ticker: null,
  market: 'KOSPI',
  isListed: true,
});
const raw = {
  title: '<b>삼성전자</b> &quot;실적 발표&quot;',
  description: '영업이익 &amp; 매출 증가',
  originallink: 'https://publisher.example/article?utm_source=naver',
  link: 'https://news.naver.com/article/1',
  pubDate: 'Thu, 24 Sep 2026 10:00:00 +0900',
};
const result: NaverNewsSearchResult = {
  provider: 'NAVER',
  lastBuildDate: raw.pubDate,
  total: 1,
  start: 1,
  display: 1,
  items: [raw],
};

function persistence() {
  const sources = new Map<string, SourceItemEntity>();
  const news = new Map<string, Partial<NewsItemEntity>>();
  const links: Array<Partial<NewsSourceCompanyEntity>> = [];
  const sourceRepository = {
    createQueryBuilder: () => {
      let values: SourceItemEntity;
      let externalId: string;
      const query = {
        insert: () => query,
        values: (value: SourceItemEntity) => {
          values = value;
          return query;
        },
        orIgnore: () => query,
        execute: async () => {
          if (!sources.has(values.externalId!))
            sources.set(values.externalId!, Object.assign(new SourceItemEntity(), values));
        },
        where: (_sql: string, parameters: { externalId: string }) => {
          externalId = parameters.externalId;
          return query;
        },
        setLock: () => query,
        getOneOrFail: async () => sources.get(externalId),
      };
      return query;
    },
    save: async (source: SourceItemEntity) => source,
    update: async (id: string, values: Partial<SourceItemEntity>) => {
      Object.assign(
        [...sources.values()].find((source) => source.id === id)!,
        values,
      );
    },
  };
  const companyQuery = {
    select: () => companyQuery,
    where: () => companyQuery,
    orderBy: () => companyQuery,
    setLock: () => companyQuery,
    getMany: async () => [company],
  };
  const manager = {
    queryRunner: { isTransactionActive: true },
    getRepository: (entity: unknown) => {
      if (entity === SourceItemEntity) return sourceRepository;
      if (entity === CompanyEntity)
        return { find: async () => [company], createQueryBuilder: () => companyQuery };
      if (entity === NewsArticleEntity)
        return { findOneBy: async () => ({ id: 'existing-article-from-newsroom' }) };
      if (entity === NewsItemEntity)
        return {
          upsert: async (value: Partial<NewsItemEntity>) => news.set(value.sourceItemId!, value),
        };
      assert.equal(entity, NewsSourceCompanyEntity);
      return {
        delete: async () => {
          links.length = 0;
        },
        insert: async (values: Partial<NewsSourceCompanyEntity>[]) => links.push(...values),
      };
    },
  };
  const db = {
    ...manager,
    transaction: async (fn: (manager: EntityManager) => Promise<void>) =>
      fn(manager as unknown as EntityManager),
  };
  return {
    service: new NaverNewsPersistenceService(
      loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
      { requireDataSource: () => db } as never,
    ),
    sources,
    news,
    links,
  };
}

test('NAVER persists original metadata, UTC publication, matched companies and shared article identity; repeat ingestion retains first observation', async () => {
  const { service, sources, news, links } = persistence();
  await service.persist(result, { topicId: 'topic:kr-equities', kind: 'MARKET', region: 'kr' });
  const first = [...sources.values()][0]!;
  const observed = first.firstObservedAt;
  assert.deepEqual(first.rawMetadataJson?.providerOriginal, raw);
  assert.equal(first.title, '삼성전자 "실적 발표"');
  assert.equal(first.publishedAt!.toISOString(), '2026-09-24T01:00:00.000Z');
  assert.equal(first.provenanceUrl, raw.link);
  assert.equal(first.rightsMode, 'LINK_ONLY');
  assert.equal(first.newsArticleId, 'existing-article-from-newsroom');
  assert.equal(links[0]!.companyId, company.id);
  assert.equal(news.get(first.id)?.description, '영업이익 & 매출 증가');
  await service.persist(
    { ...result, items: [{ ...raw, description: '정정된 제공 요약' }] },
    { topicId: 'topic:gold', kind: 'ASSET' },
  );
  assert.equal(sources.size, 1);
  assert.equal(news.size, 1);
  assert.equal(first.firstObservedAt, observed);
  assert.deepEqual(first.rawMetadataJson?.topicIds, ['topic:kr-equities', 'topic:gold']);
  assert.deepEqual(first.rawMetadataJson?.topicKinds, ['MARKET', 'ASSET']);
  assert.equal(first.rawMetadataJson?.description, '정정된 제공 요약');
  const view = mapSourceItem(first);
  assert.equal(view.description, '정정된 제공 요약');
  assert.equal(view.summaryAllowed, true);
  assert.equal(view.providerOriginal?.title, raw.title);
  assert.equal(view.contentState, 'UNAVAILABLE');
  assert.equal(view.translationStatus, 'UNAVAILABLE');
});

test('a search query alone cannot assign a company and unsafe article links are not stored', async () => {
  const { service, sources, links } = persistence();
  await service.persist(
    {
      ...result,
      items: [{ ...raw, title: '국제 금값 동향', description: '전망', pubDate: 'invalid' }],
    },
    { topicId: 'topic:gold', kind: 'ASSET' },
  );
  const source = [...sources.values()][0]!;
  assert.equal(source.companyId, null);
  assert.equal(source.publishedAt, null);
  assert.equal(links.length, 0);
  await service.persist({
    ...result,
    items: [{ ...raw, originallink: 'file:///etc/passwd', link: 'javascript:alert(1)' }],
  });
  assert.equal(sources.size, 1);
});

test('new NAVER metadata approval does not approve legacy records, bots, rooms, AI or article bodies', () => {
  const policy = NAVER_NEWS_METADATA_POLICY;
  for (const audience of ['ADMIN_UI', 'MEMBER_UI', 'SHARED_ROOM', 'BOT'] as const) {
    assert.equal(
      newsPolicyAllowsAudience(policy, audience),
      ['ADMIN_UI', 'MEMBER_UI'].includes(audience),
    );
    assert.equal(newsAudienceAllows({ source: 'NAVER', sourcePolicyJson: null }, audience), false);
  }
  assert.equal(policy.fullTextStorageAllowed, false);
  assert.equal(policy.aiAllowed, false);
  assert.equal(policy.translationAllowed, false);
});

test('combined feed reads after provider persistence and never bypasses paging with raw result sets', async () => {
  let saved = false;
  const controller = new NewsController(
    {
      listNews: async () => {
        assert.equal(saved, true);
        return {
          items: ['stored-only'],
          nextCursor: 'cursor',
          pageInfo: { hasMore: true, nextCursor: 'cursor' },
        };
      },
    } as never,
    {
      feed: async () => {
        saved = true;
        return { groups: [[raw]], resultSets: [{ items: [raw] }], status: 'AVAILABLE' };
      },
    } as never,
  );
  const page = await controller.list({ companyId: company.id }, {
    session: { memberId: company.id },
  } as Request);
  assert.deepEqual(page.items, ['stored-only']);
  assert.deepEqual(page.providerGroups, []);
  assert.deepEqual(page.providerResultSets, []);
  assert.equal(page.nextCursor, 'cursor');
});
