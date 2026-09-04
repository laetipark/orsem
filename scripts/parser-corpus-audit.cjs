#!/usr/bin/env node
'use strict';

// Read-only offline audit. Raw filings, result files and credentials never enter the repository.
// node scripts/parser-corpus-audit.cjs --snapshot /external/snapshot.json \
//   --old-results /external/old-results.json --output-dir /external/audit-output
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const repository = path.resolve(__dirname, '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const countBy = (values) => {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!['--snapshot', '--old-results', '--output-dir'].includes(name) || !argv[index + 1]) {
      throw new Error('Expected --snapshot FILE --old-results FILE --output-dir DIRECTORY.');
    }
    if (options[name]) throw new Error(`Duplicate argument: ${name}`);
    options[name] = path.resolve(argv[index + 1]);
  }
  for (const name of ['--snapshot', '--old-results', '--output-dir']) {
    if (!options[name]) throw new Error(`Missing argument: ${name}`);
  }
  return options;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function prepareOutputDirectory(directory) {
  // Check existing ancestors before mkdir so a repository symlink cannot redirect the output.
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const physical = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, directory));
  if (isWithin(fs.realpathSync(repository), physical)) {
    throw new Error('Audit output must be outside the repository.');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return fs.realpathSync(directory);
}

function writePrivate(directory, filename, contents) {
  const target = path.join(directory, filename);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link output: ${filename}`);
  }
  const descriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, contents);
  } finally {
    fs.closeSync(descriptor);
  }
}

function loadSourceModules() {
  const localRequire = createRequire(path.join(repository, 'package.json'));
  const ts = localRequire('typescript');
  // Use the exact checked-out source, without emitting dist files or importing a running app.
  require.extensions['.ts'] = (module, filename) => {
    if (!isWithin(repository, fs.realpathSync(filename)))
      throw new Error('TypeScript source outside repository.');
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
      fileName: filename,
    });
    module._compile(compiled.outputText, filename);
  };
  return {
    parser: require(path.join(repository, 'packages/opendart-parser/src/index.ts')),
    classification: require(
      path.join(repository, 'packages/contracts/src/filing-classification.ts'),
    ),
    validator: localRequire('fast-xml-parser').XMLValidator,
  };
}

function rowsOf(parsed) {
  return parsed?.transactions ?? parsed?.changes ?? parsed?.planItems ?? [];
}

function warningsOf(parsed) {
  return [
    ...new Set(
      [...(parsed?.warnings ?? []), ...rowsOf(parsed).flatMap((row) => row.warnings ?? [])].map(
        (warning) => warning.code,
      ),
    ),
  ].sort();
}

function confidenceOf(parsed) {
  const rows = rowsOf(parsed);
  const rowsConfidence =
    parsed.detailType === 'D001'
      ? rows.length
        ? 0.8
        : 0.5
      : parsed.detailType === 'D002'
        ? rows.length
          ? Math.min(...rows.map((row) => row.confidence))
          : 0
        : rows.length
          ? Math.min(...rows.map((row) => (row.nature === 'UNKNOWN' ? 0.25 : 0.9)))
          : 0;
  return Math.min(parsed.confidence ?? 1, rowsConfidence);
}

const OMITTED_FIELDS = new Set([
  'source',
  'warnings',
  'provenance',
  'parserVersion',
  'tablesScanned',
]);
// Source prose is represented by hashes, never copied into the audit export.
const TEXT_FIELDS = /Raw$|Name$|^reporterName$|^headerPath$/u;
function fieldMap(value, prefix = '', output = {}) {
  if (Array.isArray(value)) {
    output[`${prefix}.length`] = value.length;
    value.forEach((item, index) => fieldMap(item, `${prefix}[${index}]`, output));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (OMITTED_FIELDS.has(key)) continue;
      const field = prefix ? `${prefix}.${key}` : key;
      if (TEXT_FIELDS.test(key) && typeof child === 'string') {
        output[field] = { sha256: hash(child), characters: child.length };
      } else fieldMap(child, field, output);
    }
  } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
    output[prefix] = value;
  return output;
}

function fieldDifferences(previous, current) {
  if (!previous) return { status: 'NO_BASELINE', fields: [] };
  if (previous.detailType !== current.detailType) return { status: 'TYPE_CHANGED', fields: [] };
  const before = fieldMap(previous);
  const after = fieldMap(current);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .flatMap((field) => {
      const oldValue = before[field] ?? null;
      const newValue = after[field] ?? null;
      return JSON.stringify(oldValue) === JSON.stringify(newValue)
        ? []
        : [{ field, previous: oldValue, current: newValue }];
    });
  return { status: fields.length ? 'CHANGED' : 'UNCHANGED', fields };
}

function provenanceAudit(parsed) {
  const fields = [];
  const visit = (value, prefix = '') => {
    if (Array.isArray(value))
      return value.forEach((item, index) => visit(item, `${prefix}[${index}]`));
    if (!value || typeof value !== 'object') return;
    if (value.provenance) {
      for (const [name, source] of Object.entries(value.provenance)) {
        fields.push({
          field: prefix ? `${prefix}.${name}` : name,
          source_entry_name: source.sourceEntryName,
          table_index: source.tableIndex,
          row_index: source.rowIndex,
          column_index: source.columnIndex,
          source_row_index: source.sourceRowIndex,
          source_column_index: source.sourceColumnIndex,
          source_path: source.sourcePath,
          header_path_sha256: hash(JSON.stringify(source.headerPath)),
          raw_text_sha256: hash(source.rawText),
          raw_text_characters: source.rawText.length,
        });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!OMITTED_FIELDS.has(key)) visit(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  visit(parsed);
  return fields;
}

function csvCell(value) {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  // Preserve CSV text while neutralizing spreadsheet formulas in user/provider supplied cells.
  return `"${(/^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
}
function csv(rows, columns) {
  return (
    '\uFEFF' +
    [columns, ...rows.map((row) => columns.map((column) => row[column]))]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') +
    '\r\n'
  );
}

