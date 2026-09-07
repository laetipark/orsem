import assert from 'node:assert/strict';
import test from 'node:test';
import { RightsMode } from '@orsem/contracts';
import type { EntityManager, QueryRunner } from 'typeorm';
import { NewsArticleEntity, SourceItemEntity } from './entities';
import {
  attachNewsArticle,
  hasReadableNewsMetadata,
  isExactSyndicatedNews,
  lockNewsArticleCompanies,
  normalizedNewsTitleHash,
} from './news-articles';
import { createTypeOrmOptions } from './data-source';
import { AddNewsTitleHash1788413000000 } from './migrations/1788413000000-AddNewsTitleHash';

function source(overrides: Partial<SourceItemEntity> = {}): SourceItemEntity {
  return Object.assign(new SourceItemEntity(), {
    id: 'source-a',
    source: 'MARKETAUX_NEWS',
    newsArticleId: null,
    title: 'Example revenue +12% in Q2',
    url: 'https://publisher.example/news/one',
    companyId: 'company-a',
    publishedAt: new Date('2026-09-07T01:00:00Z'),
    firstObservedAt: new Date('2026-09-07T01:05:00Z'),
    rightsMode: RightsMode.STORE_METADATA_ONLY,
    sourcePolicyJson: {
      rightsMode: RightsMode.STORE_METADATA_ONLY,
      metadataStorageAllowed: true,
      displayAllowed: true,
    },
    ...overrides,
  });
}

test('normalization tolerates unicode width, whitespace and case but preserves amounts, signs and events', () => {
  assert.equal(
    normalizedNewsTitleHash(' ＡＢＣ\n revenue +１２%  '),
    normalizedNewsTitleHash('abc revenue +12%'),
  );
  for (const title of ['ABC revenue -12%', 'ABC revenue +13%', 'ABC earnings +12%'])
    assert.notEqual(normalizedNewsTitleHash('ABC revenue +12%'), normalizedNewsTitleHash(title));
  assert.equal(normalizedNewsTitleHash(' \t\n'), null);
});

test('only exact headline, original publisher, shared company and 24-hour window merges aggregators', () => {
  const original = source();
  const duplicate = source({
    source: 'FINNHUB_NEWS',
    id: 'source-b',
    url: 'https://publisher.example/syndicated/one',
    publishedAt: new Date('2026-09-08T01:00:00Z'),
  });
  assert.equal(isExactSyndicatedNews(original, duplicate, ['company-a'], ['company-a']), true);
  assert.equal(isExactSyndicatedNews(original, duplicate, ['company-a'], ['company-b']), false);
  for (const changed of [
    { title: 'Example revenue -12% in Q2' },
    { title: 'Example revenue +12% in Q3' },
    { url: 'https://another-publisher.example/news/one' },
    { publishedAt: new Date('2026-09-08T01:00:00.001Z') },
    { publishedAt: null },
    { sourcePolicyJson: null },
    { rightsMode: RightsMode.LINK_ONLY },
  ])
    assert.equal(
      isExactSyndicatedNews(original, source(changed), ['company-a'], ['company-a']),
      false,
    );
});

test('canonical URL wins before title matching and keeps every provenance source row', async () => {
  const updates: Array<{ id: string; update: Partial<SourceItemEntity> }> = [];
  const article = { id: 'article-a' };
  const manager = {
    getRepository(entity: unknown) {
      if (entity === NewsArticleEntity) return { findOneBy: async () => article };
      assert.equal(entity, SourceItemEntity);
      return {
        update: async (id: string, update: Partial<SourceItemEntity>) =>
          updates.push({ id, update }),
      };
    },
  } as unknown as EntityManager;
  const first = source();
  const second = source({
    id: 'source-b',
    source: 'FINNHUB_NEWS',
    title: 'Different supplied headline',
    url: 'https://publisher.example/news/one?utm_source=other',
  });
  await attachNewsArticle(manager, first);
  await attachNewsArticle(manager, second);
  assert.equal(first.newsArticleId, 'article-a');
  assert.equal(second.newsArticleId, 'article-a');
  assert.equal(updates.filter((row) => row.update.newsArticleId).length, 2);
  assert.deepEqual(new Set(updates.map((row) => row.id)), new Set(['source-a', 'source-b']));
});

test('overlapping company ingestion locks canonical company rows in deterministic order', async () => {
  const calls: unknown[] = [];
  const query = {
    select: () => query,
    where: (_sql: string, parameters: unknown) => {
      calls.push(parameters);
      return query;
    },
    orderBy: (...args: unknown[]) => {
      calls.push(args);
      return query;
    },
    setLock: (mode: string) => {
      calls.push(mode);
      return query;
    },
    getMany: async () => [],
  };
  const manager = {
    queryRunner: { isTransactionActive: true },
    getRepository: () => ({ createQueryBuilder: () => query }),
  } as unknown as EntityManager;
  await lockNewsArticleCompanies(manager, ['b', 'a', 'b']);
  assert.deepEqual(calls, [{ ids: ['a', 'b'] }, ['company.id', 'ASC'], 'pessimistic_write']);
  await assert.rejects(
    lockNewsArticleCompanies({ queryRunner: { isTransactionActive: false } } as EntityManager, [
      'a',
    ]),
    /ingestion transaction/u,
  );
});

test('a stored v2 approval cannot authorize reads after its current registered policy is unapproved', () => {
  const row = source({
    sourcePolicyJson: {
      policyVersion: 2,
      policyId: 'marketaux-news-v1',
      provider: 'MARKETAUX',
      rightsStatus: 'METADATA_ONLY',
      rightsMode: RightsMode.STORE_METADATA_ONLY,
      metadataStorageAllowed: true,
      displayAllowed: true,
      aiAllowed: false,
      fullTextStorageAllowed: false,
      publicRedistributionAllowed: false,
      notifyAllowed: false,
      allowedAudiences: ['ADMIN_UI'],
      policyUrl: 'https://www.marketaux.com/tos',
      checkedAt: '2026-09-07',
    },
  });
  assert.equal(hasReadableNewsMetadata(source()), true);
  assert.equal(hasReadableNewsMetadata(row), false);
});

test('title migration adds a nullable indexed attribute without regrouping, deleting or making title unique', async () => {
  const statements: string[] = [];
  await new AddNewsTitleHash1788413000000().up({
    query: async (sql: string) => statements.push(sql),
  } as unknown as QueryRunner);
  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /normalized_title_hash CHAR\(64\) NULL/u);
  assert.match(statements[0]!, /\(normalized_title_hash, published_at\)/u);
  assert.doesNotMatch(statements[0]!, /UNIQUE|DELETE|UPDATE|CREATE TABLE/u);
  const options = createTypeOrmOptions('mysql://orsem:test@localhost/orsem');
  assert.equal(options.synchronize, false);
  assert.ok(
    Array.isArray(options.migrations) && options.migrations.includes(AddNewsTitleHash1788413000000),
  );
});
