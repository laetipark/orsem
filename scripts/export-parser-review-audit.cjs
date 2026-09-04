#!/usr/bin/env node
'use strict';

// node scripts/export-parser-review-audit.cjs --output-dir /external/parser-review-audit
// Reads DATABASE_URL from process environment or repository .env without logging secrets.
// Test overrides: ORSEM_AUDIT_DATABASE_URL and optional ORSEM_AUDIT_SOCKET_PATH.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepareOutputDirectory } = require('./parser-corpus-audit.cjs');

class AuditExportError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'AuditExportError';
    this.code = code;
    this.details = details;
  }
}

function utcInstant(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value);
  if (typeof value !== 'string') throw new AuditExportError('EXPORT_INVALID_TIMESTAMP');
  const mysql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/u.exec(value);
  const explicit = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
    value,
  );
  if (!mysql && !explicit) throw new AuditExportError('EXPORT_INVALID_TIMESTAMP');
  const iso = mysql ? `${mysql[1]}T${mysql[2]}${mysql[3] ?? ''}Z` : value;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) throw new AuditExportError('EXPORT_INVALID_TIMESTAMP');
  if (mysql && parsed.toISOString().slice(0, 19) !== `${mysql[1]}T${mysql[2]}`)
    throw new AuditExportError('EXPORT_INVALID_TIMESTAMP');
  return parsed;
}

function kstInstant(value) {
  if (value === null || value === undefined || value === '') return '';
  return new Date(utcInstant(value).getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace(/Z$/u, '+09:00');
}

function sourceDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const parsed = typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(parsed?.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new AuditExportError('EXPORT_INVALID_SOURCE_DATE');
  }
  return value;
}

function sourceDates(value) {
  if (value === null || value === undefined) return null;
  let dates;
  try {
    dates = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new AuditExportError('EXPORT_INVALID_SOURCE_DATE');
  }
  if (!Array.isArray(dates)) throw new AuditExportError('EXPORT_INVALID_SOURCE_DATE');
  return dates.map((date) => (date === null ? null : sourceDate(date)));
}

function csvCell(value, opaque = false) {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  // The apostrophe is an explicit reversible text marker, never a spreadsheet formula.
  // It preserves leading zeroes and >15-digit receipt numbers when Excel opens CSV directly.
  if (text && (opaque || /^[\s\ufeff]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)))
    text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

function csv(rows, columns) {
  return (
    '\uFEFF' +
    [
      columns.map((column) => csvCell(column.label)).join(','),
      ...rows.map((row) =>
        columns.map((column) => csvCell(row[column.key], column.opaque)).join(','),
      ),
    ].join('\r\n') +
    '\r\n'
  );
}

