import { newsContentBlockSchema, RightsMode } from '@orsem/contracts';
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
export const manualMetadataV2Schema = manualMetadataSchema
  .omit({ contentHash: true, version: true })
  .extend({ version: z.literal(2) });
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
  _contents: VerifiedManualContent[] = [],
): Promise<void> {
  void _contents;
  const manualRows = rows.filter((row) => row.manualTranslationJson != null);
  if (!manualRows.length) return;
  const parsedRows = manualRows.map((row) => ({
    row,
    parsed: manualMetadataV2Schema.safeParse(storedJson(row.manualTranslationJson)),
  }));
  const ids = parsedRows.flatMap(({ parsed }) => (parsed.success ? [parsed.data.revisionId] : []));
  const revisions = ids.length
    ? await source.getRepository(NewsTranslationRevisionEntity).find({
        select: { id: true, sourceItemId: true, sourceHash: true, manualJson: true },
        where: { id: In(ids) },
      })
    : [];
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  for (const { row, parsed } of parsedRows) {
    row.manualRevisionVerified = false;
    if (!parsed.success) continue;
    const revision = byId.get(parsed.data.revisionId);
    const saved = storedJson(revision?.manualJson) as Record<string, unknown> | null;
    const snapshot = manualMetadataV2Schema.safeParse(saved?.metadata);
    const policy = storedJson(row.sourcePolicyJson) as Record<string, unknown> | null;
    row.manualRevisionVerified = Boolean(
      revision &&
      snapshot.success &&
      revision.sourceItemId === row.id &&
      revision.sourceHash === row.rawHash &&
      parsed.data.sourceHash === row.rawHash &&
      JSON.stringify(snapshot.data) === JSON.stringify(parsed.data) &&
      editableRights.has(row.rightsMode) &&
      policy?.rightsMode === row.rightsMode &&
      policy.metadataStorageAllowed === true &&
      policy.displayAllowed === true &&
      policy.aiAllowed === true,
    );
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
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.aiAllowed') = true
    AND JSON_EXTRACT(${json}, '$.version') = 2
    AND BINARY ${value('sourceHash')} = BINARY ${alias}.raw_hash
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.title')) = 'STRING'
    AND CHAR_LENGTH(TRIM(${value('title')})) BETWEEN 1 AND 2000
    AND JSON_TYPE(JSON_EXTRACT(${json}, '$.description')) IN ('STRING','NULL')
    AND EXISTS (SELECT 1 FROM news_translation_revisions manual_revision
      WHERE manual_revision.id = ${value('revisionId')} AND manual_revision.source_item_id = ${alias}.id
      AND BINARY manual_revision.source_hash = BINARY ${alias}.raw_hash
      AND BINARY JSON_EXTRACT(manual_revision.manual_json, '$.metadata') = BINARY JSON_EXTRACT(${json}, '$')))`;
}
