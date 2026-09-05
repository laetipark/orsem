import { createHash } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';

const SAMSUNG_GLOBAL_FEED = 'https://news.samsung.com/global/feed';
const MICROSOFT_NEWS_FEED = 'https://microsoft.gcs-web.com/rss/news-releases.xml';
const RETIRED_ETODAY_FEEDS = [
  ['etoday-market', 'https://rss.etoday.co.kr/eto/market_news.xml'],
  ['etoday-finance', 'https://rss.etoday.co.kr/eto/finance_news.xml'],
  ['etoday-industry', 'https://rss.etoday.co.kr/eto/industry_news.xml'],
  ['etoday-economy', 'https://rss.etoday.co.kr/eto/economy_news.xml'],
] as const;
const APPROVED_CONTENT_NEWS_RSS_FEEDS = [
  'https://www.federalreserve.gov/feeds/press_all.xml',
  'https://www.federalreserve.gov/feeds/speeches_and_testimony.xml',
  'https://www.bls.gov/feed/bls_latest.rss',
] as const;
const SAMSUNG_CLOCK_CORRECTION = 'SAMSUNG_GLOBAL_RSS_KST_V1';
const SAMSUNG_RIGHTS_MODE = 'PRIVATE_DISPLAY_ONLY';

function feedCheckpointStream(url: string): string {
  return `RSS_HTTP:${createHash('sha256').update(url).digest('hex')}`;
}

/**
 * Adds normalized article bodies, repairs the known Samsung wall-clock feed, and removes
 * previously collected news whose content/display rights are no longer approved.
 */