const column = (key, label, opaque = false) => ({ key, label, opaque });
const COMMON_COLUMNS = [
  column('snapshot_kst', '기준시각_KST'),
  column('filing_id', '공시_ID', true),
  column('company_name', '기업명'),
  column('market', '시장'),
  column('stock_code', '종목코드', true),
  column('ticker', '티커', true),
  column('corp_code', '고유번호', true),
  column('rcept_no', '접수번호', true),
  column('report_name', '공시제목'),
  column('rcept_date', '접수일_원본날짜'),
  column('source', '원문출처'),
  column('rights_mode', '권리모드'),
  column('source_url', '공시원문링크'),
  column('first_observed_at_kst', '최초관측_KST'),
  column('detail_type', '공시유형_현재저장'),
  column('source_detail_type', '공시유형_원본'),
  column('title_detected_type', '공시유형_제목판정'),
  column('canonical_type', '공시유형_확정'),
  column('document_kind', '문서종류'),
  column('filing_classification_status', '공시분류상태'),
  column('filing_classifier_version', '공시분류버전'),
  column('active_parse_run_id', '활성실행_ID', true),
  column('active_parse_status', '활성실행상태'),
  column('latest_run_id', '최신실행_ID', true),
  column('latest_run_status', '최신실행상태'),
];
const RUN_COLUMNS = [
  column('parse_run_id', '파싱실행_ID', true),
  column('parse_status', '파싱상태'),
  column('input_type', '파싱입력유형'),
  column('extractor_type', '추출기유형'),
  column('result_type', '결과유형'),
  column('validation_status', '검증상태'),
  column('projection_applied', '결과활성화여부'),
  column('report_reason_kind', '보고사유분류'),
  column('report_reason_raw', '보고사유_원문'),
  column('methods_json', '거래방법_원문_JSON'),
  column('natures_json', '거래방법분류_JSON'),
  column('source_review_json', '원문대조기록_JSON'),
  column('before_fields_json', '이전추출값_JSON'),
  column('after_fields_json', '현재추출값_JSON'),
  column('classification_result', '분류판정'),
  column('confidence', '추출신뢰도'),
  column('parser_version', '파서버전'),
  column('normalizer_version', '정규화버전'),
  column('classifier_version', '실행분류버전'),
  column('reuse_fingerprint', '재사용지문', true),
  column('raw_sha256', '원본_SHA256', true),
  column('supersedes_run_id', '대체한실행_ID', true),
  column('superseded_by_run_ids', '이후대체실행_ID들'),
  column('error_code', '오류코드'),
  column('error_message', '오류메시지_저장원본'),
  column('candidate_errors_json', '후보별실제오류_JSON'),
  column('normalization_audits_json', '정규화감사_JSON'),
  column('warnings_json', '추출경고_JSON'),
  column('event_dates_json', '거래일_원본날짜_JSON'),
  column('planned_start_dates_json', '계획시작일_원본날짜_JSON'),
  column('planned_end_dates_json', '계획종료일_원본날짜_JSON'),
  column('run_created_at_kst', '실행생성_KST'),
  column('run_updated_at_kst', '실행갱신_KST'),
  column('started_at_kst', '시작_KST'),
  column('finished_at_kst', '종료_KST'),
];
const FAILURE_COLUMNS = [
  ...COMMON_COLUMNS,
  ...RUN_COLUMNS,
  column('is_latest_run', '최신실행여부'),
  column('has_newer_success', '이후완전성공실행있음'),
  column('open_review_ids', '연결된대기검토_ID들'),
];
const REVIEW_COLUMNS = [
  column('review_id', '검토_ID', true),
  column('review_group', '검토그룹'),
  column('review_status', '검토상태'),
  column('subject_type', '검토대상종류'),
  column('subject_id', '검토대상_ID', true),
  column('reason', '검토사유_저장원본'),
  column('dedupe_key', '검토중복방지키', true),
  column('superseded_by_review_id', '대체후속검토_ID', true),
  column('reopened_from_review_id', '재개이전검토_ID', true),
  column('review_created_at_kst', '검토생성_KST'),
  column('review_updated_at_kst', '검토갱신_KST'),
  ...COMMON_COLUMNS,
  ...RUN_COLUMNS,
  column('relation_type', '공시연결유형'),
  column('related_rcept_no', '연결후보접수번호', true),
];
const METRIC_COLUMNS = [
  column('snapshot_kst', '기준시각_KST'),
  column('metric', '집계항목'),
  column('count', '건수'),
  column('definition', '집계정의'),
];

const RANKED_RUNS = `WITH ranked_runs AS (
  SELECT id,filing_id,status,created_at,ROW_NUMBER() OVER (PARTITION BY filing_id ORDER BY created_at DESC,id DESC) AS rn
  FROM parse_runs
)`;
const COMMON_SELECT = `f.id AS filing_id,c.name_ko AS company_name,c.market,c.stock_code,c.ticker,c.corp_code,
  f.rcept_no,f.report_name,f.rcept_date,f.source,f.first_observed_at,f.detail_type,f.source_detail_type,
  f.title_detected_type,f.canonical_type,
  JSON_UNQUOTE(JSON_EXTRACT(f.classification_provenance_json,'$.documentKind')) AS document_kind,
  f.classification_status AS filing_classification_status,
  f.classifier_version AS filing_classifier_version,f.active_parse_run_id,active.status AS active_parse_status,
  latest.id AS latest_run_id,latest.status AS latest_run_status,d.rights_mode`;
