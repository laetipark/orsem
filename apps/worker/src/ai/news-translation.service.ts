import { Inject, Injectable } from '@nestjs/common';
import { RightsMode } from '@orsem/contracts';
import { NewsItemEntity, SourceItemEntity } from '@orsem/database';
import { Brackets, DataSource } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import {
  LocalNewsTranslationClient,
  type NewsTranslationInput,
} from './local-news-translation.client';

const TRANSLATABLE_SOURCES = ['GDELT', 'IR', 'NEWS_RSS'];
const DESCRIPTION_RIGHTS = new Set<RightsMode>([
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
]);

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
  source: Pick<SourceItemEntity, 'translationJson' | 'rawHash'>,
  now: Date,
): boolean {
  const saved = source.translationJson;
  if (!saved || saved.inputHash !== source.rawHash || saved.version !== 1) return true;
  if (saved.status === 'COMPLETED' || saved.status === 'SKIPPED') return false;
  const retryAt = typeof saved.nextAttemptAt === 'string' ? Date.parse(saved.nextAttemptAt) : NaN;
  return !Number.isFinite(retryAt) || retryAt <= now.getTime();
}

export function translationInput(
  source: SourceItemEntity,
  news: NewsItemEntity,
): NewsTranslationInput | null {
  if (
    source.source === 'NAVER' ||
    source.sourcePolicyJson?.aiAllowed !== true ||
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
  }> {
    const result = { completed: 0, failed: 0, skipped: 0, stale: 0 };
    if (!this.config.newsTranslationEnabled) return { disabled: true, ...result };
    const now = new Date();
    const ids = await this.dataSource
      .getRepository(SourceItemEntity)
      .createQueryBuilder('source')
      .select('source.id', 'id')
      .innerJoin(NewsItemEntity, 'news', 'news.sourceItemId = source.id')
      .where('source.source IN (:...sources)', { sources: TRANSLATABLE_SOURCES })
      .andWhere('source.rawHash IS NOT NULL')
      .andWhere("JSON_EXTRACT(source.sourcePolicyJson, '$.aiAllowed') = CAST('true' AS JSON)")
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
        const translated = await this.client.translate(claimed.input);
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
      const saved = await this.dataSource
        .getRepository(SourceItemEntity)
        .createQueryBuilder()
        .update(SourceItemEntity)
        .set({
          translationJson: final as QueryDeepPartialEntity<SourceItemEntity>['translationJson'],
        })
        .where('id = :id AND raw_hash = :rawHash', { id, rawHash: claimed.rawHash })
        .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.attemptedAt')) = :attemptedAt", {
          attemptedAt: claimed.audit.attemptedAt,
        })
        .execute();
      if (saved.affected === 1) result[outcome]++;
      else result.stale++;
    }
    return result;
  }

  private async claim(id: string) {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(SourceItemEntity);
      const source = await repository.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      const now = new Date();
      if (
        !source?.rawHash ||
        source.source === 'NAVER' ||
        source.sourcePolicyJson?.aiAllowed !== true ||
        !translationIsDue(source, now)
      )
        return null;
      const news = await manager
        .getRepository(NewsItemEntity)
        .findOne({ where: { sourceItemId: id } });
      if (!news) return null;
      const input = translationInput(source, news);
      const previous =
        source.translationJson?.inputHash === source.rawHash ? source.translationJson : null;
      const attempts = Number.isSafeInteger(previous?.attempts)
        ? Math.min(Number(previous?.attempts) + 1, 1000)
        : 1;
      const audit: Record<string, string | number | null> = {
        version: 1,
        status: input ? 'PROCESSING' : 'SKIPPED',
        inputHash: source.rawHash,
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        provider: 'LOCAL',
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
