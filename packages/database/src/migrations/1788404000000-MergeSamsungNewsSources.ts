import type { MigrationInterface, QueryRunner } from 'typeorm';

const MERGE_KEY = 'SAMSUNG_GLOBAL_CANONICAL_SOURCE_V1';
const REKEY_KEY = 'SAMSUNG_GLOBAL_EXTERNAL_ID_V1';
const SAMSUNG_GLOBAL_FEED = 'https://news.samsung.com/global/feed';

interface CountRow {
  count: string | number;
}

interface UnsafeGroupRow {
  url: string;
  duplicate_count: string | number;
  article_count: string | number;
  canonical_count: string | number;
  keeper_count: string | number;
}

function count(rows: CountRow[]): number {
  return Number(rows[0]?.count ?? 0);
}

const expectedExternalIdSql = (articleAlias: string) =>
  `LOWER(SHA2(CONCAT('${SAMSUNG_GLOBAL_FEED}', ':', ${articleAlias}.canonical_url), 256))`;

const hasExpectedExternalIdSql = (sourceAlias: string, articleAlias: string) =>
  `(${sourceAlias}.external_id IS NOT NULL
    AND ${articleAlias}.canonical_url IS NOT NULL
    AND BINARY ${sourceAlias}.external_id = BINARY ${expectedExternalIdSql(articleAlias)})`;

/**
 * Merges the legacy Samsung RSS identity into the current URL-derived SHA identity.
 * The current row already owns the approved content and provenance, so only the earliest
 * observation and polymorphic references move to it.
 */
