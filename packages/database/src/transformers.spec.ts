import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource, getMetadataArgsStorage, type QueryRunner } from 'typeorm';
import {
  AlpacaAssetEntity,
  AiRunEntity,
  BotDeliveryEntity,
  CompanyEntity,
  InsiderTransactionEntity,
  MemberEntity,
  PriceBarEntity,
} from './entities';
import * as dataSourceModule from './data-source';
import { createTypeOrmOptions, resolveDatabaseUrl } from './data-source';
import { InitialSchema1788390000000 } from './migrations/1788390000000-InitialSchema';
import { AddAiRunIdentityUnique1788391000000 } from './migrations/1788391000000-AddAiRunIdentityUnique';
import { AddAlpacaAssetMaster1788392000000 } from './migrations/1788392000000-AddAlpacaAssetMaster';
import { PreservePriceBarSources1788393000000 } from './migrations/1788393000000-PreservePriceBarSources';
import { AddKakaoMembers1788394000000 } from './migrations/1788394000000-AddKakaoMembers';
import { AddNewsTranslation1788395000000 } from './migrations/1788395000000-AddNewsTranslation';
import { AddMarketIndicators1788396000000 } from './migrations/1788396000000-AddMarketIndicators';
import { AddWebPush1788397000000 } from './migrations/1788397000000-AddWebPush';
import { AllowSharedCompanyCik1788398000000 } from './migrations/1788398000000-AllowSharedCompanyCik';
import { AddParseIntegrity1788399000000 } from './migrations/1788399000000-AddParseIntegrity';
import { RepairLegacyParserClock1788400000000 } from './migrations/1788400000000-RepairLegacyParserClock';
import { numericStringTransformer } from './transformers';

test('TypeORM CLI module exports exactly one DataSource instance', () => {
  const exportedDataSources = Object.values(dataSourceModule).filter(
    (value): value is DataSource => value instanceof DataSource,
  );

  assert.deepEqual(exportedDataSources, [dataSourceModule.dataSource]);
});

test('initial migration avoids the MySQL reserved cursor identifier', async () => {
  const queries: string[] = [];
  const queryRunner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as unknown as QueryRunner;

  await new InitialSchema1788390000000().up(queryRunner);
  const createCheckpoint = queries.find((sql) => sql.includes('CREATE TABLE `source_checkpoints`'));

  assert.ok(createCheckpoint);
  assert.match(createCheckpoint, /\n\s+checkpoint_cursor TEXT NULL,/u);
  assert.doesNotMatch(createCheckpoint, /\n\s+`?cursor`? TEXT NULL,/u);
});

test('AI run identity is unique in both metadata and an incremental migration', async () => {
  const identityUnique = getMetadataArgsStorage().uniques.find(
    (unique) => unique.target === AiRunEntity && unique.name === 'ux_ai_runs_identity',
  );
  assert.deepEqual(identityUnique?.columns, [
    'subjectType',
    'subjectId',
    'provider',
    'model',
    'promptHash',
  ]);

  const queries: string[] = [];
  const queryRunner = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes('HAVING COUNT(*) > 1') ? [] : undefined;
    },
  } as unknown as QueryRunner;
  const migration = new AddAiRunIdentityUnique1788391000000();

  await migration.up(queryRunner);
  await migration.down(queryRunner);

  assert.match(queries[0]!, /GROUP BY subject_type, subject_id, provider, model, prompt_hash/u);
  assert.match(queries[1]!, /ADD CONSTRAINT ux_ai_runs_identity/u);
  assert.match(queries[2]!, /DROP INDEX ux_ai_runs_identity/u);
});

test('AI identity migration refuses to discard duplicate audit provenance', async () => {
  const queryRunner = {
    query: async (sql: string) =>
      sql.includes('HAVING COUNT(*) > 1')
        ? [
            {
              subject_type: 'PARSE_RUN',
              subject_id: '00000000-0000-4000-8000-000000000001',
              provider: 'OPENAI_COMPATIBLE',
              model: 'local-model',
              prompt_hash: 'a'.repeat(64),
              duplicate_count: 2,
            },
          ]
        : undefined,
  } as unknown as QueryRunner;

  await assert.rejects(
    new AddAiRunIdentityUnique1788391000000().up(queryRunner),
    /duplicate AI audit identities exist/u,
  );
});

