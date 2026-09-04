'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const parser = require('@orsem/opendart-parser');
const { OPENDART_CLASSIFIER_VERSION, classifyOpenDartFiling } = require('@orsem/contracts');
const {
  parseArguments,
  fingerprint,
  sourceOrder,
  stageCorpus,
  applyFiling,
} = require('./stage-parser-corpus.cjs');
const sha = (value) => createHash('sha256').update(value).digest('hex');

test('mixed reuse cannot make an older SHA the latest and releases the company lock without writes', async () => {
  const filing = {
    id: 'filing',
    company_id: 'company',
    rcept_no: 'receipt',
    report_name: '임원ㆍ주요주주특정증권등소유상황보고서',
  };
  const resolved = classifyOpenDartFiling({ reportName: filing.report_name });
  const older = {
    filing,
    resolved,
    reuse: 'old-fingerprint',
    previous: { id: 'old-run', started_at: '2026-09-01' },
    document: { id: 'doc-a', sha256: 'old-sha', retrieved_at: '2026-09-01' },
  };
  const newer = {
    filing,
    resolved,
    reuse: 'new-fingerprint',
    previous: { id: 'new-run', started_at: '2026-09-02' },
    document: { id: 'doc-b', sha256: 'new-sha', retrieved_at: '2026-09-02' },
  };
  const queries = [];
  let rollbacks = 0;
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {
      throw new Error('must not commit');
    },
    rollback: async () => {
      rollbacks += 1;
    },
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT * FROM filings ')) return [[filing]];
      if (sql.includes('FROM filing_documents')) return [[newer.document, older.document]];
      if (sql.includes('FROM parse_runs')) return [[{ reuse_fingerprint: newer.reuse }]];
      throw new Error('unexpected query');
    },
  };
  await assert.rejects(
    applyFiling(connection, [older, newer], 'audit'),
    /MIXED_REUSE_WOULD_REORDER_SOURCE/u,
  );
  assert.equal(rollbacks, 1);
  assert.equal(
    queries.some((sql) => /^(INSERT|UPDATE|DELETE)/u.test(sql)),
    false,
  );
  assert.match(queries[0], /GET_LOCK/u);
  assert.match(queries.at(-1), /RELEASE_LOCK/u);
});

test('staging defaults to offline dry-run and requires explicit apply', () => {
  const args = [
    '--snapshot',
    '/tmp/snapshot.json',
    '--corpus',
    '/tmp/corpus.json',
    '--output-dir',
    '/tmp/output',
  ];
  assert.equal(parseArguments(args).apply, false);
  assert.equal(parseArguments([...args, '--apply']).apply, true);
  assert.throws(() => parseArguments([...args, '--activate']), /Expected/u);
  assert.notEqual(fingerprint('a'.repeat(64), 'D002'), fingerprint('a'.repeat(64), 'D005'));
});

test('source ordering retains newest observed SHA even when old run IDs sort differently', () => {
  const older = {
    document: { retrieved_at: '2026-09-03 00:00:00' },
    previous: { started_at: '2026-09-05', id: 'z' },
  };
  const newer = {
    document: { retrieved_at: '2026-09-04 00:00:00' },
    previous: { started_at: '2026-09-01', id: 'a' },
  };
  assert.deepEqual([newer, older].sort(sourceOrder), [older, newer]);
});

test('revalidation writes an inactive quality manifest without connecting to a database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orsem-stage-test-'));
  try {
    const bytes = zipSync({
      'main.xml': fs.readFileSync(
        path.join(__dirname, '../packages/opendart-parser/test/fixtures/d002.xml'),
      ),
    });
    const sourcePath = path.join(directory, 'raw.zip');
    fs.writeFileSync(sourcePath, bytes);
    const rawSha = sha(bytes);
    const snapshot = {
      runs: [{ id: 'old', filing_id: 'filing', raw_sha256: rawSha, started_at: '2026-09-01' }],
      filings: [
        {
          id: 'filing',
          rcept_no: '0001',
          report_name: '임원ㆍ주요주주특정증권등소유상황보고서',
          detail_type: 'D005',
          active_parse_run_id: 'old-active',
        },
      ],
      documents: [
        {
          id: 'doc',
          filing_id: 'filing',
          sha256: rawSha,
          object_uri: pathToFileURL(sourcePath).href,
          byte_size: bytes.length,
          rights_mode: 'OFFICIAL_PUBLIC_DATA',
          retrieved_at: '2026-09-01',
        },
      ],
    };
    const snapshotFile = path.join(directory, 'snapshot.json');
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
    const corpusFile = path.join(directory, 'corpus.json');
    fs.writeFileSync(
      corpusFile,
      JSON.stringify({
        summary: {
          snapshot_sha256: sha(fs.readFileSync(snapshotFile)),
          parser_version: parser.OPENDART_PARSER_VERSION,
          normalizer_version: parser.OPENDART_NORMALIZER_VERSION,
          classifier_version: OPENDART_CLASSIFIER_VERSION,
        },
        runs: [
          {
            run_id: 'old',
            raw_sha256: rawSha,
            source_verified: true,
            source_unchanged: true,
            reuse_fingerprint: fingerprint(rawSha, 'D002'),
          },
        ],
      }),
    );
    const options = {
      '--snapshot': snapshotFile,
      '--corpus': corpusFile,
      '--output-dir': path.join(directory, 'output'),
      apply: false,
    };
    const result = await stageCorpus(options, {
      ORSEM_STAGE_DATABASE_URL: 'invalid://must-not-connect',
    });
    assert.equal(result.activated, 0);
    assert.equal(result.inserted, 0);
    assert.equal(result.statusCounts.PARTIAL, 1);
    const [candidate] = JSON.parse(
      fs.readFileSync(path.join(options['--output-dir'], 'staging-candidates.json')),
    );
    assert.equal(candidate.projectionApplied, false);
    assert.equal(candidate.protectedActiveParseRunId, 'old-active');
    assert.equal(candidate.classification.canonicalType, 'D002');
    assert.equal(candidate.crosscheck.status, 'NOT_RUN');
    assert.equal(candidate.parsed.detailType, 'D002');
    assert.equal(
      fs.statSync(path.join(options['--output-dir'], 'staging-candidates.json')).mode & 0o777,
      0o600,
    );
    fs.writeFileSync(sourcePath, 'tampered');
    await assert.rejects(
      stageCorpus({ ...options, '--output-dir': path.join(directory, 'tampered-output') }),
      /SOURCE_SHA_MISMATCH/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
