import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRunner } from 'typeorm';
import { createTypeOrmOptions } from './data-source';
import { UseNewsMetadataOnly1788411000000 } from './migrations/1788411000000-UseNewsMetadataOnly';

async function migrationQueries(): Promise<string[]> {
  const queries: string[] = [];
  await new UseNewsMetadataOnly1788411000000().up({
    query: async (sql: string) => {
      queries.push(sql);
      return { affectedRows: 0 };
    },
  } as unknown as QueryRunner);
  return queries;
}

test('metadata-only migration is registered and repeats without schema creation or body restoration', async () => {
  const options = createTypeOrmOptions('mysql://orsem:test@localhost/orsem');
  assert.equal(options.synchronize, false);
  assert.ok(Array.isArray(options.migrations));
  assert.ok(options.migrations.includes(UseNewsMetadataOnly1788411000000));
  const first = await migrationQueries();
  assert.equal(first.length, 4);
  assert.deepEqual(await migrationQueries(), first);
  for (const sql of first) {
    assert.match(
      sql,
      /WHERE source(?:\.source)? IN \('IR', 'NEWS_RSS', 'GDELT', 'ALPACA_NEWS', 'NAVER'\)/u,
    );
    assert.doesNotMatch(sql, /\b(?:DROP|DELETE|INSERT|ALTER)\b|filings|opendart|\bSEC\b|backup/iu);
    // Audit instants, original hashes, rights, relations and the original metadata survive.
    assert.doesNotMatch(
      sql,
      /(?:created_at|updated_at|published_at|first_observed_at|fetched_at|attempted_at|content_hash|source_hash|raw_hash|rights_policy_json|source_policy_json|raw_metadata_json)\s*=/u,
    );
  }
  await assert.rejects(new UseNewsMetadataOnly1788411000000().down(), /backups remain unchanged/u);
});

test('body JSON is entirely removed including partial translation checkpoints and manual body copies', async () => {
  const [body, source, current, previous] = await migrationQueries();
  assert.match(body!, /content\.blocks_json = NULL/u);
  assert.match(body!, /content\.translation_json = NULL/u);
  assert.match(body!, /content\.manual_translation_json = NULL/u);
  assert.match(body!, /content\.status = 'PURGED'/u);
  assert.match(body!, /content\.next_attempt_at = NULL/u);
  assert.match(current!, /JSON_REMOVE\(revision\.manual_json, '\$\.content'/u);
  assert.match(previous!, /JSON_REMOVE\(revision\.previous_manual_json, '\$\.content'/u);
  assert.doesNotMatch(source!, /(?:^|[^a-z_])translation_json\s*=/u);
});

test('manual title, summary and identity use an in-place metadata v2 conversion with no body hash gate', async () => {
  const [, source, ...revisions] = await migrationQueries();
  assert.match(source!, /JSON_REMOVE\(manual_translation_json, '\$\.contentHash'/u);
  assert.match(source!, /'\$\.version', 2/u);
  for (const sql of revisions) {
    assert.match(sql, /'\$\.metadata\.contentHash'/u);
    assert.match(sql, /'\$\.metadata\.version', 2/u);
  }
  // Removing only obsolete fields keeps arbitrary revision identities/audit fields and
  // valid title/description values instead of rebuilding a lossy replacement object.
  for (const sql of [source!, ...revisions]) {
    assert.doesNotMatch(
      sql,
      /JSON_OBJECT|\$\.(?:metadata\.)?(?:title|description|revisionId|sourceHash|editedAt|editedByAdminId)'/u,
    );
    assert.match(sql, /JSON_CONTAINS_PATH/u);
    assert.match(sql, /NOT \(JSON_EXTRACT/u);
  }
});
