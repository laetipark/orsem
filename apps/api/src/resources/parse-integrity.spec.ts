import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ParseStatus, ProcessingStatus } from '@orsem/contracts';
import {
  CompanyEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  FilingRelationEntity,
  InsiderReportEntity,
  InsiderTransactionEntity,
  TradePlanEntity,
  TradePlanItemEntity,
  JobOutboxEntity,
  PARSE_INTEGRITY_METRICS_SQL,
  ParseRunEntity,
  ReviewEntity,
} from '@orsem/database';
import { DataSource, type EntityManager } from 'typeorm';
import type { AuthService } from '../auth/auth.service';
import type { MemberService } from '../auth/member.service';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { OperationsController } from '../operations/operations.controller';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { AdminSessionGuard } from '../security/security';
import { OrsemDataService } from './orsem-data.service';

function dataService(source: unknown): OrsemDataService {
  return new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    { dataSource: source } as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
}

const now = new Date('2026-09-05T01:02:03.000Z');
const filing = (changes: Partial<FilingEntity> = {}) =>
  ({
    id: 'filing',
    detailType: 'D002',
    canonicalType: 'D002',
    classificationStatus: 'CONFIRMED',
    activeParseRunId: 'active',
    companyId: 'company',
    reportName: '임원ㆍ주요주주특정증권등소유상황보고서',
    rceptNo: '20260905000001',
    rceptDate: '2026-09-05',
    firstObservedAt: now,
    lastSeenAt: now,
    ...changes,
  }) as FilingEntity;
const parseRun = (changes: Partial<ParseRunEntity> = {}) =>
  ({
    id: 'active',
    filingId: 'filing',
    inputType: 'D002',
    extractorType: 'D002',
    resultType: 'D002',
    validationStatus: 'PASSED',
    status: ParseStatus.SUCCEEDED,
    confidence: '1',
    finishedAt: now,
    resultJson: { projectionApplied: true, parsed: { detailType: 'D002' } },
    ...changes,
  }) as ParseRunEntity;

type ParseMethods = {
  activeParseRun(filing: FilingEntity): Promise<ParseRunEntity | null>;
  enqueueDeferredProjection(
    manager: EntityManager,
    review: ReviewEntity,
    adminId: string,
  ): Promise<boolean>;
};

for (const current of [
  filing({ activeParseRunId: null }),
  filing({ activeParseRunId: 'missing' }),
]) {
  test(`no active fallback to a newer failed or shadow run when active=${current.activeParseRunId}`, async () => {
    const lookups: unknown[] = [];
    const data = dataService({
      getRepository: () => ({
        findOneBy: async (query: unknown) => {
          lookups.push(query);
          return null;
        },
        findOne: async () => {
          assert.fail('A latest-run fallback would publish an unactivated result');
        },
      }),
    });
    assert.equal(await (data as unknown as ParseMethods).activeParseRun(current), null);
    assert.equal(lookups.length, current.activeParseRunId ? 1 : 0);
  });
}

for (const [label, current, run] of [
  ['type mismatch', filing(), parseRun({ extractorType: 'D005' })],
  ['persisted result type mismatch', filing(), parseRun({ resultType: 'D005' })],
  ['unconfirmed type', filing({ classificationStatus: 'UNKNOWN' }), parseRun()],
  ['unsupported canonical type', filing({ canonicalType: 'D003' }), parseRun()],
  [
    'shadow projection',
    filing(),
    parseRun({ resultJson: { projectionApplied: false, parsed: { detailType: 'D002' } } }),
  ],
  ['rejected validation', filing(), parseRun({ validationStatus: 'REJECTED' })],
  ['failed run', filing(), parseRun({ status: ParseStatus.FAILED })],
  ['running run', filing(), parseRun({ status: ParseStatus.RUNNING })],
] as const) {
  test(`active result fails closed for ${label}`, async () => {
    const data = dataService({ getRepository: () => ({ findOneBy: async () => run }) });
    assert.equal(await (data as unknown as ParseMethods).activeParseRun(current), null);
  });
}

test('a validated and explicitly activated result remains available', async () => {
  const current = filing();
  const run = parseRun();
  const data = dataService({ getRepository: () => ({ findOneBy: async () => run }) });
  assert.equal(await (data as unknown as ParseMethods).activeParseRun(current), run);
});

