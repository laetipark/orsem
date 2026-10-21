import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { EntityManager } from 'typeorm';
import type { Request } from 'express';
import { analysisSelectionSchema } from '@orsem/contracts';
import { APP_CONFIG, loadAppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { PersistenceModule } from '../persistence/persistence.module';
import type {
  GroupActor,
  WatchlistAccessService,
} from '../watchlist-groups/watchlist-access.service';
import { AnalysisConfig } from './analysis-config';
import {
  AnalysisController,
  AnalysisMappingAdminController,
  AnalysisDiffAdminController,
} from './analysis.controller';
import { AnalysisModule } from './analysis.module';
import { AnalysisService } from './analysis.service';
import { analysisJson, publicAnalysisJson, readAnalysisArtifact } from './analysis-artifacts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: GroupActor = { kind: 'MEMBER', id: uuid(1), key: `MEMBER:${uuid(1)}` };
const companyId = uuid(2),
  groupId = uuid(3),
  reportId = uuid(4),
  documentId = uuid(5),
  filingId = uuid(7);
const selection = () =>
  analysisSelectionSchema.parse({
    companyIds: [companyId],
    periods: [{ year: 2025, reportCode: '11011' }],
  });
type Row = Record<string, unknown> & { id: string };

function harness() {
  const runs = new Map<string, Row>(),
    exports = new Map<string, Row>(),
    documents = new Map<string, Row>(),
    diffs = new Map<string, Row>();
  const jobs: unknown[][] = [],
    calls: Array<{ sql: string; params: unknown[] }> = [];
  const controls = {
    groupAllowed: true,
    failJob: false,
    rights: 'OFFICIAL_PUBLIC_DATA',
    diffJobRunning: false,
    reportCompanyId: companyId,
  };
  const now = '2026-10-10T00:00:00.000Z';
  const query = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id FROM companies')) return params.map((id) => ({ id }));
    if (sql.startsWith('SELECT company_id FROM watchlist_group_items'))
      return [{ company_id: companyId }];
    if (sql.startsWith('SELECT company_id FROM market_leader_watchlist'))
      return [{ company_id: companyId }];
    if (sql.startsWith('INSERT INTO analysis_runs')) {
      const row: Row = {
        id: String(params[0]),
        owner_key: params[1],
        saved_query_id: params[2],
        parent_run_id: params[3],
        status: 'QUEUED',
        selection_json: JSON.parse(String(params[4])),
        company_ids_json: JSON.parse(String(params[5])),
        progress_json: JSON.parse(String(params[6])),
        created_at: now,
        updated_at: now,
        result_json: null,
        completed_at: null,
        error_message: null,
        next_attempt_at: null,
      };
      runs.set(row.id, row);
      return [];
    }
    if (sql.startsWith('INSERT INTO analysis_jobs')) {
      if (controls.failJob) throw new Error('synthetic job failure');
      jobs.push(params);
      return [];
    }
    if (sql.startsWith('SELECT * FROM analysis_runs WHERE id=')) {
      const row = runs.get(String(params[0]));
      return row?.owner_key === params[1] ? [row] : [];
    }
    if (
      sql.includes('SELECT * FROM analysis_runs WHERE owner_key=') &&
      sql.includes('parent_run_id')
    )
      return [...runs.values()].filter(
        (r) =>
          r.owner_key === params[0] &&
          r.parent_run_id === params[1] &&
          ['QUEUED', 'RUNNING', 'WAITING'].includes(String(r.status)),
      );
    if (sql.startsWith('SELECT * FROM analysis_runs WHERE owner_key='))
      return [...runs.values()].filter((r) => r.owner_key === params[0]);
    if (sql.startsWith('UPDATE analysis_runs SET result_json=')) {
      const row = runs.get(String(params[1]));
      if (row && row.owner_key === params[2]) row.result_json = JSON.parse(String(params[0]));
      return [];
    }
    if (sql.startsWith('SELECT * FROM analysis_reports'))
      return params[0] === reportId
        ? [
            {
              id: reportId,
              company_id: controls.reportCompanyId,
              rights_mode: controls.rights,
              source_url: 'https://dart.fss.or.kr/official',
              raw_uri: '/private/raw',
              raw_sha256: 'a'.repeat(64),
            },
          ]
        : [];
    if (sql.startsWith('SELECT * FROM analysis_documents WHERE id='))
      return documents.has(String(params[0])) ? [documents.get(String(params[0]))!] : [];
    if (sql.startsWith('SELECT * FROM analysis_documents WHERE report_id='))
      return [...documents.values()].filter((r) => r.report_id === params[0]);
    if (sql.startsWith('SELECT * FROM analysis_documents WHERE filing_id='))
      return [...documents.values()].filter((r) => r.filing_id === params[0]);
    if (sql.startsWith('SELECT f.*,d.rights_mode document_rights_mode'))
      return params[0] === filingId
        ? [{ id: filingId, company_id: companyId, rcept_no: '20261010000001', detail_type: 'D005' }]
        : [];
    if (sql.includes('FROM event_cluster_items') || sql.startsWith('SELECT id FROM source_items'))
      return [];
    if (sql.startsWith('INSERT INTO analysis_documents')) {
      const row: Row = {
        id: String(params[0]),
        report_id: params[1],
        filing_id: params[2],
        source_item_id: params[3],
        source_url: params[4],
        rights_mode: params[5],
        raw_uri: params[6],
        raw_sha256: params[7],
        media_type: params[8],
        parser_version: params[9],
        status: 'QUEUED',
        tables_json: [],
      };
      documents.set(row.id, row);
      return [];
    }
    if (sql.startsWith('SELECT * FROM analysis_notes')) return [];
    if (sql.startsWith('SELECT * FROM analysis_diffs WHERE id='))
      return diffs.has(String(params[0])) ? [diffs.get(String(params[0]))!] : [];
    if (sql.startsWith('SELECT * FROM analysis_jobs WHERE kind='))
      return controls.diffJobRunning ? [{ id: uuid(89), status: 'RUNNING' }] : [];
    if (sql.startsWith('UPDATE analysis_diffs SET review_json=')) {
      const row = diffs.get(String(params[1]));
      if (row)
        Object.assign(row, {
          review_json: JSON.parse(String(params[0])),
          status: 'QUEUED',
          error_message: null,
        });
      return [];
    }
    if (sql.startsWith('INSERT INTO analysis_exports')) {
      const row: Row = {
        id: String(params[0]),
        run_id: params[1],
        owner_key: params[2],
        status: 'QUEUED',
        selection_json: JSON.parse(String(params[3])),
        created_at: now,
        updated_at: now,
        object_uri: null,
        sha256: null,
        error_message: null,
      };
      exports.set(row.id, row);
      return [];
    }
    if (sql.startsWith('SELECT * FROM analysis_exports WHERE id=')) {
      const row = exports.get(String(params[0]));
      return row?.owner_key === params[1] ? [row] : [];
    }
    throw new Error(`Unhandled test query: ${sql}`);
  };
  const access = {
    async transaction<T>(current: GroupActor, work: (m: EntityManager) => Promise<T>): Promise<T> {
      assert.equal(current.key, `${current.kind}:${current.id}`);
      const before = structuredClone([...runs.entries()]);
      const beforeDiffs = structuredClone([...diffs.entries()]);
      const jobCount = jobs.length;
      try {
        return await work({ query } as unknown as EntityManager);
      } catch (error) {
        runs.clear();
        for (const [id, row] of before) runs.set(id, row);
        diffs.clear();
        for (const [id, row] of beforeDiffs) diffs.set(id, row);
        jobs.splice(jobCount);
        throw error;
      }
    },
    async group() {
      if (!controls.groupAllowed) throw new NotFoundException();
      return {};
    },
  } as unknown as WatchlistAccessService;
  const config = {
    enabled: true,
    documentsEnabled: true,
    notesEnabled: true,
    storageDir: tmpdir(),
  } as AnalysisConfig;
  return {
    service: new AnalysisService(access, config),
    config,
    controls,
    runs,
    exports,
    documents,
    diffs,
    jobs,
    calls,
  };
}