export class MergeSamsungNewsSources1788404000000 implements MigrationInterface {
  name = 'MergeSamsungNewsSources1788404000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const engine = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    // MariaDB implicitly commits DDL even when TypeORM opened its global migration transaction.
    // Durable mapping rows therefore drive every later mutation and make an interrupted run
    // resumable before TypeORM records this migration as complete.
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS samsung_news_source_merge_audit (
      id CHAR(36) NOT NULL PRIMARY KEY,
      merge_key VARCHAR(64) NOT NULL,
      canonical_url TEXT NOT NULL,
      keeper_source_item_id CHAR(36) NOT NULL,
      loser_source_item_id CHAR(36) NOT NULL,
      keeper_news_item_id CHAR(36) NULL,
      loser_news_item_id CHAR(36) NULL,
      keeper_external_id VARCHAR(255) NOT NULL,
      loser_external_id VARCHAR(255) NULL,
      previous_keeper_first_observed_at DATETIME(3) NOT NULL,
      loser_first_observed_at DATETIME(3) NOT NULL,
      merged_first_observed_at DATETIME(3) NOT NULL,
      applied_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      UNIQUE KEY ux_samsung_source_merge_loser (merge_key, loser_source_item_id),
      KEY ix_samsung_source_merge_keeper (keeper_source_item_id),
      KEY ix_samsung_source_merge_applied (merge_key, applied_at)
    ) ${engine}`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS samsung_news_source_rekey_audit (
      id CHAR(36) NOT NULL PRIMARY KEY,
      rekey_key VARCHAR(64) NOT NULL,
      source_item_id CHAR(36) NOT NULL,
      news_article_id CHAR(36) NOT NULL,
      canonical_url TEXT NOT NULL,
      previous_external_id VARCHAR(255) NULL,
      canonical_external_id CHAR(64) NOT NULL,
      applied_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      UNIQUE KEY ux_samsung_source_rekey_item (rekey_key, source_item_id),
      KEY ix_samsung_source_rekey_applied (rekey_key, applied_at)
    ) ${engine}`);

    // Refuse ambiguous groups before moving any reference. Exactly one current SHA row with
    // AVAILABLE content must exist for every duplicated Samsung article URL.
    const unsafeGroups = (await queryRunner.query(
      `SELECT grouped.url, grouped.duplicate_count, grouped.article_count,
         grouped.canonical_count, grouped.keeper_count
       FROM (
         SELECT MIN(source.url) AS url,
           COUNT(*) AS duplicate_count,
           COUNT(DISTINCT COALESCE(source.news_article_id, '')) AS article_count,
           SUM(CASE WHEN ${hasExpectedExternalIdSql('source', 'article')} THEN 1 ELSE 0 END) AS canonical_count,
           SUM(CASE WHEN ${hasExpectedExternalIdSql('source', 'article')}
             AND EXISTS (
               SELECT 1 FROM news_article_contents content
               WHERE content.source_item_id = source.id AND content.status = 'AVAILABLE'
             ) THEN 1 ELSE 0 END) AS keeper_count
         FROM source_items source
         LEFT JOIN news_articles article ON article.id = source.news_article_id
         WHERE source.source = 'IR'
           AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?
         GROUP BY BINARY source.url
         HAVING COUNT(*) > 1
       ) grouped
       WHERE grouped.article_count <> 1
          OR grouped.canonical_count <> 1
          OR grouped.keeper_count <> 1
       LIMIT 10`,
      [SAMSUNG_GLOBAL_FEED],
    )) as UnsafeGroupRow[];
    if (unsafeGroups.length > 0) {
      const details = unsafeGroups
        .map(
          (row) =>
            `${row.url} (rows=${Number(row.duplicate_count)}, articles=${Number(row.article_count)}, canonical=${Number(row.canonical_count)}, keepers=${Number(row.keeper_count)})`,
        )
        .join(', ');
      throw new Error(`Unsafe Samsung source merge groups: ${details}`);
    }

    const missingArticles = (await queryRunner.query(
      `SELECT COUNT(*) AS count
       FROM source_items source
       LEFT JOIN news_articles article ON article.id = source.news_article_id
       WHERE source.source = 'IR'
         AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?
         AND article.id IS NULL`,
      [SAMSUNG_GLOBAL_FEED],
    )) as CountRow[];
    if (count(missingArticles) > 0) {
      throw new Error('Samsung source merge requires a canonical article for every source row.');
    }

    await queryRunner.query(
      `INSERT INTO samsung_news_source_merge_audit (
        id, merge_key, canonical_url,
        keeper_source_item_id, loser_source_item_id,
        keeper_news_item_id, loser_news_item_id,
        keeper_external_id, loser_external_id,
        previous_keeper_first_observed_at, loser_first_observed_at,
        merged_first_observed_at
      )
      SELECT UUID(), ?, keeper_article.canonical_url,
        keeper.id, loser.id, keeper_news.id, loser_news.id,
        keeper.external_id, loser.external_id,
        keeper.first_observed_at, loser.first_observed_at,
        LEAST(keeper.first_observed_at, loser.first_observed_at)
      FROM source_items keeper
      INNER JOIN news_articles keeper_article ON keeper_article.id = keeper.news_article_id
      INNER JOIN news_article_contents keeper_content
        ON keeper_content.source_item_id = keeper.id AND keeper_content.status = 'AVAILABLE'
      INNER JOIN source_items loser
        ON loser.id <> keeper.id
       AND loser.news_article_id = keeper.news_article_id
       AND BINARY loser.url = BINARY keeper.url
      LEFT JOIN news_items keeper_news ON keeper_news.source_item_id = keeper.id
      LEFT JOIN news_items loser_news ON loser_news.source_item_id = loser.id
      WHERE keeper.source = 'IR' AND loser.source = 'IR'
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(keeper.raw_metadata_json, '$.feedUrl')) = BINARY ?
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(loser.raw_metadata_json, '$.feedUrl')) = BINARY ?
        AND ${hasExpectedExternalIdSql('keeper', 'keeper_article')}
        AND NOT ${hasExpectedExternalIdSql('loser', 'keeper_article')}
        AND NOT EXISTS (
          SELECT 1 FROM samsung_news_source_merge_audit existing
          WHERE existing.merge_key = ? AND existing.loser_source_item_id = loser.id
        )`,
      [MERGE_KEY, SAMSUNG_GLOBAL_FEED, SAMSUNG_GLOBAL_FEED, MERGE_KEY],
    );

    const missingKeeperNews = (await queryRunner.query(
      `SELECT COUNT(*) AS count
       FROM samsung_news_source_merge_audit merge
       WHERE merge.merge_key = ?
         AND merge.loser_news_item_id IS NOT NULL
         AND merge.keeper_news_item_id IS NULL`,
      [MERGE_KEY],
    )) as CountRow[];
    if (count(missingKeeperNews) > 0) {
      throw new Error('Samsung source merge cannot preserve a news item without a keeper row.');
    }

    // Four historical Samsung rows currently have no duplicate because they fell outside the
    // latest feed window. Rekey every surviving row from the stored canonical article URL so
    // future polling can find it by the same identity as the runtime parser.
    await queryRunner.query(
      `INSERT INTO samsung_news_source_rekey_audit (
        id, rekey_key, source_item_id, news_article_id, canonical_url,
        previous_external_id, canonical_external_id
      )
      SELECT UUID(), ?, source.id, article.id, article.canonical_url,
        source.external_id, ${expectedExternalIdSql('article')}
      FROM source_items source
      INNER JOIN news_articles article ON article.id = source.news_article_id
      LEFT JOIN samsung_news_source_merge_audit merge_loser
        ON merge_loser.merge_key = ? AND merge_loser.loser_source_item_id = source.id
      WHERE source.source = 'IR'
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?
        AND merge_loser.id IS NULL
        AND NOT ${hasExpectedExternalIdSql('source', 'article')}
        AND NOT EXISTS (
          SELECT 1 FROM samsung_news_source_rekey_audit existing
          WHERE existing.rekey_key = ? AND existing.source_item_id = source.id
        )`,
      [REKEY_KEY, MERGE_KEY, SAMSUNG_GLOBAL_FEED, REKEY_KEY],
    );

    const survivingArticleDuplicates = (await queryRunner.query(
      `SELECT COUNT(*) AS count FROM (
         SELECT source.news_article_id
         FROM source_items source
         LEFT JOIN samsung_news_source_merge_audit planned_loser
           ON planned_loser.merge_key = ? AND planned_loser.loser_source_item_id = source.id
         WHERE source.source = 'IR'
           AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?
           AND planned_loser.id IS NULL
         GROUP BY source.news_article_id
         HAVING COUNT(*) > 1
       ) duplicates`,
      [MERGE_KEY, SAMSUNG_GLOBAL_FEED],
    )) as CountRow[];
    if (count(survivingArticleDuplicates) > 0) {
      throw new Error('Samsung source merge found multiple intended keepers for one article.');
    }

    const rekeyConflicts = (await queryRunner.query(
      `SELECT COUNT(*) AS count
       FROM samsung_news_source_rekey_audit rekey
       INNER JOIN source_items conflicting
         ON conflicting.source = 'IR'
        AND conflicting.id <> rekey.source_item_id
        AND BINARY conflicting.external_id = BINARY rekey.canonical_external_id
       LEFT JOIN samsung_news_source_merge_audit planned_loser
         ON planned_loser.merge_key = ?
        AND planned_loser.loser_source_item_id = conflicting.id
       WHERE rekey.rekey_key = ? AND planned_loser.id IS NULL`,
      [MERGE_KEY, REKEY_KEY],
    )) as CountRow[];
    if (count(rekeyConflicts) > 0) {
      throw new Error('Samsung source rekey would violate the external identity constraint.');
    }

    const polymorphicMappings = [
      {
        itemType: 'SOURCE_ITEM',
        loserColumn: 'loser_source_item_id',
        keeperColumn: 'keeper_source_item_id',
      },
      {
        itemType: 'NEWS_ITEM',
        loserColumn: 'loser_news_item_id',
        keeperColumn: 'keeper_news_item_id',
      },
    ] as const;

    const sourceAiConflicts = (await queryRunner.query(
      `SELECT COUNT(*) AS count
       FROM ai_runs losing
       INNER JOIN samsung_news_source_merge_audit merge
         ON merge.merge_key = ? AND merge.loser_source_item_id = losing.subject_id
       INNER JOIN ai_runs existing
         ON existing.subject_type = 'SOURCE_ITEM'
        AND existing.subject_id = merge.keeper_source_item_id
        AND existing.provider = losing.provider
        AND existing.model = losing.model
        AND existing.prompt_hash = losing.prompt_hash
       WHERE losing.subject_type = 'SOURCE_ITEM'`,
      [MERGE_KEY],
    )) as CountRow[];
    const newsAiConflicts = (await queryRunner.query(
      `SELECT COUNT(*) AS count
       FROM ai_runs losing
       INNER JOIN samsung_news_source_merge_audit merge
         ON merge.merge_key = ? AND merge.loser_news_item_id = losing.subject_id
       INNER JOIN ai_runs existing
         ON existing.subject_type = 'NEWS_ITEM'
        AND existing.subject_id = merge.keeper_news_item_id
        AND existing.provider = losing.provider
        AND existing.model = losing.model
        AND existing.prompt_hash = losing.prompt_hash
       WHERE losing.subject_type = 'NEWS_ITEM'`,
      [MERGE_KEY],
    )) as CountRow[];
    const sourceLoserAiConflicts = (await queryRunner.query(
      `SELECT COUNT(*) AS count FROM (
         SELECT merge.keeper_source_item_id, losing.provider, losing.model, losing.prompt_hash
         FROM ai_runs losing
         INNER JOIN samsung_news_source_merge_audit merge
           ON merge.merge_key = ? AND merge.loser_source_item_id = losing.subject_id
         WHERE losing.subject_type = 'SOURCE_ITEM'
         GROUP BY merge.keeper_source_item_id, losing.provider, losing.model, losing.prompt_hash
         HAVING COUNT(*) > 1
       ) conflicts`,
      [MERGE_KEY],
    )) as CountRow[];
    const newsLoserAiConflicts = (await queryRunner.query(
      `SELECT COUNT(*) AS count FROM (
         SELECT merge.keeper_news_item_id, losing.provider, losing.model, losing.prompt_hash
         FROM ai_runs losing
         INNER JOIN samsung_news_source_merge_audit merge
           ON merge.merge_key = ? AND merge.loser_news_item_id = losing.subject_id
         WHERE losing.subject_type = 'NEWS_ITEM' AND merge.keeper_news_item_id IS NOT NULL
         GROUP BY merge.keeper_news_item_id, losing.provider, losing.model, losing.prompt_hash
         HAVING COUNT(*) > 1
       ) conflicts`,
      [MERGE_KEY],
    )) as CountRow[];
    if (
      count(sourceAiConflicts) +
        count(newsAiConflicts) +
        count(sourceLoserAiConflicts) +
        count(newsLoserAiConflicts) >
      0
    ) {
      throw new Error('Samsung source merge would collapse distinct AI audit rows.');
    }

    for (const mapping of polymorphicMappings) {
      const keeperReviewConflicts = (await queryRunner.query(
        `SELECT COUNT(*) AS count
         FROM reviews losing
         INNER JOIN samsung_news_source_merge_audit merge
           ON merge.merge_key = ? AND merge.${mapping.loserColumn} = losing.subject_id
         INNER JOIN reviews existing
           ON existing.subject_type = ?
          AND existing.subject_id = merge.${mapping.keeperColumn}
          AND existing.dedupe_key = losing.dedupe_key
         WHERE losing.subject_type = ?`,
        [MERGE_KEY, mapping.itemType, mapping.itemType],
      )) as CountRow[];
      const loserReviewConflicts = (await queryRunner.query(
        `SELECT COUNT(*) AS count FROM (
           SELECT merge.${mapping.keeperColumn}, losing.dedupe_key
           FROM reviews losing
           INNER JOIN samsung_news_source_merge_audit merge
             ON merge.merge_key = ? AND merge.${mapping.loserColumn} = losing.subject_id
           WHERE losing.subject_type = ? AND merge.${mapping.keeperColumn} IS NOT NULL
           GROUP BY merge.${mapping.keeperColumn}, losing.dedupe_key
           HAVING COUNT(*) > 1
         ) conflicts`,
        [MERGE_KEY, mapping.itemType],
      )) as CountRow[];
      if (count(keeperReviewConflicts) + count(loserReviewConflicts) > 0) {
        throw new Error('Samsung source merge would collapse distinct review rows.');
      }

      const multipleMemberships = (await queryRunner.query(
        `SELECT COUNT(*) AS count FROM (
           SELECT merge.${mapping.keeperColumn}, losing.event_cluster_id
           FROM event_cluster_items losing
           INNER JOIN samsung_news_source_merge_audit merge
             ON merge.merge_key = ? AND losing.item_id = merge.${mapping.loserColumn}
           WHERE losing.item_type = ? AND merge.${mapping.keeperColumn} IS NOT NULL
           GROUP BY merge.${mapping.keeperColumn}, losing.event_cluster_id
           HAVING COUNT(*) > 1
         ) conflicts`,
        [MERGE_KEY, mapping.itemType],
      )) as CountRow[];
      const incompatibleProvenance = (await queryRunner.query(
        `SELECT COUNT(*) AS count
         FROM event_cluster_items losing
         INNER JOIN samsung_news_source_merge_audit merge
           ON merge.merge_key = ? AND losing.item_id = merge.${mapping.loserColumn}
         INNER JOIN event_cluster_items kept
           ON kept.event_cluster_id = losing.event_cluster_id
          AND kept.item_type = losing.item_type
          AND kept.item_id = merge.${mapping.keeperColumn}
         WHERE losing.item_type = ?
           AND losing.provenance_json IS NOT NULL
           AND kept.provenance_json IS NOT NULL
           AND BINARY losing.provenance_json <> BINARY kept.provenance_json`,
        [MERGE_KEY, mapping.itemType],
      )) as CountRow[];
      if (count(multipleMemberships) + count(incompatibleProvenance) > 0) {
        throw new Error('Samsung source merge would collapse distinct event provenance.');
      }
    }

    await queryRunner.query(
      `UPDATE source_items keeper
       INNER JOIN (
         SELECT keeper_source_item_id, MIN(merged_first_observed_at) AS first_observed_at
         FROM samsung_news_source_merge_audit
         WHERE merge_key = ?
         GROUP BY keeper_source_item_id
       ) observed ON observed.keeper_source_item_id = keeper.id
       SET keeper.first_observed_at = LEAST(keeper.first_observed_at, observed.first_observed_at),
         keeper.updated_at = UTC_TIMESTAMP(3)`,
      [MERGE_KEY],
    );

    for (const mapping of polymorphicMappings) {
      await queryRunner.query(
        `INSERT IGNORE INTO event_cluster_items (
          id, created_at, updated_at, event_cluster_id,
          item_type, item_id, is_primary, provenance_json
        )
        SELECT UUID(), losing.created_at, losing.updated_at, losing.event_cluster_id,
          losing.item_type, merge.${mapping.keeperColumn}, losing.is_primary, losing.provenance_json
        FROM event_cluster_items losing
        INNER JOIN samsung_news_source_merge_audit merge
          ON merge.merge_key = ? AND losing.item_id = merge.${mapping.loserColumn}
        WHERE losing.item_type = ? AND merge.${mapping.keeperColumn} IS NOT NULL`,
        [MERGE_KEY, mapping.itemType],
      );
      await queryRunner.query(
        `UPDATE event_cluster_items kept
         INNER JOIN samsung_news_source_merge_audit merge
           ON merge.merge_key = ? AND kept.item_id = merge.${mapping.keeperColumn}
         INNER JOIN event_cluster_items losing
           ON losing.event_cluster_id = kept.event_cluster_id
          AND losing.item_type = kept.item_type
          AND losing.item_id = merge.${mapping.loserColumn}
         SET kept.is_primary = IF(kept.is_primary OR losing.is_primary, 1, 0),
           kept.provenance_json = COALESCE(kept.provenance_json, losing.provenance_json),
           kept.updated_at = UTC_TIMESTAMP(3)
         WHERE kept.item_type = ?`,
        [MERGE_KEY, mapping.itemType],
      );
      await queryRunner.query(
        `DELETE losing FROM event_cluster_items losing
         INNER JOIN samsung_news_source_merge_audit merge
           ON merge.merge_key = ? AND losing.item_id = merge.${mapping.loserColumn}
         WHERE losing.item_type = ?`,
        [MERGE_KEY, mapping.itemType],
      );
    }

    for (const mapping of polymorphicMappings) {
      await queryRunner.query(
        `UPDATE reviews review
         INNER JOIN samsung_news_source_merge_audit merge
           ON merge.merge_key = ? AND review.subject_id = merge.${mapping.loserColumn}
         SET review.subject_id = merge.${mapping.keeperColumn},
           review.updated_at = UTC_TIMESTAMP(3)
         WHERE review.subject_type = ? AND merge.${mapping.keeperColumn} IS NOT NULL`,
        [MERGE_KEY, mapping.itemType],
      );
      await queryRunner.query(
        `UPDATE ai_runs run
         INNER JOIN samsung_news_source_merge_audit merge
           ON merge.merge_key = ? AND run.subject_id = merge.${mapping.loserColumn}
         SET run.subject_id = merge.${mapping.keeperColumn},
           run.updated_at = UTC_TIMESTAMP(3)
         WHERE run.subject_type = ? AND merge.${mapping.keeperColumn} IS NOT NULL`,
        [MERGE_KEY, mapping.itemType],
      );
    }

    await queryRunner.query(
      `DELETE news FROM news_items news
       INNER JOIN samsung_news_source_merge_audit merge
         ON merge.merge_key = ? AND news.id = merge.loser_news_item_id`,
      [MERGE_KEY],
    );
    await queryRunner.query(
      `DELETE source FROM source_items source
       INNER JOIN samsung_news_source_merge_audit merge
         ON merge.merge_key = ? AND source.id = merge.loser_source_item_id`,
      [MERGE_KEY],
    );
    // Planned losers have now been removed, so a historical survivor can safely assume its
    // canonical identity even if a loser's old identifier happened to equal that value.
    await queryRunner.query(
      `UPDATE source_items source
       INNER JOIN samsung_news_source_rekey_audit rekey
         ON rekey.rekey_key = ? AND rekey.source_item_id = source.id
       SET source.external_id = rekey.canonical_external_id,
         source.updated_at = UTC_TIMESTAMP(3)`,
      [REKEY_KEY],
    );
    await queryRunner.query(
      `UPDATE samsung_news_source_rekey_audit rekey
       INNER JOIN source_items source ON source.id = rekey.source_item_id
       SET rekey.applied_at = COALESCE(rekey.applied_at, UTC_TIMESTAMP(3))
       WHERE rekey.rekey_key = ?
         AND BINARY source.external_id = BINARY rekey.canonical_external_id`,
      [REKEY_KEY],
    );
    await queryRunner.query(
      `UPDATE samsung_news_source_merge_audit merge
       SET merge.applied_at = COALESCE(merge.applied_at, UTC_TIMESTAMP(3))
       WHERE merge.merge_key = ?
         AND NOT EXISTS (
           SELECT 1 FROM source_items loser WHERE loser.id = merge.loser_source_item_id
         )`,
      [MERGE_KEY],
    );

    const remainingUrlDuplicates = (await queryRunner.query(
      `SELECT COUNT(*) AS count FROM (
         SELECT MIN(source.url) AS url
         FROM source_items source
         WHERE source.source = 'IR'
           AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?
         GROUP BY BINARY source.url
         HAVING COUNT(*) > 1
       ) duplicates`,
      [SAMSUNG_GLOBAL_FEED],
    )) as CountRow[];
    const remainingArticleDuplicates = (await queryRunner.query(
      `SELECT COUNT(*) AS count FROM (
         SELECT source.news_article_id
         FROM source_items source
         WHERE source.source = 'IR'
           AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?
         GROUP BY source.news_article_id
         HAVING COUNT(*) > 1
       ) duplicates`,
      [SAMSUNG_GLOBAL_FEED],
    )) as CountRow[];
    if (count(remainingUrlDuplicates) + count(remainingArticleDuplicates) > 0) {
      throw new Error('Samsung source merge left duplicate article URLs.');
    }

    const noncanonical = (await queryRunner.query(
      `SELECT COUNT(*) AS count
       FROM source_items source
       LEFT JOIN news_articles article ON article.id = source.news_article_id
       WHERE source.source = 'IR'
         AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?
         AND NOT ${hasExpectedExternalIdSql('source', 'article')}`,
      [SAMSUNG_GLOBAL_FEED],
    )) as CountRow[];
    if (count(noncanonical) > 0) {
      throw new Error('Samsung source merge left noncanonical external identities.');
    }
  }

  async down(): Promise<void> {
    throw new Error(
      'Samsung source identities and polymorphic references were merged; restore a verified backup instead.',
    );
  }
}
