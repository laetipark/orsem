import { newsContentBlockSchema, parseNewsMarkdown, RightsMode } from '@orsem/contracts';
import {
  NewsArticleContentEntity,
  NewsTranslationRevisionEntity,
  type SourceItemEntity,
} from '@orsem/database';
import { In, type DataSource } from 'typeorm';
import { z } from 'zod';

export const manualIdentitySchema = z.object({
  version: z.literal(1),
  revisionId: z.string().uuid(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  editedAt: z.string().datetime({ offset: true }),
  editedByAdminId: z.string().min(1).max(64),
});
export const manualMetadataSchema = manualIdentitySchema.extend({
  title: z.string().trim().min(1).max(2_000),
  description: z.string().max(20_000).nullable(),
});
export const manualContentSchema = manualIdentitySchema.extend({
  markdown: z.string().min(1).max(100_000),
  blocks: z.array(newsContentBlockSchema).min(1).max(2_000),
});
export function storedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
const editableRights = new Set<RightsMode>([
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
]);

export function allowsNewsEditingPolicy(value: unknown, rightsMode: RightsMode): boolean {
  const policy = storedJson(value) as Record<string, unknown> | null;
  return Boolean(
    policy &&
    editableRights.has(rightsMode) &&
    policy.rightsMode === rightsMode &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.fullTextStorageAllowed === true &&
    policy.aiAllowed === true,
  );
}

/** Match the immutable edit snapshot as well as its revision identifier. */
export function manualRevisionMatches(
  metadata: z.infer<typeof manualMetadataSchema>,
  body: z.infer<typeof manualContentSchema>,
  revision:
    | Pick<
        NewsTranslationRevisionEntity,
        'id' | 'sourceItemId' | 'sourceHash' | 'contentHash' | 'manualJson'
      >
    | null
    | undefined,
): boolean {
  if (!revision) return false;
  const saved = storedJson(revision.manualJson) as Record<string, unknown> | null;
  const savedMetadata = manualMetadataSchema.safeParse(saved?.metadata);
  const savedBody = manualContentSchema.safeParse(saved?.content);
  return Boolean(
    savedMetadata.success &&
    savedBody.success &&
    revision.id === metadata.revisionId &&
    revision.sourceHash === metadata.sourceHash &&
    revision.contentHash === metadata.contentHash &&
    metadata.revisionId === body.revisionId &&
    metadata.sourceHash === body.sourceHash &&
    metadata.contentHash === body.contentHash &&
    metadata.editedAt === body.editedAt &&
    metadata.editedByAdminId === body.editedByAdminId &&
    JSON.stringify(savedMetadata.data) === JSON.stringify(metadata) &&
    JSON.stringify(savedBody.data) === JSON.stringify(body),
  );
}

export type VerifiedManualSource = SourceItemEntity & { manualRevisionVerified?: boolean };
export type VerifiedManualContent = NewsArticleContentEntity & { manualRevisionVerified?: boolean };

/** Verify audit identity and both current hashes once per page, never one lookup per article. */
export async function verifyManualNewsSources(
  source: DataSource,
  rows: VerifiedManualSource[],
  contents: VerifiedManualContent[] = [],
): Promise<void> {
  const manualRows = rows.filter((row) => row.manualTranslationJson != null);
  if (!manualRows.length) return;
  const bySource = new Map(contents.map((content) => [content.sourceItemId, content]));
  const missing = manualRows.filter((row) => !bySource.has(row.id)).map((row) => row.id);
  if (missing.length) {
    for (const content of await source
      .getRepository(NewsArticleContentEntity)
      .findBy({ sourceItemId: In(missing) }))
      bySource.set(content.sourceItemId, content);
  }
  const revisionIds = [
    ...new Set(
      manualRows.flatMap((row) => {
        const parsed = manualMetadataSchema.safeParse(storedJson(row.manualTranslationJson));
        return parsed.success ? [parsed.data.revisionId] : [];
      }),
    ),
  ];
  const revisions = revisionIds.length
    ? await source.getRepository(NewsTranslationRevisionEntity).find({
        select: {
          id: true,
          sourceItemId: true,
          sourceHash: true,
          contentHash: true,
          manualJson: true,
        },
        where: { id: In(revisionIds) },
      })
    : [];
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  for (const row of manualRows) {
    row.manualRevisionVerified = false;
    const content = bySource.get(row.id);
    if (!content) continue;
    content.manualRevisionVerified = false;
    const metadata = manualMetadataSchema.safeParse(storedJson(row.manualTranslationJson));
    const body = manualContentSchema.safeParse(storedJson(content.manualTranslationJson));
    if (!metadata.success || !body.success) continue;
    const revision = byId.get(metadata.data.revisionId);
    if (
      !revision ||
      !manualRevisionMatches(metadata.data, body.data, revision) ||
      revision.sourceItemId !== row.id ||
      revision.sourceHash !== row.rawHash ||
      revision.contentHash !== content.contentHash ||
      metadata.data.sourceHash !== row.rawHash ||
      metadata.data.contentHash !== content.contentHash ||
      body.data.sourceHash !== row.rawHash ||
      body.data.contentHash !== content.contentHash ||
      metadata.data.revisionId !== body.data.revisionId ||
      metadata.data.editedAt !== body.data.editedAt ||
      metadata.data.editedByAdminId !== body.data.editedByAdminId ||
      !allowsNewsEditingPolicy(row.sourcePolicyJson, row.rightsMode) ||
      !allowsNewsEditingPolicy(content.rightsPolicyJson, row.rightsMode) ||
      content.language !== 'en' ||
      content.status !== 'AVAILABLE'
    )
      continue;
    try {
      if (
        JSON.stringify(parseNewsMarkdown(body.data.markdown)) !== JSON.stringify(body.data.blocks)
      )
        continue;
    } catch {
      continue;
    }
    row.manualRevisionVerified = true;
    content.manualRevisionVerified = true;
  }
}

export function manualNewsTranslationSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(alias)) throw new Error('Invalid manual source identifier.');
  const json = `${alias}.manual_translation_json`;
  const value = (field: string) => `JSON_UNQUOTE(JSON_EXTRACT(${json}, '$.${field}'))`;
  return `(${alias}.source IN ('NEWS_RSS','IR')
    AND ${alias}.rights_mode IN ('OFFICIAL_PUBLIC_DATA','PRIVATE_DISPLAY_ONLY')
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(${alias}.source_policy_json, '$.rightsMode')) = BINARY ${alias}.rights_mode
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.fullTextStorageAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.aiAllowed') = true
    AND JSON_EXTRACT(${json}, '$.version') = 1
    AND BINARY ${value('sourceHash')} = BINARY ${alias}.raw_hash
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.title')) = 'STRING'
    AND CHAR_LENGTH(TRIM(${value('title')})) BETWEEN 1 AND 2000
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.description')) IN ('STRING','NULL')
    AND EXISTS (SELECT 1 FROM news_article_contents manual_body
      JOIN news_translation_revisions manual_revision ON manual_revision.id = ${value('revisionId')}
      WHERE manual_body.source_item_id = ${alias}.id
      AND manual_revision.source_item_id = ${alias}.id
      AND BINARY JSON_EXTRACT(manual_revision.manual_json, '$.metadata') = BINARY JSON_EXTRACT(${json}, '$')
      AND BINARY JSON_EXTRACT(manual_revision.manual_json, '$.content') = BINARY JSON_EXTRACT(manual_body.manual_translation_json, '$')
      AND BINARY manual_revision.source_hash = BINARY ${alias}.raw_hash
      AND BINARY manual_revision.content_hash = BINARY manual_body.content_hash
      AND BINARY ${value('contentHash')} = BINARY manual_body.content_hash
      AND manual_body.status = 'AVAILABLE' AND manual_body.language = 'en'
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(manual_body.rights_policy_json, '$.rightsMode')) = BINARY ${alias}.rights_mode
      AND JSON_EXTRACT(manual_body.rights_policy_json, '$.metadataStorageAllowed') = true
      AND JSON_EXTRACT(manual_body.rights_policy_json, '$.displayAllowed') = true
      AND JSON_EXTRACT(manual_body.rights_policy_json, '$.fullTextStorageAllowed') = true
      AND JSON_EXTRACT(manual_body.rights_policy_json, '$.aiAllowed') = true
      AND JSON_EXTRACT(manual_body.manual_translation_json, '$.version') = 1
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(manual_body.manual_translation_json, '$.revisionId')) = BINARY ${value('revisionId')}
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(manual_body.manual_translation_json, '$.editedAt')) = BINARY ${value('editedAt')}
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(manual_body.manual_translation_json, '$.editedByAdminId')) = BINARY ${value('editedByAdminId')}
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(manual_body.manual_translation_json, '$.sourceHash')) = BINARY ${alias}.raw_hash
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(manual_body.manual_translation_json, '$.contentHash')) = BINARY manual_body.content_hash
      AND JSON_TYPE(JSON_EXTRACT(manual_body.manual_translation_json, '$.blocks')) = 'ARRAY'
      AND JSON_LENGTH(JSON_EXTRACT(manual_body.manual_translation_json, '$.blocks')) BETWEEN 1 AND 2000))`;
}
