import {
  manualMetadataSchema,
  manualNewsTranslationSql,
  storedJson,
} from '../resources/manual-news-translation';
import {
  RightsMode,
  isoInstantSchema,
  newsTranslationSchema,
  type NewsTranslation,
} from '@orsem/contracts';
import { z } from 'zod';

interface TranslationSource {
  source: string;
  rightsMode: RightsMode;
  rawHash?: string | null;
  translationJson?: unknown;
  sourcePolicyJson?: unknown;
  manualTranslationJson?: unknown;
  manualRevisionVerified?: boolean | number | string;
}

const translationSources = ['NEWS_RSS', 'IR'] as const;
const translationRights: readonly RightsMode[] = [
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
];
export const storedTranslationSchema = z.object({
  version: z.literal(1),
  status: z.literal('COMPLETED'),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceLanguage: z.literal('en'),
  targetLanguage: z.literal('ko'),
  provider: z.enum(['LOCAL', 'AZURE']),
  model: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().nullable(),
  translatedAt: isoInstantSchema,
  attemptedAt: isoInstantSchema,
  attempts: z.number().int().positive(),
  nextAttemptAt: isoInstantSchema.nullable(),
});

export function publicNewsTranslation(source: TranslationSource): NewsTranslation | null {
  let policy = source.sourcePolicyJson;
  if (typeof policy === 'string') {
    try {
      policy = JSON.parse(policy);
    } catch {
      return null;
    }
  }
  if (
    !translationSources.some((allowed) => allowed === source.source) ||
    !policy ||
    typeof policy !== 'object' ||
    !('aiAllowed' in policy) ||
    policy.aiAllowed !== true ||
    !('rightsMode' in policy) ||
    policy.rightsMode !== source.rightsMode ||
    !('metadataStorageAllowed' in policy) ||
    policy.metadataStorageAllowed !== true ||
    !('displayAllowed' in policy) ||
    policy.displayAllowed !== true ||
    !('fullTextStorageAllowed' in policy) ||
    policy.fullTextStorageAllowed !== true ||
    !translationRights.includes(source.rightsMode) ||
    !source.rawHash
  )
    return null;
  if (source.manualTranslationJson != null) {
    const manual = manualMetadataSchema.safeParse(storedJson(source.manualTranslationJson));
    if (
      !manual.success ||
      ![true, 1, '1'].includes(source.manualRevisionVerified ?? false) ||
      manual.data.sourceHash !== source.rawHash
    )
      return null;
    const original = storedTranslationSchema.safeParse(storedJson(source.translationJson));
    if (!original.success) return null;
    return {
      language: 'ko',
      title: manual.data.title,
      description: manual.data.description,
      translatedAt: manual.data.editedAt,
      provider: original.data.provider,
      model: original.data.model,
      editedAt: manual.data.editedAt,
    };
  }
  let stored = source.translationJson;
  if (typeof stored === 'string') {
    // MariaDB의 원시 조회는 JSON 컬럼을 문자열로 반환할 수 있습니다.
    try {
      stored = JSON.parse(stored);
    } catch {
      return null;
    }
  }
  const parsed = storedTranslationSchema.safeParse(stored);
  if (!parsed.success || parsed.data.inputHash !== source.rawHash) return null;
  const translation = parsed.data;
  // 원문 해시가 맞는 완료 결과에서 공개 필드만 골라 반환합니다. 내부 오류와 프롬프트는 제외합니다.
  return newsTranslationSchema.parse({
    language: translation.targetLanguage,
    title: translation.title,
    description:
      source.rightsMode === RightsMode.STORE_METADATA_ONLY ? null : translation.description,
    translatedAt: translation.translatedAt,
    provider: translation.provider,
    model: translation.model,
  });
}

export function literalSearchPattern(term: string): string {
  return `%${term.replace(/[!%_]/gu, (character) => `!${character}`)}%`;
}

export function publicNewsDescription(rightsMode: RightsMode, description: unknown): string | null {
  return (rightsMode === RightsMode.OFFICIAL_PUBLIC_DATA ||
    rightsMode === RightsMode.PRIVATE_DISPLAY_ONLY) &&
    typeof description === 'string'
    ? description
    : null;
}

export function completedAutomaticNewsTranslationCondition(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(alias))
    throw new Error('Invalid translation source identifier.');
  const json = `${alias}.translation_json`;
  const value = (field: string) => `JSON_UNQUOTE(JSON_EXTRACT(${json}, '$.${field}'))`;
  return `(${alias}.source IN ('NEWS_RSS', 'IR')
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(${alias}.source_policy_json, '$.rightsMode')) = BINARY ${alias}.rights_mode
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.fullTextStorageAllowed') = true
    AND JSON_TYPE(JSON_EXTRACT(${alias}.source_policy_json, '$.aiAllowed')) = 'BOOLEAN'
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.aiAllowed') = true
    AND ${alias}.rights_mode IN ('OFFICIAL_PUBLIC_DATA', 'PRIVATE_DISPLAY_ONLY')
    AND ${alias}.raw_hash IS NOT NULL
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.version')) = 'INTEGER'
    AND JSON_EXTRACT(${json}, '$.version') = 1
    AND BINARY ${value('status')} = BINARY 'COMPLETED'
    AND BINARY ${value('inputHash')} = BINARY ${alias}.raw_hash
    AND BINARY ${value('sourceLanguage')} = BINARY 'en'
    AND BINARY ${value('targetLanguage')} = BINARY 'ko'
    AND BINARY ${value('provider')} IN (BINARY 'LOCAL', BINARY 'AZURE')
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.title')) = 'STRING'
    AND CHAR_LENGTH(TRIM(${value('title')})) > 0
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.model')) = 'STRING'
    AND CHAR_LENGTH(TRIM(${value('model')})) > 0
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.translatedAt')) = 'STRING'
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.description')) IN ('STRING', 'NULL')
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.attemptedAt')) = 'STRING'
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.attempts')) = 'INTEGER'
    AND JSON_EXTRACT(${json}, '$.attempts') > 0
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.nextAttemptAt')) IN ('STRING', 'NULL'))`;
}

export function completedNewsTranslationCondition(alias: string): string {
  return `((${alias}.manual_translation_json IS NULL AND ${completedAutomaticNewsTranslationCondition(alias)}) OR ${manualNewsTranslationSql(alias)})`;
}

export function newsTranslationSearchCondition(alias: string, parameter: string): string {
  // 별칭과 파라미터 이름은 코드에서 정한 식별자만 받으며 검색어는 항상 바인딩합니다.
  if (!/^[a-z_][a-z0-9_]*$/iu.test(parameter))
    throw new Error('Invalid translation search identifier.');
  const json = `${alias}.translation_json`;
  const title = `CASE WHEN ${alias}.manual_translation_json IS NOT NULL THEN JSON_UNQUOTE(JSON_EXTRACT(${alias}.manual_translation_json, '$.title')) ELSE JSON_UNQUOTE(JSON_EXTRACT(${json}, '$.title')) END`;
  return `(${completedNewsTranslationCondition(alias)} AND ${title} LIKE :${parameter} ESCAPE '!')`;
}