for (const [label, current, run] of [
  ['wrong extractor', filing(), parseRun({ extractorType: 'D005' })],
  [
    'wrong result',
    filing(),
    parseRun({ resultJson: { projectionApplied: false, parsed: { detailType: 'D001' } } }),
  ],
  ['unclassified filing', filing({ classificationStatus: 'UNKNOWN' }), parseRun()],
  ['unsupported filing', filing({ canonicalType: 'D004' }), parseRun()],
  ['rejected validation', filing(), parseRun({ validationStatus: 'REJECTED' })],
  ['failed run', filing(), parseRun({ status: ParseStatus.FAILED })],
  ['running run', filing(), parseRun({ status: ParseStatus.RUNNING })],
] as const) {
  test(`manual CONFIRMED never queues projection for ${label}`, async () => {
    const pending = { ...run, resultJson: { ...run.resultJson, projectionApplied: false } };
    let outboxTouched = false;
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === ParseRunEntity) return { findOneBy: async () => pending };
        if (entity === FilingEntity) return { findOneBy: async () => current };
        if (entity === JobOutboxEntity) outboxTouched = true;
        throw new Error('No outbox or mutation is allowed before the type gate');
      },
    } as unknown as EntityManager;
    const data = dataService({});
    await assert.rejects(
      () =>
        (data as unknown as ParseMethods).enqueueDeferredProjection(
          manager,
          { subjectId: 'filing', dedupeKey: 'parse:active' } as ReviewEntity,
          'admin',
        ),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
    );
    assert.equal(outboxTouched, false);
  });
}

function metricsHarness(fail = false) {
  const calls: Array<{ action: string; args?: unknown[] }> = [];
  const row = Object.fromEntries(
    [
      'totalParseRuns',
      'failedParseRuns',
      'openReviewRows',
      'currentReviewSubjects',
      'currentUnrecoveredFilings',
      'currentFailedFilings',
      'staleOpenParseReviews',
      'supersededReviews',
      'documentUnavailableReviews',
      'relationReviews',
      'currentTypeMismatches',
      'futureCreatedRows',
    ].map((key, index) => [key, String(index)]),
  );
  const runner = {
    isTransactionActive: false,
    connect: async () => {
      calls.push({ action: 'connect' });
    },
    query: async (sql: string, args?: unknown[]) => {
      calls.push({ action: sql, args });
      if (sql === PARSE_INTEGRITY_METRICS_SQL) {
        if (fail) throw new Error('synthetic-read-failure');
        return [row];
      }
      return sql.includes('UTC_TIMESTAMP') ? [{ snapshot_at: now }] : [];
    },
    startTransaction: async (isolation: string) => {
      calls.push({ action: 'begin', args: [isolation] });
      runner.isTransactionActive = true;
    },
    commitTransaction: async () => {
      calls.push({ action: 'commit' });
      runner.isTransactionActive = false;
    },
    rollbackTransaction: async () => {
      calls.push({ action: 'rollback' });
      runner.isTransactionActive = false;
    },
    release: async () => {
      calls.push({ action: 'release' });
    },
  };
  return { calls, data: dataService({ createQueryRunner: () => runner }) };
}

test('integrity counts use one read-only snapshot with its database UTC timestamp', async () => {
  const { calls, data } = metricsHarness();
  const result = await data.parseIntegrityMetrics();
  assert.equal(result.asOf, now.toISOString());
  assert.equal(result.currentUnrecoveredFilings, 4);
  assert.equal(result.staleOpenParseReviews, 6);
  assert.deepEqual(
    calls.map((call) => call.action),
    [
      'connect',
      'SET TRANSACTION READ ONLY',
      'begin',
      'SELECT id FROM parse_runs LIMIT 1',
      'SELECT UTC_TIMESTAMP(3) AS snapshot_at',
      PARSE_INTEGRITY_METRICS_SQL,
      'commit',
      'release',
    ],
  );
  assert.deepEqual(calls.find((call) => call.action === 'begin')?.args, ['REPEATABLE READ']);
  assert.deepEqual(calls.find((call) => call.action === PARSE_INTEGRITY_METRICS_SQL)?.args, [
    now,
    now,
  ]);
});

test('a failed integrity read rolls back and releases its dedicated snapshot', async () => {
  const { calls, data } = metricsHarness(true);
  await assert.rejects(() => data.parseIntegrityMetrics(), /synthetic-read-failure/);
  assert.deepEqual(
    calls.slice(-2).map((call) => call.action),
    ['rollback', 'release'],
  );
  assert.equal(
    calls.some((call) => call.action === 'commit'),
    false,
  );
});

