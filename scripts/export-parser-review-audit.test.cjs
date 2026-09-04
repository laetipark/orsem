'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AuditExportError,
  utcInstant,
  kstInstant,
  sourceDate,
  sourceDates,
  csvCell,
  csv,
  captureSnapshot,
  prepareRows,
  connectionOptions,
  exportAudit,
  QUERIES,
} = require('./export-parser-review-audit.cjs');

function fakeConnection({ violations = [], failures = [], reviews = [], metrics } = {}) {
  const statements = [];
  let rolledBack = false;
  return {
    statements,
    get rolledBack() {
      return rolledBack;
    },
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql === QUERIES.snapshot)
        return [
          [
            {
              snapshot_utc: '2026-09-04 15:00:00.125',
              session_time_zone: '+00:00',
              isolation_level: 'REPEATABLE-READ',
            },
          ],
        ];
      if (sql === QUERIES.clock) return [violations];
      if (sql === QUERIES.failures) return [failures];
      if (sql === QUERIES.reviews) return [reviews];
      if (sql === QUERIES.metrics)
        return [
          metrics ?? [
            {
              metric: 'all_failed_runs',
              count: String(failures.length),
              definition: 'FAILED 이력',
            },
            { metric: 'open_reviews', count: String(reviews.length), definition: 'OPEN 검토' },
          ],
        ];
      return [[]];
    },
    async rollback() {
      rolledBack = true;
      statements.push({ sql: 'ROLLBACK' });
    },
  };
}

const failure = {
  parse_run_id: '00123',
  filing_id: 'f-1',
  company_name: '한글, "기업"\n테스트',
  stock_code: '005930',
  corp_code: '00126380',
  rcept_no: '202609040000000001',
  source: 'OPENDART',
  rcept_date: '2026-09-04',
  run_created_at: '2026-09-04 14:59:59.000',
  run_updated_at: '2026-09-04 15:00:00.000',
  first_observed_at: '2026-09-04 14:58:00.000',
  input_type: 'D002',
  extractor_type: 'D002',
  result_type: null,
  candidate_errors_json: [
    { candidateName: 'main.xml', errorCode: 'INVALID_XML', line: 19, column: 2 },
  ],
};

test('serializes UTC instants once across KST midnight and preserves date-only fields', () => {
  assert.equal(kstInstant('2026-09-04 14:59:59.999'), '2026-09-04T23:59:59.999+09:00');
  assert.equal(kstInstant('2026-09-04 15:00:00.000'), '2026-09-05T00:00:00.000+09:00');
  assert.equal(kstInstant('2026-09-05T00:00:00.000+09:00'), '2026-09-05T00:00:00.000+09:00');
  assert.equal(kstInstant(new Date('2026-09-04T15:00:00Z')), '2026-09-05T00:00:00.000+09:00');
  assert.equal(sourceDate('2026-09-04'), '2026-09-04');
  assert.equal(sourceDate(null), '');
  assert.deepEqual(sourceDates('["2026-09-04",null,"2026-09-05"]'), [
    '2026-09-04',
    null,
    '2026-09-05',
  ]);
  assert.throws(() => sourceDates('["2026-09-04T00:00:00Z"]'), AuditExportError);
  assert.throws(() => utcInstant('2026-09-04'), AuditExportError);
  assert.throws(() => utcInstant('2026-02-30 12:00:00'), AuditExportError);
  assert.throws(() => sourceDate('2026-02-30'), AuditExportError);
  assert.throws(() => sourceDate('2026-99-99'), AuditExportError);
  const rows = prepareRows([failure], '2026-09-04 15:00:00.125');
  assert.equal(rows[0].rcept_date, '2026-09-04');
  assert.equal(rows[0].run_created_at_kst, '2026-09-04T23:59:59.000+09:00');
});

test('CSV preserves Unicode, quote/newline escaping and opaque codes without formulas', () => {
  assert.equal(csvCell('005930', true), '"\'005930"');
  assert.equal(csvCell('202609040000000001', true), '"\'202609040000000001"');
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell('\ufeff =cmd'), '"\'\ufeff =cmd"');
  assert.equal(csvCell('\ttext'), '"\'\ttext"');
  assert.equal(csvCell('한글, "기업"\n둘'), '"한글, ""기업""\n둘"');
  const output = csv([{ code: '000001' }], [{ key: 'code', label: '종목코드', opaque: true }]);
  assert.equal(output, '\ufeff"종목코드"\r\n"\'000001"\r\n');
});