test('new run and durable job commit together and derive owner only from the actor', async () => {
  const h = harness();
  const run = await h.service.createRun(actor, selection());
  assert.equal(run.status, 'QUEUED');
  assert.equal(h.runs.get(run.id)?.owner_key, actor.key);
  assert.deepEqual(h.jobs[0]?.slice(1, 3), ['RUN', run.id]);
  assert.equal('ownerKey' in run, false);
  const other = { kind: 'MEMBER' as const, id: uuid(99), key: `MEMBER:${uuid(99)}` };
  await assert.rejects(() => h.service.getRun(other, run.id), NotFoundException);
  h.controls.failJob = true;
  await assert.rejects(() => h.service.createRun(actor, selection()), /synthetic job failure/);
  assert.equal(h.runs.size, 1);
  assert.equal(h.jobs.length, 1);
});

test('group company injection is rejected and personal history survives group removal without permitting reruns', async () => {
  const h = harness();
  await assert.rejects(
    () => h.service.createRun(actor, { ...selection(), companyIds: [uuid(9)], groupId }),
    ForbiddenException,
  );
  assert.equal(h.jobs.length, 0);
  const run = await h.service.createRun(actor, { ...selection(), companyIds: [], groupId });
  assert.deepEqual(run.selection.companyIds, [companyId]);
  h.runs.get(run.id)!.status = 'PARTIAL';
  h.controls.groupAllowed = false;
  assert.equal((await h.service.getRun(actor, run.id)).id, run.id);
  assert.equal((await h.service.listRuns(actor)).items.length, 1);
  await assert.rejects(() => h.service.retryRun(actor, run.id), NotFoundException);
  assert.equal(h.jobs.length, 1);
});

