import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  RightsMode,
  currentNewsSourcePolicy,
  isNewsTranslationAllowed,
  newsPolicyAllowsAudience,
  registeredNewsSourcePolicies,
  type NewsSourcePolicy,
} from '@orsem/contracts';
import { NewsItemEntity, SourceItemEntity } from '@orsem/database';
import { Brackets, DataSource } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import type { NewsTranslationInput } from './news-translation-validation';
import { LocalNewsTranslationClient } from './local-news-translation.client';

const TRANSLATABLE_SOURCES = ['IR', 'NEWS_RSS'];
const DESCRIPTION_RIGHTS = new Set<RightsMode>([
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
]);

export function sourcePolicyAllowsTranslation(
  source: Pick<SourceItemEntity, 'rightsMode' | 'sourcePolicyJson'>,
  currentPolicy: NewsSourcePolicy | null = currentNewsSourcePolicy(source.sourcePolicyJson),
): boolean {
  const policy = source.sourcePolicyJson;
  if (policy?.policyVersion === 2) {
    return Boolean(
      policy.rightsMode === source.rightsMode &&
      currentPolicy?.rightsMode === source.rightsMode &&
      currentPolicy.policyId === policy.policyId &&
      newsPolicyAllowsAudience(policy, 'ADMIN_UI', currentPolicy) &&
      isNewsTranslationAllowed(policy) &&
      isNewsTranslationAllowed(currentPolicy),
    );
  }
  return Boolean(
    policy &&
    DESCRIPTION_RIGHTS.has(source.rightsMode) &&
    policy.rightsMode === source.rightsMode &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.aiAllowed === true,
  );
}

function currentTranslationPolicyIds(): string[] {
  return registeredNewsSourcePolicies()
    .filter(
      (policy) =>
        policy.policyVersion === 2 &&
        sourcePolicyAllowsTranslation(
          { rightsMode: policy.rightsMode, sourcePolicyJson: policy },
          policy,
        ),
    )
    .map((policy) => policy.policyId!);
}

function sourcePolicyAllowsDescription(
  policy: NewsSourcePolicy | null,
  currentPolicy: NewsSourcePolicy | null,
): boolean {
  return policy?.policyVersion === 2
    ? policy.summaryStorageAllowed === true && currentPolicy?.summaryStorageAllowed === true
    : Boolean(policy && DESCRIPTION_RIGHTS.has(policy.rightsMode));
}

