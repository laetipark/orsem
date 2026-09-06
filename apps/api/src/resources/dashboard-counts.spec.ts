import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardViewSchema } from '@orsem/contracts';
import { ENTITIES, FilingEntity } from '@orsem/database';
import { DataSource } from 'typeorm';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { OrsemDataService } from './orsem-data.service';

type CountsReader = {
  dashboardCounts(asOf: string): Promise<{
    counts: {
      filingsToday: number;
      d001Today: number;
      d002Today: number;
      d003Today: number;
      d004Today: number;
      d005Today: number;
    };
    totalCounts: Record<string, number>;
  }>;
};

test('disclosure counts aggregate all five types once, using canonical type and KST receipt dates', async () => {
  const metadata = new DataSource({
    type: 'mysql',
    database: 'test',
    entities: [...ENTITIES],
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const captured: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const filings = [
    { source: 'OPENDART', canonicalType: 'D001', detailType: 'D001', rceptDate: '2026-09-04' },
    { source: 'OPENDART', canonicalType: 'D002', detailType: 'D001', rceptDate: '2026-09-05' },
    { source: 'OPENDART', canonicalType: 'D003', detailType: 'D003', rceptDate: '2026-09-05' },
    { source: 'OPENDART', canonicalType: 'D004', detailType: 'D004', rceptDate: '2026-09-05' },
    { source: 'OPENDART', canonicalType: null, detailType: 'D005', rceptDate: '2026-09-05' },
    { source: 'OPENDART', canonicalType: null, detailType: 'D005', rceptDate: '2026-09-03' },
    { source: 'OPENDART', canonicalType: 'D099', detailType: 'D001', rceptDate: '2026-09-05' },
    { source: 'SEC', canonicalType: 'D001', detailType: 'D001', rceptDate: '2026-09-05' },
  ];
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    {
      dataSource: {
        getRepository(entity: unknown) {
          return {
            count: async () => 0,
            countBy: async () => 0,
            createQueryBuilder(alias: string) {
              assert.equal(entity, FilingEntity);
              const qb = metadata.getRepository(FilingEntity).createQueryBuilder(alias);
              qb.getRawMany = async <T>() => {
                const params = qb.getParameters();
                captured.push({ sql: qb.getQuery(), params });
                const groups = new Map<
                  string,
                  { detailType: string; countTotal: number; countToday: number }
                >();
                for (const row of filings) {
                  const type = row.canonicalType ?? row.detailType;
                  if (
                    row.source !== params.source ||
                    !(params.supportedTypes as string[]).includes(type)
                  )
                    continue;
                  const group = groups.get(type) ?? {
                    detailType: type,
                    countTotal: 0,
                    countToday: 0,
                  };
                  group.countTotal += 1;
                  group.countToday += Number(row.rceptDate === params.today);
                  groups.set(type, group);
                }
                return [...groups.values()].map((group) => ({
                  ...group,
                  countTotal: String(group.countTotal),
                  countToday: String(group.countToday),
                })) as T[];
              };
              return qb;
            },
          };
        },
      },
    } as unknown as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
  const reader = service as unknown as CountsReader;
  const beforeMidnight = await reader.dashboardCounts('2026-09-04T14:59:59.999Z');
  const afterMidnight = await reader.dashboardCounts('2026-09-04T15:00:00.000Z');
  const weekend = await reader.dashboardCounts('2026-09-05T15:00:00.000Z');
  assert.equal(captured.length, 3, 'one filing aggregate query per request');
  assert.equal(captured[0]!.params.today, '2026-09-04');
  assert.equal(captured[1]!.params.today, '2026-09-05');
  assert.equal(beforeMidnight.counts.filingsToday, 1);
  assert.deepEqual(afterMidnight.counts, {
    filingsToday: 4,
    d001Today: 0,
    d002Today: 1,
    d003Today: 1,
    d004Today: 1,
    d005Today: 1,
    reviewRequired: 0,
    failedJobs: 0,
    watchedCompanies: 0,
  });
  assert.deepEqual(afterMidnight.totalCounts, { D001: 1, D002: 1, D003: 1, D004: 1, D005: 2 });
  assert.equal(weekend.counts.filingsToday, 0);
  assert.deepEqual(weekend.totalCounts, afterMidnight.totalCounts);
  for (const { sql } of captured) {
    assert.match(sql, /GROUP BY COALESCE\(`filing`\.`canonical_type`, `filing`\.`detail_type`\)/u);
    assert.match(sql, /SUM\(CASE WHEN `filing`\.`rcept_date` = :today/u);
    assert.match(sql, /`filing`\.`source` = :source/u);
    assert.doesNotMatch(sql, /first_observed_at/u);
  }
});

test('fixture dashboard counts use receipt dates and the added totalCounts contract remains optional', async () => {
  const fixtures = new FixtureStoreService();
  const base = fixtures.filings[0]!;
  fixtures.filings.splice(
    0,
    fixtures.filings.length,
    { ...base, id: 'today', detailType: 'D001', rceptDate: '2026-09-05' },
    {
      ...base,
      id: 'backfill',
      detailType: 'D002',
      rceptDate: '2026-09-04',
      firstObservedAt: '2026-09-05T00:00:00Z',
    },
  );
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {} as DatabaseRuntimeService,
    fixtures,
  );
  const result = await (service as unknown as CountsReader).dashboardCounts('2026-09-05T00:00:00Z');
  assert.equal(result.counts.filingsToday, 1);
  assert.equal(result.counts.d002Today, 0);
  assert.deepEqual(result.totalCounts, { D001: 1, D002: 1, D003: 0, D004: 0, D005: 0 });
  const totals = dashboardViewSchema.shape.totalCounts;
  assert.equal(totals.safeParse(undefined).success, true);
  assert.deepEqual(totals.parse(result.totalCounts), result.totalCounts);
  assert.equal(totals.safeParse({ ...result.totalCounts, D003: -1 }).success, false);
  assert.equal(totals.safeParse({ ...result.totalCounts, D004: '4' }).success, false);
});
