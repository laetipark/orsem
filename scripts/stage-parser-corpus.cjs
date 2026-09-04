#!/usr/bin/env node
'use strict';

// Offline by default. --apply requires an explicit ORSEM_STAGE_DATABASE_URL;
// optional ORSEM_STAGE_SOCKET_PATH selects a local MySQL socket. No .env fallback.
// All staged results remain inactive; this command never calls connectors or queues work.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const parser = require('@orsem/opendart-parser');
const classification = require('@orsem/contracts');
const { prepareOutputDirectory, fieldMap } = require('./parser-corpus-audit.cjs');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const REJECTED = new Set([
  'TABLE_NOT_FOUND',
  'REQUIRED_HEADER_NOT_FOUND',
  'NO_DATA_ROWS',
  'ROWS_FOUND_BUT_INVALID',
  'HEADER_SELECTED_AS_VALUE',
  'MISSING_REQUIRED_QUANTITY',
  'INVALID_INTEGER',
  'INVALID_DECIMAL',
  'INVALID_SHARE_UNIT',
  'INVALID_DATE',
  'NUMERIC_OUT_OF_RANGE',
  'NUMERIC_SCALE_EXCEEDED',
]);

function parseArguments(argv) {
  const options = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name === '--apply') {
      if (options.apply) throw new Error('DUPLICATE_APPLY');
      options.apply = true;
    } else if (['--snapshot', '--corpus', '--output-dir'].includes(name) && argv[i + 1]) {
      if (options[name]) throw new Error('DUPLICATE_ARGUMENT');
      options[name] = path.resolve(argv[++i]);
    } else
      throw new Error('Expected --snapshot FILE --corpus FILE --output-dir DIRECTORY [--apply].');
  }
  for (const name of ['--snapshot', '--corpus', '--output-dir'])
    if (!options[name]) throw new Error('MISSING_ARGUMENT');
  return options;
}

function classify(filing) {
  return classification.classifyOpenDartFiling({
    reportName: filing.report_name,
    sourceDetailType: filing.source_detail_type ?? null,
    manualCanonicalType:
      filing.classification_status === 'MANUAL_OVERRIDE' ? filing.canonical_type : null,
  });
}

function fingerprint(rawSha, canonicalType) {
  return sha(
    JSON.stringify([
      rawSha,
      parser.OPENDART_PARSER_VERSION,
      parser.OPENDART_NORMALIZER_VERSION,
      classification.OPENDART_CLASSIFIER_VERSION,
      canonicalType,
    ]),
  );
}

function sourceOrder(a, b) {
  return (
    String(a.document.retrieved_at).localeCompare(String(b.document.retrieved_at)) ||
    String(a.document.id).localeCompare(String(b.document.id)) ||
    String(a.previous.started_at).localeCompare(String(b.previous.started_at)) ||
    a.previous.id.localeCompare(b.previous.id)
  );
}

