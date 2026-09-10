import { manualContentSchema, storedJson } from './manual-news-translation';
import {
  NewsContentState,
  RightsMode,
  newsArticleContentDetailSchema,
  newsContentBlockSchema,
  newsContentOriginalSchema,
  type NewsArticleContentDetail,
  type NewsContentBlock,
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
  manualTranslationJson?: unknown;
  manualRevisionVerified?: boolean;
}

export const storedTranslationMetadataSchema = z.object({
  version: z.literal(1),
  status: z.literal('COMPLETED'),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  provider: z.enum(['LOCAL', 'AZURE']),
  model: z.string().trim().min(1),
  sourceLanguage: z.string().trim().min(1),
  targetLanguage: z.literal('ko'),
  attemptedAt: z.string().datetime({ offset: true }),
  translatedAt: z.string().datetime({ offset: true }),
  attempts: z.number().int().positive(),
  nextAttemptAt: z.string().datetime({ offset: true }).nullable(),
});
const originalMetadataSchema = newsContentOriginalSchema.omit({ blocks: true });
const sourceIdSchema = newsArticleContentDetailSchema.shape.sourceItemId;
const contentStates = new Set<string>(Object.values(NewsContentState));

const contentRights = new Set<RightsMode>([
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
]);

function contentPolicyAllows(
  content: NewsContentRecord,
  requireAi = false,
  sourceRightsMode?: RightsMode,
): boolean {
  const value = storedJson(content.rightsPolicyJson);
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

/** Validate with the public block schema; retain sanitized copies only for article details. */
function readBlocks(value: unknown, materialize: boolean): NewsContentBlock[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2_000) return null;
  const blocks: NewsContentBlock[] = [];
  for (const block of value) {
    const parsed = newsContentBlockSchema.safeParse(block);
    if (!parsed.success) return null;
    if (materialize) blocks.push(parsed.data);
  }
  // The original array is used internally only for structure comparison, never returned publicly.
  return materialize ? blocks : (value as NewsContentBlock[]);
}

function readTranslation(
  content: NewsContentRecord,
  materialize: boolean,
  sourceRightsMode?: RightsMode,
): NewsContentTranslation | null {
  if (
    !content.contentHash ||
    !content.language ||
    !contentPolicyAllows(content, true, sourceRightsMode)
  )
    return null;
  const value = storedJson(content.translationJson);
  const parsed = storedTranslationMetadataSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.inputHash !== content.contentHash ||
    parsed.data.sourceLanguage !== content.language
  )
    return null;
  const blocks = readBlocks((value as Record<string, unknown>).blocks, materialize);
  if (!blocks) return null;
  return {
    language: parsed.data.targetLanguage,
    blocks,
    translatedAt: parsed.data.translatedAt,
    provider: parsed.data.provider,
    model: parsed.data.model,
  };
}

export function publicContentTranslation(
  content: NewsContentRecord,
  sourceRightsMode?: RightsMode,
): NewsContentTranslation | null {
  return readTranslation(content, true, sourceRightsMode);
}

function translationStructureMatchesOriginal(
  original: NewsContentBlock[],
  translated: NewsContentBlock[],
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

export function contentSummary(
  content?: NewsContentRecord | null,
  sourceRightsMode?: RightsMode,
  validatedContent?: NewsArticleContentDetail | null,
) {
  if (!content || !contentPolicyAllows(content, false, sourceRightsMode)) {
    return {
      contentState: NewsContentState.UNAVAILABLE,
      contentSourceId: null,
      contentLanguage: null,
      translated: false,
    } as const;
  }
  const state = contentStates.has(content.status)
    ? (content.status as NewsContentState)
    : NewsContentState.FAILED;
  return {
    contentState: state,
    contentSourceId: content.sourceItemId,
    contentLanguage: content.language,
    translated: Boolean(
      (validatedContent === undefined
        ? readNewsContent(content, false, sourceRightsMode)
        : validatedContent
      )?.translation,
    ),
  };
}

function readNewsContent(
  content: NewsContentRecord | null | undefined,
  materialize: boolean,
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
  const blocks = readBlocks(storedJson(content.blocksJson), materialize);
  if (!blocks) return null;
  if (content.manualTranslationJson != null) {
    const manual = manualContentSchema.safeParse(storedJson(content.manualTranslationJson));
    if (
      !content.manualRevisionVerified ||
      !manual.success ||
      manual.data.contentHash !== content.contentHash
    )
      return null;
    const originalTranslation = storedTranslationMetadataSchema.safeParse(
      storedJson(content.translationJson),
    );
    if (!originalTranslation.success) return null;
    return {
      sourceItemId: sourceIdSchema.parse(content.sourceItemId),
      original: {
        ...originalMetadataSchema.parse({
          language: content.language,
          fetchedAt: content.fetchedAt.toISOString(),
        }),
        blocks,
      },
      translation: {
        language: 'ko',
        blocks: manual.data.blocks,
        translatedAt: manual.data.editedAt,
        provider: originalTranslation.data.provider,
        model: originalTranslation.data.model,
        format: 'MARKDOWN',
        editedAt: manual.data.editedAt,
      },
    };
  }
  const translation = readTranslation(content, materialize, sourceRightsMode);
  if (
    content.language === 'en' &&
    (!translation || !translationStructureMatchesOriginal(blocks, translation.blocks))
  )
    return null;
  return {
    sourceItemId: sourceIdSchema.parse(content.sourceItemId),
    original: {
      ...originalMetadataSchema.parse({
        language: content.language,
        fetchedAt: content.fetchedAt.toISOString(),
      }),
      blocks,
    },
    translation,
  };
}

export function publicNewsContent(
  content?: NewsContentRecord | null,
  sourceRightsMode?: RightsMode,
): NewsArticleContentDetail | null {
  return readNewsContent(content, true, sourceRightsMode);
}
