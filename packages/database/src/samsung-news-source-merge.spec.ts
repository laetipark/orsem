import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRunner } from 'typeorm';
import { MergeSamsungNewsSources1788404000000 } from './migrations/1788404000000-MergeSamsungNewsSources';

test('Samsung source merge keeps the approved row and rekeys polymorphic references', async () => {
  const calls: Array<{ sql: string; parameters?: unknown[] }> = [];
  let countQuery = 0;
  const runner = {
    query: async (sql: string, parameters?: unknown[]) => {
      calls.push({ sql, parameters });
      if (sql.includes('SELECT grouped.url')) return [];
      if (sql.includes('SELECT COUNT(*) AS count')) {
        countQuery += 1;
        return [{ count: 0 }];
      }
      return [];
    },
  } as unknown as QueryRunner;

  const migration = new MergeSamsungNewsSources1788404000000();
  await migration.up(runner);
  const sql = calls.map((call) => call.sql);

  const audit = sql.find((query) =>
    query.includes('CREATE TABLE IF NOT EXISTS samsung_news_source_merge_audit'),
  );
  assert.ok(audit);
  assert.match(audit, /UNIQUE KEY ux_samsung_source_merge_loser/u);
  const rekeyAudit = sql.find((query) =>
    query.includes('CREATE TABLE IF NOT EXISTS samsung_news_source_rekey_audit'),
  );
  assert.ok(rekeyAudit);
  assert.match(rekeyAudit, /previous_external_id VARCHAR\(255\) NULL/u);

  const mapping = calls.find((call) =>
    call.sql.includes('INSERT INTO samsung_news_source_merge_audit'),
  );
  assert.ok(mapping);
  assert.deepEqual(mapping.parameters, [
    'SAMSUNG_GLOBAL_CANONICAL_SOURCE_V1',
    'https://news.samsung.com/global/feed',
    'https://news.samsung.com/global/feed',
    'SAMSUNG_GLOBAL_CANONICAL_SOURCE_V1',
  ]);
  assert.match(mapping.sql, /keeper_content\.status = 'AVAILABLE'/u);
  assert.match(mapping.sql, /SHA2\(CONCAT\('https:\/\/news\.samsung\.com\/global\/feed'/u);
  assert.match(mapping.sql, /loser\.news_article_id = keeper\.news_article_id/u);
  assert.match(mapping.sql, /LEAST\(keeper\.first_observed_at, loser\.first_observed_at\)/u);
  assert.doesNotMatch(mapping.sql, /SEC|OPENDART/u);

  const rekeyMapping = calls.find((call) =>
    call.sql.includes('INSERT INTO samsung_news_source_rekey_audit'),
  );
  assert.ok(rekeyMapping);
  assert.deepEqual(rekeyMapping.parameters, [
    'SAMSUNG_GLOBAL_EXTERNAL_ID_V1',
    'SAMSUNG_GLOBAL_CANONICAL_SOURCE_V1',
    'https://news.samsung.com/global/feed',
    'SAMSUNG_GLOBAL_EXTERNAL_ID_V1',
  ]);
  assert.match(rekeyMapping.sql, /merge_loser\.id IS NULL/u);
  assert.match(rekeyMapping.sql, /article\.canonical_url/u);
  assert.ok(sql.some((query) => query.startsWith('UPDATE source_items source')));

  const observation = sql.find((query) => query.startsWith('UPDATE source_items keeper'));
  assert.ok(observation);
  assert.match(observation, /MIN\(merged_first_observed_at\)/u);
  assert.match(observation, /keeper\.first_observed_at = LEAST/u);
  assert.doesNotMatch(observation, /published_at|raw_metadata_json|source_policy_json/u);

  const membershipInserts = sql.filter((query) =>
    query.startsWith('INSERT IGNORE INTO event_cluster_items'),
  );
  const membershipDeletes = sql.filter((query) =>
    query.startsWith('DELETE losing FROM event_cluster_items'),
  );
  assert.equal(membershipInserts.length, 2);
  assert.equal(membershipDeletes.length, 2);
  assert.ok(calls.some((call) => call.parameters?.[1] === 'SOURCE_ITEM'));
  assert.ok(calls.some((call) => call.parameters?.[1] === 'NEWS_ITEM'));
  assert.equal(
    sql.some((query) => /DELETE .*event_clusters/u.test(query)),
    false,
  );
  assert.equal(
    sql.some((query) => /DELETE .*alerts|DELETE .*deliveries/u.test(query)),
    false,
  );

  const reviews = sql.filter((query) => query.startsWith('UPDATE reviews review'));
  const aiRuns = sql.filter((query) => query.startsWith('UPDATE ai_runs run'));
  const loserAiPreflights = sql.filter(
    (query) => query.includes('FROM ai_runs losing') && query.includes('HAVING COUNT(*) > 1'),
  );
  const eventConflictPreflights = sql.filter(
    (query) => query.includes('FROM event_cluster_items losing') && query.includes('AS count'),
  );
  const reviewConflictPreflights = sql.filter(
    (query) => query.includes('FROM reviews losing') && query.includes('AS count'),
  );
  assert.equal(reviews.length, 2);
  assert.equal(aiRuns.length, 2);
  assert.equal(loserAiPreflights.length, 2);
  assert.equal(eventConflictPreflights.length, 4);
  assert.equal(reviewConflictPreflights.length, 4);
  assert.ok(reviews.every((query) => !query.includes('review.dedupe_key =')));

  const deleteNews = sql.find((query) => query.startsWith('DELETE news FROM news_items'));
  const deleteSource = sql.find((query) => query.startsWith('DELETE source FROM source_items'));
  const rekeySources = sql.find((query) => query.startsWith('UPDATE source_items source'));
  assert.ok(deleteNews);
  assert.ok(deleteSource);
  assert.ok(rekeySources);
  assert.ok(sql.indexOf(deleteNews) < sql.indexOf(deleteSource));
  assert.ok(sql.indexOf(deleteSource) < sql.indexOf(rekeySources));
  assert.equal(countQuery, 19);

  await assert.rejects(migration.down(), /restore a verified backup/u);
});

test('Samsung source merge refuses an ambiguous duplicate group before writing mappings', async () => {
  const calls: string[] = [];
  const runner = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT grouped.url')) {
        return [
          {
            url: 'https://news.samsung.com/global/example',
            duplicate_count: 2,
            article_count: 2,
            canonical_count: 0,
            keeper_count: 0,
          },
        ];
      }
      return [];
    },
  } as unknown as QueryRunner;

  await assert.rejects(
    new MergeSamsungNewsSources1788404000000().up(runner),
    /Unsafe Samsung source merge groups/u,
  );
  assert.equal(
    calls.some((sql) => sql.includes('INSERT INTO samsung_news_source_merge_audit')),
    false,
  );
});

