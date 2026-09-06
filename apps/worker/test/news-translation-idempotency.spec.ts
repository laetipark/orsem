import 'reflect-metadata';
import { RightsMode, type NewsContentBlock } from '@orsem/contracts';
import { NewsArticleContentEntity, SourceItemEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import { LocalNewsTranslationClient } from '../src/ai/local-news-translation.client';
import { NewsTranslationService } from '../src/ai/news-translation.service';

const sourceHash = 'a'.repeat(64);
const contentHash = 'b'.repeat(64);
const at = new Date('2026-09-05T00:00:00Z');
const policy = {
  rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
  metadataStorageAllowed: true,
  displayAllowed: true,
  fullTextStorageAllowed: true,
  aiAllowed: true,
};
const completed = (inputHash: string) => ({ version: 1, status: 'COMPLETED', inputHash });

function harness(mode: 'metadata' | 'content', blocks: NewsContentBlock[] = []) {
  const source = {
    id: 'source',
    source: 'NEWS_RSS',
    rawHash: sourceHash,
    title: 'Company announces official results',
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    sourcePolicyJson: policy,
    firstObservedAt: at,
    publishedAt: at,
    url: 'https://example.test/news',
    manualTranslationJson: null,
    translationJson: mode === 'metadata' ? null : completed(sourceHash),
  } as unknown as SourceItemEntity;
  const content = {
    id: 'content',
    sourceItemId: source.id,
    status: 'AVAILABLE',
    language: 'en',
    contentHash,
    blocksJson: blocks,
    rightsPolicyJson: policy,
    manualTranslationJson: null,
    translationJson: mode === 'content' ? null : completed(contentHash),
  } as unknown as NewsArticleContentEntity;
  const news = { sourceItemId: source.id, description: 'Official results.', tickersJson: [] };
  const client = {
    model: 'local-test',
    provider: 'LOCAL',
    translate: jest
      .fn()
      .mockResolvedValue({ title: '회사가 공식 결과 발표', description: '공식 결과입니다.' }),
    translateContentChunk: jest.fn(),
  };
  const updates: Array<{ entity: unknown; values: Record<string, unknown>; predicates: string[] }> =
    [];
  const current = (entity: unknown): Record<string, unknown> =>
    entity === SourceItemEntity
      ? (source as unknown as Record<string, unknown>)
      : entity === NewsArticleContentEntity
        ? (content as unknown as Record<string, unknown>)
        : news;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const repository = (entity: unknown) => ({
    async findOne(options: { where: Record<string, unknown> }) {
      const row = current(entity);
      return matches(row, options.where) ? structuredClone(row) : null;
    },
    async update(where: Record<string, unknown>, values: Record<string, unknown>) {
      const row = current(entity);
      if (!matches(row, where)) return { affected: 0 };
      Object.assign(row, structuredClone(values));
      return { affected: 1 };
    },
    createQueryBuilder() {
      const predicates: string[] = [];
      const parameters: Record<string, unknown> = {};
      let values: Record<string, unknown> = {};
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'innerJoin', 'orderBy', 'addOrderBy', 'limit', 'update'])
        query[method] = () => query;
      query.set = (data: Record<string, unknown>) => {
        values = structuredClone(data);
        return query;
      };
      for (const method of ['where', 'andWhere'])
        query[method] = (sql: unknown, params = {}) => {
          if (typeof sql === 'string') predicates.push(sql);
          Object.assign(parameters, params);
          return query;
        };
      query.getRawMany = async () => [{ id: current(entity).id }];
      query.execute = async () => {
        const row = current(entity);
        const audit = row.translationJson as Record<string, unknown> | null;
        const conditions = predicates.join(' ');
        if (
          row.id !== parameters.id ||
          ('rawHash' in parameters && row.rawHash !== parameters.rawHash) ||
          ('contentHash' in parameters && row.contentHash !== parameters.contentHash) ||
          (conditions.includes('manual_translation_json IS NULL') && row.manualTranslationJson) ||
          (conditions.includes("'PROCESSING'") && audit?.status !== 'PROCESSING') ||
          ('claimId' in parameters && audit?.claimId !== parameters.claimId) ||
          ('attemptedAt' in parameters && audit?.attemptedAt !== parameters.attemptedAt)
        )
          return { affected: 0 };
        updates.push({ entity, values: structuredClone(values), predicates });
        Object.assign(row, structuredClone(values));
        return { affected: 1 };
      };
      return query;
    },
  });
  const manager = { getRepository: repository };
  let pending = Promise.resolve();
  const db = {
    ...manager,
    async transaction<T>(callback: (value: typeof manager) => Promise<T>): Promise<T> {
      const prior = pending;
      let release!: () => void;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await callback(manager);
      } finally {
        release();
      }
    },
  } as unknown as DataSource;
  const config = loadWorkerConfig({
    NEWS_TRANSLATION_ENABLED: 'true',
    NEWS_TRANSLATION_TIMEOUT_MS: '120000',
  });
  const service = new NewsTranslationService(
    db,
    config,
    client as unknown as LocalNewsTranslationClient,
  );
  return { service, config, source, content, client, updates };
}

