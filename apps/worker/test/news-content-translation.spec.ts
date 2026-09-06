import 'reflect-metadata';
import { RightsMode, type NewsContentBlock } from '@orsem/contracts';
import { NewsArticleContentEntity, NewsItemEntity, SourceItemEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { LocalNewsTranslationClient } from '../src/ai/local-news-translation.client';
import {
  NewsContentTranslationError,
  validateNewsContentTranslation,
} from '../src/ai/news-translation-validation';
import {
  contentChunks,
  contentTranslationFailureCode,
  contentTranslationIsDue,
  NewsTranslationService,
} from '../src/ai/news-translation.service';
import { loadWorkerConfig } from '../src/config/worker-config';
import type { FetchImplementation } from '../src/opendart/opendart.client';

const now = new Date('2026-09-05T00:00:00Z');
const original: NewsContentBlock[] = [
  { type: 'HEADING', level: 2, text: 'Policy decision' },
  { type: 'PARAGRAPH', text: 'The rate remains at 5%.' },
  { type: 'LIST', ordered: false, items: ['Growth was 2%', 'Inflation was 3%'] },
];
const translated: NewsContentBlock[] = [
  { type: 'HEADING', level: 2, text: '정책 결정' },
  { type: 'PARAGRAPH', text: '금리는 5%로 유지됩니다.' },
  { type: 'LIST', ordered: false, items: ['성장률은 2%였습니다', '물가상승률은 3%였습니다'] },
];

describe('news article content translation', () => {
  it('preserves every block, list item and numeric fact', () => {
    expect(validateNewsContentTranslation(original, [], { blocks: translated })).toEqual(
      translated,
    );
    expect(() =>
      validateNewsContentTranslation(original, [], {
        blocks: translated.slice(0, 2),
      }),
    ).toThrow(/blocks/u);
    expect(() =>
      validateNewsContentTranslation(original, [], {
        blocks: [translated[0], { type: 'PARAGRAPH', text: '금리는 6%입니다.' }, translated[2]],
      }),
    ).toThrow(/numeric/u);
  });

  it('bounds normal content chunks to eight blocks and 1,500 JSON characters', () => {
    const blocks: NewsContentBlock[] = Array.from({ length: 17 }, (_, index) => ({
      type: 'PARAGRAPH',
      text: `Paragraph ${index + 1}: ${'a'.repeat(120)}`,
    }));
    const chunks = contentChunks(blocks);
    expect(chunks.flat()).toEqual(blocks);
    expect(chunks.every((chunk) => chunk.length <= 8)).toBe(true);
    expect(chunks.every((chunk) => JSON.stringify(chunk).length <= 1_500)).toBe(true);
  });

  it('uses the smaller local-model bounds and returns only a limited failure code', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ details: { format: 'gguf' } })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ done: true, done_reason: 'length', message: { content: '{}' } }),
        ),
      );
    const client = new LocalNewsTranslationClient(
      loadWorkerConfig({ NEWS_TRANSLATION_ENABLED: 'true' }),
      fetchImpl as FetchImplementation,
    );
    await expect(client.translateContentChunk(original, [])).rejects.toMatchObject({
      failureCode: 'OUTPUT_TRUNCATED',
    });
    const request = fetchImpl.mock.calls[1]![1] as RequestInit;
    const body = JSON.parse(request.body as string) as { options: Record<string, number> };
    expect(body.options).toMatchObject({ num_predict: 1200, num_ctx: 4096 });
    expect(contentTranslationFailureCode(new Error('raw article text'))).toBe('UNKNOWN');
  });

  it('retries pending or failed content and accepts only matching completed hashes', () => {
    const content: NewsArticleContentEntity = Object.assign(new NewsArticleContentEntity(), {
      contentHash: 'a'.repeat(64),
      translationJson: null,
    });
    expect(contentTranslationIsDue(content, now)).toBe(true);
    content.translationJson = {
      version: 1,
      status: 'COMPLETED',
      inputHash: content.contentHash!,
      provider: 'LOCAL',
      model: 'local',
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      blocks: translated,
      attemptedAt: now.toISOString(),
      translatedAt: now.toISOString(),
      attempts: 1,
      nextAttemptAt: null,
    };
    expect(contentTranslationIsDue(content, now)).toBe(false);
    content.contentHash = 'b'.repeat(64);
    expect(contentTranslationIsDue(content, now)).toBe(true);
  });

  it('stores no partial blocks when a later bounded chunk fails', async () => {
    const longBlocks: NewsContentBlock[] = [
      { type: 'PARAGRAPH', text: `First 5% ${'a'.repeat(3_600)}` },
      { type: 'PARAGRAPH', text: `Second 6% ${'b'.repeat(3_600)}` },
    ];
    const client = {
      model: 'qwen-local',
      translate: jest.fn(),
      translateContentChunk: jest
        .fn()
        .mockResolvedValueOnce([{ type: 'PARAGRAPH', text: `첫 번째 5% ${'가'.repeat(3_600)}` }])
        .mockRejectedValueOnce(new Error('model failed')),
    };
    const test = translationHarness(longBlocks, client as unknown as LocalNewsTranslationClient);
    const result = await test.service.translateBatch();
    expect(result).toMatchObject({ contentCompleted: 0, contentFailed: 1 });
    expect(client.translateContentChunk).toHaveBeenCalledTimes(2);
    expect(test.finalSet).toHaveBeenCalledWith({
      translationJson: expect.objectContaining({
        status: 'FAILED',
        blocks: null,
        failureCode: 'UNKNOWN',
      }),
    });
  });

  it('splits a failed multi-block chunk once and publishes only the complete article', async () => {
    const blocks: NewsContentBlock[] = Array.from({ length: 4 }, (_, index) => ({
      type: 'PARAGRAPH',
      text: `Paragraph ${index + 1}.`,
    }));
    const korean = blocks.map((_, index) => ({
      type: 'PARAGRAPH' as const,
      text: `문단 ${index + 1}.`,
    }));
    const client = {
      model: 'qwen-local',
      translate: jest.fn(),
      translateContentChunk: jest
        .fn()
        .mockRejectedValueOnce(new NewsContentTranslationError('TIMEOUT'))
        .mockResolvedValueOnce(korean.slice(0, 2))
        .mockResolvedValueOnce(korean.slice(2)),
    };
    const test = translationHarness(blocks, client as unknown as LocalNewsTranslationClient);
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentCompleted: 1 });
    expect(client.translateContentChunk).toHaveBeenCalledTimes(3);
    expect(test.finalSet).toHaveBeenCalledWith({
      translationJson: expect.objectContaining({
        status: 'COMPLETED',
        blocks: korean,
        failureCode: null,
      }),
    });
    expect(test.contentSelection.orderBy).toHaveBeenCalledWith(
      'CHAR_LENGTH(CAST(content.blocksJson AS CHAR))',
      'ASC',
    );
  });

  it('keeps split retry results private when either half fails', async () => {
    const blocks: NewsContentBlock[] = Array.from({ length: 4 }, (_, index) => ({
      type: 'PARAGRAPH',
      text: `Paragraph ${index + 1}.`,
    }));
    const client = {
      model: 'qwen-local',
      translate: jest.fn(),
      translateContentChunk: jest
        .fn()
        .mockRejectedValueOnce(new NewsContentTranslationError('TIMEOUT'))
        .mockResolvedValueOnce([
          { type: 'PARAGRAPH', text: '문단 1.' },
          { type: 'PARAGRAPH', text: '문단 2.' },
        ])
        .mockRejectedValueOnce(new NewsContentTranslationError('VALIDATION')),
    };
    const test = translationHarness(blocks, client as unknown as LocalNewsTranslationClient);
    await expect(test.service.translateBatch()).resolves.toMatchObject({ contentFailed: 1 });
    expect(test.finalSet).toHaveBeenCalledWith({
      translationJson: expect.objectContaining({
        status: 'FAILED',
        blocks: null,
        failureCode: 'VALIDATION',
      }),
    });
  });
});

