import assert from 'node:assert/strict';
import test from 'node:test';
import { getMetadataArgsStorage, type QueryRunner } from 'typeorm';
import { CompanyEntity } from './entities';
import { AllowSharedCompanyCik1788398000000 } from './migrations/1788398000000-AllowSharedCompanyCik';

test('CIK is indexed per issuer without requiring a unique listed share class', async () => {
  const index = getMetadataArgsStorage().indices.find(
    (entry) => entry.target === CompanyEntity && entry.name === 'ix_companies_cik',
  );
  assert.deepEqual(index?.columns, ['cik']);
  assert.notEqual(index?.unique, true);
  assert.equal(
    getMetadataArgsStorage().indices.some(
      (entry) => entry.target === CompanyEntity && entry.name === 'ux_companies_cik',
    ),
    false,
  );
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
      return [];
    },
  } as unknown as QueryRunner;
  const migration = new AllowSharedCompanyCik1788398000000();
  await migration.up(runner);
  await migration.down(runner);
  assert.match(queries[0]!, /ADD INDEX ix_companies_cik \(cik\), DROP INDEX ux_companies_cik/u);
  assert.match(queries[1]!, /WHERE cik IS NOT NULL GROUP BY cik HAVING COUNT\(\*\) > 1/u);
  assert.match(
    queries[2]!,
    /ADD UNIQUE INDEX ux_companies_cik \(cik\), DROP INDEX ix_companies_cik/u,
  );
});

test('rollback refuses shared CIK mappings without deleting data or dropping an index', async () => {
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
      return [{ cik: '0001652044' }];
    },
  } as unknown as QueryRunner;
  await assert.rejects(
    new AllowSharedCompanyCik1788398000000().down(runner),
    /shared issuer mappings exist/u,
  );
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries.join('\n'), /ALTER|DELETE|UPDATE|DROP/u);
});