function writePrivate(output, name, value) {
  const temporary = path.join(output, `.${name}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, path.join(output, name));
}

async function revalidate(previous, filing, document, evidence) {
  if (!document || !document.object_uri.startsWith('file:'))
    throw new Error('LOCAL_DOCUMENT_REQUIRED');
  const sourcePath = fileURLToPath(document.object_uri);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > parser.DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes)
    throw new Error('SOURCE_SIZE_LIMIT');
  const bytes = fs.readFileSync(sourcePath);
  if (
    sha(bytes) !== previous.raw_sha256 ||
    document.sha256 !== previous.raw_sha256 ||
    bytes.length !== Number(document.byte_size)
  )
    throw new Error('SOURCE_SHA_MISMATCH');
  const resolved = classify(filing);
  const evidenceFingerprint = fingerprint(previous.raw_sha256, resolved.canonicalType);
  const extractorType = classification.isSupportedFilingType(resolved.canonicalType)
    ? resolved.canonicalType
    : null;
  const reuse = fingerprint(previous.raw_sha256, extractorType);
  if (
    !evidence ||
    evidence.raw_sha256 !== previous.raw_sha256 ||
    !evidence.source_verified ||
    !evidence.source_unchanged ||
    evidence.reuse_fingerprint !== evidenceFingerprint
  )
    throw new Error('CORPUS_EVIDENCE_MISMATCH');
  let parsed = null,
    errorCode = null,
    candidateErrors = [],
    audits = [];
  const startedAt = new Date();
  try {
    if (
      !classification.isSupportedFilingType(resolved.canonicalType) ||
      !['CONFIRMED', 'MANUAL_OVERRIDE'].includes(resolved.classificationStatus)
    ) {
      const archive = await parser.readOpenDartArchive(bytes);
      for (const candidate of archive.xmlCandidates) {
        const result = parser.normalizeOpenDartXml(
          candidate.xml,
          candidate.entryName,
          candidate.sha256,
        );
        audits.push(result.audit);
      }
      errorCode =
        resolved.classificationStatus === 'UNSUPPORTED'
          ? 'UNSUPPORTED_FILING_TYPE'
          : 'FILING_TYPE_UNCONFIRMED';
    } else {
      parsed = await parser.parseOpenDartDisclosure({
        detailType: resolved.canonicalType,
        archive: bytes,
      });
      audits = parsed.source.normalizationAudits ?? [];
      candidateErrors = parsed.source.candidateErrors ?? [];
      if (
        !classification.hasParseTypeInvariant({
          canonicalType: resolved.canonicalType,
          classificationStatus: resolved.classificationStatus,
          inputType: resolved.canonicalType,
          extractorType: resolved.canonicalType,
          resultType: parsed.detailType,
        })
      )
        errorCode = 'FILING_TYPE_INVARIANT';
    }
  } catch (error) {
    errorCode = error.code ?? 'PARSER_FAILED';
    candidateErrors = error.candidateErrors ?? [];
    audits = candidateErrors.flatMap((item) =>
      item.normalizationAudit ? [item.normalizationAudit] : [],
    );
    if (error.normalizationAudit) audits.push(error.normalizationAudit);
  }
  if (sha(fs.readFileSync(sourcePath)) !== previous.raw_sha256)
    throw new Error('SOURCE_CHANGED_DURING_PARSE');
  candidateErrors = parser.mergeCandidateErrorsWithNormalizationAudits(candidateErrors, audits);
  const rows = parsed?.transactions ?? parsed?.changes ?? parsed?.planItems ?? [];
  const warnings = [...(parsed?.warnings ?? []), ...rows.flatMap((row) => row.warnings ?? [])];
  const validation =
    errorCode || warnings.some((w) => REJECTED.has(w.code)) ? 'REJECTED' : 'REVIEW_REQUIRED';
  if (
    errorCode &&
    !['UNSUPPORTED_FILING_TYPE', 'FILING_TYPE_UNCONFIRMED'].includes(errorCode) &&
    evidence.outcome !== 'FAILED'
  )
    throw new Error('NEW_FAILURE_SINCE_CORPUS_AUDIT');
  if (
    parsed &&
    evidence.fields &&
    JSON.stringify(fieldMap(parsed)) !== JSON.stringify(evidence.fields)
  )
    throw new Error('FIELD_DRIFT_SINCE_CORPUS_AUDIT');
  const confidence = parsed
    ? Math.min(
        parsed.confidence ?? 1,
        parsed.detailType === 'D001'
          ? rows.length
            ? 0.8
            : 0
          : rows.length
            ? Math.min(
                ...rows.map((row) => row.confidence ?? (row.nature === 'UNKNOWN' ? 0.25 : 0.9)),
              )
            : 0,
      )
    : 0;
  return {
    previous,
    filing,
    document,
    resolved,
    evidence,
    extractorType,
    reuse,
    parsed,
    warnings,
    candidateErrors,
    audits,
    errorCode,
    validation,
    confidence,
    startedAt,
    finishedAt: new Date(),
    status: ['UNSUPPORTED_FILING_TYPE', 'FILING_TYPE_UNCONFIRMED'].includes(errorCode)
      ? 'SKIPPED'
      : errorCode
        ? 'FAILED'
        : 'PARTIAL',
  };
}

async function stageReview(connection, candidate, runId, at) {
  const [reviews] = await connection.query(
    "SELECT * FROM reviews WHERE subject_type='FILING' AND subject_id=? AND (review_group='PARSE' OR dedupe_key LIKE 'parse:%') ORDER BY created_at DESC,id DESC FOR UPDATE",
    [candidate.filing.id],
  );
  const id = randomUUID();
  const reason =
    candidate.errorCode === 'UNSUPPORTED_FILING_TYPE'
      ? `지원 범위 밖 공시(${candidate.resolved.canonicalType}): 원문 보존, 추출 제외`
      : candidate.errorCode === 'FILING_TYPE_UNCONFIRMED'
        ? '공시 유형 미확정: 원문 보존, 추출 보류'
        : candidate.errorCode
          ? `비활성 재검증: ${candidate.errorCode}`
          : '비활성 재검증: 원문 교차검증 미실행 및 개별 품질 검토 필요';
  await connection.query('INSERT INTO reviews SET ?', {
    id,
    subject_type: 'FILING',
    subject_id: candidate.filing.id,
    dedupe_key: `parse:${runId}`,
    review_group: 'PARSE',
    parse_run_id: runId,
    reopened_from_review_id: reviews[0]?.id ?? null,
    superseded_by_review_id: null,
    status: 'RESOLVED',
    classification_result: 'REVIEW_REQUIRED',
    reason,
    created_at: at,
    updated_at: at,
    resolution: null,
    resolved_by_admin_id: null,
    resolved_at: null,
  });
  for (const review of reviews.filter((row) => row.status === 'OPEN')) {
    await connection.query(
      "UPDATE reviews SET status='SUPERSEDED', review_group='PARSE', superseded_by_review_id=?, resolved_at=?, updated_at=?, resolution=? WHERE id=? AND status='OPEN'",
      [
        id,
        at,
        at,
        JSON.stringify({ resolution: 'SUPERSEDED_BY_STAGED_PARSE', parseRunId: runId }),
        review.id,
      ],
    );
  }
  await connection.query("UPDATE reviews SET status='OPEN' WHERE id=?", [id]);
}

async function applyFiling(connection, candidates, auditHash) {
  const lockName = `orsem:company:${candidates[0].filing.company_id}`;
  const [lock] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
  if (Number(lock[0]?.acquired) !== 1) throw new Error('COMPANY_LOCK_TIMEOUT');
  try {
    return await applyFilingUnderLock(connection, candidates, auditHash);
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
  }
}

async function applyFilingUnderLock(connection, candidates, auditHash) {
  await connection.beginTransaction();
  try {
    const first = candidates[0];
    const [filings] = await connection.query('SELECT * FROM filings WHERE id=? FOR UPDATE', [
      first.filing.id,
    ]);
    const current = filings[0];
    if (
      !current ||
      current.rcept_no !== first.filing.rcept_no ||
      current.report_name !== first.filing.report_name ||
      current.company_id !== first.filing.company_id
    )
      throw new Error('FILING_CHANGED_SINCE_SNAPSHOT');
    const resolved = classify(current);
    if (
      resolved.canonicalType !== first.resolved.canonicalType ||
      resolved.classificationStatus !== first.resolved.classificationStatus
    )
      throw new Error('CLASSIFICATION_CHANGED_SINCE_SNAPSHOT');
    const [documents] = await connection.query(
      'SELECT * FROM filing_documents WHERE filing_id=? ORDER BY retrieved_at DESC,id DESC',
      [current.id],
    );
    const newestSource = [...candidates].sort(sourceOrder).at(-1).document;
    if (!documents[0] || documents[0].sha256 !== newestSource.sha256)
      throw new Error('NEWER_SOURCE_OUTSIDE_CORPUS');
    const [priorRuns] = await connection.query(
      'SELECT * FROM parse_runs WHERE filing_id=? ORDER BY created_at DESC,id DESC',
      [current.id],
    );
    const existingByFingerprint = new Map(
      priorRuns.filter((row) => row.reuse_fingerprint).map((row) => [row.reuse_fingerprint, row]),
    );
    const newestCandidate = [...candidates].sort(sourceOrder).at(-1);
    if (
      existingByFingerprint.has(newestCandidate.reuse) &&
      candidates.some((candidate) => !existingByFingerprint.has(candidate.reuse))
    )
      throw new Error('MIXED_REUSE_WOULD_REORDER_SOURCE');
    for (const candidate of candidates) {
      if (
        !documents.some(
          (document) =>
            document.sha256 === candidate.document.sha256 &&
            document.object_uri === candidate.document.object_uri,
        )
      )
        throw new Error('DOCUMENT_CHANGED_SINCE_SNAPSHOT');
    }
    const provenance =
      current.classification_status === 'MANUAL_OVERRIDE'
        ? {
            ...json(current.classification_provenance_json),
            ...resolved.classificationProvenanceJson,
          }
        : resolved.classificationProvenanceJson;
    const values = {
      canonical_type: resolved.canonicalType,
      source_detail_type: resolved.sourceDetailType,
      title_detected_type: resolved.titleDetectedType,
      classification_status: resolved.classificationStatus,
      classifier_version: resolved.classifierVersion,
      classification_provenance_json: JSON.stringify(provenance),
    };
    if (classification.isSupportedFilingType(resolved.canonicalType))
      values.detail_type = resolved.canonicalType;
    // Narrow columns only: active pointer, first-observed/source data and manual relations are untouched.
    await connection.query('UPDATE filings SET ? WHERE id=?', [values, current.id]);
    let inserted = 0,
      reused = 0;
    for (const candidate of [...candidates].sort(sourceOrder)) {
      const saved = existingByFingerprint.get(candidate.reuse);
      if (saved) {
        if (
          saved.raw_sha256 !== candidate.previous.raw_sha256 ||
          saved.parser_version !== parser.OPENDART_PARSER_VERSION ||
          saved.normalizer_version !== parser.OPENDART_NORMALIZER_VERSION ||
          saved.classifier_version !== resolved.classifierVersion ||
          saved.extractor_type !== candidate.extractorType ||
          ['PENDING', 'RUNNING'].includes(saved.status)
        )
          throw new Error('EXISTING_FINGERPRINT_RUN_NOT_REUSABLE');
        candidate.stagedRunId = saved.id;
        candidate.protectedActiveParseRunId = current.active_parse_run_id;
        candidate.reused = true;
        candidate.existingProjectionApplied = json(saved.result_json)?.projectionApplied ?? null;
        reused += 1;
        continue;
      }
      const [latest] = await connection.query(
        'SELECT id,created_at FROM parse_runs WHERE filing_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
        [current.id],
      );
      let now = new Date();
      const previousAt = latest[0]?.created_at;
      const parsedAt = previousAt ? Date.parse(String(previousAt).replace(' ', 'T') + 'Z') : 0;
      if (parsedAt > now.getTime() + 1000) throw new Error('LATEST_RUN_CLOCK_NOT_UTC_OR_FUTURE');
      while (parsedAt >= now.getTime()) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        now = new Date();
      }
      const id = randomUUID();
      const row = {
        id,
        filing_id: current.id,
        parser_version: parser.OPENDART_PARSER_VERSION,
        normalizer_version: parser.OPENDART_NORMALIZER_VERSION,
        classifier_version: resolved.classifierVersion,
        raw_sha256: candidate.previous.raw_sha256,
        reuse_fingerprint: candidate.reuse,
        input_type: resolved.canonicalType,
        extractor_type: candidate.extractorType,
        result_type: candidate.parsed?.detailType ?? null,
        supersedes_run_id: latest[0]?.id ?? null,
        status: candidate.status,
        validation_status: candidate.validation,
        confidence: candidate.confidence.toFixed(6),
        classification_result: 'REVIEW_REQUIRED',
        started_at: candidate.startedAt,
        finished_at: candidate.finishedAt,
        created_at: now,
        updated_at: now,
        error_code: candidate.errorCode,
        error_message: candidate.errorCode
          ? `Offline inactive parse: ${candidate.errorCode}`
          : null,
        warnings_json: JSON.stringify([
          ...candidate.warnings.map((w) => `${w.code}: ${w.message}`),
          'OFFLINE_CROSSCHECK_NOT_RUN: Candidate remains inactive pending source crosscheck and individual quality review.',
        ]),
        candidate_errors_json: JSON.stringify(candidate.candidateErrors),
        normalization_audits_json: JSON.stringify(candidate.audits),
        result_json: JSON.stringify({
          parsed: candidate.parsed,
          crosscheck: { status: 'NOT_RUN' },
          projectionApplied: false,
          protectedActiveParseRunId: current.active_parse_run_id,
          staging: {
            mode: 'OFFLINE_INACTIVE',
            corpusSha256: auditHash,
            previousRunId: candidate.previous.id,
            sourceDocumentId: candidate.document.id,
            sourceRetrievedAt: candidate.document.retrieved_at,
            rightsMode: candidate.document.rights_mode,
            requiresIndividualReview: true,
          },
        }),
      };
      await connection.query('INSERT INTO parse_runs SET ?', row);
      existingByFingerprint.set(candidate.reuse, row);
      await stageReview(connection, candidate, id, now);
      candidate.stagedRunId = id;
      candidate.protectedActiveParseRunId = current.active_parse_run_id;
      inserted += 1;
    }
    await connection.commit();
    return { inserted, reused };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function backfillMetadataOnly(connection, snapshotFiling) {
  await connection.beginTransaction();
  try {
    const [rows] = await connection.query('SELECT * FROM filings WHERE id=? FOR UPDATE', [
      snapshotFiling.id,
    ]);
    const filing = rows[0];
    if (
      !filing ||
      filing.rcept_no !== snapshotFiling.rcept_no ||
      filing.report_name !== snapshotFiling.report_name
    )
      throw new Error('FILING_CHANGED_SINCE_SNAPSHOT');
    const resolved = classify(filing);
    const provenance =
      filing.classification_status === 'MANUAL_OVERRIDE'
        ? {
            ...json(filing.classification_provenance_json),
            ...resolved.classificationProvenanceJson,
          }
        : resolved.classificationProvenanceJson;
    const values = {
      canonical_type: resolved.canonicalType,
      source_detail_type: resolved.sourceDetailType,
      title_detected_type: resolved.titleDetectedType,
      classification_status: resolved.classificationStatus,
      classifier_version: resolved.classifierVersion,
      classification_provenance_json: JSON.stringify(provenance),
    };
    if (classification.isSupportedFilingType(resolved.canonicalType))
      values.detail_type = resolved.canonicalType;
    await connection.query('UPDATE filings SET ? WHERE id=?', [values, filing.id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

function candidateManifest(candidates) {
  return candidates.map((candidate) => ({
    previousRunId: candidate.previous.id,
    filingId: candidate.filing.id,
    reuseFingerprint: candidate.reuse,
    rawSha256: candidate.previous.raw_sha256,
    classification: candidate.resolved,
    extractorType: candidate.extractorType,
    protectedActiveParseRunId:
      candidate.protectedActiveParseRunId ?? candidate.filing.active_parse_run_id,
    stagedRunId: candidate.stagedRunId ?? null,
    reused: candidate.reused ?? false,
    existingProjectionApplied: candidate.existingProjectionApplied ?? null,
    status: candidate.status,
    validationStatus: candidate.validation,
    projectionApplied: false,
    candidateErrors: candidate.candidateErrors,
    normalizationAudits: candidate.audits,
    crosscheck: { status: 'NOT_RUN' },
    confidence: candidate.confidence,
    warnings: candidate.warnings,
    fieldComparison: candidate.evidence.field_diff ?? null,
    sourceDocumentId: candidate.document.id,
    sourceRetrievedAt: candidate.document.retrieved_at,
    sourceRightsMode: candidate.document.rights_mode,
    parsed: candidate.parsed,
  }));
}

async function stageCorpus(options, environment = process.env) {
  const output = prepareOutputDirectory(options['--output-dir']);
  if (fs.readdirSync(output).length) throw new Error('OUTPUT_DIRECTORY_MUST_BE_EMPTY');
  const snapshotBytes = fs.readFileSync(options['--snapshot']);
  const corpusBytes = fs.readFileSync(options['--corpus']);
  const snapshot = JSON.parse(snapshotBytes),
    corpus = JSON.parse(corpusBytes);
  if (
    corpus.summary.snapshot_sha256 !== sha(snapshotBytes) ||
    corpus.summary.parser_version !== parser.OPENDART_PARSER_VERSION ||
    corpus.summary.normalizer_version !== parser.OPENDART_NORMALIZER_VERSION ||
    corpus.summary.classifier_version !== classification.OPENDART_CLASSIFIER_VERSION ||
    snapshot.runs.length !== corpus.runs.length
  )
    throw new Error('CORPUS_VERSION_OR_SNAPSHOT_MISMATCH');
  const filings = new Map(snapshot.filings.map((row) => [row.id, row]));
  const documents = new Map(
    snapshot.documents.map((row) => [`${row.filing_id}:${row.sha256}`, row]),
  );
  const evidence = new Map(corpus.runs.map((row) => [row.run_id, row]));
  const candidates = [];
  for (const previous of snapshot.runs)
    candidates.push(
      await revalidate(
        previous,
        filings.get(previous.filing_id),
        documents.get(`${previous.filing_id}:${previous.raw_sha256}`),
        evidence.get(previous.id),
      ),
    );
  const summary = {
    mode: options.apply ? 'APPLY_INACTIVE' : 'DRY_RUN',
    inputs: candidates.length,
    metadataOnlyFilings: snapshot.filings.filter(
      (filing) => !snapshot.runs.some((run) => run.filing_id === filing.id),
    ).length,
    inserted: 0,
    reused: 0,
    activated: 0,
    networkCrosschecks: 0,
    notifications: 0,
    statusCounts: {},
    validationCounts: {},
    corpusSha256: sha(corpusBytes),
    snapshotSha256: sha(snapshotBytes),
  };
  for (const candidate of candidates) {
    summary.statusCounts[candidate.status] = (summary.statusCounts[candidate.status] ?? 0) + 1;
    summary.validationCounts[candidate.validation] =
      (summary.validationCounts[candidate.validation] ?? 0) + 1;
  }
  writePrivate(output, 'staging-preflight.json', candidateManifest(candidates));
  if (options.apply) {
    if (!environment.ORSEM_STAGE_DATABASE_URL) throw new Error('EXPLICIT_STAGE_DATABASE_REQUIRED');
    const url = new URL(environment.ORSEM_STAGE_DATABASE_URL);
    if (url.protocol !== 'mysql:' || !url.pathname.slice(1))
      throw new Error('INVALID_STAGE_DATABASE');
    const connection = await require('mysql2/promise').createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ...(environment.ORSEM_STAGE_SOCKET_PATH
        ? { socketPath: environment.ORSEM_STAGE_SOCKET_PATH }
        : {}),
      timezone: 'Z',
      dateStrings: true,
    });
    try {
      await connection.query("SET SESSION time_zone='+00:00'");
      const groups = new Map();
      for (const candidate of candidates) {
        if (!groups.has(candidate.filing.id)) groups.set(candidate.filing.id, []);
        groups.get(candidate.filing.id).push(candidate);
      }
      for (const group of groups.values()) {
        const result = await applyFiling(connection, group, summary.corpusSha256);
        summary.inserted += result.inserted;
        summary.reused += result.reused;
        writePrivate(output, 'staging-progress.json', {
          updatedAt: new Date().toISOString(),
          inserted: summary.inserted,
          reused: summary.reused,
          completed: candidates
            .filter((candidate) => candidate.stagedRunId)
            .map((candidate) => ({
              filingId: candidate.filing.id,
              previousRunId: candidate.previous.id,
              stagedRunId: candidate.stagedRunId,
              reused: candidate.reused ?? false,
            })),
        });
      }
      for (const filing of snapshot.filings.filter((filing) => !groups.has(filing.id)))
        await backfillMetadataOnly(connection, filing);
    } finally {
      await connection.end();
    }
  }
  writePrivate(output, 'staging-summary.json', summary);
  writePrivate(output, 'staging-candidates.json', candidateManifest(candidates));
  return summary;
}

module.exports = { parseArguments, fingerprint, sourceOrder, revalidate, applyFiling, stageCorpus };
if (require.main === module)
  stageCorpus(parseArguments(process.argv.slice(2)))
    .then((summary) => process.stdout.write(JSON.stringify(summary, null, 2) + '\n'))
    .catch((error) => {
      const code = error.code ?? error.message;
      process.stderr.write(
        `Inactive staging failed (${typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? code : 'UNEXPECTED_ERROR'}).\n`,
      );
      process.exitCode = 1;
    });
