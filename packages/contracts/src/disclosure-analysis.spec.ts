import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisSelectionSchema,
  analysisExportRequestSchema,
  saveAnalysisQuerySchema,
} from './disclosure-analysis';

const companyId = 'c01f4b28-8b9e-4e14-8e40-95c9b1fd3074';
const base = { companyIds: [companyId], rolling: { kind: 'ANNUAL', count: 3 } };

test('analysis defaults preserve a bounded, explicit financial scope and manual refresh', () => {
  const selection = analysisSelectionSchema.parse(base);
  assert.equal(selection.scope, 'CFS');
  assert.equal(selection.basis, 'ANNUAL');
  assert.equal(selection.versionPolicy, 'LATEST_OBSERVED');
  assert.equal(selection.metrics.length, 7);
  assert.equal(saveAnalysisQuerySchema.parse({ name: '비교', selection }).autoRefresh, false);
});

test('analysis rejects ambiguous or unbounded selections and ownership injection', () => {
  for (const input of [
    { ...base, companyIds: [] },
    { ...base, companyIds: [companyId, companyId] },
    { ...base, rolling: { kind: 'QUARTER', count: 10000 } },
    { ...base, periods: [{ year: 2025, reportCode: '11011' }] },
    { ...base, ownerKey: 'ADMIN:another-user' },
    { ...base, versionPolicy: 'SPECIFIC' },
    {
      companyIds: [companyId],
      periods: [
        { year: 2025, reportCode: '11011' },
        { year: 2025, reportCode: '11011' },
      ],
    },
  ])
    assert.equal(analysisSelectionSchema.safeParse(input).success, false);
});

test('exports accept saved document identifiers, never arbitrary paths or URLs', () => {
  assert.deepEqual(analysisExportRequestSchema.parse({}).documentIds, []);
  assert.equal(
    analysisExportRequestSchema.safeParse({ documentIds: ['../../etc/passwd'] }).success,
    false,
  );
  assert.equal(
    analysisExportRequestSchema.safeParse({ objectUri: 'file:///etc/passwd' }).success,
    false,
  );
});