test('the operations integrity endpoint is administrator-only, including approved viewers', async () => {
  const guard = new AdminSessionGuard(
    new Reflector(),
    { getAdmin: async () => ({ id: 'admin' }) } as unknown as AuthService,
    {
      getMember: async () => ({ id: 'member', role: 'VIEWER', status: 'APPROVED' }),
    } as unknown as MemberService,
  );
  const context = (identity: Record<string, string>) =>
    ({
      getHandler: () => OperationsController.prototype.parseIntegrity,
      getClass: () => OperationsController,
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          session: { ...identity, sessionStartedAt: new Date().toISOString() },
        }),
      }),
    }) as unknown as ExecutionContext;
  assert.equal(await guard.canActivate(context({ adminId: 'admin' })), true);
  for (const identity of [{}, { memberId: 'member' }] as Array<Record<string, string>>) {
    await assert.rejects(
      () => guard.canActivate(context(identity)),
      (error: unknown) => error instanceof HttpException && [401, 403].includes(error.getStatus()),
    );
  }
});

test('unsupported filing and event filters execute before pagination and use canonical type', async () => {
  const metadata = new DataSource({
    type: 'mysql',
    database: 'test',
    entities: [CompanyEntity, FilingEntity, EventClusterEntity],
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const captured: string[] = [];
  const data = dataService({
    getRepository: (entity: typeof FilingEntity | typeof EventClusterEntity) => ({
      createQueryBuilder: (alias: string) => {
        const qb = metadata.getRepository(entity).createQueryBuilder(alias);
        qb.getMany = async () => {
          captured.push(qb.getQuery());
          return [];
        };
        return qb;
      },
    }),
  });
  await data.listFilings({ detailType: 'D002', limit: 1 });
  await data.listEvents({ detailType: 'D002', limit: 1 });
  assert.match(captured[0]!, /canonical_type.*IN \('D001','D002','D005'\)/);
  assert.match(captured[0]!, /COALESCE\([^)]*canonical_type[^)]*\) = :detailType/);
  assert.match(captured[1]!, /COALESCE\(edf\.canonical_type,\s*edf\.detail_type\) = :detailType/);
  assert.match(captured[1]!, /NOT EXISTS[\s\S]*canonical_type NOT IN \('D001','D002','D005'\)/);
  for (const sql of captured) assert.match(sql, /LIMIT 2$/);
});

for (const type of ['D003', 'D004']) {
  test(`unsupported ${type} cannot reappear through a direct filing URL`, async () => {
    const current = filing({ canonicalType: type });
    const fixture = new FixtureStoreService();
    const fallback = {
      findOneBy: async () => null,
      findOne: async () => null,
      find: async () => [],
    };
    const data = dataService({
      getRepository: (entity: unknown) => {
        if (entity === FilingEntity)
          return {
            createQueryBuilder: () => ({
              where() {
                return this;
              },
              getOne: async () => current,
            }),
          };
        if (entity === CompanyEntity)
          return { findOneBy: async () => ({ ...fixture.companies[0], updatedAt: now }) };
        return fallback;
      },
    });
    await assert.rejects(
      () => data.getFiling('filing'),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 404,
    );
  });

  test(`unsupported ${type} cannot reappear through a direct event URL`, async () => {
    const data = dataService({
      getRepository: (entity: unknown) => {
        if (entity === EventClusterEntity)
          return {
            findOneBy: async () => ({
              id: 'event',
              companyId: null,
              firstObservedAt: now,
              state: 'ACTIVE',
            }),
          };
        if (entity === EventClusterItemEntity)
          return {
            findBy: async () => [{ itemType: 'FILING', itemId: 'filing' }],
            findOneBy: async () => ({ itemType: 'FILING', itemId: 'filing' }),
          };
        if (entity === FilingEntity)
          return { findOneBy: async () => filing({ canonicalType: type }) };
        return { findOneBy: async () => null };
      },
    });
    await assert.rejects(
      () => data.getEvent('event'),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 404,
    );
  });
}

