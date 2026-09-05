import assert from 'node:assert/strict';
import test from 'node:test';
import { getMetadataArgsStorage, type QueryRunner } from 'typeorm';
import { NewsArticleContentEntity } from './entities';
import { AddNewsArticleContents1788403000000 } from './migrations/1788403000000-AddNewsArticleContents';

test('news article content is source-scoped and preserves structured original and translation data', () => {
  const storage = getMetadataArgsStorage();
  const properties = new Set(
    storage.columns
      .filter((column) => column.target === NewsArticleContentEntity)
      .map((column) => column.propertyName),
  );
  for (const property of [
    'sourceItemId',
    'status',
    'language',
    'blocksJson',
    'contentHash',
    'extractorVersion',
    'fetchedAt',
    'attemptedAt',
    'attempts',
    'nextAttemptAt',
    'failureCode',
    'rightsPolicyJson',
    'translationJson',
  ]) {
    assert.equal(properties.has(property), true, `missing content property ${property}`);
  }
  const identity = storage.uniques.find(
    (unique) =>
      unique.target === NewsArticleContentEntity &&
      unique.name === 'ux_news_article_content_source',
  );
  assert.deepEqual(identity?.columns, ['sourceItemId']);
  const retry = storage.indices.find(
    (index) =>
      index.target === NewsArticleContentEntity &&
      index.name === 'ix_news_article_contents_status_retry',
  );
  assert.deepEqual(retry?.columns, ['status', 'nextAttemptAt']);
});