const RUN_SELECT = `p.id AS parse_run_id,p.status AS parse_status,p.input_type,p.extractor_type,p.result_type,
  p.validation_status,p.classification_result,p.confidence,p.parser_version,p.normalizer_version,p.classifier_version,
  p.reuse_fingerprint,p.raw_sha256,p.supersedes_run_id,p.error_code,p.error_message,p.candidate_errors_json,
  p.normalization_audits_json,p.warnings_json,p.created_at AS run_created_at,p.updated_at AS run_updated_at,
  p.started_at,p.finished_at,
  JSON_EXTRACT(p.result_json,'$.projectionApplied') AS projection_applied,
  JSON_UNQUOTE(JSON_EXTRACT(p.result_json,'$.parsed.reportReasonKind')) AS report_reason_kind,
  JSON_UNQUOTE(JSON_EXTRACT(p.result_json,'$.parsed.reportReasonRaw')) AS report_reason_raw,
  COALESCE(JSON_EXTRACT(p.result_json,'$.parsed.transactions[*].methodRaw'),JSON_EXTRACT(p.result_json,'$.parsed.changes[*].methodRaw'),JSON_EXTRACT(p.result_json,'$.parsed.planItems[*].methodRaw')) AS methods_json,
  COALESCE(JSON_EXTRACT(p.result_json,'$.parsed.transactions[*].nature'),JSON_EXTRACT(p.result_json,'$.parsed.planItems[*].nature')) AS natures_json,
  JSON_EXTRACT(p.result_json,'$.sourceReview') AS source_review_json,
  (SELECT JSON_REMOVE(JSON_EXTRACT(previous.result_json,'$.parsed'),'$.source') FROM parse_runs previous WHERE previous.id=p.supersedes_run_id) AS before_fields_json,
  JSON_REMOVE(JSON_EXTRACT(p.result_json,'$.parsed'),'$.source') AS after_fields_json,
  COALESCE(JSON_EXTRACT(p.result_json,'$.parsed.transactions[*].eventDate'),JSON_EXTRACT(p.result_json,'$.parsed.changes[*].eventDate')) AS event_dates_json,
  JSON_EXTRACT(p.result_json,'$.parsed.planItems[*].plannedStartDate') AS planned_start_dates_json,
  JSON_EXTRACT(p.result_json,'$.parsed.planItems[*].plannedEndDate') AS planned_end_dates_json,
  (SELECT JSON_ARRAYAGG(newer.id) FROM parse_runs newer WHERE newer.supersedes_run_id=p.id) AS superseded_by_run_ids`;
const COMMON_JOINS = `LEFT JOIN companies c ON c.id=f.company_id
  LEFT JOIN parse_runs active ON active.id=f.active_parse_run_id
  LEFT JOIN ranked_runs latest ON latest.filing_id=f.id AND latest.rn=1
  LEFT JOIN filing_documents d ON d.filing_id=f.id AND d.sha256=p.raw_sha256`;