test('Alpaca asset master preserves identity, raw provenance, and observation times', async () => {
  const columns = getMetadataArgsStorage().columns.filter(
    (column) => column.target === AlpacaAssetEntity,
  );
  const properties = new Set(columns.map((column) => column.propertyName));
  for (const required of [
    'providerAssetId',
    'rawJson',
    'rightsMode',
    'provenanceUrl',
    'firstObservedAt',
    'lastObservedAt',
    'isCurrent',
  ]) {
    assert.equal(properties.has(required), true, `missing Alpaca asset column ${required}`);
  }
  const identity = getMetadataArgsStorage().indices.find(
    (index) => index.target === AlpacaAssetEntity && index.name === 'ux_alpaca_assets_provider_id',
  );
  assert.deepEqual(identity?.columns, ['providerAssetId']);
  assert.equal(identity?.unique, true);

  const queries: string[] = [];
  const queryRunner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as unknown as QueryRunner;
  const migration = new AddAlpacaAssetMaster1788392000000();
  await migration.up(queryRunner);
  await migration.down(queryRunner);

  assert.match(queries[0]!, /CREATE TABLE alpaca_assets/u);
  assert.match(queries[0]!, /raw_json JSON NOT NULL/u);
  assert.match(queries[0]!, /first_observed_at DATETIME\(3\) NOT NULL/u);
  assert.match(queries[0]!, /FOREIGN KEY \(company_id\) REFERENCES companies\(id\)/u);
  assert.equal(queries[1], 'DROP TABLE alpaca_assets');
});

test('exact decimal transformer never converts through JavaScript number', () => {
  const exact = '12345678901234567890123456789012.123456';
  assert.equal(numericStringTransformer.to(exact), exact);
  assert.equal(numericStringTransformer.from(exact), exact);
  assert.equal(numericStringTransformer.from(null), null);
});

test('TypeORM production options never use schema synchronization', () => {
  const options = createTypeOrmOptions('mysql://orsem:test@127.0.0.1:3306/orsem');
  assert.equal(options.synchronize, false);
  assert.equal(options.migrationsRun, false);
  if (options.type !== 'mysql') assert.fail('Orsem persistence must use the MySQL driver');
  assert.deepEqual(options.dateStrings, ['DATE']);
  assert.deepEqual(options.migrations, [
    InitialSchema1788390000000,
    AddAiRunIdentityUnique1788391000000,
    AddAlpacaAssetMaster1788392000000,
    PreservePriceBarSources1788393000000,
    AddKakaoMembers1788394000000,
    AddNewsTranslation1788395000000,
    AddMarketIndicators1788396000000,
    AddWebPush1788397000000,
    AllowSharedCompanyCik1788398000000,
    AddParseIntegrity1788399000000,
    RepairLegacyParserClock1788400000000,
  ]);
});

test('Kakao members have isolated provider identities and pending read-only defaults without admin linking', async () => {
  const identity = getMetadataArgsStorage().uniques.find(
    (unique) => unique.target === MemberEntity,
  );
  assert.deepEqual(identity?.columns, ['provider', 'providerSubject']);
  const properties = getMetadataArgsStorage().columns.filter(
    (column) => column.target === MemberEntity,
  );
  assert.equal(
    properties.some((column) => column.propertyName === 'email'),
    false,
  );
  assert.equal(
    properties.some((column) => column.propertyName === 'adminId'),
    false,
  );
  const queries: string[] = [];
  await new AddKakaoMembers1788394000000().up({
    query: async (sql: string) => {
      queries.push(sql);
    },
  } as unknown as QueryRunner);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /CREATE TABLE members/u);
  assert.match(queries[0]!, /DEFAULT 'VIEWER'/u);
  assert.match(queries[0]!, /DEFAULT 'PENDING'/u);
  assert.match(
    queries[0]!,
    /UNIQUE KEY ux_members_provider_subject \(provider, provider_subject\)/u,
  );
  assert.match(
    queries[0]!,
    /provider_subject VARCHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin/u,
  );
  assert.doesNotMatch(queries[0]!, /INSERT INTO|UPDATE admins|ALTER TABLE admins/u);
});

