import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RightsMode } from '@orsem/contracts';
import {
  ENTITIES,
  EventClusterEntity,
  EventClusterItemEntity,
  NewsArticleContentEntity,
  NewsItemEntity,
  SourceItemEntity,
} from '@orsem/database';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { literalSearchPattern } from '../common/news-translation';
import { OrsemDataService } from './orsem-data.service';

async function context() {
  const now = new Date('2026-09-04T03:00:00.000Z');
  const row: SourceItemEntity = Object.assign(new SourceItemEntity(), {
    id: 'source-id',
    source: 'IR',
    newsArticleId: null,
    sourceKind: 'COMPANY_IR',
    sourcePolicyJson: {
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      aiAllowed: true,
      fullTextStorageAllowed: true,
      publicRedistributionAllowed: true,
      displayAllowed: true,
      metadataStorageAllowed: true,
      notifyAllowed: false,
      policyUrl: 'https://example.com/policy',
      checkedAt: '2026-09-05',
    },
    externalId: 'external-id',
    companyId: null,
    title: 'Original news title',
    url: 'https://example.com/news',
    sourceName: 'Example IR',
    author: null,
    publishedAt: now,
    firstObservedAt: now,
    processedAt: now,
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    provenanceUrl: 'https://example.com/news',
    rawHash: 'a'.repeat(64),
    rawMetadataJson: {
      description: 'Original feed summary',
      publisherId: 'samsung-global-newsroom',
      private: true,
    },
    translationJson: {
      version: 1,
      status: 'COMPLETED',
      inputHash: 'a'.repeat(64),
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      provider: 'LOCAL',
      model: 'test-local-model',
      title: '번역 뉴스 제목',
      description: '번역한 요약',
      translatedAt: now.toISOString(),
      attemptedAt: now.toISOString(),
      attempts: 1,
      nextAttemptAt: null,
      internalError: '숨길 내부 값',
    },
  });
  const content = Object.assign(new NewsArticleContentEntity(), {
    id: 'content-id',
    sourceItemId: row.id,
    status: 'AVAILABLE',
    language: 'en',
    blocksJson: [{ type: 'PARAGRAPH', text: 'Original article body' }],
    contentHash: 'c'.repeat(64),
    extractorVersion: 1,
    fetchedAt: now,
    attemptedAt: now,
    attempts: 1,
    nextAttemptAt: null,
    failureCode: null,
    rightsPolicyJson: row.sourcePolicyJson,
    translationJson: {
      version: 1,
      status: 'COMPLETED',
      inputHash: 'c'.repeat(64),
      provider: 'LOCAL',
      model: 'test-local-model',
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      blocks: [{ type: 'PARAGRAPH', text: '번역한 기사 본문' }],
      attemptedAt: now.toISOString(),
      translatedAt: now.toISOString(),
      attempts: 1,
      nextAttemptAt: null,
    },
  });
  (row as SourceItemEntity & { newsContent: NewsArticleContentEntity }).newsContent = content;
  const event = Object.assign(new EventClusterEntity(), {
    id: 'event-id',
    canonicalEventType: 'NEWS',
    companyId: null,
    occurredAt: null,
    publishedAt: now,
    firstObservedAt: now,
    processedAt: now,
    state: 'ACTIVE',
    evidenceGrade: 'A',
    summary: 'Original event summary',
  });
  const metadata = new DataSource({
    type: 'mysql',
    host: '127.0.0.1',
    database: 'test',
    username: 'test',
    password: 'test',
    entities: [...ENTITIES],
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const dataSource = {
    getRepository(entity: EntityTarget<ObjectLiteral>) {
      const rows =
        entity === SourceItemEntity ? [row] : entity === EventClusterEntity ? [event] : [];
      return {
        createQueryBuilder(alias: string) {
          const query = metadata.getRepository(entity).createQueryBuilder(alias);
          const capture = () => {
            const [sql, parameters] = query.getQueryAndParameters();
            queries.push({ sql, parameters });
          };
          query.getMany = async () => {
            capture();
            return rows;
          };
          query.getOne = async () => {
            capture();
            return rows[0] ?? null;
          };
          return query;
        },
        findOneBy: async () =>
          entity === NewsItemEntity
            ? { title: row.title, description: 'Original news summary', publishedAt: now }
            : (rows[0] ?? null),
        findBy: async () =>
          entity === EventClusterItemEntity
            ? [{ eventClusterId: event.id, itemType: 'SOURCE_ITEM', itemId: row.id }]
            : [],
      };
    },
  } as unknown as DataSource;
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    { dataSource } as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
  return { service, row, event, content, queries };
}

test('뉴스 목록·상세와 이벤트·근거에서 원문을 보존하고 검증된 번역만 전달한다', async () => {
  const { service, row, event } = await context();
  const list = await service.listNews({ limit: 5 });
  const detail = await service.getNews(row.id);
  assert.equal(list.items[0]?.title, row.title);
  assert.equal(list.items[0]?.translation?.title, '번역 뉴스 제목');
  assert.equal(list.items[0]?.description, 'Original feed summary');
  assert.equal(detail.description, 'Original news summary');
  assert.equal(detail.translation?.description, '번역한 요약');
  assert.equal(detail.content?.sourceItemId, row.id);
  assert.deepEqual(detail.content?.translation?.blocks, [
    { type: 'PARAGRAPH', text: '번역한 기사 본문' },
  ]);
  const eventList = await service.listEventViews({ limit: 5 });
  const view = await service.getEventView(event.id);
  assert.equal(eventList.items[0]?.title, row.title);
  assert.equal(eventList.items[0]?.summary, event.summary);
  assert.equal(eventList.items[0]?.translation?.title, '번역 뉴스 제목');
  const evidence = (view.evidence as Array<Record<string, unknown>>)[0]!;
  assert.equal(evidence.title, row.title);
  assert.equal(evidence.description, 'Original feed summary');
  assert.equal((evidence.translation as { title: string }).title, '번역 뉴스 제목');
  for (const value of [list, detail, view]) {
    assert.ok(!JSON.stringify(value).includes('internalError'));
    assert.ok(!JSON.stringify(value).includes('rawMetadataJson'));
  }
  row.rawHash = 'b'.repeat(64);
  await assert.rejects(() => service.getNews(row.id));
  assert.equal((await service.listEventViews({ limit: 5 })).items[0]?.translation, null);
  row.rawHash = 'a'.repeat(64);
  row.rightsMode = RightsMode.STORE_METADATA_ONLY;
  await assert.rejects(() => service.getNews(row.id));
  row.source = 'SEC';
  await assert.rejects(() => service.getNews(row.id));
});

test('뉴스와 이벤트의 번역 제목 검색도 실제 MySQL SQL에 입력을 바인딩한다', async () => {
  const { service, queries } = await context();
  const q = "번역%' OR 1=1 --_!";
  await service.listNews({ q, limit: 5 });
  await service.listEvents({ q, limit: 5 });
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.ok(!query.sql.includes(q));
    assert.ok(query.parameters.includes(literalSearchPattern(q)));
    assert.match(query.sql, /translation_json/u);
    assert.match(query.sql, /\$\.inputHash/u);
    assert.match(query.sql, /BINARY 'COMPLETED'/u);
    assert.match(query.sql, /'NEWS_RSS', 'IR'/u);
    assert.match(query.sql, /LIKE \? ESCAPE '!'/u);
  }
});

test('원문 해시가 없는 예시 SourceItem에는 번역을 추가하지 않는다', async () => {
  const fixtures = new FixtureStoreService();
  const source = fixtures.sourceItems[0]!;
  source.source = 'IR';
  source.translation = {
    language: 'ko',
    title: '검증되지 않은 예시 번역',
    description: null,
    translatedAt: '2026-09-04T03:00:00.000Z',
    provider: 'LOCAL',
    model: 'test-local-model',
  };
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {} as DatabaseRuntimeService,
    fixtures,
  );
  await assert.rejects(
    () => service.getNews(source.id),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'getStatus' in error &&
      (error as { getStatus(): number }).getStatus() === 404,
  );
  assert.equal(
    (await service.listNews({ limit: 100 })).items.find((item) => item.id === source.id)
      ?.translation,
    undefined,
  );
});