async function auditCorpus(options) {
  const output = prepareOutputDirectory(options['--output-dir']);
  const snapshotBytes = fs.readFileSync(options['--snapshot']);
  const oldBytes = fs.readFileSync(options['--old-results']);
  const snapshot = JSON.parse(snapshotBytes);
  const baseline = new Map(
    JSON.parse(oldBytes).map((row) => [row.id, json(row.result_json)?.parsed ?? null]),
  );
  const filings = new Map(snapshot.filings.map((filing) => [filing.id, filing]));
  const documents = new Map(
    snapshot.documents.map((document) => [`${document.filing_id}:${document.sha256}`, document]),
  );
  const { parser, classification, validator } = loadSourceModules();
  const rows = [];
  for (const run of snapshot.runs) {
    const filing = filings.get(run.filing_id);
    const document = documents.get(`${run.filing_id}:${run.raw_sha256}`);
    const previous = baseline.get(run.id);
    const resolved = classification.classifyOpenDartFiling({
      reportName: filing?.report_name ?? '',
      queryDetailType: filing?.detail_type ?? null,
    });
    const row = {
      run_id: run.id,
      filing_id: run.filing_id,
      rcept_no: filing?.rcept_no ?? null,
      raw_sha256: run.raw_sha256,
      raw_document_id: document?.id ?? null,
      old_status: run.status,
      stored_filing_type: filing?.detail_type ?? null,
      previous_result_type: previous?.detailType ?? null,
      title_detected_type: resolved.titleDetectedType,
      canonical_type: resolved.canonicalType,
      classification_status: resolved.classificationStatus,
      classifier_version: resolved.classifierVersion,
      parser_version: parser.OPENDART_PARSER_VERSION,
      normalizer_version: parser.OPENDART_NORMALIZER_VERSION,
      reuse_fingerprint: hash(
        JSON.stringify([
          run.raw_sha256,
          parser.OPENDART_PARSER_VERSION,
          parser.OPENDART_NORMALIZER_VERSION,
          resolved.classifierVersion,
          resolved.canonicalType,
        ]),
      ),
      source_verified: false,
      source_unchanged: false,
      normalization: [],
      previous_row_count: rowsOf(previous).length,
    };
    let sourcePath;
    try {
      if (!filing || !document) throw new Error('SNAPSHOT_REFERENCE_MISSING');
      if (!document.object_uri.startsWith('file:'))
        throw new Error('ONLY_LOCAL_SOURCE_FILES_ALLOWED');
      sourcePath = fileURLToPath(document.object_uri);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile() || stat.size > parser.DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes)
        throw new Error('SOURCE_FILE_SIZE_LIMIT');
      const bytes = fs.readFileSync(sourcePath);
      row.source_verified =
        hash(bytes) === run.raw_sha256 &&
        hash(bytes) === document.sha256 &&
        bytes.length === Number(document.byte_size);
      if (!row.source_verified) throw new Error('SOURCE_INTEGRITY_MISMATCH');
      const archive = await parser.readOpenDartArchive(bytes);
      row.archive_entries = archive.entriesSeen;
      for (const candidate of archive.xmlCandidates) {
        try {
          const normalized = parser.normalizeOpenDartXml(
            candidate.xml,
            candidate.entryName,
            candidate.sha256,
          );
          const second = parser.normalizeOpenDartXml(normalized.xml, candidate.entryName);
          row.normalization.push({
            candidate_name: candidate.entryName,
            candidate_sha256: candidate.sha256,
            strict_valid:
              validator.validate(normalized.xml, { allowBooleanAttributes: false }) === true,
            idempotent: second.xml === normalized.xml && second.audit.status === 'UNCHANGED',
            audit: normalized.audit,
          });
        } catch (error) {
          row.normalization.push({
            candidate_name: candidate.entryName,
            candidate_sha256: candidate.sha256,
            strict_valid: false,
            idempotent: false,
            error_code: error.code ?? 'NORMALIZATION_FAILED',
            audit: error.normalizationAudit ?? null,
          });
        }
      }
      if (resolved.classificationStatus === 'UNSUPPORTED') {
        row.outcome = 'SKIPPED_UNSUPPORTED';
      } else if (
        !['CONFIRMED', 'MANUAL_OVERRIDE'].includes(resolved.classificationStatus) ||
        !classification.isSupportedFilingType(resolved.canonicalType)
      ) {
        row.outcome = 'REVIEW_REQUIRED_TYPE';
      } else {
        const parsed = await parser.parseOpenDartDisclosure({
          archive: bytes,
          detailType: resolved.canonicalType,
        });
        row.result_type = parsed.detailType;
        row.type_invariant = classification.hasParseTypeInvariant({
          canonicalType: resolved.canonicalType,
          classificationStatus: resolved.classificationStatus,
          inputType: resolved.canonicalType,
          extractorType: resolved.canonicalType,
          resultType: parsed.detailType,
        });
        row.current_row_count = rowsOf(parsed).length;
        row.confidence = confidenceOf(parsed);
        row.warning_codes = warningsOf(parsed);
        row.outcome =
          !row.type_invariant ||
          row.confidence < 0.8 ||
          row.warning_codes.some(
            (code) => !['NO_RECOGNIZED_DISCLOSURE_TABLE', 'XML_CANDIDATE_REJECTED'].includes(code),
          )
            ? 'REVIEW_REQUIRED'
            : 'EXTRACTED';
        row.field_diff = fieldDifferences(previous, parsed);
        row.fields = fieldMap(parsed);
        row.provenance = provenanceAudit(parsed);
        row.candidate_errors = parsed.source.candidateErrors ?? [];
        row.tables_scanned = parsed.tablesScanned;
      }
    } catch (error) {
      row.outcome = 'FAILED';
      row.error_code = error.code ?? error.message ?? 'AUDIT_FAILED';
      row.candidate_errors = error.candidateErrors ?? [];
    }
    if (sourcePath && row.source_verified)
      row.source_unchanged = hash(fs.readFileSync(sourcePath)) === run.raw_sha256;
    rows.push(row);
    if (rows.length % 100 === 0)
      process.stderr.write(`Audited ${rows.length}/${snapshot.runs.length} variants\n`);
  }
  const summary = {
    generated_at: new Date().toISOString(),
    snapshot_sha256: hash(snapshotBytes),
    old_results_sha256: hash(oldBytes),
    parser_version: parser.OPENDART_PARSER_VERSION,
    normalizer_version: parser.OPENDART_NORMALIZER_VERSION,
    classifier_version: classification.OPENDART_CLASSIFIER_VERSION,
    runs: rows.length,
    unique_filings: new Set(rows.map((row) => row.filing_id)).size,
    original_status_counts: countBy(rows.map((row) => row.old_status)),
    outcomes: countBy(rows.map((row) => row.outcome)),
    canonical_type_counts: countBy(rows.map((row) => row.canonical_type ?? 'UNKNOWN')),
    sources_verified: rows.filter((row) => row.source_verified).length,
    sources_unchanged: rows.filter((row) => row.source_unchanged).length,
    all_candidates_strict_valid: rows.filter(
      (row) =>
        row.normalization.length && row.normalization.every((candidate) => candidate.strict_valid),
    ).length,
    all_candidates_idempotent: rows.filter(
      (row) =>
        row.normalization.length && row.normalization.every((candidate) => candidate.idempotent),
    ).length,
    normalized_variants: rows.filter((row) =>
      row.normalization.some((candidate) => candidate.audit?.status === 'NORMALIZED'),
    ).length,
    former_failed: countBy(
      rows.filter((row) => row.old_status === 'FAILED').map((row) => row.outcome),
    ),
    field_comparison_counts: countBy(rows.map((row) => row.field_diff?.status ?? 'NOT_PARSED')),
    note: 'Offline parser evidence only. No DB writes, network crosschecks, projection, notifications or production status changes. Extracted row count increases do not prove accuracy. Prose and raw field text are hashed. CSV identifiers should be imported as text.',
  };
  writePrivate(output, 'corpus-audit.json', JSON.stringify({ summary, runs: rows }, null, 2));
  writePrivate(
    output,
    'corpus-audit.csv',
    csv(
      rows.map((row) => ({
        ...row,
        strict_valid: row.normalization.every((candidate) => candidate.strict_valid),
        idempotent: row.normalization.every((candidate) => candidate.idempotent),
        normalization_statuses: row.normalization.map(
          (candidate) => candidate.audit?.status ?? 'FAILED',
        ),
        diff_status: row.field_diff?.status ?? null,
        changed_fields: row.field_diff?.fields.length ?? null,
        provenance_fields: row.provenance?.length ?? null,
      })),
      [
        'run_id',
        'filing_id',
        'rcept_no',
        'raw_sha256',
        'raw_document_id',
        'old_status',
        'stored_filing_type',
        'previous_result_type',
        'title_detected_type',
        'canonical_type',
        'classification_status',
        'parser_version',
        'normalizer_version',
        'classifier_version',
        'reuse_fingerprint',
        'source_verified',
        'source_unchanged',
        'strict_valid',
        'idempotent',
        'normalization_statuses',
        'outcome',
        'error_code',
        'type_invariant',
        'previous_row_count',
        'current_row_count',
        'confidence',
        'warning_codes',
        'diff_status',
        'changed_fields',
        'provenance_fields',
      ],
    ),
  );
  writePrivate(output, 'summary.json', JSON.stringify(summary, null, 2));
  return summary;
}

module.exports = {
  csv,
  fieldDifferences,
  fieldMap,
  provenanceAudit,
  parseArguments,
  prepareOutputDirectory,
  auditCorpus,
};
if (require.main === module) {
  auditCorpus(parseArguments(process.argv.slice(2)))
    .then((summary) => process.stdout.write(JSON.stringify(summary, null, 2) + '\n'))
    .catch(() => {
      // Do not echo payloads, source locations or unexpected error text to terminal logs.
      process.stderr.write(
        'Offline corpus audit failed. Check input paths, JSON schema and external output directory.\n',
      );
      process.exitCode = 1;
    });
}