describe('automatic translations are idempotent for each current source version', () => {
  it('does not repeat completed metadata inference on a queue retry', async () => {
    const test = harness('metadata');
    await expect(test.service.translateBatch()).resolves.toMatchObject({ completed: 1 });
    const saved = structuredClone(test.source.translationJson);
    await expect(test.service.translateBatch()).resolves.toMatchObject({ completed: 0 });
    expect(test.client.translate).toHaveBeenCalledTimes(1);
    expect(test.source.translationJson).toEqual(saved);
  });

  it('keeps completed translations when the local model changes and honors the disable setting', async () => {
    const test = harness('metadata');
    await test.service.translateBatch();
    const saved = structuredClone(test.source.translationJson);
    test.client.model = 'local-test-v2';
    await test.service.translateBatch();
    expect(test.client.translate).toHaveBeenCalledTimes(1);
    expect(test.source.translationJson).toEqual(saved);
    test.config.newsTranslationEnabled = false;
    test.source.translationJson = null;
    await expect(test.service.translateBatch()).resolves.toMatchObject({ disabled: true });
    expect(test.client.translate).toHaveBeenCalledTimes(1);
  });

  it('reuses completed metadata when a later raw hash has an identical recorded input fingerprint', async () => {
    const test = harness('metadata');
    await test.service.translateBatch();
    const saved = structuredClone(test.source.translationJson)!;
    test.source.rawHash = 'c'.repeat(64);
    await test.service.translateBatch();
    expect(test.client.translate).toHaveBeenCalledTimes(1);
    expect(test.source.translationJson).toEqual({ ...saved, inputHash: test.source.rawHash });
  });

  it('prevents a concurrent batch from claiming an inference already in progress', async () => {
    const test = harness('metadata');
    let release!: (value: { title: string; description: null }) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    test.client.translate.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const first = test.service.translateBatch();
    await ready;
    await expect(test.service.translateBatch()).resolves.toMatchObject({ completed: 0 });
    release({ title: '공식 결과 발표', description: null });
    await expect(first).resolves.toMatchObject({ completed: 1 });
    expect(test.client.translate).toHaveBeenCalledTimes(1);
  });

  it('renews metadata lease before a title-only fallback and releases it on completion', async () => {
    jest.useFakeTimers({ now: at });
    try {
      const test = harness('metadata');
      test.client.translate
        .mockImplementationOnce(async () => {
          jest.setSystemTime(Date.now() + 119000);
          throw new Error('summary validation failed');
        })
        .mockImplementationOnce(async () => {
          expect(Date.parse(String(test.source.translationJson!.nextAttemptAt)) - Date.now()).toBe(
            180000,
          );
          return { title: '공식 결과 발표', description: null };
        });
      await expect(test.service.translateBatch()).resolves.toMatchObject({ completed: 1 });
      expect(test.source.translationJson!.nextAttemptAt).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not overwrite a manual metadata edit made during inference', async () => {
    const test = harness('metadata');
    test.client.translate.mockImplementationOnce(async () => {
      Object.assign(test.source, {
        manualTranslationJson: { version: 2, revisionId: 'manual-save' },
      });
      return { title: '자동 결과', description: null };
    });
    await expect(test.service.translateBatch()).resolves.toMatchObject({ completed: 0, stale: 1 });
    expect(test.source.manualTranslationJson).toMatchObject({ revisionId: 'manual-save' });
    await test.service.translateBatch();
    expect(test.client.translate).toHaveBeenCalledTimes(1);
  });

  it('never resumes historical body checkpoints from an old batch job', async () => {
    const test = harness('content', [{ type: 'PARAGRAPH', text: 'Legacy body secret' }]);
    const saved = structuredClone(test.content);
    await test.service.translateBatch();
    await test.service.translateBatch();
    expect(test.client.translateContentChunk).not.toHaveBeenCalled();
    expect(test.content).toEqual(saved);
    expect(test.updates.some(({ entity }) => entity === NewsArticleContentEntity)).toBe(false);
  });

  it('rejects an old claim even if another claim has the same attemptedAt timestamp', async () => {
    const test = harness('metadata');
    test.client.translate.mockImplementationOnce(async () => {
      test.source.translationJson!.claimId = 'replacement-claim';
      return { title: '지연된 결과', description: null };
    });
    await expect(test.service.translateBatch()).resolves.toMatchObject({ stale: 1, completed: 0 });
    expect(test.source.translationJson!.claimId).toBe('replacement-claim');
  });
});
