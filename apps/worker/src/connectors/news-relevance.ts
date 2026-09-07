import { createHash } from 'node:crypto';
import { MARKET_LEADER_COMPANIES_SQL, NewsSourceCompanyEntity } from '@orsem/database';
import type { EntityManager } from 'typeorm';
import { NEWS_MATCHER_VERSION } from './news-company-matching';

export async function replaceNewsCompanyRelevance(
  manager: EntityManager,
  sourceItemId: string,
  evidence: string,
  matches: readonly { companyId: string; matchMethod: string }[],
): Promise<void> {
  const repository = manager.getRepository(NewsSourceCompanyEntity);
  const inputHash = createHash('sha256').update(evidence.normalize('NFKC')).digest('hex');
  const unique = [...new Map(matches.map((match) => [match.companyId, match])).values()];
  // Call inside the source row's transaction/lock; stale metadata matches are removed atomically.
  const previous = await repository.find({ where: { sourceItemId } });
  const keep = new Set(unique.map((match) => match.companyId));
  for (const row of previous)
    if (!keep.has(row.companyId) && row.matchMethod !== 'MANUAL_REVIEW')
      await repository.delete(row.id);
  for (const match of unique) {
    const existing = previous.find((row) => row.companyId === match.companyId);
    if (existing?.matchMethod === 'MANUAL_REVIEW') continue;
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

/** Quote subscriptions retain the 40 representative symbols; news uses every verified class. */
export const MARKET_SELECTION_COMPANIES_SQL = `SELECT DISTINCT m.company_id AS companyId FROM market_cap_memberships m JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id JOIN companies c ON c.id=m.company_id WHERE c.is_listed=1`;
export const NEWS_COLLECTION_COMPANIES_SQL = `${APPROVED_GROUP_COMPANIES_SQL} UNION ${MARKET_LEADER_COMPANIES_SQL}`;

/** Personal-use news API scope: administrators' own groups, then spare-budget US leaders. */
export const ADMIN_NEWS_COMPANIES_SQL = `SELECT DISTINCT gi.company_id AS companyId
  FROM watchlist_group_items gi JOIN watchlist_groups g ON g.id=gi.group_id
  JOIN admins a ON g.owner_key=CONCAT('ADMIN:',a.id) AND a.is_active=1
  WHERE g.room_id IS NULL ORDER BY gi.company_id`;