test('every filing membership is checked before a direct event exposes an unsupported secondary filing', async () => {
  const membership = [
    { itemType: 'FILING', itemId: 'supported' },
    { itemType: 'FILING', itemId: 'unsupported' },
  ];
  const data = dataService({
    getRepository: (entity: unknown) => {
      if (entity === EventClusterEntity)
        return {
          findOneBy: async () => ({
            id: 'event',
            companyId: null,
            firstObservedAt: now,
            state: 'ACTIVE',
          }),
        };
      if (entity === EventClusterItemEntity)
        return { findBy: async () => membership, findOneBy: async () => membership[0] };
      if (entity === FilingEntity)
        return {
          findOneBy: async ({ id }: { id: string }) =>
            filing({
              id,
              companyId: 'company',
              canonicalType: id === 'supported' ? 'D002' : 'D003',
            }),
        };
      if (entity === CompanyEntity)
        return { findOneBy: async () => ({ id: 'company', updatedAt: now }) };
      return { findOneBy: async () => null };
    },
  });
  await assert.rejects(
    () => data.getEvent('event'),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 404,
  );
});

test('a type-consistent reviewed partial run queues one explicit administrator projection request', async () => {
  const current = filing();
  const run = parseRun({
    status: ParseStatus.PARTIAL,
    resultJson: { projectionApplied: false, parsed: { detailType: 'D002' } },
  });
  const saved: Array<Record<string, unknown>> = [];
  const query = {
    setLock() {
      return this;
    },
    where() {
      return this;
    },
    andWhere() {
      return this;
    },
    getOne: async () => null,
  };
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === FilingEntity) return { findOneBy: async () => current };
      if (entity === ParseRunEntity) return { findOneBy: async () => run };
      if (entity === JobOutboxEntity)
        return {
          createQueryBuilder: () => query,
          create: (value: Record<string, unknown>) => value,
          save: async (value: Record<string, unknown>) => {
            saved.push(value);
            return value;
          },
        };
      throw new Error('Unexpected repository');
    },
  } as unknown as EntityManager;
  const data = dataService({});
  assert.equal(
    await (data as unknown as ParseMethods).enqueueDeferredProjection(
      manager,
      { subjectId: 'filing', dedupeKey: 'parse:active' } as ReviewEntity,
      'admin',
    ),
    true,
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.kind, 'APPLY_PARSE_PROJECTION');
  assert.deepEqual(saved[0]?.payloadJson, {
    filingId: 'filing',
    parseRunId: 'active',
    requestedByAdminId: 'admin',
    crosscheckOnly: false,
  });
});

function stagedProjectionHarness(run: ParseRunEntity, existing: JobOutboxEntity | null = null) {
  const saved: Array<Record<string, unknown>> = [];
  const query = {
    setLock() {
      return this;
    },
    where() {
      return this;
    },
    andWhere() {
      return this;
    },
    getOne: async () => existing,
  };
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === FilingEntity)
        return {
          findOneBy: async () => filing({ canonicalType: run.resultType }),
        };
      if (entity === ParseRunEntity) return { findOneBy: async () => run };
      if (entity === JobOutboxEntity)
        return {
          createQueryBuilder: () => query,
          create: (value: Record<string, unknown>) => value,
          save: async (value: Record<string, unknown>) => {
            saved.push(structuredClone(value));
            return value;
          },
        };
      throw new Error('Unexpected repository');
    },
  } as unknown as EntityManager;
  const data = dataService({});
  return {
    saved,
    enqueue: (adminId = 'admin') =>
      (data as unknown as ParseMethods).enqueueDeferredProjection(
        manager,
        { subjectId: 'filing', dedupeKey: 'parse:active' } as ReviewEntity,
        adminId,
      ),
  };
}

for (const [label, type, crosscheck, crosscheckOnly] of [
  ['not yet checked', 'D002', { status: 'NOT_RUN' }, true],
  ['no exact receipt match', 'D002', { status: 'OK', exactReceiptMatches: [] }, true],
  ['missing receipt number', 'D002', { status: 'OK', exactReceiptMatches: [{}] }, true],
  [
    'another receipt matched',
    'D002',
    { status: 'OK', exactReceiptMatches: [{ rcept_no: '20260905000002' }] },
    true,
  ],
  [
    'exact receipt matched',
    'D002',
    { status: 'OK', exactReceiptMatches: [{ rcept_no: '20260905000001' }] },
    false,
  ],
  ['trade plan crosscheck not applicable', 'D005', { status: 'NOT_APPLICABLE' }, false],
] as const) {
  test(`offline candidates queue an immutable crosscheck-only decision: ${label}`, async () => {
    const run = parseRun({
      inputType: type,
      extractorType: type,
      resultType: type,
      resultJson: {
        projectionApplied: false,
        parsed: { detailType: type },
        staging: { mode: 'OFFLINE_INACTIVE' },
        crosscheck: structuredClone(crosscheck),
      },
    });
    const before = structuredClone(run.resultJson);
    const harness = stagedProjectionHarness(run);
    assert.equal(await harness.enqueue(), true);
    assert.deepEqual(harness.saved[0]?.payloadJson, {
      filingId: 'filing',
      parseRunId: 'active',
      requestedByAdminId: 'admin',
      crosscheckOnly,
    });
    assert.deepEqual(run.resultJson, before);
    run.resultJson = { ...run.resultJson, crosscheck: { status: 'MISSING' } };
    assert.equal(
      (harness.saved[0]?.payloadJson as { crosscheckOnly: boolean }).crosscheckOnly,
      crosscheckOnly,
    );
  });
}

