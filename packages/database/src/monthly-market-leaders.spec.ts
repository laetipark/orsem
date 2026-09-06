import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource, type QueryRunner } from 'typeorm';
import { MarketLeaderScopeEntity, WatchlistItemEntity } from './entities';
import { marketLeaderCompanyIds, MARKET_LEADER_COMPANIES_SQL } from './market-leader-scope';
import { UseMonthlyMarketLeaders1788412000000 } from './migrations/1788412000000-UseMonthlyMarketLeaders';

test('collection and alert repositories read monthly leaders, never legacy manual rows', async () => {
  const source = new DataSource({
    type: 'mysql',
    database: 'test',
    entities: [WatchlistItemEntity, MarketLeaderScopeEntity],
    synchronize: false,
  });
  await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const metadata = source.getMetadata(WatchlistItemEntity);
  assert.equal(metadata.tableName, 'market_leader_watchlist');
  assert.equal(metadata.synchronize, false);
  const query = source
    .getRepository(WatchlistItemEntity)
    .createQueryBuilder('watch')
    .where('watch.companyId = :id', { id: 'company' });
  const [sql, values] = query.getQueryAndParameters();
  assert.match(sql, /FROM `market_leader_watchlist`/u);
  assert.doesNotMatch(sql, /watchlist_items/u);
  assert.deepEqual(values, ['company']);
  assert.equal(
    source.getMetadata(MarketLeaderScopeEntity).tableName,
    'market_leader_company_links',
  );
  assert.equal(source.getMetadata(MarketLeaderScopeEntity).synchronize, false);
  assert.match(
    source.getRepository(MarketLeaderScopeEntity).createQueryBuilder('scope').getSql(),
    /FROM `market_leader_company_links`/u,
  );
});

test('the repeatable migration only creates a complete-snapshot projection and preserves historical tables', async () => {
  const statements: string[] = [];
  const runner = {
    query: async (sql: string) => {
      statements.push(sql);
    },
  } as unknown as QueryRunner;
  const migration = new UseMonthlyMarketLeaders1788412000000();
  await migration.up(runner);
  await migration.up(runner);
  assert.equal(statements[0], statements[2]);
  assert.equal(statements[1], statements[3]);
  assert.match(
    statements[0]!,
    /CREATE OR REPLACE SQL SECURITY INVOKER VIEW market_leader_watchlist/u,
  );
  assert.match(statements[0]!, /st\.active_snapshot_id=m\.snapshot_id/u);
  assert.match(statements[0]!, /BETWEEN 1 AND 20\)=20/u);
  assert.match(statements[0]!, /GROUP BY m\.company_id/u);
  assert.match(statements[1]!, /SQL SECURITY INVOKER VIEW market_leader_company_links/u);
  assert.match(statements[1]!, /JSON_EXTRACT\(s\.raw_json,'\$\.leaders'\)/u);
  assert.match(statements[1]!, /company_id VARCHAR\(128\) PATH '\$\.companyId'/u);
  assert.match(statements[1]!, /BINARY c\.ticker=BINARY component\.symbol/u);
  assert.match(statements[1]!, /SELECT c\.id AS company_id, m\.company_id/u);
  assert.match(statements[1]!, /BINARY component\.company_id<>BINARY m\.company_id/u);
  assert.match(statements[1]!, /BINARY primary_member\.company_id=BINARY component\.company_id/u);
  assert.match(statements[1]!, /HAVING COUNT\(DISTINCT coverage\.representative_company_id\)=1/u);
  assert.doesNotMatch(statements.join('\n'), /DELETE|TRUNCATE|UPDATE|DROP|INSERT/u);
  await migration.down(runner);
  assert.equal(statements[4], 'DROP VIEW IF EXISTS market_leader_company_links');
  assert.equal(statements[5], 'DROP VIEW IF EXISTS market_leader_watchlist');
});

test('shared company scope binds region and returns actual class IDs without replacing them', async () => {
  const queries: unknown[] = [];
  const source = {
    query: async (sql: string, values: unknown[]) => {
      queries.push([sql, values]);
      return [{ companyId: 'representative' }, { companyId: 'other-class' }];
    },
  } as Pick<DataSource, 'query'>;
  assert.deepEqual(
    [...(await marketLeaderCompanyIds(source, 'us'))],
    ['representative', 'other-class'],
  );
  assert.deepEqual(queries, [[`${MARKET_LEADER_COMPANIES_SQL} WHERE region=?`, ['us']]]);
});