export class AddNewsArticleContents1788403000000 implements MigrationInterface {
  name = 'AddNewsArticleContents1788403000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const timestamps = `created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))`;
    const engine = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS news_article_contents (
      id CHAR(36) NOT NULL PRIMARY KEY,
      source_item_id CHAR(36) NOT NULL,
      status VARCHAR(16) NOT NULL,
      language VARCHAR(35) NULL,
      blocks_json JSON NULL,
      content_hash CHAR(64) NULL,
      extractor_version INT UNSIGNED NOT NULL DEFAULT 1,
      fetched_at DATETIME(3) NULL,
      attempted_at DATETIME(3) NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at DATETIME(3) NULL,
      failure_code VARCHAR(64) NULL,
      rights_policy_json JSON NOT NULL,
      translation_json JSON NULL,
      ${timestamps},
      UNIQUE KEY ux_news_article_content_source (source_item_id),
      KEY ix_news_article_contents_status_retry (status, next_attempt_at),
      CONSTRAINT fk_news_article_content_source FOREIGN KEY (source_item_id)
        REFERENCES source_items(id) ON DELETE CASCADE
    ) ${engine}`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS news_time_correction_audit (
      id CHAR(36) NOT NULL PRIMARY KEY,
      correction_key VARCHAR(64) NOT NULL,
      source_item_id CHAR(36) NOT NULL,
      news_article_id CHAR(36) NULL,
      feed_url VARCHAR(2048) NOT NULL,
      original_published_at VARCHAR(255) NULL,
      previous_source_published_at DATETIME(3) NOT NULL,
      corrected_source_published_at DATETIME(3) NOT NULL,
      previous_news_published_at DATETIME(3) NULL,
      corrected_news_published_at DATETIME(3) NULL,
      previous_article_sort_at DATETIME(3) NULL,
      corrected_article_sort_at DATETIME(3) NULL,
      applied_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      UNIQUE KEY ux_news_time_correction_source (correction_key, source_item_id),
      KEY ix_news_time_correction_article (news_article_id)
    ) ${engine}`);

    // Samsung Global emits Korean wall-clock values with a UTC suffix. Preserve the source
    // string, record before/after values, and assign exact targets so an interrupted migration
    // can resume without subtracting nine hours twice.
    await queryRunner.query(
      `INSERT INTO news_time_correction_audit (
        id, correction_key, source_item_id, news_article_id, feed_url,
        original_published_at, previous_source_published_at, corrected_source_published_at,
        previous_news_published_at, corrected_news_published_at,
        previous_article_sort_at, corrected_article_sort_at
      )
      SELECT UUID(), ?, source.id, source.news_article_id, ?,
        JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.originalPublishedAt')),
        source.published_at, DATE_SUB(source.published_at, INTERVAL 9 HOUR),
        news.published_at,
        CASE WHEN news.published_at IS NULL THEN NULL ELSE DATE_SUB(news.published_at, INTERVAL 9 HOUR) END,
        article.sort_at,
        CASE WHEN source.news_article_id IS NULL THEN NULL ELSE (
          SELECT MIN(CASE
            WHEN peer.source = 'IR'
              AND BINARY JSON_UNQUOTE(JSON_EXTRACT(peer.raw_metadata_json, '$.feedUrl')) = BINARY ?
              AND peer.published_at IS NOT NULL
              THEN DATE_SUB(peer.published_at, INTERVAL 9 HOUR)
            ELSE COALESCE(peer.published_at, peer.first_observed_at)
          END)
          FROM source_items peer WHERE peer.news_article_id = source.news_article_id
        ) END
      FROM source_items source
      LEFT JOIN news_items news ON news.source_item_id = source.id
      LEFT JOIN news_articles article ON article.id = source.news_article_id
      WHERE source.source = 'IR'
        AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?
        AND source.published_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM news_time_correction_audit existing
          WHERE existing.correction_key = ? AND existing.source_item_id = source.id
        )`,
      [
        SAMSUNG_CLOCK_CORRECTION,
        SAMSUNG_GLOBAL_FEED,
        SAMSUNG_GLOBAL_FEED,
        SAMSUNG_GLOBAL_FEED,
        SAMSUNG_CLOCK_CORRECTION,
      ],
    );
    await queryRunner.query(
      `UPDATE source_items source
       INNER JOIN news_time_correction_audit audit ON audit.source_item_id = source.id
       SET source.published_at = audit.corrected_source_published_at
       WHERE audit.correction_key = ?`,
      [SAMSUNG_CLOCK_CORRECTION],
    );
    await queryRunner.query(
      `UPDATE news_items news
       INNER JOIN news_time_correction_audit audit ON audit.source_item_id = news.source_item_id
       SET news.published_at = audit.corrected_news_published_at
       WHERE audit.correction_key = ?`,
      [SAMSUNG_CLOCK_CORRECTION],
    );
    await queryRunner.query(
      `UPDATE news_articles article
       INNER JOIN (
         SELECT news_article_id, MIN(corrected_article_sort_at) AS corrected_sort_at
         FROM news_time_correction_audit
         WHERE correction_key = ? AND news_article_id IS NOT NULL
         GROUP BY news_article_id
       ) correction ON correction.news_article_id = article.id
       SET article.sort_at = correction.corrected_sort_at`,
      [SAMSUNG_CLOCK_CORRECTION],
    );
    await queryRunner.query(
      `UPDATE news_time_correction_audit
       SET applied_at = COALESCE(applied_at, UTC_TIMESTAMP(3))
       WHERE correction_key = ?`,
      [SAMSUNG_CLOCK_CORRECTION],
    );

    // The reviewed Samsung newsroom profile permits private display, while arbitrary IR feeds
    // remain metadata-only. Assign the exact target so this repair is safe to rerun.
    await queryRunner.query(
      `UPDATE ir_sources
       SET rights_mode = ?, updated_at = UTC_TIMESTAMP(3)
       WHERE BINARY url = BINARY ? AND rights_mode <> ?`,
      [SAMSUNG_RIGHTS_MODE, SAMSUNG_GLOBAL_FEED, SAMSUNG_RIGHTS_MODE],
    );

    await queryRunner.query('DROP TEMPORARY TABLE IF EXISTS retired_news_orphan_cluster_ids');
    await queryRunner.query('DROP TEMPORARY TABLE IF EXISTS retired_news_event_cluster_ids');
    await queryRunner.query('DROP TEMPORARY TABLE IF EXISTS retired_news_source_ids');
    await queryRunner.query(`CREATE TEMPORARY TABLE retired_news_source_ids (
      source_item_id CHAR(36) NOT NULL PRIMARY KEY,
      news_item_id CHAR(36) NULL,
      news_article_id CHAR(36) NULL,
      KEY ix_retired_news_item (news_item_id),
      KEY ix_retired_news_article (news_article_id)
    ) ${engine}`);
    await queryRunner.query(
      `INSERT IGNORE INTO retired_news_source_ids (source_item_id, news_item_id, news_article_id)
       SELECT source.id, news.id, source.news_article_id
       FROM source_items source
       LEFT JOIN news_items news ON news.source_item_id = source.id
       WHERE source.source IN ('NAVER', 'GDELT')
          OR (source.source = 'NEWS_RSS' AND JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedId')) IN (?, ?, ?, ?))
          OR (source.source = 'IR' AND BINARY JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.feedUrl')) = BINARY ?)`,
      [...RETIRED_ETODAY_FEEDS.map(([id]) => id), MICROSOFT_NEWS_FEED],
    );
    await queryRunner.query(`CREATE TEMPORARY TABLE retired_news_event_cluster_ids (
      event_cluster_id CHAR(36) NOT NULL PRIMARY KEY
    ) ${engine}`);
    await queryRunner.query(
      `INSERT IGNORE INTO retired_news_event_cluster_ids (event_cluster_id)
       SELECT DISTINCT item.event_cluster_id
       FROM event_cluster_items item
       INNER JOIN retired_news_source_ids retired
         ON (item.item_type = 'SOURCE_ITEM' AND item.item_id = retired.source_item_id)
         OR (item.item_type = 'NEWS_ITEM' AND item.item_id = retired.news_item_id)`,
    );
    await queryRunner.query(`CREATE TEMPORARY TABLE retired_news_orphan_cluster_ids (
      event_cluster_id CHAR(36) NOT NULL PRIMARY KEY
    ) ${engine}`);
    // Snapshot clusters whose every membership is being retired before deleting memberships.
    // This keeps the cleanup recoverable and prevents a mixed-source cluster from being removed.
    await queryRunner.query(
      `INSERT IGNORE INTO retired_news_orphan_cluster_ids (event_cluster_id)
       SELECT affected.event_cluster_id
       FROM retired_news_event_cluster_ids affected
       WHERE NOT EXISTS (
         SELECT 1 FROM event_cluster_items survivor
         LEFT JOIN retired_news_source_ids retired_survivor
           ON (survivor.item_type = 'SOURCE_ITEM'
             AND survivor.item_id = retired_survivor.source_item_id)
           OR (survivor.item_type = 'NEWS_ITEM'
             AND survivor.item_id = retired_survivor.news_item_id)
         WHERE survivor.event_cluster_id = affected.event_cluster_id
           AND retired_survivor.source_item_id IS NULL
       )`,
    );
    await queryRunner.query(
      `DELETE item FROM event_cluster_items item
       INNER JOIN retired_news_source_ids retired
         ON (item.item_type = 'SOURCE_ITEM' AND item.item_id = retired.source_item_id)
         OR (item.item_type = 'NEWS_ITEM' AND item.item_id = retired.news_item_id)`,
    );
    // Remove delivery payloads and alert history before their now-empty event clusters. Alerts
    // cascade to the outbox/delivery tables; bot and push deliveries need explicit cleanup.
    await queryRunner.query(
      `DELETE push FROM push_deliveries push
       INNER JOIN retired_news_orphan_cluster_ids retired
         ON BINARY retired.event_cluster_id = BINARY push.event_cluster_id`,
    );
    await queryRunner.query(
      `DELETE push FROM push_deliveries push
       INNER JOIN alerts alert ON BINARY alert.id = BINARY push.alert_id
       INNER JOIN retired_news_orphan_cluster_ids retired
         ON retired.event_cluster_id = alert.event_cluster_id`,
    );
    await queryRunner.query(
      `DELETE bot FROM bot_deliveries bot
       INNER JOIN alerts alert ON alert.id = bot.alert_id
       INNER JOIN retired_news_orphan_cluster_ids retired
         ON retired.event_cluster_id = alert.event_cluster_id`,
    );
    await queryRunner.query(
      `DELETE bot FROM bot_deliveries bot
       INNER JOIN alert_deliveries delivery ON delivery.id = bot.alert_delivery_id
       INNER JOIN alerts alert ON alert.id = delivery.alert_id
       INNER JOIN retired_news_orphan_cluster_ids retired
         ON retired.event_cluster_id = alert.event_cluster_id`,
    );
    await queryRunner.query(
      `DELETE review FROM reviews review
       INNER JOIN retired_news_orphan_cluster_ids retired
         ON review.subject_type = 'EVENT_CLUSTER'
         AND review.subject_id = retired.event_cluster_id`,
    );
    await queryRunner.query(
      `DELETE run FROM ai_runs run
       INNER JOIN retired_news_orphan_cluster_ids retired
         ON run.subject_type = 'EVENT_CLUSTER'
         AND run.subject_id = retired.event_cluster_id`,
    );
    await queryRunner.query(
      `DELETE alert FROM alerts alert
       INNER JOIN retired_news_orphan_cluster_ids retired
         ON retired.event_cluster_id = alert.event_cluster_id`,
    );
    await queryRunner.query(
      `DELETE cluster FROM event_clusters cluster
       INNER JOIN retired_news_orphan_cluster_ids retired
         ON retired.event_cluster_id = cluster.id
       WHERE NOT EXISTS (
         SELECT 1 FROM event_cluster_items remaining
         WHERE remaining.event_cluster_id = cluster.id
       )`,
    );
    await queryRunner.query(
      `DELETE review FROM reviews review
       INNER JOIN retired_news_source_ids retired
         ON (review.subject_type = 'SOURCE_ITEM' AND review.subject_id = retired.source_item_id)
         OR (review.subject_type = 'NEWS_ITEM' AND review.subject_id = retired.news_item_id)`,
    );
    await queryRunner.query(
      `DELETE run FROM ai_runs run
       INNER JOIN retired_news_source_ids retired
         ON (run.subject_type = 'SOURCE_ITEM' AND run.subject_id = retired.source_item_id)
         OR (run.subject_type = 'NEWS_ITEM' AND run.subject_id = retired.news_item_id)`,
    );
    await queryRunner.query(
      `DELETE news FROM news_items news
       INNER JOIN retired_news_source_ids retired ON retired.news_item_id = news.id`,
    );
    await queryRunner.query(
      `DELETE source FROM source_items source
       INNER JOIN retired_news_source_ids retired ON retired.source_item_id = source.id`,
    );
    await queryRunner.query(
      `DELETE article FROM news_articles article
       LEFT JOIN source_items source ON source.news_article_id = article.id
       WHERE source.id IS NULL`,
    );
    await queryRunner.query('DROP TEMPORARY TABLE retired_news_orphan_cluster_ids');
    await queryRunner.query('DROP TEMPORARY TABLE retired_news_event_cluster_ids');
    await queryRunner.query('DROP TEMPORARY TABLE retired_news_source_ids');

    // Clear exact HTTP validators for both retired feeds and approved content feeds. The latter
    // must return a full 200 response once so existing metadata rows receive their content row.
    const newsRssCheckpointUrls = [
      ...RETIRED_ETODAY_FEEDS.map(([, url]) => url),
      ...APPROVED_CONTENT_NEWS_RSS_FEEDS,
    ];
    const irCheckpointUrls = [MICROSOFT_NEWS_FEED, SAMSUNG_GLOBAL_FEED];
    const newsRssPlaceholders = newsRssCheckpointUrls.map(() => '?').join(', ');
    const irPlaceholders = irCheckpointUrls.map(() => '?').join(', ');
    await queryRunner.query(
      `DELETE FROM source_checkpoints
       WHERE connector IN ('NAVER', 'GDELT')
          OR (connector = 'NEWS_RSS' AND (
            JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.feedUrl')) IN (${newsRssPlaceholders})
            OR stream IN (${newsRssPlaceholders})
          ))
          OR (connector = 'IR' AND (
            JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.feedUrl')) IN (${irPlaceholders})
            OR stream IN (${irPlaceholders})
          ))`,
      [
        ...newsRssCheckpointUrls,
        ...newsRssCheckpointUrls.map(feedCheckpointStream),
        ...irCheckpointUrls,
        ...irCheckpointUrls.map(feedCheckpointStream),
      ],
    );
    await queryRunner.query('DELETE FROM ir_sources WHERE BINARY url = BINARY ?', [
      MICROSOFT_NEWS_FEED,
    ]);
  }

  async down(): Promise<void> {
    throw new Error(
      'This migration includes audited clock repair and rights-driven deletion; restore a verified backup instead.',
    );
  }
}