for (const status of [ProcessingStatus.COMPLETED, ProcessingStatus.FAILED]) {
  test(`a ${status} crosscheck job is requeued with the new verified projection decision`, async () => {
    const previousPayload = {
      filingId: 'filing',
      parseRunId: 'active',
      requestedByAdminId: 'previous-admin',
      crosscheckOnly: true,
    };
    const existing: JobOutboxEntity = {
      id: 'outbox',
      kind: 'APPLY_PARSE_PROJECTION',
      dedupeKey: 'manual-apply-projection:active',
      status,
      payloadJson: previousPayload,
      availableAt: now,
      attempts: 1,
      lockedAt: now,
      lastError: 'previous attempt',
      createdAt: now,
      updatedAt: now,
    };
    const run = parseRun({
      resultJson: {
        projectionApplied: false,
        parsed: { detailType: 'D002' },
        staging: { mode: 'OFFLINE_INACTIVE' },
        crosscheck: {
          status: 'OK',
          exactReceiptMatches: [{ rcept_no: '20260905000001' }],
        },
      },
    });
    const harness = stagedProjectionHarness(run, existing);
    assert.equal(await harness.enqueue('reviewing-admin'), true);
    assert.equal(harness.saved.length, 1);
    assert.equal(existing.id, 'outbox');
    assert.equal(existing.status, 'PENDING');
    assert.equal(existing.lockedAt, null);
    assert.equal(existing.lastError, null);
    assert.deepEqual(existing.payloadJson, {
      filingId: 'filing',
      parseRunId: 'active',
      requestedByAdminId: 'reviewing-admin',
      crosscheckOnly: false,
    });
    assert.equal(previousPayload.crosscheckOnly, true);
    assert.equal(previousPayload.requestedByAdminId, 'previous-admin');
  });
}

for (const type of ['D001', 'D002', 'D005'] as const) {
  test(`a current ${type} filing never reads preserved projection rows from another domain`, async () => {
    const current = filing({ canonicalType: type, detailType: type === 'D005' ? 'D002' : 'D005' });
    const run = parseRun({
      inputType: type,
      extractorType: type,
      resultType: type,
      resultJson: { projectionApplied: true, parsed: { detailType: type } },
    });
    const reads: string[] = [];
    const query = {
      where() {
        return this;
      },
      getOne: async () => current,
      getMany: async () => [],
    };
    const data = dataService({
      getRepository: (entity: unknown) => {
        if (entity === FilingEntity || entity === FilingRelationEntity)
          return { createQueryBuilder: () => query };
        if (entity === CompanyEntity)
          return { findOneBy: async () => ({ id: 'company', nameKo: '합성기업', updatedAt: now }) };
        if (entity === ParseRunEntity) return { findOneBy: async () => run };
        if (entity === InsiderReportEntity)
          return {
            findOne: async () => {
              reads.push('D002');
              return { id: 'insider', reporterName: 'current reporter' };
            },
          };
        if (entity === InsiderTransactionEntity) return { find: async () => [] };
        if (entity === TradePlanEntity)
          return {
            findOne: async () => {
              reads.push('D005');
              return { id: 'plan', planStatus: 'PLANNED' };
            },
          };
        if (entity === TradePlanItemEntity) return { findOne: async () => null };
        throw new Error('Unexpected repository');
      },
    });
    const detail = await data.getFiling('filing');
    assert.equal(detail.detailType, type);
    assert.deepEqual(reads, type === 'D001' ? [] : [type]);
    assert.equal(detail.reporter === null, type !== 'D002');
    assert.equal(detail.tradePlan === null, type !== 'D005');
  });
}
