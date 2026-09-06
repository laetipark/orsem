import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRunner } from 'typeorm';
import { AddManualNewsTranslations1788405000000 } from './migrations/1788405000000-AddManualNewsTranslations';

test('manual translation migration adds isolated nullable overrides and durable audit without modifying source or AI results', async () => {
  const queries: string[] = [];
  const runner = {
    hasColumn: async () => false,
    query: async (sql: string) => queries.push(sql),
  } as unknown as QueryRunner;
  await new AddManualNewsTranslations1788405000000().up(runner);
  assert.equal(queries.length, 3);
  assert.ok(
    queries.slice(0, 2).every((sql) => /ADD COLUMN manual_translation_json JSON NULL/u.test(sql)),
  );
  assert.match(queries[2]!, /CREATE TABLE IF NOT EXISTS news_translation_revisions/u);
  assert.match(queries[2]!, /UTC_TIMESTAMP\(3\)/u);
  assert.match(queries[2]!, /source_items\(id\) ON DELETE CASCADE/u);
  assert.match(queries[2]!, /admins\(id\) ON DELETE SET NULL/u);
  assert.ok(queries.every((sql) => !/^\s*(?:UPDATE|DELETE|DROP)/iu.test(sql)));
  const second: string[] = [];
  await new AddManualNewsTranslations1788405000000().up({
    hasColumn: async () => true,
    query: async (sql: string) => second.push(sql),
  } as unknown as QueryRunner);
  assert.equal(second.length, 1);
});
