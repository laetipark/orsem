import { createHash } from 'node:crypto';
import { NewsSourceCompanyEntity } from '@orsem/database';
import type { EntityManager } from 'typeorm';
import { NEWS_MATCHER_VERSION } from './news-company-matching';

export async function replaceNewsCompanyRelevance(
  manager: EntityManager,
  sourceItemId: string,
  title: string,
  matches: readonly { companyId: string; matchMethod: string }[],
): Promise<void> {
  const repository = manager.getRepository(NewsSourceCompanyEntity);
  const inputHash = createHash('sha256').update(title.normalize('NFKC')).digest('hex');
  const unique = [...new Map(matches.map((match) => [match.companyId, match])).values()];
  // Call inside the source row's transaction/lock; stale title matches are removed atomically.
  const previous = await repository.find({ where: { sourceItemId } });
  const keep = new Set(unique.map((match) => match.companyId));
  for (const row of previous) if (!keep.has(row.companyId)) await repository.delete(row.id);
  for (const match of unique) {
    const existing = previous.find((row) => row.companyId === match.companyId);
    if (
      existing?.inputHash === inputHash &&
      existing.matcherVersion === NEWS_MATCHER_VERSION &&
      existing.matchMethod === match.matchMethod
    )
      continue;
    await repository.save(
      repository.create({
        ...existing,
        sourceItemId,
        ...match,
        inputHash,
        matcherVersion: NEWS_MATCHER_VERSION,
      }),
    );
  }
}

/** Shared collection coverage contains IDs only, never group names, owners or followers. */
export const APPROVED_GROUP_COMPANIES_SQL = `SELECT DISTINCT gi.company_id AS companyId
  FROM watchlist_group_items gi JOIN watchlist_groups g ON g.id=gi.group_id
  LEFT JOIN watchlist_rooms r ON r.id=g.room_id
  WHERE (g.room_id IS NULL OR r.id IS NOT NULL) AND (
    EXISTS (SELECT 1 FROM admins a WHERE COALESCE(r.owner_key,g.owner_key)=CONCAT('ADMIN:',a.id) AND a.is_active=1)
    OR EXISTS (SELECT 1 FROM members m WHERE COALESCE(r.owner_key,g.owner_key)=CONCAT('MEMBER:',m.id) AND m.role='VIEWER' AND m.status='APPROVED'))`;