const QUERIES = Object.freeze({
  // InnoDB table access establishes the MVCC read view before the reference clock is read.
  firstRead: 'SELECT id FROM parse_runs ORDER BY id LIMIT 1',
  snapshot:
    'SELECT UTC_TIMESTAMP(3) AS snapshot_utc, @@session.time_zone AS session_time_zone, @@session.transaction_isolation AS isolation_level',
  clock: `SELECT table_name,row_id,field_name,stored_time FROM (
    SELECT 'parse_runs' AS table_name,id AS row_id,'created_at' AS field_name,created_at AS stored_time FROM parse_runs
    UNION ALL SELECT 'parse_runs',id,'updated_at',updated_at FROM parse_runs
    UNION ALL SELECT 'parse_runs',id,'started_at',started_at FROM parse_runs
    UNION ALL SELECT 'parse_runs',id,'finished_at',finished_at FROM parse_runs
    UNION ALL SELECT 'reviews',id,'created_at',created_at FROM reviews
    UNION ALL SELECT 'reviews',id,'updated_at',updated_at FROM reviews
  ) clocks WHERE stored_time > ? ORDER BY table_name,row_id,field_name`,
  failures: `${RANKED_RUNS} SELECT ${COMMON_SELECT},${RUN_SELECT},
    (p.id=latest.id) AS is_latest_run,
    EXISTS(SELECT 1 FROM parse_runs newer WHERE newer.filing_id=p.filing_id AND newer.status='SUCCEEDED'
      AND (newer.created_at>p.created_at OR (newer.created_at=p.created_at AND newer.id>p.id))) AS has_newer_success,
    (SELECT JSON_ARRAYAGG(r.id) FROM reviews r WHERE r.parse_run_id=p.id AND r.status='OPEN') AS open_review_ids
    FROM parse_runs p JOIN filings f ON f.id=p.filing_id ${COMMON_JOINS}
    WHERE p.status='FAILED' ORDER BY p.created_at,p.id`,
  reviews: `${RANKED_RUNS} SELECT r.id AS review_id,r.review_group,r.status AS review_status,r.subject_type,r.subject_id,
    r.reason,r.dedupe_key,r.superseded_by_review_id,r.reopened_from_review_id,
    r.created_at AS review_created_at,r.updated_at AS review_updated_at,
    ${COMMON_SELECT},${RUN_SELECT},relation.relation_type,target.rcept_no AS related_rcept_no
    FROM reviews r LEFT JOIN parse_runs p ON p.id=r.parse_run_id
    LEFT JOIN filing_relations relation ON r.subject_type='FILING_RELATION' AND relation.id=r.subject_id
    LEFT JOIN filings f ON f.id=CASE WHEN r.subject_type='FILING' THEN r.subject_id
      WHEN r.subject_type='FILING_RELATION' THEN relation.from_filing_id ELSE p.filing_id END
    LEFT JOIN filings target ON target.id=relation.to_filing_id ${COMMON_JOINS}
    WHERE r.status='OPEN' ORDER BY r.created_at,r.id`,
  metrics: `${RANKED_RUNS}
    SELECT 'all_failed_runs' AS metric,COUNT(*) AS count,'전체 FAILED 실행: 과거 이력 포함' AS definition FROM parse_runs WHERE status='FAILED'
    UNION ALL SELECT 'failed_filings',COUNT(DISTINCT filing_id),'FAILED 실행이 한 번 이상 있는 공시 수' FROM parse_runs WHERE status='FAILED'
    UNION ALL SELECT 'latest_failed_filings',COUNT(*),'공시별 최신 실행이 FAILED인 수: created_at DESC,id DESC' FROM ranked_runs WHERE rn=1 AND status='FAILED'
    UNION ALL SELECT 'latest_partial_filings',COUNT(*),'공시별 최신 실행이 PARTIAL인 수' FROM ranked_runs WHERE rn=1 AND status='PARTIAL'
    UNION ALL SELECT 'latest_succeeded_filings',COUNT(*),'공시별 최신 실행이 SUCCEEDED인 수' FROM ranked_runs WHERE rn=1 AND status='SUCCEEDED'
    UNION ALL SELECT 'active_succeeded_filings',COUNT(*),'활성 실행이 SUCCEEDED인 공시 수' FROM filings f JOIN parse_runs p ON p.id=f.active_parse_run_id WHERE p.status='SUCCEEDED'
    UNION ALL SELECT 'open_reviews',COUNT(*),'현재 OPEN인 전체 검토 수' FROM reviews WHERE status='OPEN'
    UNION ALL SELECT 'open_parse_reviews',COUNT(*),'현재 OPEN이며 review_group=PARSE인 검토 수' FROM reviews WHERE status='OPEN' AND review_group='PARSE'
    UNION ALL SELECT 'open_document_reviews',COUNT(*),'현재 OPEN이며 review_group=DOCUMENT인 검토 수' FROM reviews WHERE status='OPEN' AND review_group='DOCUMENT'
    UNION ALL SELECT 'open_relation_reviews',COUNT(*),'현재 OPEN인 공시 연결 검토 수' FROM reviews WHERE status='OPEN' AND subject_type='FILING_RELATION'
    UNION ALL SELECT 'open_failed_parse_reviews',COUNT(*),'OPEN 검토 중 연결된 실행이 FAILED인 수: 실패 CSV와 중복' FROM reviews r JOIN parse_runs p ON p.id=r.parse_run_id WHERE r.status='OPEN' AND p.status='FAILED'
    UNION ALL SELECT 'all_parse_runs',COUNT(*),'전체 파싱 실행 수' FROM parse_runs
    UNION ALL SELECT 'filings_with_parse_runs',COUNT(*),'실행이 있는 공시 수' FROM ranked_runs WHERE rn=1`,
});