test('content migration creates storage, audits Samsung correction, and retires disallowed news', async () => {
  const calls: Array<{ sql: string; parameters?: unknown[] }> = [];
  const runner = {
    query: async (sql: string, parameters?: unknown[]) => {
      calls.push({ sql, parameters });
    },
  } as unknown as QueryRunner;
  const migration = new AddNewsArticleContents1788403000000();
  await migration.up(runner);

  const sql = calls.map((call) => call.sql);
  const contentTable = sql.find((query) =>
    query.includes('CREATE TABLE IF NOT EXISTS news_article_contents'),
  );
  assert.ok(contentTable);
  assert.match(contentTable, /blocks_json JSON NULL/u);
  assert.match(contentTable, /translation_json JSON NULL/u);
  assert.match(contentTable, /rights_policy_json JSON NOT NULL/u);
  assert.match(contentTable, /ON DELETE CASCADE/u);

  const auditTable = sql.find((query) =>
    query.includes('CREATE TABLE IF NOT EXISTS news_time_correction_audit'),
  );
  assert.ok(auditTable);
  assert.match(auditTable, /previous_source_published_at/u);
  assert.match(auditTable, /corrected_article_sort_at/u);
  const auditInsert = calls.find((call) =>
    call.sql.includes('INSERT INTO news_time_correction_audit'),
  );
  assert.ok(auditInsert);
  assert.deepEqual(auditInsert.parameters, [
    'SAMSUNG_GLOBAL_RSS_KST_V1',
    'https://news.samsung.com/global/feed',
    'https://news.samsung.com/global/feed',
    'https://news.samsung.com/global/feed',
    'SAMSUNG_GLOBAL_RSS_KST_V1',
  ]);
  assert.match(auditInsert.sql, /DATE_SUB\(source\.published_at, INTERVAL 9 HOUR\)/u);
  assert.match(auditInsert.sql, /NOT EXISTS/u);
  assert.match(auditInsert.sql, /existing\.source_item_id = source\.id/u);

  const sourceCorrection = sql.find((query) => query.includes('UPDATE source_items source'));
  const newsCorrection = sql.find((query) => query.includes('UPDATE news_items news'));
  const articleCorrection = sql.find((query) => query.includes('UPDATE news_articles article'));
  assert.ok(sourceCorrection);
  assert.ok(newsCorrection);
  assert.ok(articleCorrection);
  assert.doesNotMatch(sourceCorrection, /first_observed_at/u);
  assert.doesNotMatch(sourceCorrection, /DATE_SUB/u);
  assert.doesNotMatch(newsCorrection, /first_observed_at|DATE_SUB/u);
  assert.doesNotMatch(articleCorrection, /first_observed_at|DATE_SUB/u);
  assert.match(newsCorrection, /corrected_news_published_at/u);
  assert.match(articleCorrection, /corrected_article_sort_at/u);
  const samsungRights = calls.find((call) => call.sql.includes('UPDATE ir_sources'));
  assert.ok(samsungRights);
  assert.deepEqual(samsungRights.parameters, [
    'PRIVATE_DISPLAY_ONLY',
    'https://news.samsung.com/global/feed',
    'PRIVATE_DISPLAY_ONLY',
  ]);

  const retirement = calls.find((call) =>
    call.sql.includes('INSERT IGNORE INTO retired_news_source_ids'),
  );
  assert.ok(retirement);
  assert.match(retirement.sql, /source\.source IN \('NAVER', 'GDELT'\)/u);
  assert.doesNotMatch(retirement.sql, /SEC|OPENDART/u);
  assert.deepEqual(retirement.parameters, [
    'etoday-market',
    'etoday-finance',
    'etoday-industry',
    'etoday-economy',
    'https://microsoft.gcs-web.com/rss/news-releases.xml',
  ]);
  assert.ok(sql.some((query) => query.startsWith('DELETE news FROM news_items')));
  assert.ok(sql.some((query) => query.startsWith('DELETE source FROM source_items')));
  assert.ok(sql.some((query) => query.startsWith('DELETE article FROM news_articles')));
  assert.ok(sql.some((query) => query.startsWith('DELETE item FROM event_cluster_items')));
  assert.ok(sql.some((query) => query.startsWith('DELETE review FROM reviews')));
  assert.ok(sql.some((query) => query.startsWith('DELETE run FROM ai_runs')));
  const affectedClusters = sql.find((query) =>
    query.includes('INSERT IGNORE INTO retired_news_event_cluster_ids'),
  );
  assert.ok(affectedClusters);
  const orphanClusters = sql.find((query) =>
    query.includes('INSERT IGNORE INTO retired_news_orphan_cluster_ids'),
  );
  assert.ok(orphanClusters);
  assert.match(orphanClusters, /retired_survivor\.source_item_id IS NULL/u);
  assert.match(orphanClusters, /LEFT JOIN retired_news_source_ids/u);
  const membershipDeleteIndex = sql.findIndex((query) =>
    query.startsWith('DELETE item FROM event_cluster_items'),
  );
  const clusterDeleteIndex = sql.findIndex((query) =>
    query.startsWith('DELETE cluster FROM event_clusters'),
  );
  assert.ok(membershipDeleteIndex >= 0);
  assert.ok(clusterDeleteIndex > membershipDeleteIndex);
  assert.match(sql[clusterDeleteIndex]!, /NOT EXISTS/u);
  assert.ok(sql.some((query) => query.startsWith('DELETE alert FROM alerts')));
  assert.ok(sql.some((query) => query.startsWith('DELETE push FROM push_deliveries')));
  assert.ok(sql.some((query) => query.startsWith('DELETE bot FROM bot_deliveries')));
  for (const table of [
    'retired_news_source_ids',
    'retired_news_event_cluster_ids',
    'retired_news_orphan_cluster_ids',
  ]) {
    const create = sql.find((query) => query.includes(`CREATE TEMPORARY TABLE ${table}`));
    assert.ok(create);
    assert.match(create, /DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/u);
  }
  const checkpointReset = calls.find((call) =>
    call.sql.startsWith('DELETE FROM source_checkpoints'),
  );
  assert.ok(checkpointReset);
  for (const url of [
    'https://news.samsung.com/global/feed',
    'https://www.federalreserve.gov/feeds/press_all.xml',
    'https://www.federalreserve.gov/feeds/speeches_and_testimony.xml',
    'https://www.bls.gov/feed/bls_latest.rss',
  ]) {
    assert.equal(
      checkpointReset.parameters?.includes(url),
      true,
      `checkpoint not reset for ${url}`,
    );
  }
  assert.ok(
    calls.some(
      (call) =>
        call.sql.startsWith('DELETE FROM ir_sources') &&
        call.parameters?.[0] === 'https://microsoft.gcs-web.com/rss/news-releases.xml',
    ),
  );

  await assert.rejects(migration.down(), /rights-driven deletion/u);
});