test('Samsung source merge refuses to orphan a loser news item when its keeper has none', async () => {
  const calls: string[] = [];
  const runner = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT grouped.url')) return [];
      if (sql.includes('loser_news_item_id IS NOT NULL')) return [{ count: 1 }];
      return [];
    },
  } as unknown as QueryRunner;

  await assert.rejects(
    new MergeSamsungNewsSources1788404000000().up(runner),
    /cannot preserve a news item without a keeper row/u,
  );
  assert.equal(
    calls.some((sql) => sql.startsWith('UPDATE source_items keeper')),
    false,
  );
});

test('Samsung source merge refuses a singleton rekey identity collision before mutations', async () => {
  const calls: string[] = [];
  const runner = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT grouped.url')) return [];
      if (sql.includes('FROM samsung_news_source_rekey_audit rekey')) return [{ count: 1 }];
      if (sql.includes('SELECT COUNT(*) AS count')) return [{ count: 0 }];
      return [];
    },
  } as unknown as QueryRunner;

  await assert.rejects(
    new MergeSamsungNewsSources1788404000000().up(runner),
    /would violate the external identity constraint/u,
  );
  assert.equal(
    calls.some(
      (sql) =>
        sql.startsWith('UPDATE source_items keeper') ||
        sql.startsWith('DELETE source FROM source_items'),
    ),
    false,
  );
});

test('Samsung source merge refuses AI identity collisions between two mapped losers', async () => {
  const calls: string[] = [];
  const runner = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT grouped.url')) return [];
      if (sql.includes('FROM ai_runs losing') && sql.includes('HAVING COUNT(*) > 1'))
        return [{ count: 1 }];
      if (sql.includes('SELECT COUNT(*) AS count')) return [{ count: 0 }];
      return [];
    },
  } as unknown as QueryRunner;

  await assert.rejects(
    new MergeSamsungNewsSources1788404000000().up(runner),
    /would collapse distinct AI audit rows/u,
  );
  assert.equal(
    calls.some((sql) => sql.startsWith('UPDATE source_items keeper')),
    false,
  );
});