async function captureSnapshot(connection) {
  let transaction = false;
  try {
    await connection.query("SET SESSION time_zone = '+00:00'");
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    transaction = true;
    await connection.query(QUERIES.firstRead);
    const [[clock]] = await connection.query(QUERIES.snapshot);
    if (clock?.session_time_zone !== '+00:00' || clock?.isolation_level !== 'REPEATABLE-READ')
      throw new AuditExportError('EXPORT_SNAPSHOT_SESSION_INVALID');
    utcInstant(clock.snapshot_utc);
    const [violations] = await connection.query(QUERIES.clock, [clock.snapshot_utc]);
    if (violations.length)
      throw new AuditExportError('EXPORT_CLOCK_ERROR', {
        count: violations.length,
        violations: violations.slice(0, 20),
      });
    const [failures] = await connection.query(QUERIES.failures);
    const [reviews] = await connection.query(QUERIES.reviews);
    const [metrics] = await connection.query(QUERIES.metrics);
    if (
      Number(metrics.find((item) => item.metric === 'all_failed_runs')?.count) !==
        failures.length ||
      Number(metrics.find((item) => item.metric === 'open_reviews')?.count) !== reviews.length
    )
      throw new AuditExportError('EXPORT_SNAPSHOT_COUNT_MISMATCH');
    return { snapshot_utc: clock.snapshot_utc, failures, reviews, metrics };
  } finally {
    if (transaction) await connection.rollback();
  }
}

