import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RightsMode, type NewsContentBlock } from '@orsem/contracts';
import { NewsArticleContentEntity, NewsItemEntity, SourceItemEntity } from '@orsem/database';
import { Brackets, DataSource } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import {
  NewsContentTranslationError,
  validateNewsContentTranslation,
  type NewsContentTranslationFailureCode,
  type NewsTranslationInput,
} from './news-translation-validation';
import { LocalNewsTranslationClient } from './local-news-translation.client';

const TRANSLATABLE_SOURCES = ['IR', 'NEWS_RSS'];
const DESCRIPTION_RIGHTS = new Set<RightsMode>([
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
]);

function sourcePolicyAllowsTranslation(source: SourceItemEntity): boolean {
  const policy = source.sourcePolicyJson;
  return Boolean(
    policy &&
    DESCRIPTION_RIGHTS.has(source.rightsMode) &&
    policy.rightsMode === source.rightsMode &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.fullTextStorageAllowed === true &&
    policy.aiAllowed === true,
  );
}

function contentPolicyAllowsTranslation(
  content: NewsArticleContentEntity,
  source: SourceItemEntity,
): boolean {
  const policy = content.rightsPolicyJson;
  return Boolean(
    sourcePolicyAllowsTranslation(source) &&
    policy &&
    policy.rightsMode === source.rightsMode &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.fullTextStorageAllowed === true &&
    policy.aiAllowed === true,
  );
}

export function looksLikeEnglishNews(title: string): boolean {
  const letters = title.match(/\p{L}/gu) ?? [];
  const latin = title.match(/[A-Za-z]/g) ?? [];
  return (
    !/[가-힣]/u.test(title) &&
    latin.length >= 8 &&
    latin.length / Math.max(1, letters.length) >= 0.85 &&
    (title.match(/[A-Za-z]{2,}/g) ?? []).length >= 2
  );
}

export function translationIsDue(
  source: Pick<SourceItemEntity, 'translationJson' | 'rawHash'> & {
    manualTranslationJson?: unknown;
  },
  now: Date,
): boolean {
  if (source.manualTranslationJson) return false;
  const saved = source.translationJson;
  if (!saved || saved.inputHash !== source.rawHash || saved.version !== 1) return true;
  if (saved.status === 'COMPLETED' || saved.status === 'SKIPPED') return false;
  const retryAt = typeof saved.nextAttemptAt === 'string' ? Date.parse(saved.nextAttemptAt) : NaN;
  return !Number.isFinite(retryAt) || retryAt <= now.getTime();
}

export function contentTranslationIsDue(
  content: Pick<NewsArticleContentEntity, 'translationJson' | 'contentHash'> & {
    manualTranslationJson?: unknown;
  },
  now: Date,
): boolean {
  if (content.manualTranslationJson) return false;
  const saved = content.translationJson;
  if (
    !content.contentHash ||
    !saved ||
    saved.inputHash !== content.contentHash ||
    saved.version !== 1
  )
    return true;
  if (saved.status === 'COMPLETED' || saved.status === 'SKIPPED') return false;
  const retryAt = saved.nextAttemptAt ? Date.parse(saved.nextAttemptAt) : Number.NaN;
  return !Number.isFinite(retryAt) || retryAt <= now.getTime();
}

const CONTENT_CHUNK_MAX_BLOCKS = 8;
const CONTENT_CHUNK_MAX_JSON_CHARS = 1_500;