test('uses one read-only repeatable snapshot and reads MVCC data before the reference clock', async () => {
  const db = fakeConnection({ failures: [failure] });
  const result = await captureSnapshot(db);
  assert.deepEqual(
    db.statements.slice(0, 5).map((item) => item.sql),
    [
      "SET SESSION time_zone = '+00:00'",
      'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      QUERIES.firstRead,
      QUERIES.snapshot,
    ],
  );
  assert.equal(db.statements.filter((item) => item.sql.startsWith('START TRANSACTION')).length, 1);
  assert.deepEqual(db.statements.find((item) => item.sql === QUERIES.clock).values, [
    '2026-09-04 15:00:00.125',
  ]);
  assert.equal(db.rolledBack, true);
  assert.equal(result.failures.length, 1);
  assert.equal(
    db.statements.some((item) => /^(?:UPDATE|INSERT|DELETE|COMMIT)\b/u.test(item.sql)),
    false,
  );
  assert.equal(QUERIES.failures.includes('created_at <='), false);
  assert.equal(QUERIES.reviews.includes('created_at <='), false);
});

test('future creation times stop export explicitly, without filtering or producing success files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orsem-export-clock-'));
  const violation = {
    table_name: 'parse_runs',
    row_id: 'bad-clock',
    field_name: 'created_at',
    stored_time: '2026-09-05 00:00:00.000',
  };
  const db = fakeConnection({ violations: [violation] });
  try {
    await assert.rejects(
      exportAudit({ outputDir: directory, connection: db }),
      (error) => error.code === 'EXPORT_CLOCK_ERROR' && error.details.count === 1,
    );
    assert.equal(db.rolledBack, true);
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(
      db.statements.some((item) => item.sql === QUERIES.failures),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects inconsistent detail counts even within a mocked snapshot', async () => {
  const db = fakeConnection({
    failures: [failure],
    metrics: [
      { metric: 'all_failed_runs', count: '0' },
      { metric: 'open_reviews', count: '0' },
    ],
  });
  await assert.rejects(captureSnapshot(db), { code: 'EXPORT_SNAPSHOT_COUNT_MISMATCH' });
  assert.equal(db.rolledBack, true);
});

test('writes private CSVs with stable new integrity fields and a final success manifest', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orsem-export-valid-'));
  const db = fakeConnection({
    failures: [failure],
    reviews: [
      {
        ...failure,
        review_id: 'review-1',
        review_group: 'PARSE',
        review_status: 'OPEN',
        review_created_at: '2026-09-04 14:59:59.125',
        review_updated_at: '2026-09-04 15:00:00.000',
      },
    ],
  });
  try {
    const manifest = await exportAudit({ outputDir: directory, connection: db });
    assert.equal(manifest.snapshot_utc, '2026-09-04T15:00:00.125Z');
    assert.equal(manifest.files[0].rows, 1);
    const output = fs.readFileSync(path.join(directory, 'parser-failures.csv'), 'utf8');
    assert.equal(output.charCodeAt(0), 0xfeff);
    assert.match(output, /후보별실제오류_JSON/u);
    assert.match(output, /"'005930"/u);
    assert.match(output, /INVALID_XML/u);
    assert.match(
      fs.readFileSync(path.join(directory, 'open-reviews.csv'), 'utf8'),
      /대체후속검토_ID/u,
    );
    for (const file of fs.readdirSync(directory))
      assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
    await assert.rejects(exportAudit({ outputDir: directory, connection: db }), {
      code: 'EXPORT_OUTPUT_DIRECTORY_NOT_EMPTY',
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('test database overrides are isolated and do not enable write queries or numeric conversion', () => {
  const config = connectionOptions({
    ORSEM_AUDIT_DATABASE_URL: 'mysql://root@localhost/orsem_integrity_test',
    ORSEM_AUDIT_SOCKET_PATH: '/tmp/orsem-test.sock',
  });
  assert.equal(config.database, 'orsem_integrity_test');
  assert.equal(config.socketPath, '/tmp/orsem-test.sock');
  assert.equal(config.dateStrings, true);
  assert.equal(config.timezone, 'Z');
  assert.equal(config.multipleStatements, false);
  assert.equal(config.decimalNumbers, false);
  assert.throws(() => connectionOptions({ ORSEM_AUDIT_SOCKET_PATH: '/tmp/orsem-test.sock' }), {
    code: 'EXPORT_DATABASE_CONFIG_REQUIRED',
  });
});