test('retries create a new immutable result version, deduplicate pending retries and respect provider waits', async () => {
  const h = harness();
  const original = await h.service.createRun(actor, selection());
  const row = h.runs.get(original.id)!;
  row.status = 'WAITING';
  row.next_attempt_at = '2099-01-01T00:00:00Z';
  await assert.rejects(() => h.service.retryRun(actor, original.id), ConflictException);
  h.runs.get(original.id)!.next_attempt_at = null;
  const retry = await h.service.retryRun(actor, original.id);
  assert.notEqual(retry.id, original.id);
  assert.equal(retry.parentRunId, original.id);
  assert.equal(h.runs.get(original.id)?.status, 'WAITING');
  assert.equal((await h.service.retryRun(actor, original.id)).id, retry.id);
  assert.equal(h.jobs.length, 2);
});

test('export request snapshots values and rechecks owner and current source rights on every read', async () => {
  const h = harness();
  const run = await h.service.createRun(actor, selection());
  const row = h.runs.get(run.id)!;
  row.status = 'COMPLETE';
  row.result_json = {
    facts: [{ id: uuid(6), reportId, value: '123.4500' }],
    reportIds: [reportId],
    documentIds: [],
    diffIds: [],
    validations: [],
  };
  const manifest = await h.service.createExport(actor, run.id, {
    documentIds: [],
    tableIds: [],
    diffIds: [],
    includeNotes: false,
    includeOwnership: false,
    includeValidation: true,
  });
  const snapshot = analysisJson(h.exports.get(manifest.id)!.selection_json);
  assert.equal(
    (snapshot.runSnapshot as { facts: Array<{ value: string }> }).facts[0]!.value,
    '123.4500',
  );
  (row.result_json as { facts: Array<{ value: string }> }).facts[0]!.value = '987';
  assert.equal(
    (snapshot.runSnapshot as { facts: Array<{ value: string }> }).facts[0]!.value,
    '123.4500',
  );
  await assert.rejects(
    () =>
      h.service.getExport({ kind: 'MEMBER', id: uuid(90), key: `MEMBER:${uuid(90)}` }, manifest.id),
    NotFoundException,
  );
  h.controls.rights = 'LINK_ONLY';
  await assert.rejects(() => h.service.getExport(actor, manifest.id), ForbiddenException);
  await assert.rejects(() => h.service.getRun(actor, run.id), ForbiddenException);
});