/** SQL prefilter plus claim-time registry checks keep unknown/revoked policies off the AI client. */
function translationPolicyPredicate(column: string, approvedIds: readonly string[]): Brackets {
  return new Brackets((query) => {
    query.where(`JSON_EXTRACT(${column}, '$.policyVersion') IS NULL`);
    if (approvedIds.length)
      query.orWhere(
        `(JSON_EXTRACT(${column}, '$.policyVersion') = 2
        AND JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.policyId')) IN (:...translationPolicyIds)
        AND JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.rightsStatus')) IN ('APPROVED', 'METADATA_ONLY')
        AND JSON_EXTRACT(${column}, '$.translationAllowed') = CAST('true' AS JSON)
        AND JSON_EXTRACT(${column}, '$.fullTextStorageAllowed') = CAST('false' AS JSON))`,
        { translationPolicyIds: [...approvedIds] },
      );
  });
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

export function translationInput(
  source: SourceItemEntity,
  news: NewsItemEntity,
  currentPolicy: NewsSourcePolicy | null = currentNewsSourcePolicy(source.sourcePolicyJson),
): NewsTranslationInput | null {
  if (
    source.source === 'NAVER' ||
    !sourcePolicyAllowsTranslation(source, currentPolicy) ||
    !TRANSLATABLE_SOURCES.includes(source.source) ||
    source.rightsMode === RightsMode.LINK_ONLY ||
    source.rightsMode === RightsMode.NO_REDISTRIBUTION ||
    !looksLikeEnglishNews(source.title) ||
    source.title.length > 1000
  )
    return null;
  return {
    title: source.title,
    description: sourcePolicyAllowsDescription(source.sourcePolicyJson, currentPolicy)
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
    const result = {
      completed: 0,
      failed: 0,
      skipped: 0,
      stale: 0,
    };
    if (!this.config.newsTranslationEnabled) return { disabled: true, ...result };
    const now = new Date();
    const ids = await this.dataSource
      .getRepository(SourceItemEntity)
      .createQueryBuilder('source')
      .select('source.id', 'id')
      .innerJoin(NewsItemEntity, 'news', 'news.sourceItemId = source.id')
      .where('source.source IN (:...sources)', { sources: TRANSLATABLE_SOURCES })
      .andWhere('source.manualTranslationJson IS NULL')
      .andWhere('source.rawHash IS NOT NULL')
      .andWhere(
        `(source.rightsMode IN ('OFFICIAL_PUBLIC_DATA', 'PRIVATE_DISPLAY_ONLY') OR
        (source.rightsMode = 'STORE_METADATA_ONLY' AND JSON_EXTRACT(source.sourcePolicyJson, '$.policyVersion') = 2))`,
      )
      .andWhere(
        translationPolicyPredicate('source.sourcePolicyJson', currentTranslationPolicyIds()),
      )
      .andWhere("JSON_EXTRACT(source.sourcePolicyJson, '$.aiAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(source.sourcePolicyJson, '$.metadataStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere("JSON_EXTRACT(source.sourcePolicyJson, '$.displayAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_UNQUOTE(JSON_EXTRACT(source.sourcePolicyJson, '$.rightsMode')) = source.rightsMode",
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
    return result;
  }

  private claimExpiresAt(): string {
    return new Date(Date.now() + this.config.newsTranslationTimeoutMs + 60_000).toISOString();
  }

  private async saveSourceTranslation(
    id: string,
    claimed: NonNullable<Awaited<ReturnType<NewsTranslationService['claim']>>>,
    translationJson: Record<string, string | number | null>,
  ): Promise<boolean> {
    const currentPolicy = currentNewsSourcePolicy(claimed.policy);
    if (
      !sourcePolicyAllowsTranslation(
        { rightsMode: claimed.rightsMode, sourcePolicyJson: claimed.policy },
        currentPolicy,
      ) ||
      (claimed.input?.description !== null &&
        claimed.input?.description !== undefined &&
        !sourcePolicyAllowsDescription(claimed.policy, currentPolicy))
    )
      return false;
    const query = this.dataSource
      .getRepository(SourceItemEntity)
      .createQueryBuilder()
      .update(SourceItemEntity)
      .set({
        translationJson:
          translationJson as QueryDeepPartialEntity<SourceItemEntity>['translationJson'],
      })
      .where('id = :id AND raw_hash = :rawHash', { id, rawHash: claimed.rawHash })
      .andWhere('manual_translation_json IS NULL')
      .andWhere("JSON_EXTRACT(source_policy_json, '$.aiAllowed') = CAST('true' AS JSON)")
      .andWhere(
        "JSON_EXTRACT(source_policy_json, '$.metadataStorageAllowed') = CAST('true' AS JSON)",
      )
      .andWhere("JSON_EXTRACT(source_policy_json, '$.displayAllowed') = CAST('true' AS JSON)")
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(source_policy_json, '$.rightsMode')) = rights_mode")
      .andWhere(translationPolicyPredicate('source_policy_json', currentTranslationPolicyIds()))
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.status')) = 'PROCESSING'")
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.claimId')) = :claimId", {
        claimId: claimed.audit.claimId,
      })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(translation_json, '$.attemptedAt')) = :attemptedAt", {
        attemptedAt: claimed.audit.attemptedAt,
      });
    if (claimed.input?.description !== null && claimed.input?.description !== undefined)
      query.andWhere(`(JSON_EXTRACT(source_policy_json, '$.policyVersion') IS NULL OR
        JSON_EXTRACT(source_policy_json, '$.summaryStorageAllowed') = CAST('true' AS JSON))`);
    if (claimed.policy?.policyVersion === 2)
      query.andWhere(
        "JSON_UNQUOTE(JSON_EXTRACT(source_policy_json, '$.policyId')) = :claimedPolicyId",
        {
          claimedPolicyId: claimed.policy.policyId,
        },
      );
    const saved = await query.execute();
    return saved.affected === 1;
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
        !sourcePolicyAllowsTranslation(source) ||
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
      return {
        input,
        audit,
        rawHash: source.rawHash,
        attempts,
        policy: source.sourcePolicyJson,
        rightsMode: source.rightsMode,
      };
    });
  }
}