export function contentChunks(
  blocks: readonly NewsContentBlock[],
): readonly (readonly NewsContentBlock[])[] {
  const chunks: NewsContentBlock[][] = [];
  let current: NewsContentBlock[] = [];
  for (const block of blocks) {
    const candidate = [...current, block];
    if (
      current.length > 0 &&
      (candidate.length > CONTENT_CHUNK_MAX_BLOCKS ||
        JSON.stringify(candidate).length > CONTENT_CHUNK_MAX_JSON_CHARS)
    ) {
      chunks.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function contentTranslationFailureCode(error: unknown): NewsContentTranslationFailureCode {
  return error instanceof NewsContentTranslationError ? error.failureCode : 'UNKNOWN';
}

export function translationInput(
  source: SourceItemEntity,
  news: NewsItemEntity,
): NewsTranslationInput | null {
  if (
    source.source === 'NAVER' ||
    !sourcePolicyAllowsTranslation(source) ||
    !TRANSLATABLE_SOURCES.includes(source.source) ||
    source.rightsMode === RightsMode.LINK_ONLY ||
    source.rightsMode === RightsMode.NO_REDISTRIBUTION ||
    !looksLikeEnglishNews(source.title) ||
    source.title.length > 1000
  )
    return null;
  return {
    title: source.title,
    description: DESCRIPTION_RIGHTS.has(source.rightsMode)
      ? news.description?.trim().slice(0, 1000) || null
      : null,
    tickers: (news.tickersJson ?? [])
      .filter((value) => /^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(value))
      .slice(0, 20),
  };
}

export function newsTranslationInputHash(input: NewsTranslationInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

class StaleTranslationClaimError extends Error {}

function contentChunkHash(blocks: readonly NewsContentBlock[], tickers: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ blocks, tickers })).digest('hex');
}

@Injectable()
export class NewsTranslationService {
  public constructor(
    private readonly dataSource: DataSource,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly client: LocalNewsTranslationClient,
  ) {}

  public async translateBatch(): Promise<{
    disabled?: boolean;
    completed: number;
    failed: number;
    skipped: number;
    stale: number;
    contentCompleted: number;
    contentFailed: number;
    contentStale: number;
  }> {
    const result = {
      completed: 0,
      failed: 0,
      skipped: 0,
      stale: 0,
      contentCompleted: 0,
      contentFailed: 0,
      contentStale: 0,
    };
    if (!this.config.newsTranslationEnabled) return { disabled: true, ...result };
    const now = new Date();
    const ids = await this.dataSource
      .getRepository(SourceItemEntity)
      .createQueryBuilder('source')
      .select('source.id', 'id')
      .innerJoin(NewsItemEntity, 'news', 'news.sourceItemId = source.id')
      .innerJoin(NewsArticleContentEntity, 'content', 'content.sourceItemId = source.id')
      .where('source.source IN (:...sources)', { sources: TRANSLATABLE_SOURCES })
      .andWhere('source.manualTranslationJson IS NULL AND content.manualTranslationJson IS NULL')
      .andWhere('source.rawHash IS NOT NULL')
      .andWhere("source.rightsMode IN ('OFFICIAL_PUBLIC_DATA', 'PRIVATE_DISPLAY_ONLY')")
      .andWhere("JSON_EXTRACT(source.sourcePolicyJson, '$.aiAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(source.sourcePolicyJson, '$.metadataStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere("JSON_EXTRACT(source.sourcePolicyJson, '$.displayAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(source.sourcePolicyJson, '$.fullTextStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere(
        "JSON_UNQUOTE(JSON_EXTRACT(source.sourcePolicyJson, '$.rightsMode')) = source.rightsMode",
      )
      .andWhere("content.status = 'AVAILABLE'")
      .andWhere('content.contentHash IS NOT NULL')
      .andWhere("JSON_EXTRACT(content.rightsPolicyJson, '$.aiAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(content.rightsPolicyJson, '$.metadataStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere("JSON_EXTRACT(content.rightsPolicyJson, '$.displayAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(content.rightsPolicyJson, '$.fullTextStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere(
        "JSON_UNQUOTE(JSON_EXTRACT(content.rightsPolicyJson, '$.rightsMode')) = source.rightsMode",
      )
      .andWhere(
        new Brackets((query) => {
          query
            .where('source.translationJson IS NULL')
            .orWhere(
              "NOT (JSON_UNQUOTE(JSON_EXTRACT(source.translationJson, '$.inputHash')) <=> source.rawHash)",
            )
            .orWhere("NOT (JSON_EXTRACT(source.translationJson, '$.version') <=> 1)")
            .orWhere(
              "(JSON_UNQUOTE(JSON_EXTRACT(source.translationJson, '$.status')) IN ('FAILED', 'PROCESSING') AND (JSON_EXTRACT(source.translationJson, '$.nextAttemptAt') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(source.translationJson, '$.nextAttemptAt')) <= :now))",
              { now: now.toISOString() },
            );
        }),
      )
      .orderBy('source.firstObservedAt', 'DESC')
      .addOrderBy('source.id', 'DESC')
      .limit(this.config.newsTranslationBatchSize)
      .getRawMany<{ id: string }>();
    for (const { id } of ids) {
      const claimed = await this.claim(id);
      if (!claimed) continue;
      if (!claimed.input) {
        result.skipped++;
        continue;
      }
      let final: Record<string, string | number | null>;
      let outcome: 'completed' | 'failed';
      try {
        let translated: Awaited<ReturnType<LocalNewsTranslationClient['translate']>>;
        try {
          translated = await this.client.translate(claimed.input);
        } catch (error) {
          if (claimed.input.description === null) throw error;
          if (
            !(await this.saveSourceTranslation(id, claimed, {
              ...claimed.audit,
              nextAttemptAt: this.claimExpiresAt(),
            }))
          )
            throw new StaleTranslationClaimError();
          translated = await this.client.translate({ ...claimed.input, description: null });
        }
        final = {
          ...claimed.audit,
          ...translated,
          status: 'COMPLETED',
          translatedAt: new Date().toISOString(),
          nextAttemptAt: null,
        };
        outcome = 'completed';
      } catch {
        // 외부 응답·원문·내부 주소를 오류 메시지로 저장하거나 로그에 노출하지 않습니다.
        const delay = claimed.attempts >= 3 ? 24 * 60 * 60_000 : claimed.attempts * 5 * 60_000;
        final = {
          ...claimed.audit,
          status: 'FAILED',
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
        };
        outcome = 'failed';
      }
      const saved = await this.saveSourceTranslation(id, claimed, final);
      if (saved) result[outcome]++;
      else result.stale++;
    }
    await this.translateContentBatch(now, result);
    return result;
  }

  private async translateContentBatch(
    now: Date,
    result: { contentCompleted: number; contentFailed: number; contentStale: number },
  ): Promise<void> {
    const ids = await this.dataSource
      .getRepository(NewsArticleContentEntity)
      .createQueryBuilder('content')
      .select('content.id', 'id')
      .innerJoin(SourceItemEntity, 'source', 'source.id = content.sourceItemId')
      .where("content.status = 'AVAILABLE'")
      .andWhere('source.manualTranslationJson IS NULL AND content.manualTranslationJson IS NULL')
      .andWhere("content.language = 'en'")
      .andWhere('content.contentHash IS NOT NULL')
      .andWhere('source.source IN (:...sources)', { sources: TRANSLATABLE_SOURCES })
      .andWhere("source.rightsMode IN ('OFFICIAL_PUBLIC_DATA', 'PRIVATE_DISPLAY_ONLY')")
      .andWhere("JSON_EXTRACT(source.sourcePolicyJson, '$.aiAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(source.sourcePolicyJson, '$.metadataStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere("JSON_EXTRACT(source.sourcePolicyJson, '$.displayAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(source.sourcePolicyJson, '$.fullTextStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere(
        "JSON_UNQUOTE(JSON_EXTRACT(source.sourcePolicyJson, '$.rightsMode')) = source.rightsMode",
      )
      .andWhere("JSON_EXTRACT(content.rightsPolicyJson, '$.aiAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(content.rightsPolicyJson, '$.metadataStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere("JSON_EXTRACT(content.rightsPolicyJson, '$.displayAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(content.rightsPolicyJson, '$.fullTextStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere(
        "JSON_UNQUOTE(JSON_EXTRACT(content.rightsPolicyJson, '$.rightsMode')) = source.rightsMode",
      )
      .andWhere(
        new Brackets((query) => {
          query
            .where('content.translationJson IS NULL')
            .orWhere(
              "NOT (JSON_UNQUOTE(JSON_EXTRACT(content.translationJson, '$.inputHash')) <=> content.contentHash)",
            )
            .orWhere("NOT (JSON_EXTRACT(content.translationJson, '$.version') <=> 1)")
            .orWhere(
              "(JSON_UNQUOTE(JSON_EXTRACT(content.translationJson, '$.status')) IN ('PENDING', 'FAILED', 'PROCESSING') AND (JSON_EXTRACT(content.translationJson, '$.nextAttemptAt') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(content.translationJson, '$.nextAttemptAt')) <= :contentNow))",
              { contentNow: now.toISOString() },
            );
        }),
      )
      .orderBy('CHAR_LENGTH(CAST(content.blocksJson AS CHAR))', 'ASC')
      .addOrderBy('content.fetchedAt', 'DESC')
      .addOrderBy('content.id', 'DESC')
      .limit(this.config.newsTranslationBatchSize)
      .getRawMany<{ id: string }>();
    for (const { id } of ids) {
      const claimed = await this.claimContent(id);
      if (!claimed) continue;
      try {
        const translated: NewsContentBlock[] = [];
        for (const chunk of contentChunks(claimed.blocks)) {
          translated.push(...(await this.translateContentChunk(chunk, claimed, id)));
        }
        const final = {
          ...claimed.audit,
          status: 'COMPLETED' as const,
          blocks: translated,
          chunkOrigins: (claimed.audit.completedChunks ?? []).map(
            ({ inputHash, provider, model }) => ({
              inputHash,
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
            }),
          ),
          completedChunks: [],
          translatedAt: new Date().toISOString(),
          nextAttemptAt: null,
          failureCode: null,
        };
        const saved = await this.saveContentTranslation(id, claimed, final);
        if (saved) result.contentCompleted += 1;
        else result.contentStale += 1;
      } catch (error) {
        const delay = claimed.attempts >= 3 ? 24 * 60 * 60_000 : claimed.attempts * 5 * 60_000;
        const final = {
          ...claimed.audit,
          status: 'FAILED' as const,
          blocks: null,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
          failureCode: contentTranslationFailureCode(error),
        };
        const saved = await this.saveContentTranslation(id, claimed, final);
        if (saved) result.contentFailed += 1;
        else result.contentStale += 1;
      }
    }
  }

  private async translateContentChunk(
    chunk: readonly NewsContentBlock[],
    claimed: NonNullable<Awaited<ReturnType<NewsTranslationService['claimContent']>>>,
    id: string,
    allowSplit = true,
  ): Promise<readonly NewsContentBlock[]> {
    const inputHash = contentChunkHash(chunk, claimed.tickers);
    const cached = claimed.audit.completedChunks?.find((item) => item.inputHash === inputHash);
    if (cached) {
      try {
        return validateNewsContentTranslation(chunk, claimed.tickers, { blocks: cached.blocks });
      } catch {
        claimed.audit.completedChunks = claimed.audit.completedChunks?.filter(
          (item) => item !== cached,
        );
      }
    }
    const onlyBlock = chunk.length === 1 ? chunk[0] : null;
    if (
      onlyBlock?.type === 'LIST' &&
      onlyBlock.items.length > 1 &&
      JSON.stringify(chunk).length > CONTENT_CHUNK_MAX_JSON_CHARS
    ) {
      // A single source list can exceed one provider request. Checkpoint its item groups
      // separately, then restore the original list structure when assembling the article.
      const parts: string[][] = [];
      let part: string[] = [];
      for (const item of onlyBlock.items) {
        if (
          part.length > 0 &&
          JSON.stringify([{ ...onlyBlock, items: [...part, item] }]).length >
            CONTENT_CHUNK_MAX_JSON_CHARS
        ) {
          parts.push(part);
          part = [];
        }
        part.push(item);
      }
      if (part.length) parts.push(part);
      const items: string[] = [];
      for (const entries of parts) {
        const translated = await this.translateContentChunk(
          [{ ...onlyBlock, items: entries }],
          claimed,
          id,
          false,
        );
        const list = translated[0];
        if (translated.length !== 1 || list?.type !== 'LIST')
          throw new NewsContentTranslationError('VALIDATION');
        items.push(...list.items);
      }
      return [{ ...onlyBlock, items }];
    }
    if (allowSplit && chunk.length >= 2) {
      const middle = Math.ceil(chunk.length / 2);
      const halves = [chunk.slice(0, middle), chunk.slice(middle)];
      if (
        halves.some((half) =>
          claimed.audit.completedChunks?.some(
            (item) => item.inputHash === contentChunkHash(half, claimed.tickers),
          ),
        )
      ) {
        const first = await this.translateContentChunk(halves[0]!, claimed, id, false);
        const second = await this.translateContentChunk(halves[1]!, claimed, id, false);
        return [...first, ...second];
      }
    }
    const persistProgress = async () => {
      claimed.audit.nextAttemptAt = this.claimExpiresAt();
      if (!(await this.saveContentTranslation(id, claimed, claimed.audit)))
        throw new StaleTranslationClaimError();
    };
    // Refresh before every bounded inference, including split retries. A long article owns
    // the claim for its whole run instead of only the timeout of its first chunk.
    await persistProgress();
    let blocks: readonly NewsContentBlock[];
    try {
      blocks = await this.client.translateContentChunk(chunk, claimed.tickers);
    } catch (error) {
      if (!allowSplit || chunk.length < 2) throw error;
      const middle = Math.ceil(chunk.length / 2);
      const first = await this.translateContentChunk(chunk.slice(0, middle), claimed, id, false);
      const second = await this.translateContentChunk(chunk.slice(middle), claimed, id, false);
      return [...first, ...second];
    }
    claimed.audit.completedChunks ??= [];
    claimed.audit.completedChunks.push({
      inputHash,
      blocks: [...blocks],
      provider: this.client.provider,
      model: this.client.model,
    });
    await persistProgress();
    return blocks;
  }

  private claimExpiresAt(): string {
    return new Date(Date.now() + this.config.newsTranslationTimeoutMs + 60_000).toISOString();
  }

  private async saveSourceTranslation(
    id: string,
    claimed: NonNullable<Awaited<ReturnType<NewsTranslationService['claim']>>>,
    translationJson: Record<string, string | number | null>,
  ): Promise<boolean> {
    const saved = await this.dataSource
      .getRepository(SourceItemEntity)
      .createQueryBuilder()
      .update(SourceItemEntity)
      .set({
        translationJson:
          translationJson as QueryDeepPartialEntity<SourceItemEntity>['translationJson'],
      })
      .where('id = :id AND raw_hash = :rawHash', { id, rawHash: claimed.rawHash })
      .andWhere('manual_translation_json IS NULL')
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.status')) = 'PROCESSING'")
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.claimId')) = :claimId", {
        claimId: claimed.audit.claimId,
      })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.attemptedAt')) = :attemptedAt", {
        attemptedAt: claimed.audit.attemptedAt,
      })
      .execute();
    return saved.affected === 1;
  }

  private async saveContentTranslation(
    id: string,
    claimed: Awaited<ReturnType<NewsTranslationService['claimContent']>> & {},
    translationJson: NonNullable<NewsArticleContentEntity['translationJson']>,
  ): Promise<boolean> {
    if (!claimed) return false;
    const saved = await this.dataSource
      .getRepository(NewsArticleContentEntity)
      .createQueryBuilder()
      .update(NewsArticleContentEntity)
      .set({ translationJson })
      .where('id = :id AND content_hash = :contentHash', { id, contentHash: claimed.contentHash })
      .andWhere('manual_translation_json IS NULL')
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.status')) = 'PROCESSING'")
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.claimId')) = :claimId", {
        claimId: claimed.audit.claimId,
      })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.attemptedAt')) = :attemptedAt", {
        attemptedAt: claimed.audit.attemptedAt,
      })
      .execute();
    return saved.affected === 1;
  }

  private async claimContent(id: string) {
    return this.dataSource.transaction(async (manager) => {
      const contents = manager.getRepository(NewsArticleContentEntity);
      const initial = await contents.findOne({ where: { id } });
      if (!initial) return null;
      // Discovery and admin edits take the same lock order: source, then content.
      const source = await manager.getRepository(SourceItemEntity).findOne({
        where: { id: initial.sourceItemId },
        lock: { mode: 'pessimistic_write' },
      });
      const content = await contents.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      const now = new Date();
      if (
        !content?.contentHash ||
        content.status !== 'AVAILABLE' ||
        content.language !== 'en' ||
        !content.blocksJson?.length ||
        source?.manualTranslationJson ||
        !contentTranslationIsDue(content, now)
      )
        return null;
      if (
        !source ||
        !TRANSLATABLE_SOURCES.includes(source.source) ||
        !contentPolicyAllowsTranslation(content, source)
      )
        return null;
      const news = await manager.getRepository(NewsItemEntity).findOne({
        where: { sourceItemId: source.id },
      });
      const previous =
        content.translationJson?.inputHash === content.contentHash ? content.translationJson : null;
      const attempts = Number.isSafeInteger(previous?.attempts)
        ? Math.min(Number(previous?.attempts) + 1, 1_000)
        : 1;
      const attemptedAt = now.toISOString();
      const audit: NonNullable<NewsArticleContentEntity['translationJson']> = {
        version: 1,
        claimId: randomUUID(),
        status: 'PROCESSING',
        inputHash: content.contentHash,
        provider: this.client.provider,
        model: this.client.model,
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        blocks: null,
        completedChunks: previous?.completedChunks ?? [],
        attemptedAt,
        translatedAt: null,
        attempts,
        nextAttemptAt: new Date(
          now.getTime() + this.config.newsTranslationTimeoutMs + 60_000,
        ).toISOString(),
      };
      await contents.update({ id, contentHash: content.contentHash }, { translationJson: audit });
      const tickers = (news?.tickersJson ?? [])
        .filter((value) => /^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(value))
        .slice(0, 20);
      return {
        blocks: content.blocksJson,
        tickers,
        contentHash: content.contentHash,
        attempts,
        audit,
      };
    });
  }

  private async claim(id: string) {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(SourceItemEntity);
      const source = await repository.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      const content = source
        ? await manager
            .getRepository(NewsArticleContentEntity)
            .findOne({ where: { sourceItemId: id }, lock: { mode: 'pessimistic_write' } })
        : null;
      const now = new Date();
      if (
        !source?.rawHash ||
        source.source === 'NAVER' ||
        !content ||
        content.manualTranslationJson ||
        !contentPolicyAllowsTranslation(content, source) ||
        !translationIsDue(source, now)
      )
        return null;
      const news = await manager
        .getRepository(NewsItemEntity)
        .findOne({ where: { sourceItemId: id } });
      if (!news) return null;
      const input = translationInput(source, news);
      const sourceTextHash = input ? newsTranslationInputHash(input) : null;
      const savedTranslation = source.translationJson;
      if (
        input &&
        savedTranslation?.version === 1 &&
        savedTranslation.status === 'COMPLETED' &&
        savedTranslation.sourceTextHash === sourceTextHash
      ) {
        await repository.update(
          { id, rawHash: source.rawHash },
          {
            translationJson: {
              ...savedTranslation,
              inputHash: source.rawHash,
            } as QueryDeepPartialEntity<SourceItemEntity>['translationJson'],
          },
        );
        return null;
      }
      const previous =
        source.translationJson?.inputHash === source.rawHash ? source.translationJson : null;
      const attempts = Number.isSafeInteger(previous?.attempts)
        ? Math.min(Number(previous?.attempts) + 1, 1000)
        : 1;
      const audit: Record<string, string | number | null> = {
        version: 1,
        claimId: randomUUID(),
        sourceTextHash,
        status: input ? 'PROCESSING' : 'SKIPPED',
        inputHash: source.rawHash,
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        provider: this.client.provider,
        model: this.client.model,
        title: null,
        description: null,
        translatedAt: null,
        attemptedAt: now.toISOString(),
        attempts,
        nextAttemptAt: input
          ? new Date(now.getTime() + this.config.newsTranslationTimeoutMs + 60_000).toISOString()
          : null,
        rightsMode: source.rightsMode,
        provenanceUrl: source.provenanceUrl ?? source.url,
        sourcePublishedAt: source.publishedAt?.toISOString() ?? null,
        sourceFirstObservedAt: source.firstObservedAt.toISOString(),
      };
      await repository.update(
        { id, rawHash: source.rawHash },
        {
          translationJson: audit as QueryDeepPartialEntity<SourceItemEntity>['translationJson'],
        },
      );
      return { input, audit, rawHash: source.rawHash, attempts };
    });
  }
}