test('reusing a completed public document links it to the requesting personal run without a second job', async () => {
  const h = harness();
  const run = await h.service.createRun(actor, selection());
  h.documents.set(documentId, {
    id: documentId,
    report_id: reportId,
    source_item_id: null,
    filing_id: null,
    source_url: 'https://dart.fss.or.kr/official',
    rights_mode: 'OFFICIAL_PUBLIC_DATA',
    raw_sha256: 'a'.repeat(64),
    raw_uri: '/do/not/expose',
    parser_version: 'test',
    status: 'COMPLETE',
    tables_json: [],
    ownership_json: null,
  });
  const document = await h.service.createDocument(actor, { runId: run.id, reportId });
  assert.equal(document.id, documentId);
  assert.equal('rawUri' in document, false);
  assert.deepEqual(analysisJson(h.runs.get(run.id)!.result_json).documentIds, [documentId]);
  assert.equal(h.jobs.length, 1);
});

test('report documents fetch the official filing instead of parsing financial API JSON', async () => {
  const h = harness();
  const run = await h.service.createRun(actor, selection());
  const document = await h.service.createDocument(actor, { runId: run.id, reportId });
  assert.equal(h.documents.get(document.id)!.raw_uri, null);
  assert.equal(h.documents.get(document.id)!.raw_sha256, null);
  assert.equal(document.reportId, reportId);
  assert.equal(h.jobs[1]![1], 'DOCUMENT');
});

