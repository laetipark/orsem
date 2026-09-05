import {
  NewsContentState,
  RightsMode,
  newsArticleContentDetailSchema,
  newsContentBlockSchema,
  newsContentTranslationSchema,
  type NewsArticleContentDetail,
  type NewsContentTranslation,
} from '@orsem/contracts';
import { z } from 'zod';

export interface NewsContentRecord {
  sourceItemId: string;
  status: string;
  language: string | null;
  blocksJson: unknown;
  contentHash: string | null;
  fetchedAt: Date | null;
  rightsPolicyJson: unknown;
  translationJson: unknown;
}

const storedContentTranslationSchema = z.object({
  version: z.literal(1),
  status: z.literal('COMPLETED'),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  provider: z.literal('LOCAL'),
  model: z.string().trim().min(1),
  sourceLanguage: z.string().trim().min(1),
  targetLanguage: z.literal('ko'),
  blocks: z.array(newsContentBlockSchema).min(1).max(2_000),
  attemptedAt: z.string().datetime({ offset: true }),
  translatedAt: z.string().datetime({ offset: true }),
  attempts: z.number().int().positive(),
  nextAttemptAt: z.string().datetime({ offset: true }).nullable(),
});

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const contentRights = new Set<RightsMode>([
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
]);

function contentPolicyAllows(
  content: NewsContentRecord,
  requireAi = false,
  sourceRightsMode?: RightsMode,
): boolean {
  const value = jsonValue(content.rightsPolicyJson);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return (
    typeof policy.rightsMode === 'string' &&
    contentRights.has(policy.rightsMode as RightsMode) &&
    (!sourceRightsMode || policy.rightsMode === sourceRightsMode) &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.fullTextStorageAllowed === true &&
    (!requireAi || policy.aiAllowed === true)
  );
}

export function publicContentTranslation(
  content: NewsContentRecord,
  sourceRightsMode?: RightsMode,
): NewsContentTranslation | null {
  if (
    !content.contentHash ||
    !content.language ||
    !contentPolicyAllows(content, true, sourceRightsMode)
  )
    return null;
  const parsed = storedContentTranslationSchema.safeParse(jsonValue(content.translationJson));
  if (
    !parsed.success ||
    parsed.data.inputHash !== content.contentHash ||
    parsed.data.sourceLanguage !== content.language
  )
    return null;
  return newsContentTranslationSchema.parse({
    language: parsed.data.targetLanguage,
    blocks: parsed.data.blocks,
    translatedAt: parsed.data.translatedAt,
    provider: parsed.data.provider,
    model: parsed.data.model,
  });
}

function translationStructureMatchesOriginal(
  original: NewsArticleContentDetail['original']['blocks'],
  translated: NewsContentTranslation['blocks'],
): boolean {
  if (original.length !== translated.length) return false;
  return original.every((block, index) => {
    const translatedBlock = translated[index];
    if (!translatedBlock || block.type !== translatedBlock.type) return false;
    if (block.type === 'HEADING' && translatedBlock.type === 'HEADING')
      return block.level === translatedBlock.level;
    if (block.type === 'LIST' && translatedBlock.type === 'LIST')
      return (
        block.ordered === translatedBlock.ordered &&
        block.items.length === translatedBlock.items.length
      );
    return true;
  });
}

export function contentSummary(content?: NewsContentRecord | null, sourceRightsMode?: RightsMode) {
  if (!content || !contentPolicyAllows(content, false, sourceRightsMode)) {
    return {
      contentState: NewsContentState.UNAVAILABLE,
      contentSourceId: null,
      contentLanguage: null,
      translated: false,
    } as const;
  }
  const state = Object.values(NewsContentState).includes(content.status as NewsContentState)
    ? (content.status as NewsContentState)
    : NewsContentState.FAILED;
  return {
    contentState: state,
    contentSourceId: content.sourceItemId,
    contentLanguage: content.language,
    translated: Boolean(publicNewsContent(content, sourceRightsMode)?.translation),
  };
}

export function publicNewsContent(
  content?: NewsContentRecord | null,
  sourceRightsMode?: RightsMode,
): NewsArticleContentDetail | null {
  if (
    !content ||
    !contentPolicyAllows(content, false, sourceRightsMode) ||
    content.status !== NewsContentState.AVAILABLE ||
    !content.language ||
    !content.fetchedAt
  )
    return null;
  const blocks = z
    .array(newsContentBlockSchema)
    .min(1)
    .max(2_000)
    .safeParse(jsonValue(content.blocksJson));
  if (!blocks.success) return null;
  const translation = publicContentTranslation(content, sourceRightsMode);
  if (
    content.language === 'en' &&
    (!translation || !translationStructureMatchesOriginal(blocks.data, translation.blocks))
  )
    return null;
  return newsArticleContentDetailSchema.parse({
    sourceItemId: content.sourceItemId,
    original: {
      language: content.language,
      blocks: blocks.data,
      fetchedAt: content.fetchedAt.toISOString(),
    },
    translation,
  });
}
