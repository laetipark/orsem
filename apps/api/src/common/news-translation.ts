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
}

const translationSources = ['NAVER', 'GDELT', 'IR'] as const;
const translationRights: readonly RightsMode[] = [
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
  RightsMode.STORE_METADATA_ONLY,
];
const storedTranslationSchema = z.object({
  version: z.literal(1),
  status: z.literal('COMPLETED'),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceLanguage: z.literal('en'),
  targetLanguage: z.literal('ko'),
  provider: z.literal('LOCAL'),
  model: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().nullable(),
  translatedAt: isoInstantSchema,
  attemptedAt: isoInstantSchema,
  attempts: z.number().int().positive(),
  nextAttemptAt: isoInstantSchema.nullable(),
});

export function publicNewsTranslation(source: TranslationSource): NewsTranslation | null {
  if (
    !translationSources.some((allowed) => allowed === source.source) ||
    !translationRights.includes(source.rightsMode) ||
    !source.rawHash
  )
    return null;
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

export function newsTranslationSearchCondition(alias: string, parameter: string): string {
  // 별칭과 파라미터 이름은 코드에서 정한 식별자만 받으며 검색어는 항상 바인딩합니다.
  if (!/^[a-z_][a-z0-9_]*$/iu.test(alias) || !/^[a-z_][a-z0-9_]*$/iu.test(parameter))
    throw new Error('Invalid translation search identifier.');
  const json = `${alias}.translation_json`;
  const value = (field: string) => `JSON_UNQUOTE(JSON_EXTRACT(${json}, '$.${field}'))`;
  return `(${alias}.source IN ('NAVER', 'GDELT', 'IR')
    AND ${alias}.rights_mode IN ('OFFICIAL_PUBLIC_DATA', 'PRIVATE_DISPLAY_ONLY', 'STORE_METADATA_ONLY')
    AND ${alias}.raw_hash IS NOT NULL
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.version')) = 'INTEGER'
    AND JSON_EXTRACT(${json}, '$.version') = 1
    AND BINARY ${value('status')} = BINARY 'COMPLETED'
    AND BINARY ${value('inputHash')} = BINARY ${alias}.raw_hash
    AND BINARY ${value('sourceLanguage')} = BINARY 'en'
    AND BINARY ${value('targetLanguage')} = BINARY 'ko'
    AND BINARY ${value('provider')} = BINARY 'LOCAL'
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.title')) = 'STRING'
    AND CHAR_LENGTH(TRIM(${value('title')})) > 0
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.model')) = 'STRING'
    AND CHAR_LENGTH(TRIM(${value('model')})) > 0
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.translatedAt')) = 'STRING'
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.description')) IN ('STRING', 'NULL')
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.attemptedAt')) = 'STRING'
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.attempts')) = 'INTEGER'
    AND JSON_EXTRACT(${json}, '$.attempts') > 0
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.nextAttemptAt')) IN ('STRING', 'NULL')
    AND ${value('title')} LIKE :${parameter} ESCAPE '!')`;
}
