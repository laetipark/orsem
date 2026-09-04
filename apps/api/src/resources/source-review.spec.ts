import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EffectiveFilingState, ParseStatus, ReviewTaskStatus } from '@orsem/contracts';
import { FilingEntity, ParseRunEntity, ReviewEntity } from '@orsem/database';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { OrsemDataService } from './orsem-data.service';

const reviewId = '00000000-0000-4000-8000-000000000010';
const filingId = '00000000-0000-4000-8000-000000000020';
const runId = '00000000-0000-4000-8000-000000000030';
const adminId = '00000000-0000-4000-8000-000000000040';

function harness(latestId = runId) {
  const review = {
    id: reviewId,
    subjectType: 'FILING',
    subjectId: filingId,
    status: ReviewTaskStatus.OPEN,
    parseRunId: runId,
    dedupeKey: `parse:${runId}`,
  } as ReviewEntity;
  const filing = {
    id: filingId,
    canonicalType: 'D003',
    reportName: '의결권대리행사권유참고서류',
    classificationStatus: 'CONFIRMED',
    effectiveState: EffectiveFilingState.ACTIVE,
  } as FilingEntity;
  const run = {
    id: runId,
    filingId,
    rawSha256: 'a'.repeat(64),
    status: ParseStatus.SUCCEEDED,
    inputType: 'D003',
    extractorType: 'D003',
    resultType: 'D003',
    validationStatus: 'PASSED',
    resultJson: {
      projectionApplied: false,
      parsed: { detailType: 'D003', source: { archiveSha256: 'a'.repeat(64) } },
      crosscheck: { status: 'NOT_APPLICABLE', reason: 'NO_SUMMARY_API_FOR_D003' },
    },
  } as unknown as ParseRunEntity;
  let saveCount = 0;
  const builder = (value: unknown) => ({
    setLock() {
      return this;
    },
    where() {
      return this;
    },
    getOne: async () => value,
  });
  const manager = {
    getRepository(entity: unknown) {
      if (entity === ReviewEntity) return { createQueryBuilder: () => builder(review) };
      if (entity === FilingEntity)
        return { createQueryBuilder: () => builder(filing), findOneBy: async () => filing };
      if (entity === ParseRunEntity)
        return {
          findOneBy: async () => run,
          findOne: async () => ({ id: latestId }),
          save: async () => {
            saveCount += 1;
          },
        };
      throw new Error('unexpected repository');
    },
  };
  const source = {
    getRepository(entity: unknown) {
      if (entity === ReviewEntity) return { findOneBy: async () => review };
      throw new Error('unexpected outer repository');
    },
    transaction: async (work: (value: typeof manager) => unknown) => work(manager),
  };
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    { dataSource: source } as unknown as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
  return {
    service,
    run,
    filing,
    get saveCount() {
      return saveCount;
    },
  };
}

test('source comparison records the exact inactive run and SHA while leaving activation separate', async () => {
  const current = harness();
  const result = await current.service.confirmReviewSource(
    reviewId,
    { confirmed: true, note: '원문 전체와 대조' },
    adminId,
  );
  assert.equal(result.status, ReviewTaskStatus.OPEN);
  assert.equal(result.queued, false);
  assert.equal(current.saveCount, 1);
  assert.deepEqual(current.run.resultJson?.['sourceReview'], {
    confirmedByAdminId: adminId,
    confirmedAt: result.sourceReviewConfirmedAt,
    parseRunId: runId,
    rawSha256: 'a'.repeat(64),
    note: '원문 전체와 대조',
  });
});

test('source comparison refuses an older run and writes no audit record', async () => {
  const current = harness('00000000-0000-4000-8000-000000000099');
  await assert.rejects(
    () => current.service.confirmReviewSource(reviewId, { confirmed: true }, adminId),
    /최신의 유효한 원문/,
  );
  assert.equal(current.saveCount, 0);
  assert.equal(current.run.resultJson?.['sourceReview'], undefined);
});

test('source comparison rejects a parsed payload bound to another source SHA', async () => {
  const current = harness();
  (current.run.resultJson?.parsed as Record<string, unknown>).source = {
    archiveSha256: 'b'.repeat(64),
  };
  await assert.rejects(
    () => current.service.confirmReviewSource(reviewId, { confirmed: true }, adminId),
    /최신의 유효한 원문/,
  );
  assert.equal(current.saveCount, 0);
});

test('source comparison rejects a D004 payload from a different document subtype', async () => {
  const current = harness();
  Object.assign(current.filing, {
    canonicalType: 'D004',
    reportName: '공개매수신고서',
  });
  Object.assign(current.run, {
    inputType: 'D004',
    extractorType: 'D004',
    resultType: 'D004',
  });
  current.run.resultJson = {
    ...current.run.resultJson,
    parsed: {
      detailType: 'D004',
      documentKind: 'EXPLANATION',
      source: { archiveSha256: 'a'.repeat(64) },
    },
    crosscheck: { status: 'NOT_APPLICABLE', reason: 'NO_SUMMARY_API_FOR_D004' },
  };
  await assert.rejects(
    () => current.service.confirmReviewSource(reviewId, { confirmed: true }, adminId),
    /최신의 유효한 원문/,
  );
  assert.equal(current.saveCount, 0);
});

test('active D003 and D004 reads require the exact source review and document subtype', () => {
  const current = harness();
  const predicate = current.service as unknown as {
    isValidActiveParse(filing: FilingEntity, run: ParseRunEntity): boolean;
  };
  Object.assign(current.run, {
    status: ParseStatus.SUCCEEDED,
    validationStatus: 'PASSED',
    resultJson: { ...current.run.resultJson, projectionApplied: true },
  });
  assert.equal(predicate.isValidActiveParse(current.filing, current.run), false);
  current.run.resultJson = {
    ...current.run.resultJson,
    sourceReview: {
      confirmedByAdminId: adminId,
      confirmedAt: '2026-09-04T00:00:00.000Z',
      parseRunId: runId,
      rawSha256: 'a'.repeat(64),
    },
  };
  assert.equal(predicate.isValidActiveParse(current.filing, current.run), true);
  (current.run.resultJson.parsed as Record<string, unknown>).source = {
    archiveSha256: 'b'.repeat(64),
  };
  assert.equal(predicate.isValidActiveParse(current.filing, current.run), false);

  Object.assign(current.filing, {
    canonicalType: 'D004',
    reportName: '공개매수신고서',
  });
  Object.assign(current.run, {
    inputType: 'D004',
    extractorType: 'D004',
    resultType: 'D004',
  });
  current.run.resultJson = {
    ...current.run.resultJson,
    parsed: {
      detailType: 'D004',
      documentKind: 'EXPLANATION',
      source: { archiveSha256: 'a'.repeat(64) },
    },
  };
  assert.equal(predicate.isValidActiveParse(current.filing, current.run), false);
});
