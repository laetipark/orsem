import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Run after stopping the old API and discovery/translation workers. Backups are
 * intentionally outside this migration; it only changes the live news tables.
 */
export class UseNewsMetadataOnly1788411000000 implements MigrationInterface {
  name = 'UseNewsMetadataOnly1788411000000';

  async up(runner: QueryRunner): Promise<void> {
    // Keep identifiers, source hashes, rights and original observation/audit times.
    // Delete the entire translation JSON, including resumable completedChunks.
    await runner.query(`UPDATE news_article_contents content
      INNER JOIN source_items source ON source.id = content.source_item_id
      SET content.blocks_json = NULL,
          content.translation_json = NULL,
          content.manual_translation_json = NULL,
          content.status = 'PURGED',
          content.next_attempt_at = NULL,
          content.failure_code = 'METADATA_ONLY'
      WHERE source.source IN ('IR', 'NEWS_RSS', 'GDELT', 'ALPACA_NEWS', 'NAVER')
        AND (content.blocks_json IS NOT NULL OR content.translation_json IS NOT NULL
          OR content.manual_translation_json IS NOT NULL OR content.status <> 'PURGED'
          OR content.next_attempt_at IS NOT NULL)`);

    await runner.query(`UPDATE source_items
      SET manual_translation_json = JSON_SET(
        JSON_REMOVE(manual_translation_json, '$.contentHash', '$.content', '$.blocks', '$.markdown'),
        '$.version', 2)
      WHERE source IN ('IR', 'NEWS_RSS', 'GDELT', 'ALPACA_NEWS', 'NAVER')
        AND JSON_TYPE(manual_translation_json) = 'OBJECT'
        AND (NOT (JSON_EXTRACT(manual_translation_json, '$.version') <=> 2)
          OR JSON_CONTAINS_PATH(manual_translation_json, 'one', '$.contentHash', '$.content', '$.blocks', '$.markdown') = 1)`);

    for (const column of ['manual_json', 'previous_manual_json']) {
      await runner.query(`UPDATE news_translation_revisions revision
        INNER JOIN source_items source ON source.id = revision.source_item_id
        SET revision.${column} = CASE
          WHEN JSON_TYPE(JSON_EXTRACT(revision.${column}, '$.metadata')) = 'OBJECT'
            THEN JSON_SET(JSON_REMOVE(revision.${column}, '$.content', '$.metadata.contentHash',
              '$.metadata.content', '$.metadata.blocks', '$.metadata.markdown'), '$.metadata.version', 2)
          ELSE JSON_REMOVE(revision.${column}, '$.content') END
        WHERE source.source IN ('IR', 'NEWS_RSS', 'GDELT', 'ALPACA_NEWS', 'NAVER')
          AND revision.${column} IS NOT NULL
          AND (JSON_CONTAINS_PATH(revision.${column}, 'one', '$.content', '$.metadata.contentHash',
            '$.metadata.content', '$.metadata.blocks', '$.metadata.markdown') = 1
            OR (JSON_TYPE(JSON_EXTRACT(revision.${column}, '$.metadata')) = 'OBJECT'
              AND NOT (JSON_EXTRACT(revision.${column}, '$.metadata.version') <=> 2)))`);
    }
  }

  async down(): Promise<void> {
    throw new Error('News bodies were intentionally removed; historical backups remain unchanged.');
  }
}