function chain(raw: readonly { id: string }[] = []) {
  const query: Record<string, jest.Mock> = {};
  for (const name of [
    'select',
    'innerJoin',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'update',
    'set',
  ])
    query[name] = jest.fn().mockReturnValue(query);
  query.getRawMany = jest.fn().mockResolvedValue(raw);
  query.execute = jest.fn().mockResolvedValue({ affected: 1 });
  return query;
}

function translationHarness(blocks: NewsContentBlock[], client: LocalNewsTranslationClient) {
  const sourceSelection = chain([]);
  const contentSelection = chain([{ id: 'content-id' }]);
  const finalUpdate = chain();
  const finalSet = finalUpdate.set!;
  let contentBuilderCalls = 0;
  const source = Object.assign(new SourceItemEntity(), {
    id: 'source-id',
    source: 'NEWS_RSS',
    rawHash: 's'.repeat(64),
    title: 'Federal Reserve policy decision',
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
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
  });
  const content = Object.assign(new NewsArticleContentEntity(), {
    id: 'content-id',
    sourceItemId: source.id,
    status: 'AVAILABLE',
    language: 'en',
    blocksJson: blocks,
    contentHash: 'c'.repeat(64),
    rightsPolicyJson: source.sourcePolicyJson,
    translationJson: null,
  });
  const news = Object.assign(new NewsItemEntity(), { tickersJson: [] });
  const sourceRepository = {
    createQueryBuilder: () => sourceSelection,
    findOne: jest.fn().mockResolvedValue(source),
  };
  const contentRepository = {
    createQueryBuilder: () => (contentBuilderCalls++ === 0 ? contentSelection : finalUpdate),
    findOne: jest.fn().mockResolvedValue(content),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const newsRepository = { findOne: jest.fn().mockResolvedValue(news) };
  const manager = {
    getRepository: (entity: unknown) =>
      entity === SourceItemEntity
        ? sourceRepository
        : entity === NewsArticleContentEntity
          ? contentRepository
          : newsRepository,
  };
  const dataSource = {
    getRepository: (entity: unknown) =>
      entity === SourceItemEntity ? sourceRepository : contentRepository,
    transaction: async (callback: (value: typeof manager) => unknown) => callback(manager),
  } as unknown as DataSource;
  return {
    service: new NewsTranslationService(
      dataSource,
      loadWorkerConfig({ NEWS_TRANSLATION_ENABLED: 'true', NEWS_TRANSLATION_BATCH_SIZE: '3' }),
      Object.assign(client, { provider: 'LOCAL' }),
    ),
    finalSet,
    contentSelection,
  };
}