test('direct D005 filing event links resolve without requiring a financial report record', async () => {
  const h = harness();
  const run = await h.service.createRun(actor, selection());
  const document = await h.service.createDocument(actor, { runId: run.id, eventId: filingId });
  assert.equal(document.filingId, filingId);
  assert.equal(document.reportId, null);
  assert.equal(document.sourceUrl, 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261010000001');
  assert.deepEqual(analysisJson(h.runs.get(run.id)!.result_json).documentIds, [document.id]);
  assert.equal(
    h.calls.some(({ sql }) => sql.startsWith('SELECT * FROM analysis_reports')),
    false,
  );
});

test('controllers reject ownership smuggling and ambiguous document inputs before calling services', () => {
  let called = false;
  const controller = new AnalysisController({
    createRun: () => {
      called = true;
    },
  } as unknown as AnalysisService);
  const request = { session: { memberId: actor.id } } as unknown as Request;
  assert.throws(
    () => controller.createRun(request, { ...selection(), ownerKey: 'ADMIN:other' }),
    BadRequestException,
  );
  assert.throws(
    () => controller.createDocument(request, { runId: uuid(8), reportId, sourceItemId: uuid(9) }),
    BadRequestException,
  );
  assert.equal(called, false);
});

test('mapping writes are not annotated for member access and service rejects member writes', async () => {
  assert.equal(Reflect.getMetadata('orsem:own-analysis-access', AnalysisController), true);
  assert.equal(
    Reflect.getMetadata('orsem:own-analysis-access', AnalysisMappingAdminController),
    undefined,
  );
  const h = harness();
  assert.throws(
    () =>
      h.service.createMapping(actor, {
        source: 'OPENDART',
        taxonomy: 'ifrs',
        accountId: 'ifrs-full_Revenue',
        metric: 'revenue',
        scope: 'CFS',
        status: 'CONFIRMED',
        sourceUrl: 'https://dart.fss.or.kr/',
        details: {},
      }),
    ForbiddenException,
  );
  assert.equal(h.calls.length, 0);
});

test('explicit diff confirmation requires an administrator, owned scope and immutable official evidence', async () => {
  const h = harness();
  const admin: GroupActor = { kind: 'ADMIN', id: uuid(60), key: `ADMIN:${uuid(60)}` };
  const input = {
    runId: uuid(61),
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/correction.htm',
    note: 'The amendment explicitly identifies this original filing.',
  };
  assert.equal(
    Reflect.getMetadata('orsem:own-analysis-access', AnalysisDiffAdminController),
    undefined,
  );
  assert.throws(() => h.service.confirmDiff(actor, uuid(62), input), ForbiddenException);
  assert.throws(
    () =>
      h.service.confirmDiff(admin, uuid(62), {
        ...input,
        sourceUrl: 'https://sec.gov.example.com/doc',
      }),
    BadRequestException,
  );
  const run = await h.service.createRun(admin, { ...selection(), groupId });
  input.runId = run.id;
  for (const id of [documentId, uuid(63)])
    h.documents.set(id, {
      id,
      report_id: reportId,
      source_item_id: null,
      filing_id: null,
      rights_mode: 'OFFICIAL_PUBLIC_DATA',
      status: 'COMPLETE',
    });
  const diffId = uuid(62);
  h.diffs.set(diffId, {
    id: diffId,
    before_document_id: documentId,
    after_document_id: uuid(63),
    status: 'WAITING',
    confirmed: false,
    review_json: null,
    result_json: { differences: [] },
  });
  h.runs.get(run.id)!.result_json = { diffIds: [diffId] };
  const anotherAdmin: GroupActor = { kind: 'ADMIN', id: uuid(64), key: `ADMIN:${uuid(64)}` };
  await assert.rejects(() => h.service.confirmDiff(anotherAdmin, diffId, input), NotFoundException);
  h.controls.groupAllowed = false;
  await assert.rejects(() => h.service.confirmDiff(admin, diffId, input), NotFoundException);
  h.controls.groupAllowed = true;
  h.controls.reportCompanyId = uuid(65);
  await assert.rejects(() => h.service.confirmDiff(admin, diffId, input), ForbiddenException);
  h.controls.reportCompanyId = companyId;
  h.controls.diffJobRunning = true;
  await assert.rejects(() => h.service.confirmDiff(admin, diffId, input), ConflictException);
  h.controls.diffJobRunning = false;
  h.controls.failJob = true;
  await assert.rejects(() => h.service.confirmDiff(admin, diffId, input), /synthetic job failure/);
  assert.equal(h.diffs.get(diffId)!.review_json, null);
  h.controls.failJob = false;
  const confirmed = await h.service.confirmDiff(admin, diffId, input);
  assert.equal(confirmed.status, 'QUEUED');
  assert.equal(confirmed.confirmation?.note, input.note);
  assert.equal(confirmed.confirmation?.sourceUrl, input.sourceUrl);
  assert.equal(JSON.stringify(confirmed).includes(admin.key), false);
  assert.equal(analysisJson(h.diffs.get(diffId)!.review_json).reviewedBy, admin.key);
  assert.equal(h.jobs[1]![1], 'DIFF');
  await assert.rejects(() => h.service.confirmDiff(admin, diffId, input), ConflictException);
});

test('stored metadata cannot expose raw locations, ownership keys or executable links', () => {
  assert.deepEqual(
    publicAnalysisJson({
      rawUri: '/secret',
      raw_object_uri: 'file:///secret',
      owner_key: actor.key,
      nested: {
        sourceUrl: 'javascript:alert(1)',
        source_url: 'https://dart.fss.or.kr/doc',
        value: '0',
      },
    }),
    { nested: { sourceUrl: null, source_url: 'https://dart.fss.or.kr/doc', value: '0' } },
  );
});

test('download reads immutable verified bytes and rejects path escapes, outside symlinks and changed hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orsem-analysis-artifact-'));
  const outside = await mkdtemp(join(tmpdir(), 'orsem-analysis-outside-'));
  try {
    const bytes = Buffer.from('synthetic workbook');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const path = join(root, 'data.xlsx');
    await writeFile(path, bytes);
    assert.deepEqual(await readAnalysisArtifact(root, path, digest), bytes);
    await assert.rejects(() => readAnalysisArtifact(root, path, '0'.repeat(64)), ConflictException);
    await writeFile(join(outside, 'private.xlsx'), bytes);
    await symlink(join(outside, 'private.xlsx'), join(root, 'escape.xlsx'));
    await assert.rejects(
      () => readAnalysisArtifact(root, join(root, 'escape.xlsx'), digest),
      ForbiddenException,
    );
    await assert.rejects(
      () => readAnalysisArtifact(root, '../data.xlsx', digest),
      ForbiddenException,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('analysis feature module resolves the existing shared database without creating another runtime', async () => {
  const database = {
    requireDataSource: () => {
      throw new Error('No database calls in DI test');
    },
  };
  const module = await Test.createTestingModule({ imports: [PersistenceModule, AnalysisModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }))
    .overrideProvider(DatabaseRuntimeService)
    .useValue(database)
    .compile();
  try {
    assert.ok(module.get(AnalysisService));
    assert.equal(module.get(DatabaseRuntimeService), database);
  } finally {
    await module.close();
  }
});
