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

const longBlocks: NewsContentBlock[] = [
  { type: 'PARAGRAPH', text: `First 5% ${'a'.repeat(1600)}` },
  { type: 'PARAGRAPH', text: `Second 6% ${'b'.repeat(1600)}` },
];
const korean: NewsContentBlock[] = [
  { type: 'PARAGRAPH', text: '첫 번째 5%입니다.' },
  { type: 'PARAGRAPH', text: '두 번째 6%입니다.' },
];
// These responses cover the long synthetic source instead of summarizing it.
const longKoreanTexts = [
  `첫 번째 5%입니다. ${'첫 문단의 상세 내용입니다. '.repeat(100)}`,
  `두 번째 6%입니다. ${'다음 문단의 상세 내용입니다. '.repeat(100)}`,
].map((text) => text.trim());
const longKorean: NewsContentBlock[] = longKoreanTexts.map((text) => ({
  type: 'PARAGRAPH',
  text,
}));

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

  it('resumes after a failed later chunk without translating completed earlier chunks again', async () => {
    const test = harness('content', longBlocks);
    test.client.translateContentChunk
      .mockResolvedValueOnce([longKorean[0]])
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([longKorean[1]]);
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentFailed: 1 });
    expect(test.content.translationJson).toMatchObject({
      status: 'FAILED',
      blocks: null,
      completedChunks: [{ blocks: [longKorean[0]] }],
    });
    test.content.translationJson!.nextAttemptAt = '2020-01-01T00:00:00Z';
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentCompleted: 1 });
    expect(test.client.translateContentChunk).toHaveBeenCalledTimes(3);
    expect(test.client.translateContentChunk).toHaveBeenLastCalledWith([longBlocks[1]], []);
    expect(test.content.translationJson).toMatchObject({
      status: 'COMPLETED',
      blocks: longKorean,
      completedChunks: [],
      nextAttemptAt: null,
    });
    await test.service.translateBatch();
    expect(test.client.translateContentChunk).toHaveBeenCalledTimes(3);
  });

  it('resumes a successful split half without repeating the failed parent request', async () => {
    const blocks: NewsContentBlock[] = [
      { type: 'PARAGRAPH', text: 'First 5%.' },
      { type: 'PARAGRAPH', text: 'Second 6%.' },
    ];
    const test = harness('content', blocks);
    test.client.translateContentChunk
      .mockRejectedValueOnce(new Error('split required'))
      .mockResolvedValueOnce([korean[0]])
      .mockRejectedValueOnce(new Error('second half failed'))
      .mockResolvedValueOnce([korean[1]]);
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentFailed: 1 });
    test.content.translationJson!.nextAttemptAt = '2020-01-01T00:00:00Z';
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentCompleted: 1 });
    expect(test.client.translateContentChunk).toHaveBeenCalledTimes(4);
    expect(test.client.translateContentChunk).toHaveBeenLastCalledWith([blocks[1]], []);
  });

  it('reuses completed chunks after switching local models and preserves their provenance', async () => {
    const test = harness('content', longBlocks);
    test.client.translateContentChunk
      .mockResolvedValueOnce([longKorean[0]])
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([longKorean[1]]);
    await test.service.translateBatch();
    test.client.model = 'local-test-v2';
    test.content.translationJson!.nextAttemptAt = '2020-01-01T00:00:00Z';
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentCompleted: 1 });
    expect(test.client.translateContentChunk).toHaveBeenCalledTimes(3);
    expect(test.content.translationJson).toMatchObject({
      chunkOrigins: [
        { provider: 'LOCAL', model: 'local-test' },
        { provider: 'LOCAL', model: 'local-test-v2' },
      ],
      blocks: longKorean,
    });
  });

  it('does not reuse prior checkpoints when the article content hash changes', async () => {
    const test = harness('content', longBlocks);
    test.client.translateContentChunk
      .mockResolvedValueOnce([longKorean[0]])
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([longKorean[0]])
      .mockResolvedValueOnce([longKorean[1]]);
    await test.service.translateBatch();
    test.content.contentHash = 'c'.repeat(64);
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentCompleted: 1 });
    expect(test.client.translateContentChunk).toHaveBeenCalledTimes(4);
    expect(test.content.translationJson).toMatchObject({ attempts: 1, inputHash: 'c'.repeat(64) });
  });

  it('checkpoints an oversized list by item groups and restores the original list after retry', async () => {
    const items = [`First 5% ${'a'.repeat(1600)}`, `Second 6% ${'b'.repeat(1600)}`];
    const test = harness('content', [{ type: 'LIST', ordered: true, items }]);
    test.client.translateContentChunk
      .mockResolvedValueOnce([{ type: 'LIST', ordered: true, items: [longKoreanTexts[0]] }])
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([{ type: 'LIST', ordered: true, items: [longKoreanTexts[1]] }]);
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentFailed: 1 });
    test.content.translationJson!.nextAttemptAt = '2020-01-01T00:00:00Z';
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentCompleted: 1 });
    expect(test.client.translateContentChunk).toHaveBeenCalledTimes(3);
    expect(test.client.translateContentChunk).toHaveBeenLastCalledWith(
      [{ type: 'LIST', ordered: true, items: [items[1]] }],
      [],
    );
    expect(test.content.translationJson!.blocks).toEqual([
      { type: 'LIST', ordered: true, items: longKoreanTexts },
    ]);
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

  it('renews the claim before each split call even when the total duration exceeds its initial lease', async () => {
    jest.useFakeTimers({ now: at });
    try {
      const blocks: NewsContentBlock[] = [
        { type: 'PARAGRAPH', text: 'First 5%.' },
        { type: 'PARAGRAPH', text: 'Second 6%.' },
      ];
      const test = harness('content', blocks);
      const leases: number[] = [];
      test.client.translateContentChunk.mockImplementation(async (input: NewsContentBlock[]) => {
        leases.push(Date.parse(test.content.translationJson!.nextAttemptAt!));
        expect(leases.at(-1)! - Date.now()).toBeGreaterThanOrEqual(180000);
        jest.setSystemTime(Date.now() + 119000);
        if (input.length === 2) throw new Error('split');
        return [
          input[0]?.type === 'PARAGRAPH' && input[0].text.startsWith('First')
            ? korean[0]
            : korean[1],
        ];
      });
      await expect(test.service.translateBatch()).resolves.toMatchObject({ contentCompleted: 1 });
      expect(leases).toHaveLength(3);
      expect(leases[2]! - leases[0]!).toBe(238000);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['metadata', 'content'] as const)(
    'does not overwrite a manual edit made during %s inference',
    async (mode) => {
      const test = harness(mode, [longBlocks[0]!]);
      const target = mode === 'metadata' ? test.source : test.content;
      const mock = mode === 'metadata' ? test.client.translate : test.client.translateContentChunk;
      mock.mockImplementationOnce(async () => {
        Object.assign(target, { manualTranslationJson: { revisionId: 'manual-save' } });
        return mode === 'metadata' ? { title: '자동 결과', description: null } : [korean[0]];
      });
      await expect(test.service.translateBatch()).resolves.toMatchObject(
        mode === 'metadata' ? { completed: 0, stale: 1 } : { contentCompleted: 0, contentStale: 1 },
      );
      expect(target.manualTranslationJson).toMatchObject({ revisionId: 'manual-save' });
      expect(target.translationJson?.status).toBe('PROCESSING');
      await test.service.translateBatch();
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );

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