function prepareRows(rows, snapshotUtc) {
  const reference = utcInstant(snapshotUtc).getTime();
  return rows.map((row) => {
    for (const key of [
      'run_created_at',
      'run_updated_at',
      'started_at',
      'finished_at',
      'review_created_at',
      'review_updated_at',
    ]) {
      if (row[key] && utcInstant(row[key]).getTime() > reference)
        throw new AuditExportError('EXPORT_CLOCK_ERROR', {
          field: key,
          id: row.parse_run_id ?? row.review_id,
        });
    }
    const result = {
      ...row,
      snapshot_kst: kstInstant(snapshotUtc),
      rcept_date: sourceDate(row.rcept_date),
      event_dates_json: sourceDates(row.event_dates_json),
      planned_start_dates_json: sourceDates(row.planned_start_dates_json),
      planned_end_dates_json: sourceDates(row.planned_end_dates_json),
      source_url:
        row.source === 'OPENDART' && row.rcept_no
          ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(row.rcept_no)}`
          : '',
    };
    for (const key of [
      'first_observed_at',
      'run_created_at',
      'run_updated_at',
      'started_at',
      'finished_at',
      'review_created_at',
      'review_updated_at',
    ])
      result[`${key}_kst`] = kstInstant(row[key]);
    return result;
  });
}

function connectionOptions(env = process.env) {
  const envPath = path.join(__dirname, '../.env');
  const file = fs.existsSync(envPath) ? require('dotenv').parse(fs.readFileSync(envPath)) : {};
  const value = env.ORSEM_AUDIT_DATABASE_URL ?? env.DATABASE_URL ?? file.DATABASE_URL;
  if (!value || (env.ORSEM_AUDIT_SOCKET_PATH && !env.ORSEM_AUDIT_DATABASE_URL))
    throw new AuditExportError('EXPORT_DATABASE_CONFIG_REQUIRED');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AuditExportError('EXPORT_DATABASE_CONFIG_INVALID');
  }
  if (url.protocol !== 'mysql:' || !url.pathname.slice(1))
    throw new AuditExportError('EXPORT_DATABASE_CONFIG_INVALID');
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ...(env.ORSEM_AUDIT_SOCKET_PATH ? { socketPath: env.ORSEM_AUDIT_SOCKET_PATH } : {}),
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    charset: 'utf8mb4',
    connectTimeout: 10_000,
  };
}

function outputFile(directory, filename, contents) {
  const descriptor = fs.openSync(
    path.join(directory, filename),
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, contents);
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    file: filename,
    bytes: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

async function exportAudit({ outputDir, connection, env = process.env }) {
  // A unique run directory prevents a failed attempt from resembling an earlier successful export.
  const directory = prepareOutputDirectory(outputDir);
  if (fs.readdirSync(directory).length)
    throw new AuditExportError('EXPORT_OUTPUT_DIRECTORY_NOT_EMPTY');
  let owned;
  try {
    const db =
      connection ??
      (owned = await require('mysql2/promise').createConnection(connectionOptions(env)));
    const snapshot = await captureSnapshot(db);
    const failures = prepareRows(snapshot.failures, snapshot.snapshot_utc);
    const reviews = prepareRows(snapshot.reviews, snapshot.snapshot_utc);
    const metrics = snapshot.metrics.map((row) => ({
      ...row,
      snapshot_kst: kstInstant(snapshot.snapshot_utc),
    }));
    const payloads = [
      ['parser-failures.csv', csv(failures, FAILURE_COLUMNS), failures.length, FAILURE_COLUMNS],
      ['open-reviews.csv', csv(reviews, REVIEW_COLUMNS), reviews.length, REVIEW_COLUMNS],
      ['latest-metrics.csv', csv(metrics, METRIC_COLUMNS), metrics.length, METRIC_COLUMNS],
    ];
    const manifest = {
      version: 'parser-review-audit-v1',
      snapshot_utc: utcInstant(snapshot.snapshot_utc).toISOString(),
      snapshot_kst: kstInstant(snapshot.snapshot_utc),
      transaction: 'READ ONLY / REPEATABLE READ / MVCC established before reference clock',
      session_time_zone: '+00:00',
      instant_encoding:
        'UTC persisted instants converted once to ISO 8601 +09:00; source date-only values unchanged',
      csv_encoding:
        'UTF-8 BOM, quoted cells, CRLF; opaque columns have an apostrophe text marker; formulas neutralized with an apostrophe',
      note: 'All historical FAILED runs are included. Latest metrics use one run per filing ordered by created_at DESC,id DESC. OPEN reviews overlap failures; do not add these counts.',
      files: payloads.map(([filename, contents, count, columns]) => ({
        file: filename,
        rows: count,
        sha256: createHash('sha256').update(contents).digest('hex'),
        opaque_text_columns: columns.filter((item) => item.opaque).map((item) => item.label),
      })),
    };
    for (const [filename, contents] of payloads) outputFile(directory, filename, contents);
    outputFile(directory, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    if (owned) await owned.end();
  }
}

module.exports = {
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
};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output-dir') {
    process.stderr.write(
      'Usage: node scripts/export-parser-review-audit.cjs --output-dir /external/empty-directory\n',
    );
    process.exitCode = 1;
  } else {
    exportAudit({ outputDir: path.resolve(args[1]) })
      .then((manifest) =>
        process.stdout.write(
          JSON.stringify(
            {
              snapshot_kst: manifest.snapshot_kst,
              files: manifest.files.map(({ file, rows }) => ({ file, rows })),
            },
            null,
            2,
          ) + '\n',
        ),
      )
      .catch((error) => {
        const code = error instanceof AuditExportError ? error.code : 'EXPORT_FAILED';
        const details = error instanceof AuditExportError ? error.details : {};
        // Never log the driver error, connection URL, credentials or raw provider responses.
        process.stderr.write(JSON.stringify({ code, ...details }) + '\n');
        process.exitCode = 1;
      });
  }
}