test('price source migration preserves rows and refuses to collapse distinct providers on revert', async () => {
  const identity = getMetadataArgsStorage().uniques.find(
    (unique) => unique.target === PriceBarEntity,
  );
  assert.deepEqual(identity?.columns, ['companyId', 'source', 'interval', 'barAt']);
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes('HAVING COUNT(*) > 1') ? [{ conflict: 1 }] : [];
    },
  } as unknown as QueryRunner;
  const migration = new PreservePriceBarSources1788393000000();
  await migration.up(runner);
  assert.match(queries[0]!, /source, `interval`, bar_at/u);
  assert.match(queries[0]!, /session_date DATE NULL/u);
  assert.doesNotMatch(queries[0]!, /DELETE|UPDATE|TRUNCATE/u);
  await assert.rejects(migration.down(runner), /multiple sources share a bar/u);
  assert.equal(queries.length, 2, 'unsafe revert must not issue any schema mutation');
});

test('뉴스 번역 마이그레이션은 원문을 보존하고 번역 이력이 있으면 되돌리기를 거절한다', async () => {
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.startsWith('SELECT') ? [{ count: 1 }] : undefined;
    },
  } as unknown as QueryRunner;
  const migration = new AddNewsTranslation1788395000000();
  await migration.up(runner);
  assert.doesNotMatch(queries[0]!, /DELETE|UPDATE|TRUNCATE|DROP/u);
  await assert.rejects(migration.down(runner), /번역 이력이 남아/u);
  assert.equal(queries.length, 2, '번역 이력이 있으면 컬럼을 삭제하지 않아야 합니다.');
});

test('database CLI configuration fails closed in production', () => {
  assert.throws(() => resolveDatabaseUrl({ NODE_ENV: 'production' }), /DATABASE_URL is required/u);
  assert.throws(
    () =>
      resolveDatabaseUrl({
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://orsem:change-me@127.0.0.1:3306/orsem',
      }),
    /development placeholder/u,
  );
  assert.throws(
    () => resolveDatabaseUrl({ DATABASE_URL: 'postgres://localhost/orsem' }),
    /must use mysql:\/\//u,
  );
  assert.equal(
    resolveDatabaseUrl({ DATABASE_URL: 'mysql://orsem:test@db.internal:3306/orsem' }),
    'mysql://orsem:test@db.internal:3306/orsem',
  );
});

test('entity identifiers are matching CHAR(36) UUID columns generated by TypeORM', () => {
  const storage = getMetadataArgsStorage();
  const generatedIds = storage.generations.filter((generation) => generation.propertyName === 'id');
  assert.ok(generatedIds.length > 0);
  for (const generation of generatedIds) {
    const column = storage.columns.find(
      (column) => column.propertyName === 'id' && column.target === generation.target,
    );
    assert.equal(column?.options.type, 'char');
    assert.equal(column?.options.length, 36);
    assert.equal(generation.strategy, 'uuid');
  }
});

test('fixed-width identifiers and exact transaction quantities cannot drift', () => {
  const storage = getMetadataArgsStorage();
  const corpCode = storage.columns.find(
    (column) => column.target === CompanyEntity && column.propertyName === 'corpCode',
  );
  const stockCode = storage.columns.find(
    (column) => column.target === CompanyEntity && column.propertyName === 'stockCode',
  );
  const cik = storage.columns.find(
    (column) => column.target === CompanyEntity && column.propertyName === 'cik',
  );
  const quantity = storage.columns.find(
    (column) => column.target === InsiderTransactionEntity && column.propertyName === 'quantity',
  );
  assert.deepEqual([corpCode?.options.type, corpCode?.options.length], ['char', 8]);
  assert.deepEqual([stockCode?.options.type, stockCode?.options.length], ['char', 6]);
  assert.deepEqual([cik?.options.type, cik?.options.length], ['char', 10]);
  assert.deepEqual(
    [quantity?.options.type, quantity?.options.precision, quantity?.options.scale],
    ['decimal', 38, 6],
  );
});

test('bot delivery rows retain their alert and concrete delivery lineage', () => {
  const storage = getMetadataArgsStorage();
  const alertId = storage.columns.find(
    (column) => column.target === BotDeliveryEntity && column.propertyName === 'alertId',
  );
  const alertDeliveryId = storage.columns.find(
    (column) => column.target === BotDeliveryEntity && column.propertyName === 'alertDeliveryId',
  );
  assert.deepEqual(
    [alertId?.options.type, alertId?.options.length, alertId?.options.nullable],
    ['char', 36, true],
  );
  assert.deepEqual(
    [
      alertDeliveryId?.options.type,
      alertDeliveryId?.options.length,
      alertDeliveryId?.options.nullable,
    ],
    ['char', 36, true],
  );
});
