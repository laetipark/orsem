'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const {
  fieldDifferences,
  fieldMap,
  provenanceAudit,
  csv,
  prepareOutputDirectory,
  auditCorpus,
} = require('./parser-corpus-audit.cjs');

test('type changes do not report misleading numerical gains', () => {
  assert.deepEqual(
    fieldDifferences(
      { detailType: 'D005', planItems: [] },
      { detailType: 'D002', transactions: [{ quantity: '5' }] },
    ),
    { status: 'TYPE_CHANGED', fields: [] },
  );
  assert.deepEqual(
    fieldDifferences(
      { detailType: 'D002', transactions: [{ quantity: '1' }] },
      { detailType: 'D002', transactions: [{ quantity: '2' }] },
    ).fields,
    [{ field: 'transactions[0].quantity', previous: '1', current: '2' }],
  );
});

test('audit hashes source text while retaining decimal strings and source coordinates', () => {
  const parsed = {
    detailType: 'D002',
    reporterName: 'sensitive person',
    transactions: [
      {
        quantity: '001.2500',
        methodRaw: 'sensitive method',
        provenance: {
          quantity: {
            sourceEntryName: 'main.xml',
            tableIndex: 1,
            rowIndex: 2,
            columnIndex: 3,
            sourceRowIndex: 2,
            sourceColumnIndex: 1,
            headerPath: ['sensitive header'],
            rawText: 'sensitive raw text',
          },
        },
      },
    ],
  };
  const fields = fieldMap(parsed);
  assert.equal(fields['transactions[0].quantity'], '001.2500');
  assert.equal(JSON.stringify(fields).includes('sensitive'), false);
  const evidence = provenanceAudit(parsed);
  assert.equal(evidence[0].table_index, 1);
  assert.equal(evidence[0].field, 'transactions[0].quantity');
  assert.equal(JSON.stringify(evidence).includes('sensitive'), false);
  assert.match(
    csv([{ id: '000012', formula: '=cmd', text: 'one,"two"' }], ['id', 'formula', 'text']),
    /"000012","'=cmd","one,""two"""/u,
  );
});

test('rejects repository output, including through an external symlink', () => {
  assert.throws(
    () => prepareOutputDirectory(path.join(__dirname, 'audit-output')),
    /outside the repository/u,
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orsem-audit-symlink-'));
  try {
    fs.symlinkSync(__dirname, path.join(directory, 'redirect'));
    assert.throws(
      () => prepareOutputDirectory(path.join(directory, 'redirect', 'audit-output')),
      /outside the repository/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('audits every supported variant and sends a mismatched D003 source to review', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orsem-corpus-test-'));
  try {
    const bytes = zipSync({
      'main.xml': fs.readFileSync(
        path.join(__dirname, '../packages/opendart-parser/test/fixtures/d002.xml'),
      ),
    });
    const sha = createHash('sha256').update(bytes).digest('hex');
    const rawPath = path.join(directory, 'raw.zip');
    fs.writeFileSync(rawPath, bytes);
    const snapshot = {
      runs: [
        { id: 'run-1', filing_id: 'filing-1', raw_sha256: sha, status: 'PARTIAL' },
        { id: 'run-2', filing_id: 'filing-2', raw_sha256: sha, status: 'FAILED' },
      ],
      filings: [
        {
          id: 'filing-1',
          rcept_no: '00000001',
          report_name: '임원ㆍ주요주주특정증권등소유상황보고서',
          detail_type: 'D005',
        },
        {
          id: 'filing-2',
          rcept_no: '00000002',
          report_name: '의결권대리행사권유참고서류',
          detail_type: 'D005',
        },
      ],
      documents: ['filing-1', 'filing-2'].map((id) => ({
        id: `doc-${id}`,
        filing_id: id,
        sha256: sha,
        object_uri: pathToFileURL(rawPath).href,
        byte_size: String(bytes.length),
      })),
    };
    const snapshotPath = path.join(directory, 'snapshot.json');
    const baselinePath = path.join(directory, 'old-results.json');
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    fs.writeFileSync(
      baselinePath,
      JSON.stringify([
        { id: 'run-1', result_json: { parsed: { detailType: 'D005', planItems: [] } } },
      ]),
    );
    const output = path.join(directory, 'output');
    const summary = await auditCorpus({
      '--snapshot': snapshotPath,
      '--old-results': baselinePath,
      '--output-dir': output,
    });
    assert.equal(summary.runs, 2);
    assert.equal(summary.sources_verified, 2);
    assert.equal(summary.sources_unchanged, 2);
    assert.equal(summary.all_candidates_strict_valid, 2);
    const rows = JSON.parse(fs.readFileSync(path.join(output, 'corpus-audit.json'))).runs;
    assert.equal(rows[0].canonical_type, 'D002');
    assert.equal(rows[0].type_invariant, true);
    assert.equal(rows[0].field_diff.status, 'TYPE_CHANGED');
    assert.equal(rows[1].outcome, 'REVIEW_REQUIRED');
    assert.equal(rows[1].result_type, 'D003');
    assert.equal(rows[1].current_row_count, 0);
    assert.equal(rows[1].fields.detailType, 'D003');
    assert.equal(rows[1].fields['agendas.length'], 0);
    assert.equal(rows[1].normalization[0].strict_valid, true);
    assert.equal(fs.statSync(path.join(output, 'corpus-audit.json')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(rawPath), Buffer.from(bytes));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
