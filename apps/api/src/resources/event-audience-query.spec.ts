import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { NAVER_NEWS_METADATA_POLICY, type NewsAudience } from '@orsem/contracts';
import { newsAudienceSql } from './news-access';
import { eventAudienceSql } from './news-query';

const legacyEventAudienceSql = (audience: NewsAudience) => `NOT EXISTS (
  SELECT 1 FROM event_cluster_items audience_item
  LEFT JOIN news_items audience_news ON audience_item.item_type='NEWS_ITEM' AND audience_news.id=audience_item.item_id
  JOIN source_items audience_source ON (audience_item.item_type='SOURCE_ITEM' AND audience_source.id=audience_item.item_id)
    OR audience_source.id=audience_news.source_item_id
  WHERE audience_item.event_cluster_id=event.id
    AND COALESCE((${newsAudienceSql('audience_source', audience)}), false) = false)`;

test('indexed event audience joins preserve source, news, mixed and missing-link visibility for every audience', () => {
  // Execute both SQL predicates over disposable in-memory rows. The JSON helpers
  // implement the scalar/array operations used here; no application DB is opened.
  const db = new DatabaseSync(':memory:');
  const json = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);
  db.function('JSON_EXTRACT', (input, path) => {
    if (input == null) return null;
    const parsed = json(input);
    if (parsed == null) return null;
    const value = (parsed as Record<string, unknown>)[String(path).slice(2)];
    if (value == null) return null;
    if (typeof value === 'boolean') return Number(value);
    if (typeof value === 'number') return value;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
  db.function('JSON_UNQUOTE', (value) => value);
  db.function('JSON_CONTAINS', (input, candidate) => {
    if (input == null || candidate == null) return null;
    const values = json(input);
    return Number(Array.isArray(values) && values.includes(json(candidate)));
  });
  try {
    db.exec(`CREATE TABLE event_clusters (id TEXT PRIMARY KEY);
      CREATE TABLE source_items (id TEXT PRIMARY KEY, source TEXT, source_policy_json TEXT, raw_metadata_json TEXT);
      CREATE TABLE news_items (id TEXT PRIMARY KEY, source_item_id TEXT);
      CREATE TABLE event_cluster_items (event_cluster_id TEXT, item_type TEXT, item_id TEXT);`);
    const source = db.prepare('INSERT INTO source_items VALUES (?,?,?,?)');
    const cases = [
      { id: 'official', source: 'SEC', policy: null, metadata: null },
      { id: 'legacy-public', source: 'IR', policy: { policyVersion: 1 }, metadata: null },
      { id: 'private', source: 'FINNHUB', policy: null, metadata: null },
      {
        id: 'private-profile',
        source: 'NEWS_RSS',
        policy: null,
        metadata: { feedId: 'hankyung-finance-rss' },
      },
      { id: 'approved', source: 'NAVER', policy: NAVER_NEWS_METADATA_POLICY, metadata: null },
      {
        id: 'forged',
        source: 'NAVER',
        policy: { ...NAVER_NEWS_METADATA_POLICY, policyId: 'unregistered' },
        metadata: null,
      },
      {
        id: 'missing-display',
        source: 'NAVER',
        policy: { ...NAVER_NEWS_METADATA_POLICY, displayAllowed: null },
        metadata: null,
      },
      {
        id: 'missing-audience',
        source: 'NAVER',
        policy: { ...NAVER_NEWS_METADATA_POLICY, allowedAudiences: null },
        metadata: null,
      },
    ];
    for (const item of cases) {
      source.run(item.id, item.source, JSON.stringify(item.policy), JSON.stringify(item.metadata));
      db.prepare('INSERT INTO news_items VALUES (?,?)').run(`news-${item.id}`, item.id);
    }
    const event = (id: string, members: Array<[string, string]>) => {
      db.prepare('INSERT INTO event_clusters VALUES (?)').run(id);
      for (const [kind, itemId] of members)
        db.prepare('INSERT INTO event_cluster_items VALUES (?,?,?)').run(id, kind, itemId);
    };
    event('empty', []);
    event('filing-only', [['FILING', 'private']]);
    event('missing-source', [['SOURCE_ITEM', 'missing']]);
    event('missing-news', [['NEWS_ITEM', 'missing']]);
    db.prepare('INSERT INTO news_items VALUES (?,?)').run('orphan', 'missing');
    event('orphan-news', [['NEWS_ITEM', 'orphan']]);
    for (const item of cases) {
      event(`direct-${item.id}`, [['SOURCE_ITEM', item.id]]);
      event(`news-${item.id}`, [['NEWS_ITEM', `news-${item.id}`]]);
      for (const other of cases) {
        event(`mixed-${item.id}-${other.id}`, [
          ['SOURCE_ITEM', item.id],
          ['NEWS_ITEM', `news-${other.id}`],
        ]);
      }
    }
    // IDs can collide across tables: membership type still chooses exactly one path.
    db.prepare('INSERT INTO news_items VALUES (?,?)').run('private', 'official');
    event('collision-source-denied', [['SOURCE_ITEM', 'private']]);
    event('collision-news-allowed', [['NEWS_ITEM', 'private']]);
    for (const audience of ['ADMIN_UI', 'MEMBER_UI', 'BOT', 'SHARED_ROOM'] as const) {
      const run = (predicate: string) =>
        db
          .prepare(`SELECT event.id FROM event_clusters event WHERE ${predicate} ORDER BY event.id`)
          .all()
          .map((row) => row.id);
      const actual = run(eventAudienceSql('event', audience));
      assert.deepEqual(actual, run(legacyEventAudienceSql(audience)), audience);
      assert.ok(actual.includes('direct-official'));
      assert.ok(actual.includes('news-official'));
      assert.ok(actual.includes('collision-news-allowed'));
      assert.ok(actual.includes('orphan-news'));
      for (const id of [
        'direct-private',
        'news-private',
        'mixed-official-private',
        'mixed-private-official',
        'collision-source-denied',
        'direct-forged',
        'news-missing-display',
        'direct-missing-audience',
      ])
        assert.ok(!actual.includes(id), `${audience}: ${id}`);
      assert.equal(
        actual.includes('direct-approved'),
        ['ADMIN_UI', 'MEMBER_UI'].includes(audience),
      );
      assert.equal(actual.includes('news-approved'), ['ADMIN_UI', 'MEMBER_UI'].includes(audience));
    }
  } finally {
    db.close();
  }
});

test('event audience predicates keep both source routes indexable and reject alias injection', () => {
  const sql = eventAudienceSql('event', 'MEMBER_UI');
  assert.equal((sql.match(/NOT EXISTS/g) ?? []).length, 2);
  assert.match(sql, /audience_source\.id=audience_item\.item_id/);
  assert.match(sql, /audience_source\.id=audience_news\.source_item_id/);
  assert.doesNotMatch(sql, /JOIN source_items[^\n]+\n\s*OR/);
  assert.throws(() => eventAudienceSql('event; DROP TABLE'), /Invalid event identifier/);
});
