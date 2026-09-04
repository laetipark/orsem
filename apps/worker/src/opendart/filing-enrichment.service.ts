import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AlertStatus,
  ClassificationReviewResult,
  ConnectorStatus,
  DeliveryChannel,
  Direction,
  EffectiveFilingState,
  EventState,
  EventType,
  EvidenceGrade,
  FilingRelationType,
  ParseStatus,
  ProcessingStatus,
  RelationSource,
  RelationReviewDecision,
  ReviewTaskStatus,
  RightsMode,
  TransactionNature,
} from '@orsem/contracts';
import {
  AiRunEntity,
  AlertEntity,
  AlertOutboxEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingDocumentEntity,
  FilingEntity,
  FilingRelationEntity,
  InsiderReportEntity,
  InsiderTransactionEntity,
  LargeHolderReportEntity,
  LargeHoldingChangeEntity,
  ParseIssueEntity,
  ParseRunEntity,
  PlanExecutionMatchEntity,
  ProcessingOutboxEntity,
  ReviewEntity,
  TradePlanEntity,
  TradePlanItemEntity,
} from '@orsem/database';
import {
  OPENDART_PARSER_VERSION,
  OPENDART_NORMALIZER_VERSION,
  OpenDartApiError,
  OpenDartPayloadError,
  parseOpenDartDisclosure,
  classifyTransactionMethod,
  mergeCandidateErrorsWithNormalizationAudits,
  type ParsedOpenDartDisclosure,
  type ParserWarning,
} from '@orsem/opendart-parser';
import { DataSource, In, type EntityManager, type QueryRunner } from 'typeorm';
import { z } from 'zod';
import {
  AI_CLASSIFIER_PROMPT_HASH,
  AI_CLASSIFIER_PROMPT_VERSION,
  type AiClassificationReview,
  CompatibleClassifierClient,
} from '../ai/compatible-classifier.client';
import { nextKstMidnight } from '../common/kst-date';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { ConnectorHealthService } from '../connectors/connector-health.service';
import type {
  ApplyParseProjectionJob,
  EnrichFilingJob,
  ReviewParseWithAiJob,
} from '../queues/job-data';
import { RawDocumentStore } from '../raw-documents/raw-document.store';
import { OpenDartClient } from './opendart.client';
import { canProcessFiling, updateFilingClassification } from './filing-classification';
import {
  assertParseTypeInvariant,
  crosscheckAllowsProjection,
  parseReuseFingerprint,
} from './parse-reuse';
import { updateParseReviewLifecycle } from './parse-review-lifecycle';

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function numeric(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[,%\s]/g, '').replace(/^\+/, '');
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return null;
  const integerDigits = (match[1]!.replace(/^0+(?=\d)/, '') || '0').length;
  const fractionDigits = (match[2] ?? '').replace(/0+$/, '').length;
  return integerDigits <= 32 && fractionDigits <= 6 && integerDigits + fractionDigits <= 38
    ? normalized
    : null;
}

function rowConfidenceOf(parsed: ParsedOpenDartDisclosure): number {
  if (parsed.detailType === 'D002') {
    return parsed.transactions.length === 0
      ? 0
      : Math.min(...parsed.transactions.map((row) => row.confidence));
  }
  if (parsed.detailType === 'D005') {
    return parsed.planItems.length === 0
      ? 0
      : Math.min(...parsed.planItems.map((row) => (row.nature === 'UNKNOWN' ? 0.25 : 0.9)));
  }
  return parsed.changes.length > 0 ? 0.8 : 0.5;
}

function confidenceOf(parsed: ParsedOpenDartDisclosure): number {
  const explicit =
    'confidence' in parsed && typeof parsed.confidence === 'number' ? parsed.confidence : 1;
  return Math.min(explicit, rowConfidenceOf(parsed));
}

function warningsOf(parsed: ParsedOpenDartDisclosure): readonly ParserWarning[] {
  const nested =
    parsed.detailType === 'D002'
      ? parsed.transactions.flatMap((row) => row.warnings)
      : parsed.detailType === 'D005'
        ? parsed.planItems.flatMap((row) => row.warnings)
        : parsed.changes.flatMap((row) => row.warnings);
  const unique = new Map<string, ParserWarning>();
  for (const warning of [...parsed.warnings, ...nested]) {
    unique.set(
      `${warning.code}:${warning.entryName ?? ''}:${warning.tableIndex ?? ''}:${warning.rowIndex ?? ''}:${warning.field ?? ''}`,
      warning,
    );
  }
  return Object.freeze([...unique.values()]);
}

function warningRequiresReview(warning: ParserWarning): boolean {
  return !['NO_RECOGNIZED_DISCLOSURE_TABLE', 'XML_CANDIDATE_REJECTED'].includes(warning.code);
}

const REJECTED_PROJECTION_WARNINGS = new Set([
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

function validationStatusOf(
  status: ParseStatus,
  warnings: readonly ParserWarning[],
): ParseRunEntity['validationStatus'] {
  if (warnings.some((warning) => REJECTED_PROJECTION_WARNINGS.has(warning.code))) return 'REJECTED';
  return status === ParseStatus.SUCCEEDED ? 'PASSED' : 'REVIEW_REQUIRED';
}

function projectionText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.slice(0, max);
}

function projectionTextWarnings(parsed: ParsedOpenDartDisclosure): ParserWarning[] {
  const warnings: ParserWarning[] = [];
  const inspect = (
    value: string | null | undefined,
    max: number,
    field: string,
    rowIndex?: number,
  ): void => {
    if (value && value.length > max) {
      warnings.push({
        code: 'PROJECTION_TEXT_TRUNCATED',
        message: `${field} 원문이 DB projection 한도 ${max}자를 초과해 표시값만 잘랐습니다. 전체 값은 원문 ZIP과 parse audit에 보존됩니다.`,
        field,
        ...(rowIndex === undefined ? {} : { rowIndex }),
      });
    }
  };
  inspect(parsed.reporterName, 255, 'reporterName');
  if (parsed.detailType === 'D002' || parsed.detailType === 'D005') {
    inspect(parsed.relationshipRaw, 255, 'relationshipRaw');
    inspect(parsed.positionRaw, 255, 'positionRaw');
    const rows = parsed.detailType === 'D002' ? parsed.transactions : parsed.planItems;
    for (const row of rows) {
      inspect(row.securityTypeRaw, 500, 'securityTypeRaw', row.rowIndex);
      inspect(row.methodRaw, 500, 'methodRaw', row.rowIndex);
    }
  } else {
    for (const row of parsed.changes) {
      inspect(row.methodRaw, 500, 'methodRaw', row.rowIndex);
    }
  }
  return warnings;
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown parser error').slice(0, 4000);
}

function shouldDeliverFilingAlert(filing: FilingEntity): boolean {
  if (filing.effectiveState === EffectiveFilingState.ACTIVE) return true;
  const sourceText = `${filing.reportName} ${filing.rm ?? ''}`.normalize('NFKC');
  return /취소|철회/.test(sourceText);
}

const persistedWarningSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().max(20_000),
    entryName: z.string().max(4_096).optional(),
    tableIndex: z.number().int().nonnegative().optional(),
    rowIndex: z.number().int().nonnegative().optional(),
    field: z.string().max(128).optional(),
  })
  .passthrough();
const persistedTextSchema = z.string().max(16_384);
const nullableStringSchema = persistedTextSchema.nullable();
const persistedNumericSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
  .refine((value) => numeric(value) === value, {
    message: 'Value does not fit the DECIMAL(38,6) projection contract.',
  })
  .nullable();
function isValidDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
const dateOnlySchema = z
  .string()
  .refine(isValidDateOnly, { message: 'Invalid calendar date.' })
  .nullable();
const persistedSourceSchema = z
  .object({
    archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
    archiveByteLength: z
      .number()
      .int()
      .nonnegative()
      .max(50 * 1024 * 1024),
    selectedEntryName: z.string().max(4_096).nullable(),
    candidateEntries: z.array(z.string().max(4_096)).max(200),
  })
  .passthrough();
const persistedBaseShape = {
  parserVersion: z.string().min(1).max(64),
  source: persistedSourceSchema,
  warnings: z.array(persistedWarningSchema).max(500_000),
  tablesScanned: z.number().int().nonnegative().max(2_000),
};
const persistedParsedDisclosureSchema = z.discriminatedUnion('detailType', [
  z
    .object({
      ...persistedBaseShape,
      detailType: z.literal('D001'),
      reportTypeRaw: nullableStringSchema,
      reporterName: nullableStringSchema,
      reportReasonRaw: nullableStringSchema,
      sharesAfter: persistedNumericSchema,
      sharesChange: persistedNumericSchema,
      ownershipRateAfter: persistedNumericSchema,
      ownershipRateChange: persistedNumericSchema,
      changes: z
        .array(
          z
            .object({
              rowIndex: z.number().int().nonnegative(),
              eventDate: dateOnlySchema,
              securityTypeRaw: persistedTextSchema,
              methodRaw: persistedTextSchema,
              direction: z.enum(Direction),
              quantity: persistedNumericSchema,
              warnings: z.array(persistedWarningSchema).max(32),
            })
            .passthrough(),
        )
        .max(100_000),
    })
    .passthrough(),
  z
    .object({
      ...persistedBaseShape,
      detailType: z.literal('D002'),
      reporterName: nullableStringSchema,
      relationshipRaw: nullableStringSchema,
      positionRaw: nullableStringSchema,
      transactions: z
        .array(
          z
            .object({
              rowIndex: z.number().int().nonnegative(),
              eventDate: dateOnlySchema,
              securityTypeRaw: persistedTextSchema,
              methodRaw: persistedTextSchema,
              nature: z.enum(TransactionNature),
              direction: z.enum(Direction),
              quantity: persistedNumericSchema,
              quantityUnitRaw: nullableStringSchema,
              unitPrice: persistedNumericSchema,
              amount: persistedNumericSchema,
              amountSource: z.enum(['CALCULATED']).nullable(),
              currency: nullableStringSchema,
              sharesAfter: persistedNumericSchema,
              confidence: z.number().min(0).max(1),
              warnings: z.array(persistedWarningSchema).max(32),
            })
            .passthrough(),
        )
        .max(100_000),
    })
    .passthrough(),
  z
    .object({
      ...persistedBaseShape,
      detailType: z.literal('D005'),
      reporterName: nullableStringSchema,
      relationshipRaw: nullableStringSchema,
      positionRaw: nullableStringSchema,
      planItems: z
        .array(
          z
            .object({
              rowIndex: z.number().int().nonnegative(),
              plannedStartDate: dateOnlySchema,
              plannedEndDate: dateOnlySchema,
              securityTypeRaw: persistedTextSchema,
              methodRaw: persistedTextSchema,
              nature: z.enum(TransactionNature),
              direction: z.enum(Direction),
              quantity: persistedNumericSchema,
              priceMin: persistedNumericSchema,
              priceMax: persistedNumericSchema,
              warnings: z.array(persistedWarningSchema).max(32),
            })
            .passthrough(),
        )
        .max(100_000),
    })
    .passthrough(),
]);

interface FilingProjectionLock {
  readonly runner: QueryRunner;
  readonly name: string;
}

const AI_REVIEW_PROVIDER = 'OPENAI_COMPATIBLE';
export const MAX_AI_REVIEW_ROWS = 16;
export const AI_REVIEW_MIN_PROCESSING_LEASE_MS = 30 * 60_000;
export const AI_REVIEW_MAX_PROCESSING_LEASE_MS = 4 * 60 * 60_000;
export const AI_REVIEW_OUTBOX_REARM_COOLDOWN_MS = 30 * 60_000;
export const MAX_AI_REVIEW_OUTBOX_REARMS = 3;
const AI_REVIEW_PROCESSING_LEASE_PADDING_MS = 5 * 60_000;

export type AiRunClaimDecision = 'CLAIM' | 'COMPLETED' | 'IN_FLIGHT';

export function aiReviewProcessingLeaseMs(
  requestTimeoutMs: number,
  candidateCount: number,
): number {
  const boundedCandidates = Math.max(1, Math.min(MAX_AI_REVIEW_ROWS, candidateCount));
  const expectedMaximum =
    Math.max(1_000, requestTimeoutMs) * boundedCandidates + AI_REVIEW_PROCESSING_LEASE_PADDING_MS;
  return Math.min(
    AI_REVIEW_MAX_PROCESSING_LEASE_MS,
    Math.max(AI_REVIEW_MIN_PROCESSING_LEASE_MS, expectedMaximum),
  );
}

export function decideAiRunClaim(
  status: ProcessingStatus,
  updatedAt: Date,
  now: Date,
  leaseMs: number,
): AiRunClaimDecision {
  if (status === ProcessingStatus.COMPLETED) return 'COMPLETED';
  if (status !== ProcessingStatus.PROCESSING) return 'CLAIM';
  return updatedAt.getTime() <= now.getTime() - leaseMs ? 'CLAIM' : 'IN_FLIGHT';
}

function isUniqueConstraintConflict(error: unknown): boolean {
  const candidates = [error, (error as { driverError?: unknown } | null)?.driverError];
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const details = candidate as { code?: unknown; errno?: unknown };
    return details.code === 'ER_DUP_ENTRY' || details.errno === 1062;
  });
}

export function isAiRunIdentityConflict(error: unknown): boolean {
  return isUniqueConstraintConflict(error);
}

export type AiReviewRecoveryReason =
  'MISSING_AI_RUN' | 'FAILED_AI_RUN' | 'PENDING_AI_RUN' | 'STALE_PROCESSING_AI_RUN';

export interface AiReviewOutboxRearmDecision {
  readonly count: number;
  readonly reason: AiReviewRecoveryReason;
  readonly availableAt: Date;
}

function aiReviewRecoveryReason(
  aiRun: Pick<AiRunEntity, 'status' | 'updatedAt'> | null,
  now: Date,
  processingLeaseMs: number,
): AiReviewRecoveryReason | null {
  if (!aiRun) return 'MISSING_AI_RUN';
  if (aiRun.status === ProcessingStatus.FAILED) return 'FAILED_AI_RUN';
  if (aiRun.status === ProcessingStatus.PENDING) return 'PENDING_AI_RUN';
  if (
    aiRun.status === ProcessingStatus.PROCESSING &&
    decideAiRunClaim(aiRun.status, aiRun.updatedAt, now, processingLeaseMs) === 'CLAIM'
  ) {
    return 'STALE_PROCESSING_AI_RUN';
  }
  return null;
}

function aiReviewOutboxRearmCount(payload: Record<string, unknown>): number {
  const metadata = payload['aiReviewRearm'];
  if (!metadata || typeof metadata !== 'object') return 0;
  const count = (metadata as Record<string, unknown>)['count'];
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function planAiReviewOutboxRearm(input: {
  readonly outbox: Pick<ProcessingOutboxEntity, 'status' | 'updatedAt' | 'payloadJson'>;
  readonly aiRun: Pick<AiRunEntity, 'status' | 'updatedAt'> | null;
  readonly now: Date;
  readonly processingLeaseMs: number;
}): AiReviewOutboxRearmDecision | null {
  if (
    input.outbox.status !== ProcessingStatus.COMPLETED &&
    input.outbox.status !== ProcessingStatus.FAILED
  ) {
    return null;
  }
  const reason = aiReviewRecoveryReason(input.aiRun, input.now, input.processingLeaseMs);
  if (!reason) return null;
  const previousCount = aiReviewOutboxRearmCount(input.outbox.payloadJson);
  if (previousCount >= MAX_AI_REVIEW_OUTBOX_REARMS) return null;
  const latestActivityAt = Math.max(
    input.outbox.updatedAt.getTime(),
    input.aiRun?.updatedAt.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  return Object.freeze({
    count: previousCount + 1,
    reason,
    availableAt: new Date(
      Math.max(input.now.getTime(), latestActivityAt + AI_REVIEW_OUTBOX_REARM_COOLDOWN_MS),
    ),
  });
}

export interface UnknownAiReviewCandidate {
  readonly rowIndex: number;
  readonly methodRaw: string;
  readonly securityTypeRaw: string;
  readonly quantity: string | null;
  readonly deterministicNature: TransactionNature;
  readonly deterministicDirection: Direction;
  readonly eventDate: string | null;
  readonly plannedStartDate: string | null;
  readonly plannedEndDate: string | null;
}

export interface UnknownAiReviewSelection {
  readonly candidates: readonly UnknownAiReviewCandidate[];
  readonly totalEligibleRows: number;
  readonly truncated: boolean;
}

/**
 * AI는 파서의 불확실성을 제한된 범위에서 검토하며, 별도 파서 역할을 하지 않습니다.
 * 확인된 행은 프롬프트에서 제외하고 공시별 로컬 추론 작업량을 제한합니다.
 */
export function selectUnknownAiReviewCandidates(
  parsed: ParsedOpenDartDisclosure,
): UnknownAiReviewSelection {
  if (parsed.detailType === 'D001') {
    return Object.freeze({
      candidates: Object.freeze([]),
      totalEligibleRows: 0,
      truncated: false,
    });
  }
  const rows = parsed.detailType === 'D002' ? parsed.transactions : parsed.planItems;
  const eligible = rows
    .filter(
      (row) => row.nature === TransactionNature.UNKNOWN || row.direction === Direction.UNKNOWN,
    )
    .map((row) =>
      Object.freeze({
        rowIndex: row.rowIndex,
        methodRaw: row.methodRaw,
        securityTypeRaw: row.securityTypeRaw,
        quantity: row.quantity,
        deterministicNature: row.nature,
        deterministicDirection: row.direction,
        eventDate: 'eventDate' in row ? row.eventDate : null,
        plannedStartDate: 'plannedStartDate' in row ? row.plannedStartDate : null,
        plannedEndDate: 'plannedEndDate' in row ? row.plannedEndDate : null,
      }),
    )
    .sort((left, right) => left.rowIndex - right.rowIndex);
  return Object.freeze({
    candidates: Object.freeze(eligible.slice(0, MAX_AI_REVIEW_ROWS)),
    totalEligibleRows: eligible.length,
    truncated: eligible.length > MAX_AI_REVIEW_ROWS,
  });
}

export async function reviewAiCandidatesSequentially(
  candidates: readonly UnknownAiReviewCandidate[],
  suggest: (candidate: UnknownAiReviewCandidate) => Promise<AiClassificationReview>,
): Promise<readonly AiClassificationReview[]> {
  const reviews: AiClassificationReview[] = [];
  for (const candidate of candidates.slice(0, MAX_AI_REVIEW_ROWS)) {
    // Ollama는 의도적으로 한 번에 한 행씩 호출합니다. 메모리 사용을 제한하고
    // 공시 큐가 병렬 실행될 때 로컬 모델 부하가 배로 늘어나는 것을 방지합니다.
    reviews.push(await suggest(candidate));
  }
  return Object.freeze(reviews);
}

export function aggregateAiReviewClassification(
  reviews: readonly AiClassificationReview[],
  truncated = false,
): ClassificationReviewResult {
  if (
    truncated ||
    reviews.length === 0 ||
    reviews.some((review) => review.result === ClassificationReviewResult.REVIEW_REQUIRED)
  ) {
    return ClassificationReviewResult.REVIEW_REQUIRED;
  }
  return reviews.some((review) => review.result === ClassificationReviewResult.AI_SUGGESTED)
    ? ClassificationReviewResult.AI_SUGGESTED
    : ClassificationReviewResult.AI_CONFIRMED;
}

function isAiClassificationResult(
  result: ClassificationReviewResult | null,
): result is
  typeof ClassificationReviewResult.AI_CONFIRMED | typeof ClassificationReviewResult.AI_SUGGESTED {
  return (
    result === ClassificationReviewResult.AI_CONFIRMED ||
    result === ClassificationReviewResult.AI_SUGGESTED
  );
}

/** 보조 교차 검증과 보류된 조회용 데이터 적용이 AI 검토 상태를 지우지 않도록 합니다. */
export function preserveAiClassificationResult(
  current: ClassificationReviewResult | null,
  deterministic: ClassificationReviewResult,
): ClassificationReviewResult {
  return isAiClassificationResult(current) ? current : deterministic;
}

@Injectable()
export class FilingEnrichmentService {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly client: OpenDartClient,
    private readonly rawStore: RawDocumentStore,
    private readonly connectorHealth: ConnectorHealthService,
    private readonly classifier: CompatibleClassifierClient,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  public async enrich(job: EnrichFilingJob): Promise<{
    readonly parseRunId: string;
    readonly status: ParseStatus;
    readonly rawSha256: string;
  }> {
    const filingRepository = this.dataSource.getRepository(FilingEntity);
    const filingSnapshot = await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(FilingEntity);
      const filing = await repository
        .createQueryBuilder('filing')
        .setLock('pessimistic_write')
        .where('filing.id = :id', { id: job.filingId })
        .getOne();
      if (!filing || filing.rceptNo !== job.rceptNo) return null;
      updateFilingClassification(filing, filing.reportName, job.detailType);
      return repository.save(filing);
    });
    if (!filingSnapshot || filingSnapshot.rceptNo !== job.rceptNo) {
      throw new Error('Filing job does not match a persisted filing.');
    }
    if (!canProcessFiling(filingSnapshot)) {
      throw new OpenDartPayloadError(
        `Document classification ${filingSnapshot.classificationStatus} cannot select a supported extractor.`,
        filingSnapshot.classificationStatus === 'UNSUPPORTED'
          ? 'UNSUPPORTED_FILING_TYPE'
          : 'FILING_TYPE_UNCONFIRMED',
      );
    }

    let bytes: Uint8Array;
    try {
      const pausedUntil = await this.connectorHealth.openDartPausedUntil();
      if (pausedUntil) {
        throw new OpenDartApiError(
          '020',
          `Persisted OpenDART circuit is open until ${pausedUntil.toISOString()}.`,
          'NEXT_KST_DAY',
        );
      }
      bytes = await this.client.fetchDocument(job.rceptNo);
      await this.connectorHealth
        .recordOpenDart(ConnectorStatus.HEALTHY, null, {
          operation: 'DOCUMENT',
        })
        .catch(() => undefined);
    } catch (error) {
      if (error instanceof OpenDartApiError && error.status === '020') {
        await this.connectorHealth
          .pauseOpenDartUntil(nextKstMidnight(), error.apiMessage)
          .catch(() => undefined);
      } else {
        await this.connectorHealth
          .recordOpenDart(
            error instanceof OpenDartApiError && error.retryPolicy === 'NONE'
              ? ConnectorStatus.FAILED
              : ConnectorStatus.DEGRADED,
            failureMessage(error),
            { operation: 'DOCUMENT' },
          )
          .catch(() => undefined);
      }
      throw error;
    }
    const stored = await this.rawStore.put(bytes);
    const projectionLock = await this.acquireCompanyProjectionLock(filingSnapshot.companyId);
    try {
      const documentRepository = this.dataSource.getRepository(FilingDocumentEntity);
      let document = await documentRepository.findOne({
        where: { filingId: filingSnapshot.id, sha256: stored.sha256 },
      });
      if (!document) {
        document = await documentRepository.save(
          documentRepository.create({
            filingId: filingSnapshot.id,
            objectUri: stored.objectUri,
            sha256: stored.sha256,
            mediaType: 'application/zip',
            byteSize: String(stored.byteSize),
            originalFilename: `${job.rceptNo}.zip`,
            retrievedAt: new Date(),
            rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
          }),
        );
      }

      const filing = await filingRepository.findOne({
        where: { id: filingSnapshot.id },
      });
      if (
        !filing ||
        filing.rceptNo !== job.rceptNo ||
        !canProcessFiling(filing) ||
        filing.canonicalType !== filingSnapshot.canonicalType ||
        filing.classifierVersion !== filingSnapshot.classifierVersion
      ) {
        throw new Error('Filing changed while its document was downloaded.');
      }
      const fingerprint = parseReuseFingerprint({
        rawSha256: stored.sha256,
        parserVersion: OPENDART_PARSER_VERSION,
        normalizerVersion: OPENDART_NORMALIZER_VERSION,
        classifierVersion: filing.classifierVersion!,
        extractorType: filing.detailType,
      });
      const runRepository = this.dataSource.getRepository(ParseRunEntity);
      let run = await runRepository.findOne({
        where: {
          filingId: filing.id,
          reuseFingerprint: fingerprint,
        },
      });
      if (run && (run.status === ParseStatus.SUCCEEDED || run.status === ParseStatus.PARTIAL)) {
        const audit = persistedParsedDisclosureSchema.safeParse(run.resultJson?.['parsed']);
        if (!audit.success || run.resultType !== audit.data.detailType) {
          throw new OpenDartPayloadError(
            'Cached parse audit does not match its result type.',
            'INVALID_PERSISTED_PARSE_AUDIT',
          );
        }
        assertParseTypeInvariant(filing, run, audit.data.detailType);
        const projectionApplied = run.resultJson?.['projectionApplied'] !== false;
        if (!projectionApplied) {
          // 보류된 실행은 변경하지 않는 검토 자료입니다. ENRICH를 다시 실행해도
          // resultJson을 지우거나 관리자 승인과 경합해서는 안 됩니다. 보호 중인
          // 조회용 데이터는 APPLY_PARSE_PROJECTION만 교체할 수 있습니다.
          await this.enqueuePersistedAiReview(filing, run).catch(() => undefined);
          return Object.freeze({
            parseRunId: run.id,
            status: run.status,
            rawSha256: stored.sha256,
          });
        }
        const priorCrosscheck = run.resultJson?.['crosscheck'];
        const crosscheckNeedsRetry =
          priorCrosscheck !== null &&
          typeof priorCrosscheck === 'object' &&
          (priorCrosscheck as Record<string, unknown>)['status'] === 'FAILED';
        if (projectionApplied && crosscheckNeedsRetry) {
          const persistedParsed = persistedParsedDisclosureSchema.safeParse(
            run.resultJson?.['parsed'],
          );
          if (!persistedParsed.success || persistedParsed.data.detailType !== filing.detailType) {
            throw new OpenDartPayloadError(
              'A projected parse run has an invalid persisted audit payload; crosscheck retry was stopped to protect reviewed projection links.',
              'INVALID_PERSISTED_PARSE_AUDIT',
            );
          }
          const result = await this.retryPersistedCrosscheck(
            filing,
            run,
            persistedParsed.data as ParsedOpenDartDisclosure,
            job.suppressAlerts,
            stored.sha256,
          );
          await this.enqueueAiReview(
            filing.id,
            run.id,
            persistedParsed.data as ParsedOpenDartDisclosure,
          ).catch(() => undefined);
          return result;
        }
        if (projectionApplied && !crosscheckNeedsRetry) {
          await this.dataSource.transaction(async (manager) => {
            const lockedFiling = await manager
              .getRepository(FilingEntity)
              .createQueryBuilder('filing')
              .setLock('pessimistic_write')
              .where('filing.id = :id', { id: filing.id })
              .getOne();
            if (
              !lockedFiling ||
              lockedFiling.rceptNo !== job.rceptNo ||
              lockedFiling.canonicalType !== filing.canonicalType
            ) {
              throw new Error('Filing changed while reusing its parse run.');
            }
            assertParseTypeInvariant(lockedFiling, run!, audit.data.detailType);
            // Reuse is read-only with respect to the active pointer: an older run must
            // never reactivate itself over a newer or manually reviewed projection.
            await this.dismissDocumentUnavailableReview(
              manager,
              lockedFiling.id,
              lockedFiling.rceptNo,
              new Date(),
            );
            await updateParseReviewLifecycle(
              manager,
              lockedFiling.id,
              run!.id,
              '동일한 유형·버전·원문 파싱 결과를 재사용했습니다.',
              run!.status !== ParseStatus.SUCCEEDED,
            );
          });
          await this.enqueuePersistedAiReview(filing, run).catch(() => undefined);
          return Object.freeze({
            parseRunId: run.id,
            status: run.status,
            rawSha256: stored.sha256,
          });
        }
        // 관리자가 확정된 연결을 제거하거나 다시 연결하면 보호 중인 조회용 데이터도
        // 재시도할 수 있습니다. 중복 파싱 실행을 만들지 않고 변경되지 않은
        // 입력 조합을 재사용합니다.
      }
      const previousRun = !run
        ? await runRepository.findOne({
            where: { filingId: filing.id },
            order: { createdAt: 'DESC', id: 'DESC' },
          })
        : null;
      run ??= runRepository.create({
        filingId: filing.id,
        parserVersion: OPENDART_PARSER_VERSION,
        rawSha256: stored.sha256,
        inputType: filing.detailType,
        extractorType: filing.detailType,
        resultType: null,
        normalizerVersion: OPENDART_NORMALIZER_VERSION,
        classifierVersion: filing.classifierVersion,
        reuseFingerprint: fingerprint,
        supersedesRunId: previousRun?.id ?? null,
      });
      run.status = ParseStatus.RUNNING;
      run.confidence = null;
      run.classificationResult = null;
      run.startedAt = new Date();
      run.finishedAt = null;
      run.warningsJson = null;
      run.errorCode = null;
      run.errorMessage = null;
      run.resultJson = null;
      run.resultType = null;
      run.validationStatus = 'PENDING';
      run.candidateErrorsJson = null;
      run.normalizationAuditsJson = null;
      run = await runRepository.save(run);

      let parsedAudit: ParsedOpenDartDisclosure | null = null;
      try {
        const parsed = await parseOpenDartDisclosure({
          detailType: filing.detailType,
          archive: bytes,
          parserVersion: OPENDART_PARSER_VERSION,
        });
        parsedAudit = parsed;
        run.resultType = parsed.detailType;
        run.candidateErrorsJson = mergeCandidateErrorsWithNormalizationAudits(
          parsed.source.candidateErrors,
          parsed.source.normalizationAudits,
        ).map(jsonRecord);
        run.normalizationAuditsJson = parsed.source.normalizationAudits?.map(jsonRecord) ?? null;
        assertParseTypeInvariant(filing, run, parsed.detailType);
        const crosscheck = await this.fetchCrosscheck(filing, job.rceptNo);
        const confidence = confidenceOf(parsed);
        const warnings: ParserWarning[] = [
          ...warningsOf(parsed),
          ...projectionTextWarnings(parsed),
        ];
        let status: ParseStatus =
          confidence < 0.8 ||
          warnings.some(warningRequiresReview) ||
          !crosscheckAllowsProjection(parsed.detailType, crosscheck, filing.rceptNo)
            ? ParseStatus.PARTIAL
            : ParseStatus.SUCCEEDED;
        let projectionApplied = true;
        await this.dataSource.transaction(async (manager) => {
          const lockedFiling = await manager
            .getRepository(FilingEntity)
            .createQueryBuilder('filing')
            .setLock('pessimistic_write')
            .where('filing.id = :id', { id: filing.id })
            .getOne();
          if (
            !lockedFiling ||
            lockedFiling.rceptNo !== job.rceptNo ||
            lockedFiling.canonicalType !== filing.canonicalType ||
            lockedFiling.classifierVersion !== run.classifierVersion
          ) {
            throw new Error('Filing changed while its document was parsed.');
          }
          assertParseTypeInvariant(lockedFiling, run, parsed.detailType);
          const newestRun = await manager.getRepository(ParseRunEntity).findOne({
            where: { filingId: lockedFiling.id },
            order: { createdAt: 'DESC', id: 'DESC' },
          });
          const supersededInput = Boolean(newestRun && newestRun.id !== run.id);
          const protectsManualDecision =
            lockedFiling.effectiveState === EffectiveFilingState.ACTIVE &&
            ((await this.hasConfirmedProjectionLinks(manager, lockedFiling.id, 'D002')) ||
              (await this.hasConfirmedProjectionLinks(manager, lockedFiling.id, 'D005')));
          if (protectsManualDecision || supersededInput || status !== ParseStatus.SUCCEEDED) {
            projectionApplied = false;
            status = ParseStatus.PARTIAL;
            if (supersededInput)
              warnings.push({
                code: 'SUPERSEDED_PARSE_INPUT',
                message:
                  'A newer parse input exists; this older input cannot replace the active projection.',
              });
            if (protectsManualDecision)
              warnings.push({
                code: 'MANUAL_PLAN_LINK_REQUIRES_REVIEW',
                message:
                  'A manually confirmed D005/D002 execution link references the active projection. The new parse was retained for audit, but projection replacement was deferred for administrator review.',
              });
          } else {
            await this.replaceProjection(
              manager,
              lockedFiling.id,
              lockedFiling.companyId,
              parsed,
              crosscheck,
              lockedFiling.effectiveState,
            );
          }
          run.status = status;
          run.validationStatus = validationStatusOf(status, warnings);
          run.confidence = confidence.toFixed(6);
          run.classificationResult =
            status === ParseStatus.SUCCEEDED
              ? ClassificationReviewResult.RULE_CONFIRMED
              : ClassificationReviewResult.REVIEW_REQUIRED;
          run.finishedAt = new Date();
          run.warningsJson = warnings.map((warning) => `${warning.code}: ${warning.message}`);
          run.resultJson = {
            parsed: jsonRecord(parsed),
            crosscheck,
            rawDocumentId: document.id,
            queuedDetailType: job.detailType,
            projectionApplied,
            ...(projectionApplied
              ? {}
              : {
                  protectedActiveParseRunId: lockedFiling.activeParseRunId,
                }),
          };
          await manager.getRepository(ParseRunEntity).save(run);
          if (
            crosscheck.status === 'FAILED' &&
            (crosscheck['retryPolicy'] === 'SHORT_BACKOFF' ||
              crosscheck['retryPolicy'] === 'NEXT_KST_DAY')
          ) {
            await this.scheduleCrosscheckRetry(
              manager,
              lockedFiling,
              job.suppressAlerts,
              crosscheck,
            );
          }
          await manager.getRepository(ParseIssueEntity).delete({ parseRunId: run.id });
          for (const warning of warnings) {
            await manager.getRepository(ParseIssueEntity).save({
              parseRunId: run.id,
              severity: warningRequiresReview(warning) ? 'WARNING' : 'INFO',
              code: warning.code.slice(0, 128),
              message: warning.message,
              contextJson: jsonRecord(warning),
            });
          }
          await this.dismissDocumentUnavailableReview(
            manager,
            lockedFiling.id,
            lockedFiling.rceptNo,
            run.finishedAt,
          );
          if (projectionApplied) {
            lockedFiling.activeParseRunId = run.id;
            await manager.getRepository(FilingEntity).save(lockedFiling);
          }
          await this.materializeParsedEvent(
            manager,
            lockedFiling,
            parsed,
            run.id,
            status,
            job.suppressAlerts || !projectionApplied,
            projectionApplied,
          );
          await this.enqueueAiReview(lockedFiling.id, run.id, parsed, manager);
        });
        return Object.freeze({
          parseRunId: run.id,
          status,
          rawSha256: stored.sha256,
        });
      } catch (error) {
        run.status = ParseStatus.FAILED;
        run.confidence = null;
        run.classificationResult = ClassificationReviewResult.REVIEW_REQUIRED;
        run.finishedAt = new Date();
        run.warningsJson = null;
        run.errorCode = error instanceof OpenDartPayloadError ? error.code : 'PARSER_FAILED';
        run.errorMessage = failureMessage(error);
        run.validationStatus = 'REJECTED';
        if (error instanceof OpenDartPayloadError) {
          const audits = [
            ...(parsedAudit?.source.normalizationAudits ?? []),
            ...error.candidateErrors.flatMap((candidate) =>
              candidate.normalizationAudit ? [candidate.normalizationAudit] : [],
            ),
            ...(error.normalizationAudit ? [error.normalizationAudit] : []),
          ];
          run.normalizationAuditsJson = audits.map(jsonRecord);
          run.candidateErrorsJson = mergeCandidateErrorsWithNormalizationAudits(
            [...error.candidateErrors, ...(parsedAudit?.source.candidateErrors ?? [])],
            audits,
          ).map(jsonRecord);
        }
        run.resultJson = {
          ...(parsedAudit ? { parsed: jsonRecord(parsedAudit) } : {}),
          projectionApplied: false,
          protectedActiveParseRunId: filing.activeParseRunId,
          queuedDetailType: job.detailType,
        };
        await runRepository.save(run);
        await this.recordParseFailureReview(filing, run.id, run.errorCode, run.errorMessage);
        throw error;
      }
    } finally {
      await this.releaseFilingProjectionLock(projectionLock);
    }
  }

  public async reviewParseWithAi(job: ReviewParseWithAiJob): Promise<{
    readonly aiRunId: string | null;
    readonly status: ProcessingStatus;
    readonly classificationResult: ClassificationReviewResult;
    readonly candidatesReviewed: number;
    readonly totalEligibleRows: number;
    readonly truncated: boolean;
    readonly deduplicated: boolean;
  }> {
    const filing = await this.dataSource.getRepository(FilingEntity).findOne({
      where: { id: job.filingId },
    });
    const parseRun = await this.dataSource.getRepository(ParseRunEntity).findOne({
      where: { id: job.parseRunId, filingId: job.filingId },
    });
    if (!filing || !parseRun || filing.detailType === 'D001') {
      throw new OpenDartPayloadError(
        'AI review references a missing or ineligible filing parse run.',
        'INVALID_AI_REVIEW',
      );
    }
    const persistedParsed = persistedParsedDisclosureSchema.safeParse(
      parseRun.resultJson?.['parsed'],
    );
    if (
      !persistedParsed.success ||
      persistedParsed.data.detailType !== filing.detailType ||
      (persistedParsed.data.detailType !== 'D002' && persistedParsed.data.detailType !== 'D005')
    ) {
      throw new OpenDartPayloadError(
        'AI review requires a persisted D002 or D005 parse audit.',
        'INVALID_AI_REVIEW',
      );
    }
    const parsed = persistedParsed.data as ParsedOpenDartDisclosure;
    const selection = selectUnknownAiReviewCandidates(parsed);
    if (selection.candidates.length === 0) {
      return Object.freeze({
        aiRunId: null,
        status: ProcessingStatus.COMPLETED,
        classificationResult:
          parseRun.classificationResult ?? ClassificationReviewResult.RULE_CONFIRMED,
        candidatesReviewed: 0,
        totalEligibleRows: 0,
        truncated: false,
        deduplicated: false,
      });
    }

    const configuredModel = this.config.aiModel ?? 'unconfigured';
    const identity = {
      subjectType: 'PARSE_RUN',
      subjectId: parseRun.id,
      provider: AI_REVIEW_PROVIDER,
      model: configuredModel,
      promptHash: AI_CLASSIFIER_PROMPT_HASH,
    } as const;
    const baseInputProvenance = jsonRecord({
      source: {
        connector: filing.source,
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        selectedEntryName: parsed.source.selectedEntryName,
        archiveSha256: parsed.source.archiveSha256,
        archiveByteLength: parsed.source.archiveByteLength,
      },
      filingId: filing.id,
      rceptNo: filing.rceptNo,
      publicationDate: filing.rceptDate,
      firstObservedAt: filing.firstObservedAt.toISOString(),
      detailType: filing.detailType,
      parseRunId: parseRun.id,
      parserVersion: parseRun.parserVersion,
      rawSha256: parseRun.rawSha256,
      promptHash: AI_CLASSIFIER_PROMPT_HASH,
      totalEligibleRows: selection.totalEligibleRows,
      truncated: selection.truncated,
      candidates: selection.candidates,
    });
    const processingLeaseMs = aiReviewProcessingLeaseMs(
      this.config.aiTimeoutMs,
      selection.candidates.length,
    );
    const claimToken = randomUUID();
    const claim = await this.dataSource.transaction(async (manager) => {
      // 변경되지 않는 파싱 실행 식별자를 먼저 잠급니다. 없는 행을 추가하는 경우와
      // BullMQ 재전달 또는 여러 워커 복제본의 재시도를 모두 순차 처리합니다.
      const lockedRun = await manager
        .getRepository(ParseRunEntity)
        .createQueryBuilder('parseRun')
        .setLock('pessimistic_write')
        .where('parseRun.id = :id AND parseRun.filingId = :filingId', {
          id: parseRun.id,
          filingId: filing.id,
        })
        .getOne();
      if (!lockedRun) {
        throw new Error('AI audit target disappeared before its run was claimed.');
      }
      const claimedAt = new Date();
      const repository = manager.getRepository(AiRunEntity);
      let persisted = await repository.findOne({
        where: identity,
        lock: { mode: 'pessimistic_write' },
      });

      const claimInput = (previous: AiRunEntity | null): Record<string, unknown> =>
        jsonRecord({
          ...baseInputProvenance,
          processingClaim: {
            token: claimToken,
            claimedAt: claimedAt.toISOString(),
            leaseMs: processingLeaseMs,
          },
          ...(previous
            ? {
                retryOf: {
                  status: previous.status,
                  updatedAt: previous.updatedAt.toISOString(),
                  errorMessage: previous.errorMessage,
                },
              }
            : {}),
        });

      if (!persisted) {
        try {
          const inputProvenanceJson = claimInput(null);
          persisted = await repository.save(
            repository.create({
              ...identity,
              status: ProcessingStatus.PROCESSING,
              inputProvenanceJson,
              outputJson: null,
              errorMessage: null,
            }),
          );
          return Object.freeze({
            claimed: true as const,
            aiRun: persisted,
            inputProvenanceJson,
          });
        } catch (error) {
          if (!isAiRunIdentityConflict(error)) throw error;
          // 파싱 실행 잠금에 참여하지 않은 쓰기 작업이 고유 행을 먼저 추가할 수도
          // 있습니다. 두 번째 추론을 실행하지 않고 먼저 저장된 기준 행을 다시 읽어
          // 같은 임대 판단을 적용합니다.
          persisted = await repository.findOne({
            where: identity,
            lock: { mode: 'pessimistic_write' },
          });
          if (!persisted) {
            throw new Error('AI identity insert conflicted, but the canonical row was missing.');
          }
        }
      }

      const decision = decideAiRunClaim(
        persisted.status,
        persisted.updatedAt,
        claimedAt,
        processingLeaseMs,
      );
      if (decision !== 'CLAIM') {
        return Object.freeze({ claimed: false as const, aiRun: persisted, decision });
      }
      const inputProvenanceJson = claimInput(persisted);
      persisted.status = ProcessingStatus.PROCESSING;
      persisted.inputProvenanceJson = inputProvenanceJson;
      persisted.errorMessage = null;
      persisted = await repository.save(persisted);
      return Object.freeze({
        claimed: true as const,
        aiRun: persisted,
        inputProvenanceJson,
      });
    });

    const summarizeExisting = (existing: AiRunEntity) => {
      const priorAggregate = existing.outputJson?.['classificationResult'];
      const completedAggregate = Object.values(ClassificationReviewResult).includes(
        priorAggregate as ClassificationReviewResult,
      )
        ? (priorAggregate as ClassificationReviewResult)
        : null;
      const completed = existing.status === ProcessingStatus.COMPLETED;
      return Object.freeze({
        aiRunId: existing.id,
        status: existing.status,
        classificationResult:
          (completed ? completedAggregate : null) ??
          parseRun.classificationResult ??
          ClassificationReviewResult.REVIEW_REQUIRED,
        candidatesReviewed: completed
          ? Number(existing.outputJson?.['candidatesReviewed'] ?? 0)
          : 0,
        totalEligibleRows: completed
          ? Number(existing.outputJson?.['totalEligibleRows'] ?? selection.totalEligibleRows)
          : selection.totalEligibleRows,
        truncated: completed ? existing.outputJson?.['truncated'] === true : selection.truncated,
        deduplicated: true,
      });
    };
    if (!claim.claimed) {
      if (claim.decision === 'IN_FLIGHT') {
        // 다른 소유자가 유효한 임대를 보유한 동안에는 이 BullMQ 전달을 완료 처리하지
        // 않습니다. 이후 재시도에서 COMPLETED를 확인하거나 오래된 PROCESSING 행을
        // 다시 확보하도록 하여 비정상 종료 뒤에도 복구할 수 있게 합니다.
        throw new Error(`AI review ${claim.aiRun.id} is already processing under an active lease.`);
      }
      return summarizeExisting(claim.aiRun);
    }
    const aiRun = claim.aiRun;
    const inputProvenanceJson = claim.inputProvenanceJson;

    const unexpectedErrors: string[] = [];
    const reviews = await reviewAiCandidatesSequentially(
      selection.candidates,
      async (candidate) => {
        try {
          return await this.classifier.suggest(candidate);
        } catch (error) {
          const message = failureMessage(error);
          unexpectedErrors.push(message);
          const canonicalInput = JSON.stringify({
            methodRaw: candidate.methodRaw,
            securityTypeRaw: candidate.securityTypeRaw,
            quantity: candidate.quantity,
            deterministicNature: candidate.deterministicNature,
            deterministicDirection: candidate.deterministicDirection,
          });
          return Object.freeze({
            result: ClassificationReviewResult.REVIEW_REQUIRED,
            suggestion: null,
            reasons: Object.freeze(['AI review request failed safely.']),
            audit: Object.freeze({
              inputHash: createHash('sha256').update(canonicalInput).digest('hex'),
              model: this.config.aiModel,
              promptHash: AI_CLASSIFIER_PROMPT_HASH,
              promptVersion: AI_CLASSIFIER_PROMPT_VERSION,
              rawOutput: null,
              evidenceRefs: Object.freeze([]),
            }),
          });
        }
      },
    );
    // 제한된 응답이 모두 값을 확인하거나 안전한 값을 제안했더라도, 검토하지 않은
    // 행이 남아 있으면 해당 공시를 검토 필요 상태로 유지해야 합니다.
    const classificationResult = aggregateAiReviewClassification(reviews, selection.truncated);
    const failedReviews = reviews.filter((review) => review.suggestion === null);
    const aiStatus =
      failedReviews.length > 0 ? ProcessingStatus.FAILED : ProcessingStatus.COMPLETED;
    const outputJson = jsonRecord({
      classificationResult,
      candidatesReviewed: reviews.length,
      totalEligibleRows: selection.totalEligibleRows,
      truncated: selection.truncated,
      rows: selection.candidates.map((candidate, index) => ({
        rowIndex: candidate.rowIndex,
        deterministicNature: candidate.deterministicNature,
        deterministicDirection: candidate.deterministicDirection,
        review: reviews[index],
      })),
    });
    const errorMessage =
      aiStatus === ProcessingStatus.FAILED
        ? [...failedReviews.flatMap((review) => review.reasons), ...unexpectedErrors]
            .join(' ')
            .slice(0, 4000) || 'AI review failed safely.'
        : null;

    const persistence = await this.dataSource.transaction(async (manager) => {
      const lockedRun = await manager
        .getRepository(ParseRunEntity)
        .createQueryBuilder('parseRun')
        .setLock('pessimistic_write')
        .where('parseRun.id = :id AND parseRun.filingId = :filingId', {
          id: parseRun.id,
          filingId: filing.id,
        })
        .getOne();
      const lockedAiRun = await manager.getRepository(AiRunEntity).findOne({
        where: { id: aiRun.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedRun || !lockedAiRun) {
        throw new Error('AI audit target disappeared before its result was persisted.');
      }
      const processingClaim = lockedAiRun.inputProvenanceJson['processingClaim'];
      const persistedClaimToken =
        processingClaim && typeof processingClaim === 'object'
          ? (processingClaim as Record<string, unknown>)['token']
          : null;
      if (
        lockedAiRun.status !== ProcessingStatus.PROCESSING ||
        persistedClaimToken !== claimToken
      ) {
        // 임대가 회수된 뒤 작업을 마친 이전 워커는 새 소유자의 감사 기록이나
        // 파싱 실행 분류를 덮어써서는 안 됩니다.
        return Object.freeze({ persisted: false as const, aiRun: lockedAiRun });
      }
      lockedAiRun.status = aiStatus;
      lockedAiRun.inputProvenanceJson = inputProvenanceJson;
      lockedAiRun.outputJson = outputJson;
      lockedAiRun.errorMessage = errorMessage;
      await manager.getRepository(AiRunEntity).save(lockedAiRun);

      lockedRun.classificationResult = classificationResult;
      await manager.getRepository(ParseRunEntity).save(lockedRun);

      const review = await manager.getRepository(ReviewEntity).findOne({
        where: {
          subjectType: 'FILING',
          subjectId: filing.id,
          dedupeKey: `parse:${parseRun.id}`,
          status: ReviewTaskStatus.OPEN,
        },
      });
      if (review) {
        review.classificationResult = lockedRun.classificationResult;
        const marker = `[AI:${lockedAiRun.id}]`;
        if (!review.reason.includes(marker)) {
          review.reason = `${review.reason}\n${marker} 로컬 AI가 UNKNOWN ${reviews.length}/${selection.totalEligibleRows}개 행을 보조 검토했습니다. 결정론적 projection과 알림은 변경하지 않았습니다.`;
        }
        await manager.getRepository(ReviewEntity).save(review);
      }
      return Object.freeze({ persisted: true as const, aiRun: lockedAiRun });
    });

    if (!persistence.persisted) return summarizeExisting(persistence.aiRun);

    if (aiStatus === ProcessingStatus.FAILED) {
      throw new Error(`AI review failed after persisting audit ${aiRun.id}: ${errorMessage}`);
    }

    return Object.freeze({
      aiRunId: aiRun.id,
      status: aiStatus,
      classificationResult,
      candidatesReviewed: reviews.length,
      totalEligibleRows: selection.totalEligibleRows,
      truncated: selection.truncated,
      deduplicated: false,
    });
  }

  private async enqueueAiReview(
    filingId: string,
    parseRunId: string,
    parsed: ParsedOpenDartDisclosure,
    manager?: EntityManager,
  ): Promise<void> {
    if (!this.classifier.enabled || !this.config.aiModel) return;
    const selection = selectUnknownAiReviewCandidates(parsed);
    if (selection.candidates.length === 0) return;
    const modelPromptKey = createHash('sha256')
      .update(`${this.config.aiModel}\0${AI_CLASSIFIER_PROMPT_HASH}`)
      .digest('hex');
    const dedupeKey = `ai-review:${parseRunId}:${modelPromptKey}`;
    const processingLeaseMs = aiReviewProcessingLeaseMs(
      this.config.aiTimeoutMs,
      selection.candidates.length,
    );
    const enqueue = async (transactionManager: EntityManager): Promise<void> => {
      const now = new Date();
      const aiRun = await transactionManager.getRepository(AiRunEntity).findOne({
        where: {
          subjectType: 'PARSE_RUN',
          subjectId: parseRunId,
          provider: AI_REVIEW_PROVIDER,
          model: this.config.aiModel!,
          promptHash: AI_CLASSIFIER_PROMPT_HASH,
        },
        lock: { mode: 'pessimistic_write' },
      });
      const repository = transactionManager.getRepository(ProcessingOutboxEntity);
      let outbox = await repository.findOne({
        where: { kind: 'REVIEW_PARSE_WITH_AI', dedupeKey },
        lock: { mode: 'pessimistic_write' },
      });

      if (!outbox) {
        const recoveryReason = aiReviewRecoveryReason(aiRun, now, processingLeaseMs);
        if (!recoveryReason) return;
        const recoveringExistingRun = aiRun !== null;
        const availableAt = new Date(
          recoveringExistingRun
            ? Math.max(
                now.getTime(),
                aiRun.updatedAt.getTime() + AI_REVIEW_OUTBOX_REARM_COOLDOWN_MS,
              )
            : now.getTime(),
        );
        try {
          await repository.save({
            kind: 'REVIEW_PARSE_WITH_AI',
            dedupeKey,
            payloadJson: {
              filingId,
              parseRunId,
              ...(recoveringExistingRun
                ? {
                    aiReviewRearm: {
                      count: 1,
                      reason: recoveryReason,
                      requestedAt: now.toISOString(),
                      notBefore: availableAt.toISOString(),
                      previousOutboxStatus: null,
                      previousLastError: null,
                    },
                  }
                : {}),
            },
            status: ProcessingStatus.PENDING,
            availableAt,
            // AI 실행이 이미 있으면 운영자가 이전 outbox를 삭제했더라도
            // 다음 영속 전달 세대 번호를 사용합니다.
            attempts: recoveringExistingRun ? 1 : 0,
            lockedAt: null,
            lastError: recoveringExistingRun
              ? `AI review delivery recreated after ${recoveryReason}.`
              : null,
          });
          return;
        } catch (error) {
          if (!isUniqueConstraintConflict(error)) throw error;
          outbox = await repository.findOne({
            where: { kind: 'REVIEW_PARSE_WITH_AI', dedupeKey },
            lock: { mode: 'pessimistic_write' },
          });
          if (!outbox) {
            throw new Error(
              'AI outbox identity insert conflicted, but the canonical row was missing.',
            );
          }
        }
      }

      const rearm = planAiReviewOutboxRearm({
        outbox,
        aiRun,
        now,
        processingLeaseMs,
      });
      if (!rearm) return;
      const previousOutboxStatus = outbox.status;
      const previousLastError = outbox.lastError;
      outbox.payloadJson = {
        filingId,
        parseRunId,
        aiReviewRearm: {
          count: rearm.count,
          reason: rearm.reason,
          requestedAt: now.toISOString(),
          notBefore: rearm.availableAt.toISOString(),
          previousOutboxStatus,
          previousLastError,
        },
      };
      outbox.status = ProcessingStatus.PENDING;
      outbox.availableAt = rearm.availableAt;
      // 전달 세대 번호는 계속 증가해야 합니다. 전송기는 이 카운터로 BullMQ 작업 ID를
      // 만들기 때문에, 초기화하면 첫 전달 뒤 보존된 작업과 충돌해 복구가
      // 오류 표시 없이 건너뛰어집니다.
      outbox.lockedAt = null;
      outbox.lastError = `AI review delivery re-armed (${rearm.count}/${MAX_AI_REVIEW_OUTBOX_REARMS}) after ${rearm.reason}.`;
      await repository.save(outbox);
    };

    if (manager) {
      await enqueue(manager);
    } else {
      await this.dataSource.transaction(enqueue);
    }
  }

  private async enqueuePersistedAiReview(
    filing: FilingEntity,
    parseRun: ParseRunEntity,
  ): Promise<void> {
    const persistedParsed = persistedParsedDisclosureSchema.safeParse(
      parseRun.resultJson?.['parsed'],
    );
    if (!persistedParsed.success || persistedParsed.data.detailType !== filing.detailType) return;
    await this.enqueueAiReview(
      filing.id,
      parseRun.id,
      persistedParsed.data as ParsedOpenDartDisclosure,
    );
  }

  public async applyDeferredProjection(job: ApplyParseProjectionJob): Promise<{
    readonly parseRunId: string;
    readonly status: ParseStatus;
    readonly projectionApplied: boolean;
    readonly crosscheckOnly?: boolean;
  }> {
    const filingSnapshot = await this.dataSource
      .getRepository(FilingEntity)
      .findOne({ where: { id: job.filingId } });
    if (!filingSnapshot) {
      throw new OpenDartPayloadError(
        'Deferred projection references a missing filing.',
        'INVALID_DEFERRED_PROJECTION',
      );
    }
    const projectionLock = await this.acquireCompanyProjectionLock(filingSnapshot.companyId);
    try {
      const run = await this.dataSource.getRepository(ParseRunEntity).findOne({
        where: { id: job.parseRunId, filingId: job.filingId },
      });
      const filing = await this.dataSource.getRepository(FilingEntity).findOne({
        where: { id: job.filingId },
      });
      if (!run || !filing) {
        throw new OpenDartPayloadError(
          'Deferred projection references a missing filing or parse run.',
          'INVALID_DEFERRED_PROJECTION',
        );
      }
      if (run.validationStatus === 'REJECTED' || run.validationStatus === 'LEGACY') {
        throw new OpenDartPayloadError(
          'Rejected or legacy parse requires a fresh validated run.',
          'PARSE_VALIDATION_REJECTED',
        );
      }
      const resultJson = run.resultJson;
      const initialProjectionApplied = resultJson?.['projectionApplied'];
      if (
        !resultJson ||
        (initialProjectionApplied !== true && initialProjectionApplied !== false)
      ) {
        throw new OpenDartPayloadError(
          'Parse run is not a deferred projection.',
          'INVALID_DEFERRED_PROJECTION',
        );
      }
      let parsed: ParsedOpenDartDisclosure | null = null;
      if (initialProjectionApplied === false) {
        const parsedAudit = persistedParsedDisclosureSchema.safeParse(resultJson['parsed']);
        if (!parsedAudit.success) {
          throw new OpenDartPayloadError(
            'Deferred projection contains an invalid persisted parse audit.',
            'INVALID_DEFERRED_PROJECTION',
          );
        }
        parsed = parsedAudit.data as ParsedOpenDartDisclosure;
      }
      if (parsed && parsed.detailType !== filing.detailType) {
        throw new OpenDartPayloadError(
          'Deferred parse detail type does not match its filing.',
          'INVALID_DEFERRED_PROJECTION',
        );
      }
      assertParseTypeInvariant(filing, run, parsed?.detailType ?? run.resultType);
      if (parsed && validationStatusOf(run.status, warningsOf(parsed)) === 'REJECTED') {
        throw new OpenDartPayloadError(
          'Invalid extracted rows cannot be manually activated.',
          'PARSE_VALIDATION_REJECTED',
        );
      }
      const crosscheckValue = resultJson['crosscheck'];
      let crosscheck =
        crosscheckValue && typeof crosscheckValue === 'object' && !Array.isArray(crosscheckValue)
          ? jsonRecord(crosscheckValue)
          : { status: 'MISSING' };
      const staging = resultJson['staging'];
      const crosscheckOnly = job.crosscheckOnly === true;
      if (
        crosscheckOnly &&
        (!staging ||
          typeof staging !== 'object' ||
          Array.isArray(staging) ||
          (staging as Record<string, unknown>)['mode'] !== 'OFFLINE_INACTIVE')
      ) {
        throw new OpenDartPayloadError(
          'Crosscheck-only job requires an offline staged result.',
          'INVALID_CROSSCHECK_REQUEST',
        );
      }
      if (
        crosscheckOnly &&
        !crosscheckAllowsProjection(filing.detailType, crosscheck, filing.rceptNo)
      ) {
        // Explicit administrator request: fetch evidence only. A second review is
        // required after the original rows and official summary can be compared.
        crosscheck = await this.fetchCrosscheck(filing, filing.rceptNo);
      } else if (
        !crosscheckOnly &&
        !crosscheckAllowsProjection(filing.detailType, crosscheck, filing.rceptNo)
      ) {
        throw new OpenDartPayloadError(
          'An applicable source crosscheck must finish before projection activation.',
          'PARSE_CROSSCHECK_REQUIRED',
        );
      }

      return await this.dataSource.transaction(async (manager) => {
        // 프로세스 간 잠금 순서를 일반 보강 및 검토 해결과 동일하게 유지합니다.
        // 순서는 Filing -> ParseRun -> relations/matches -> Review입니다.
        // 앞의 두 순서를 뒤집으면 Filing 다음 ParseRun.save를 수행하는 보강 작업과
        // 관리자가 승인한 보류 데이터 적용 사이에 교착이 발생할 수 있습니다.
        const lockedFiling = await manager
          .getRepository(FilingEntity)
          .createQueryBuilder('filing')
          .setLock('pessimistic_write')
          .where('filing.id = :id', { id: filing.id })
          .getOne();
        const lockedRun = await manager
          .getRepository(ParseRunEntity)
          .createQueryBuilder('parseRun')
          .setLock('pessimistic_write')
          .where('parseRun.id = :id AND parseRun.filingId = :filingId', {
            id: run.id,
            filingId: filing.id,
          })
          .getOne();
        if (!lockedRun || !lockedFiling) {
          throw new Error('Deferred projection disappeared while being applied.');
        }
        assertParseTypeInvariant(
          lockedFiling,
          lockedRun,
          parsed?.detailType ?? lockedRun.resultType,
        );
        if (lockedRun.validationStatus === 'REJECTED' || lockedRun.validationStatus === 'LEGACY') {
          throw new OpenDartPayloadError(
            'Rejected parse cannot be activated.',
            'PARSE_VALIDATION_REJECTED',
          );
        }
        if (
          lockedFiling.rceptNo !== filing.rceptNo ||
          lockedFiling.detailType !== filing.detailType ||
          lockedFiling.companyId !== filingSnapshot.companyId ||
          (parsed && parsed.detailType !== lockedFiling.detailType)
        ) {
          throw new OpenDartPayloadError(
            'Deferred projection no longer matches its locked filing.',
            'INVALID_DEFERRED_PROJECTION',
          );
        }
        if (lockedFiling.effectiveState !== EffectiveFilingState.ACTIVE) {
          if (lockedRun.resultJson?.['projectionApplied'] === false) {
            lockedRun.resultJson = {
              ...lockedRun.resultJson,
              projectionApplied: false,
              projectionSuppressedReason: 'INACTIVE_FILING',
              projectionSkippedAt: new Date().toISOString(),
            };
            await manager.getRepository(ParseRunEntity).save(lockedRun);
          }
          await this.resolveDeferredProjectionReview(
            manager,
            lockedFiling.id,
            lockedRun.id,
            job.requestedByAdminId,
            new Date(),
            'PROJECTION_SKIPPED_INACTIVE_FILING',
          );
          return Object.freeze({
            parseRunId: lockedRun.id,
            status: lockedRun.status,
            projectionApplied: false,
          });
        }
        if (lockedRun.resultJson?.['projectionApplied'] === true) {
          if (lockedFiling.activeParseRunId !== lockedRun.id) {
            throw new OpenDartPayloadError(
              'The deferred parse was applied previously but is no longer the active projection.',
              'INVALID_DEFERRED_PROJECTION',
            );
          }
          await this.resolveDeferredProjectionReview(
            manager,
            lockedFiling.id,
            lockedRun.id,
            job.requestedByAdminId,
            new Date(),
          );
          return Object.freeze({
            parseRunId: lockedRun.id,
            status: lockedRun.status,
            projectionApplied: true as const,
          });
        }
        if (lockedRun.resultJson?.['projectionApplied'] !== false) {
          throw new OpenDartPayloadError(
            'Locked parse run is no longer a deferred projection.',
            'INVALID_DEFERRED_PROJECTION',
          );
        }
        if (!parsed) {
          throw new OpenDartPayloadError(
            'Deferred parse payload is missing after acquiring its lock.',
            'INVALID_DEFERRED_PROJECTION',
          );
        }
        const protectedActiveParseRunId = lockedRun.resultJson['protectedActiveParseRunId'];
        if (
          protectedActiveParseRunId !== undefined &&
          protectedActiveParseRunId !== null &&
          typeof protectedActiveParseRunId !== 'string'
        ) {
          throw new OpenDartPayloadError(
            'Deferred projection has an invalid protected baseline.',
            'INVALID_DEFERRED_PROJECTION',
          );
        }
        if (
          protectedActiveParseRunId !== undefined &&
          lockedFiling.activeParseRunId !== protectedActiveParseRunId
        ) {
          await this.recordStaleDeferredProjectionReview(
            manager,
            lockedFiling,
            lockedRun,
            '활성 projection이 검토 대기 이후 변경되어 오래된 재파싱 적용을 중단했습니다.',
          );
          return Object.freeze({
            parseRunId: lockedRun.id,
            status: lockedRun.status,
            projectionApplied: false as const,
          });
        }
        const newestRun = await manager.getRepository(ParseRunEntity).findOne({
          where: { filingId: lockedFiling.id },
          order: { createdAt: 'DESC', id: 'DESC' },
        });
        if (newestRun && newestRun.id !== lockedRun.id) {
          await this.recordStaleDeferredProjectionReview(
            manager,
            lockedFiling,
            lockedRun,
            '더 최신인 parse run이 존재하여 오래된 재파싱 적용을 중단했습니다.',
          );
          return Object.freeze({
            parseRunId: lockedRun.id,
            status: lockedRun.status,
            projectionApplied: false as const,
          });
        }

        if (crosscheckOnly) {
          const checkedAt = new Date().toISOString();
          const previousAttempts = lockedRun.resultJson['crosscheckAttempts'];
          lockedRun.resultJson = {
            ...lockedRun.resultJson,
            crosscheck,
            crosscheckCheckedAt: checkedAt,
            crosscheckRequestedByAdminId: job.requestedByAdminId,
            crosscheckAttempts: [
              ...(Array.isArray(previousAttempts) ? previousAttempts : []),
              { checkedAt, requestedByAdminId: job.requestedByAdminId, result: crosscheck },
            ],
            projectionApplied: false,
          };
          lockedRun.status = ParseStatus.PARTIAL;
          lockedRun.validationStatus = 'REVIEW_REQUIRED';
          lockedRun.classificationResult = ClassificationReviewResult.REVIEW_REQUIRED;
          lockedRun.warningsJson = [
            ...(lockedRun.warningsJson ?? []).filter(
              (warning) =>
                !warning.startsWith('OFFLINE_CROSSCHECK_NOT_RUN:') &&
                !warning.startsWith('OFFICIAL_SUMMARY_REVIEW_REQUIRED:'),
            ),
            `OFFICIAL_SUMMARY_REVIEW_REQUIRED: ${
              crosscheck['status'] === 'OK' || crosscheck['status'] === 'NOT_APPLICABLE'
                ? '공식 요약 근거를 저장했습니다. 원문 행과 비교한 뒤 별도로 적용을 확정해 주세요.'
                : '공식 요약 조회를 완료하지 못했습니다. 결과는 비활성으로 유지하며 다시 검증할 수 있습니다.'
            }`,
          ];
          await manager.getRepository(ParseRunEntity).save(lockedRun);
          await updateParseReviewLifecycle(
            manager,
            lockedFiling.id,
            lockedRun.id,
            `공식 요약 검증 ${String(crosscheck['status'])}: 원문 필드와 개별 비교·확정 필요`,
            true,
          );
          return Object.freeze({
            parseRunId: lockedRun.id,
            status: lockedRun.status,
            projectionApplied: false,
            crosscheckOnly: true,
          });
        }

        const supersededManualLinks = await this.snapshotManualProjectionLinks(
          manager,
          lockedFiling.id,
          parsed.detailType,
        );
        await this.replaceProjection(
          manager,
          lockedFiling.id,
          lockedFiling.companyId,
          parsed,
          crosscheck,
          lockedFiling.effectiveState,
        );

        const parserWarnings = [...warningsOf(parsed), ...projectionTextWarnings(parsed)];
        const requiresRelink =
          supersededManualLinks.relations.length > 0 || supersededManualLinks.matches.length > 0;
        if (requiresRelink) {
          parserWarnings.push({
            code: 'MANUAL_PLAN_LINK_INVALIDATED_BY_APPROVED_REPARSE',
            message:
              'Administrator-approved projection replacement invalidated prior manual D005/D002 links; the prior decisions remain in the parse audit snapshot and require relinking.',
          });
        }
        const confidence = confidenceOf(parsed);
        const status: ParseStatus =
          confidence < 0.8 ||
          parserWarnings.some(warningRequiresReview) ||
          !crosscheckAllowsProjection(parsed.detailType, crosscheck, lockedFiling.rceptNo)
            ? ParseStatus.PARTIAL
            : ParseStatus.SUCCEEDED;
        lockedRun.status = status;
        lockedRun.validationStatus = validationStatusOf(status, parserWarnings);
        lockedRun.confidence = confidence.toFixed(6);
        lockedRun.classificationResult = preserveAiClassificationResult(
          lockedRun.classificationResult,
          status === ParseStatus.SUCCEEDED
            ? ClassificationReviewResult.RULE_CONFIRMED
            : ClassificationReviewResult.REVIEW_REQUIRED,
        );
        lockedRun.finishedAt = new Date();
        lockedRun.warningsJson = parserWarnings.map(
          (warning) => `${warning.code}: ${warning.message}`,
        );
        lockedRun.errorCode = null;
        lockedRun.errorMessage = null;
        lockedRun.resultJson = {
          ...lockedRun.resultJson,
          projectionApplied: true,
          projectionAppliedAt: lockedRun.finishedAt.toISOString(),
          projectionAppliedByAdminId: job.requestedByAdminId,
          supersededManualLinks,
        };
        await manager.getRepository(ParseRunEntity).save(lockedRun);
        await manager.getRepository(ParseIssueEntity).delete({
          parseRunId: lockedRun.id,
        });
        for (const warning of parserWarnings) {
          await manager.getRepository(ParseIssueEntity).save({
            parseRunId: lockedRun.id,
            severity: warningRequiresReview(warning) ? 'WARNING' : 'INFO',
            code: warning.code.slice(0, 128),
            message: warning.message,
            contextJson: jsonRecord(warning),
          });
        }
        if (
          crosscheck['status'] === 'FAILED' &&
          (crosscheck['retryPolicy'] === 'SHORT_BACKOFF' ||
            crosscheck['retryPolicy'] === 'NEXT_KST_DAY')
        ) {
          // projectionApplied=false인 동안 ENRICH는 의도적으로 이 실행을 변경하지
          // 않습니다. 승인된 조회용 데이터가 활성화된 뒤에만 근거 재시도를 다시 설정합니다.
          // 이후 retryPersistedCrosscheck를 사용하므로 모든 거래·연결 행의
          // 식별자가 그대로 유지됩니다.
          await this.scheduleCrosscheckRetry(manager, lockedFiling, false, crosscheck);
        }
        lockedFiling.activeParseRunId = lockedRun.id;
        await manager.getRepository(FilingEntity).save(lockedFiling);

        await this.resolveDeferredProjectionReview(
          manager,
          lockedFiling.id,
          lockedRun.id,
          job.requestedByAdminId,
          lockedRun.finishedAt,
        );
        if (requiresRelink) {
          const reviewRepository = manager.getRepository(ReviewEntity);
          const dedupeKey = `relink-after-projection:${lockedRun.id}`;
          if (
            !(await reviewRepository.findOne({
              where: {
                subjectType: 'FILING',
                subjectId: lockedFiling.id,
                dedupeKey,
              },
            }))
          ) {
            await reviewRepository.save({
              subjectType: 'FILING',
              subjectId: lockedFiling.id,
              dedupeKey,
              reason:
                '승인된 재파싱으로 기존 수동 거래계획 연결이 무효화되었습니다. 새 projection 후보를 검토해 다시 연결해야 합니다.',
              status: ReviewTaskStatus.OPEN,
              classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
              resolution: null,
              resolvedByAdminId: null,
              resolvedAt: null,
            });
          }
        }
        await this.materializeParsedEvent(
          manager,
          lockedFiling,
          parsed,
          lockedRun.id,
          status,
          false,
          true,
        );
        return Object.freeze({
          parseRunId: lockedRun.id,
          status,
          projectionApplied: true as const,
        });
      });
    } finally {
      await this.releaseFilingProjectionLock(projectionLock);
    }
  }

  public async recordDocumentUnavailableReview(
    job: EnrichFilingJob,
    message: string,
  ): Promise<void> {
    const filing = await this.dataSource.getRepository(FilingEntity).findOne({
      where: { id: job.filingId, rceptNo: job.rceptNo },
    });
    if (!filing) return;
    await this.dataSource.transaction(async (manager) => {
      const lockedFiling = await manager
        .getRepository(FilingEntity)
        .createQueryBuilder('filing')
        .setLock('pessimistic_write')
        .where('filing.id = :id AND filing.rceptNo = :rceptNo', {
          id: filing.id,
          rceptNo: job.rceptNo,
        })
        .getOne();
      if (!lockedFiling) return;
      const event = await manager.getRepository(EventClusterEntity).findOne({
        where: { dedupeKey: `opendart:filing:${lockedFiling.id}` },
      });
      if (event && !lockedFiling.activeParseRunId) {
        event.state =
          lockedFiling.effectiveState === EffectiveFilingState.CANCELLED ||
          lockedFiling.effectiveState === EffectiveFilingState.WITHDRAWN
            ? EventState.CANCELLED
            : lockedFiling.effectiveState === EffectiveFilingState.SUPERSEDED
              ? EventState.SUPERSEDED
              : EventState.REVIEW_REQUIRED;
        event.processedAt = new Date();
        event.summary = `[${lockedFiling.detailType} 원문 대기 만료] ${lockedFiling.reportName}`;
        event.metadataJson = {
          ...(event.metadataJson ?? {}),
          phase: 'DOCUMENT_UNAVAILABLE',
          apiStatus: '014',
        };
        await manager.getRepository(EventClusterEntity).save(event);
      }
      const repository = manager.getRepository(ReviewEntity);
      const dedupeKey = `document:${lockedFiling.rceptNo}:014`;
      if (
        !(await repository.findOne({
          where: {
            subjectType: 'FILING',
            subjectId: lockedFiling.id,
            dedupeKey,
          },
        }))
      ) {
        await repository.save({
          subjectType: 'FILING',
          subjectId: lockedFiling.id,
          dedupeKey,
          reason: `OpenDART 원문이 10분/1시간/6시간 재시도 후에도 준비되지 않았습니다: ${message.slice(0, 1000)}`,
          status: ReviewTaskStatus.OPEN,
          classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
          resolution: null,
          resolvedByAdminId: null,
          resolvedAt: null,
        });
      }
    });
  }

  private async acquireCompanyProjectionLock(companyId: string): Promise<FilingProjectionLock> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    // D002와 D005 작업은 공시 ID가 다르지만 같은 계획 후보의 연결 관계를 수정합니다.
    // 어느 쪽이든 트랜잭션 행 잠금을 시작하기 전에 기업 단위 자문 잠금으로
    // 두 경로를 순차 처리합니다.
    const lockName = `orsem:company:${companyId}`;
    try {
      const rows = (await runner.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName])) as Array<{
        acquired: number | string | null;
      }>;
      if (Number(rows[0]?.acquired) !== 1) {
        throw new Error('Timed out acquiring the filing projection lock.');
      }
      return { runner, name: lockName };
    } catch (error) {
      await runner.release().catch(() => undefined);
      throw error;
    }
  }

  private async releaseFilingProjectionLock(lock: FilingProjectionLock): Promise<void> {
    try {
      await lock.runner.query('SELECT RELEASE_LOCK(?)', [lock.name]);
    } finally {
      await lock.runner.release();
    }
  }

  private async resolveDeferredProjectionReview(
    manager: EntityManager,
    filingId: string,
    parseRunId: string,
    adminId: string,
    resolvedAt: Date,
    resolution = 'PROJECTION_APPLIED',
  ): Promise<void> {
    const repository = manager.getRepository(ReviewEntity);
    const parseReview = await repository.findOne({
      where: {
        subjectType: 'FILING',
        subjectId: filingId,
        dedupeKey: `parse:${parseRunId}`,
        status: ReviewTaskStatus.OPEN,
      },
    });
    if (!parseReview) return;
    parseReview.status = ReviewTaskStatus.RESOLVED;
    parseReview.resolution = JSON.stringify({
      resolution,
      requestedByAdminId: adminId,
    });
    parseReview.resolvedByAdminId = adminId;
    parseReview.resolvedAt = resolvedAt;
    await repository.save(parseReview);
  }

  private async recordStaleDeferredProjectionReview(
    manager: EntityManager,
    filing: FilingEntity,
    run: ParseRunEntity,
    reason: string,
  ): Promise<void> {
    run.resultJson = {
      ...run.resultJson,
      projectionApplied: false,
      projectionSuppressedReason: reason,
    };
    await manager.getRepository(ParseRunEntity).save(run);
    await updateParseReviewLifecycle(manager, filing.id, run.id, reason, true);
  }

  private async dismissDocumentUnavailableReview(
    manager: EntityManager,
    filingId: string,
    rceptNo: string,
    resolvedAt: Date,
  ): Promise<void> {
    const repository = manager.getRepository(ReviewEntity);
    const review = await repository.findOne({
      where: {
        subjectType: 'FILING',
        subjectId: filingId,
        dedupeKey: `document:${rceptNo}:014`,
        status: ReviewTaskStatus.OPEN,
      },
    });
    if (!review) return;
    review.status = ReviewTaskStatus.DISMISSED;
    review.resolution = JSON.stringify({
      resolution: 'DOCUMENT_BECAME_AVAILABLE',
    });
    review.resolvedByAdminId = null;
    review.resolvedAt = resolvedAt;
    await repository.save(review);
  }

  private async dismissParseFailureReview(
    manager: EntityManager,
    filingId: string,
    parseRunId: string,
    resolvedAt: Date,
  ): Promise<void> {
    const repository = manager.getRepository(ReviewEntity);
    const review = await repository.findOne({
      where: {
        subjectType: 'FILING',
        subjectId: filingId,
        dedupeKey: `parse:${parseRunId}:failed`,
        status: ReviewTaskStatus.OPEN,
      },
    });
    if (!review) return;
    review.status = ReviewTaskStatus.DISMISSED;
    review.resolution = JSON.stringify({
      resolution: 'PARSE_RETRY_SUCCEEDED',
    });
    review.resolvedByAdminId = null;
    review.resolvedAt = resolvedAt;
    await repository.save(review);
  }

  private async snapshotManualProjectionLinks(
    manager: EntityManager,
    filingId: string,
    detailType: ParsedOpenDartDisclosure['detailType'],
  ): Promise<{
    readonly relations: readonly Record<string, unknown>[];
    readonly matches: readonly Record<string, unknown>[];
  }> {
    if (detailType === 'D001') return { relations: [], matches: [] };
    const relationRepository = manager.getRepository(FilingRelationEntity);
    const relations = await relationRepository
      .createQueryBuilder('relation')
      .setLock('pessimistic_write')
      .where(
        detailType === 'D002'
          ? 'relation.fromFilingId = :filingId'
          : 'relation.toFilingId = :filingId',
        { filingId },
      )
      .getMany();
    const manuallyConfirmedRelations = relations.filter(
      (relation) =>
        relation.reviewDecision === RelationReviewDecision.CONFIRMED &&
        (relation.relationType === FilingRelationType.FULFILLS_PLAN ||
          (relation.relationType === FilingRelationType.EXECUTION_CANDIDATE &&
            relation.source === RelationSource.MANUAL)),
    );

    let matches: PlanExecutionMatchEntity[] = [];
    if (detailType === 'D002') {
      const reports = await manager
        .getRepository(InsiderReportEntity)
        .find({ where: { filingId } });
      const transactions =
        reports.length === 0
          ? []
          : await manager.getRepository(InsiderTransactionEntity).find({
              where: {
                insiderReportId: In(reports.map((report) => report.id)),
              },
            });
      if (transactions.length > 0) {
        matches = await manager
          .getRepository(PlanExecutionMatchEntity)
          .createQueryBuilder('executionMatch')
          .setLock('pessimistic_write')
          .where('executionMatch.insiderTransactionId IN (:...ids)', {
            ids: transactions.map((transaction) => transaction.id),
          })
          .getMany();
      }
    } else {
      const plans = await manager.getRepository(TradePlanEntity).find({ where: { filingId } });
      const items =
        plans.length === 0
          ? []
          : await manager.getRepository(TradePlanItemEntity).find({
              where: { tradePlanId: In(plans.map((plan) => plan.id)) },
            });
      if (items.length > 0) {
        matches = await manager
          .getRepository(PlanExecutionMatchEntity)
          .createQueryBuilder('executionMatch')
          .setLock('pessimistic_write')
          .where('executionMatch.tradePlanItemId IN (:...ids)', {
            ids: items.map((item) => item.id),
          })
          .getMany();
      }
    }
    const manuallyConfirmedMatches = matches.filter(isConfirmedPlanExecutionMatch);
    if (manuallyConfirmedRelations.length > 0) {
      // 공시 단위 관계에는 조회용 행을 가리키는 외래 키가 없습니다. 별도로 처리하지
      // 않으면 확정된 행이 교체된 뒤에도 FULFILLS_PLAN을 잘못 유지하게 됩니다.
      // 감사 기록을 위해 기존 값 전체를 아래에 보존합니다.
      await relationRepository.delete({
        id: In(manuallyConfirmedRelations.map((relation) => relation.id)),
      });
    }
    return {
      relations: manuallyConfirmedRelations.map((relation) => jsonRecord(relation)),
      matches: manuallyConfirmedMatches.map((match) => jsonRecord(match)),
    };
  }

  private async scheduleCrosscheckRetry(
    manager: EntityManager,
    filing: FilingEntity,
    suppressAlerts: boolean,
    crosscheck: Record<string, unknown>,
  ): Promise<void> {
    const retryPolicy = crosscheck['retryPolicy'];
    const availableAt =
      retryPolicy === 'NEXT_KST_DAY' ? nextKstMidnight() : new Date(Date.now() + 15 * 60_000);
    const repository = manager.getRepository(ProcessingOutboxEntity);
    const kind = 'ENRICH_FILING';
    const dedupeKey = `opendart:${filing.id}:summary-crosscheck`;
    let outbox = await repository.findOne({ where: { kind, dedupeKey } });
    if (!outbox) {
      outbox = repository.create({
        kind,
        dedupeKey,
        payloadJson: {
          filingId: filing.id,
          rceptNo: filing.rceptNo,
          detailType: filing.detailType,
          suppressAlerts,
        },
      });
    }
    outbox.status = ProcessingStatus.PENDING;
    outbox.availableAt = availableAt;
    outbox.lockedAt = null;
    outbox.lastError = null;
    await repository.save(outbox);
  }

  /**
   * 조회용 행은 관리자가 확정한 D005/D002 연결의 외래 키 대상입니다.
   * 이를 교체하면 수동 판단이 오류 표시 없이 삭제될 수 있습니다.
   * 확정과 재파싱이 동시에 엇갈리지 않도록 모든 공시 단위 관계를 먼저 잠급니다.
   * 변경된 문서는 검토용 PARTIAL 파싱 결과로 저장하며, 마지막으로 승인된
   * 조회용 데이터는 활성 상태로 유지합니다.
   */
  private async hasConfirmedProjectionLinks(
    manager: EntityManager,
    filingId: string,
    detailType: ParsedOpenDartDisclosure['detailType'],
  ): Promise<boolean> {
    if (detailType === 'D001') return false;

    const relationAlias = 'relation';
    const relations = await manager
      .getRepository(FilingRelationEntity)
      .createQueryBuilder(relationAlias)
      .setLock('pessimistic_write')
      .where(
        detailType === 'D002'
          ? `${relationAlias}.fromFilingId = :filingId`
          : `${relationAlias}.toFilingId = :filingId`,
        { filingId },
      )
      .getMany();
    if (
      relations.some(
        (relation) =>
          relation.reviewDecision === RelationReviewDecision.CONFIRMED &&
          (relation.relationType === FilingRelationType.FULFILLS_PLAN ||
            (relation.relationType === FilingRelationType.EXECUTION_CANDIDATE &&
              relation.source === RelationSource.MANUAL)),
      )
    ) {
      return true;
    }

    if (detailType === 'D002') {
      const reports = await manager
        .getRepository(InsiderReportEntity)
        .find({ where: { filingId } });
      if (reports.length === 0) return false;
      const transactions = await manager.getRepository(InsiderTransactionEntity).find({
        where: { insiderReportId: In(reports.map((report) => report.id)) },
      });
      if (transactions.length === 0) return false;
      const matches = await manager
        .getRepository(PlanExecutionMatchEntity)
        .createQueryBuilder('executionMatch')
        .setLock('pessimistic_write')
        .where('executionMatch.insiderTransactionId IN (:...ids)', {
          ids: transactions.map((transaction) => transaction.id),
        })
        .getMany();
      return matches.some(isConfirmedPlanExecutionMatch);
    }

    const plans = await manager.getRepository(TradePlanEntity).find({ where: { filingId } });
    if (plans.length === 0) return false;
    const items = await manager.getRepository(TradePlanItemEntity).find({
      where: { tradePlanId: In(plans.map((plan) => plan.id)) },
    });
    if (items.length === 0) return false;
    const matches = await manager
      .getRepository(PlanExecutionMatchEntity)
      .createQueryBuilder('executionMatch')
      .setLock('pessimistic_write')
      .where('executionMatch.tradePlanItemId IN (:...ids)', {
        ids: items.map((item) => item.id),
      })
      .getMany();
    return matches.some(isConfirmedPlanExecutionMatch);
  }

  private async fetchCrosscheck(
    filing: FilingEntity,
    rceptNo: string,
  ): Promise<Record<string, unknown>> {
    if (filing.detailType === 'D005') {
      return { status: 'NOT_APPLICABLE' };
    }
    const company = await this.dataSource
      .getRepository(FilingEntity)
      .createQueryBuilder('filing')
      .innerJoin('companies', 'company', 'company.id = filing.company_id')
      .select('company.corp_code', 'corpCode')
      .where('filing.id = :id', { id: filing.id })
      .getRawOne<{ corpCode: string | null }>();
    if (!company?.corpCode) return { status: 'NO_CORP_CODE' };
    try {
      const rows =
        filing.detailType === 'D001'
          ? await this.client.fetchMajorStock(company.corpCode)
          : await this.client.fetchEleStock(company.corpCode);
      await this.connectorHealth
        .recordOpenDart(ConnectorStatus.HEALTHY, null, {
          operation: filing.detailType === 'D001' ? 'MAJORSTOCK' : 'ELESTOCK',
        })
        .catch(() => undefined);
      const exactReceiptMatches = rows
        .filter((row) => row.rcept_no === rceptNo)
        .map((row) => ({ ...row }));
      return {
        status: exactReceiptMatches.length ? 'OK' : 'NO_RECEIPT_MATCH',
        exactReceiptMatches,
      };
    } catch (error) {
      if (error instanceof OpenDartApiError && error.status === '020') {
        await this.connectorHealth
          .pauseOpenDartUntil(nextKstMidnight(), error.apiMessage)
          .catch(() => undefined);
      } else {
        await this.connectorHealth
          .recordOpenDart(
            error instanceof OpenDartApiError && error.retryPolicy === 'NONE'
              ? ConnectorStatus.FAILED
              : ConnectorStatus.DEGRADED,
            failureMessage(error),
            { operation: 'SUMMARY' },
          )
          .catch(() => undefined);
      }
      return {
        status: 'FAILED',
        message: failureMessage(error),
        apiStatus: error instanceof OpenDartApiError ? error.status : null,
        retryPolicy: error instanceof OpenDartApiError ? error.retryPolicy : 'SHORT_BACKOFF',
      };
    }
  }

  /**
   * 요약 엔드포인트가 실패해도 XML에서 정상 생성한 조회용 데이터를 삭제하거나
   * 다시 만들어서는 안 됩니다. 특히 재생성은 검토한 REJECTED/UNKNOWN 계획 후보를
   * 지우고 PENDING으로 되돌릴 수 있습니다. 보조 근거만 다시 확인하고,
   * 관리자가 이미 검토했을 수 있는 파서 결과와 조회용 행의 식별자를
   * 그대로 보존합니다.
   */
  private async retryPersistedCrosscheck(
    filing: FilingEntity,
    run: ParseRunEntity,
    parsed: ParsedOpenDartDisclosure,
    suppressAlerts: boolean,
    rawSha256: string,
  ): Promise<{
    readonly parseRunId: string;
    readonly status: ParseStatus;
    readonly rawSha256: string;
  }> {
    assertParseTypeInvariant(filing, run, parsed.detailType);
    const crosscheck = await this.fetchCrosscheck(filing, filing.rceptNo);
    const warnings: ParserWarning[] = [...warningsOf(parsed), ...projectionTextWarnings(parsed)];
    const confidence = confidenceOf(parsed);
    const status: ParseStatus =
      confidence < 0.8 ||
      warnings.some(warningRequiresReview) ||
      !crosscheckAllowsProjection(parsed.detailType, crosscheck, filing.rceptNo)
        ? ParseStatus.PARTIAL
        : ParseStatus.SUCCEEDED;

    await this.dataSource.transaction(async (manager) => {
      const lockedFiling = await manager
        .getRepository(FilingEntity)
        .createQueryBuilder('filing')
        .setLock('pessimistic_write')
        .where('filing.id = :id', { id: filing.id })
        .getOne();
      const lockedRun = await manager
        .getRepository(ParseRunEntity)
        .createQueryBuilder('parseRun')
        .setLock('pessimistic_write')
        .where(
          'parseRun.id = :runId AND parseRun.filingId = :filingId AND parseRun.rawSha256 = :rawSha256',
          {
            runId: run.id,
            filingId: filing.id,
            rawSha256,
          },
        )
        .getOne();
      if (
        !lockedFiling ||
        !lockedRun ||
        lockedFiling.rceptNo !== filing.rceptNo ||
        lockedFiling.detailType !== parsed.detailType ||
        lockedFiling.activeParseRunId !== lockedRun.id ||
        lockedRun.resultJson?.['projectionApplied'] !== true
      ) {
        throw new OpenDartPayloadError(
          'Persisted crosscheck retry no longer matches its active projection.',
          'STALE_CROSSCHECK_RETRY',
        );
      }
      assertParseTypeInvariant(lockedFiling, lockedRun, parsed.detailType);

      const finishedAt = new Date();
      await this.applyCrosscheckSummaryOnly(manager, lockedFiling, crosscheck);
      lockedRun.status = status;
      lockedRun.validationStatus = validationStatusOf(status, warnings);
      lockedRun.confidence = confidence.toFixed(6);
      lockedRun.classificationResult = preserveAiClassificationResult(
        lockedRun.classificationResult,
        status === ParseStatus.SUCCEEDED
          ? ClassificationReviewResult.RULE_CONFIRMED
          : ClassificationReviewResult.REVIEW_REQUIRED,
      );
      lockedRun.finishedAt = finishedAt;
      lockedRun.warningsJson = warnings.map((warning) => `${warning.code}: ${warning.message}`);
      lockedRun.errorCode = null;
      lockedRun.errorMessage = null;
      lockedRun.resultJson = {
        ...lockedRun.resultJson,
        parsed: jsonRecord(parsed),
        crosscheck,
        projectionApplied: true,
        crosscheckRetriedAt: finishedAt.toISOString(),
      };
      await manager.getRepository(ParseRunEntity).save(lockedRun);

      await manager.getRepository(ParseIssueEntity).delete({ parseRunId: lockedRun.id });
      for (const warning of warnings) {
        await manager.getRepository(ParseIssueEntity).save({
          parseRunId: lockedRun.id,
          severity: warningRequiresReview(warning) ? 'WARNING' : 'INFO',
          code: warning.code.slice(0, 128),
          message: warning.message,
          contextJson: jsonRecord(warning),
        });
      }
      if (
        crosscheck.status === 'FAILED' &&
        (crosscheck['retryPolicy'] === 'SHORT_BACKOFF' ||
          crosscheck['retryPolicy'] === 'NEXT_KST_DAY')
      ) {
        await this.scheduleCrosscheckRetry(manager, lockedFiling, suppressAlerts, crosscheck);
      }
      await this.dismissDocumentUnavailableReview(
        manager,
        lockedFiling.id,
        lockedFiling.rceptNo,
        finishedAt,
      );
      await this.dismissParseFailureReview(manager, lockedFiling.id, lockedRun.id, finishedAt);
      if (
        lockedFiling.effectiveState === EffectiveFilingState.ACTIVE &&
        lockedFiling.activeParseRunId !== lockedRun.id
      ) {
        lockedFiling.activeParseRunId = lockedRun.id;
        await manager.getRepository(FilingEntity).save(lockedFiling);
      }
      await this.materializeParsedEvent(
        manager,
        lockedFiling,
        parsed,
        lockedRun.id,
        status,
        suppressAlerts,
        true,
      );
    });

    return Object.freeze({
      parseRunId: run.id,
      status,
      rawSha256,
    });
  }

  private async applyCrosscheckSummaryOnly(
    manager: EntityManager,
    filing: FilingEntity,
    crosscheck: Record<string, unknown>,
  ): Promise<void> {
    if (filing.detailType === 'D002') {
      const reportRepository = manager.getRepository(InsiderReportEntity);
      const report = await reportRepository.findOne({
        where: { filingId: filing.id },
      });
      if (!report) return;
      const exactMatches = Array.isArray(crosscheck.exactReceiptMatches)
        ? crosscheck.exactReceiptMatches
        : [];
      const match = exactMatches[0] as Record<string, unknown> | undefined;
      if (match) {
        report.isRegisteredExecutive = match.isu_exctv_rgist_at
          ? String(match.isu_exctv_rgist_at).toUpperCase() === 'Y'
          : null;
        report.isMajorShareholder = match.isu_main_shrholdr
          ? String(match.isu_main_shrholdr).toUpperCase() === 'Y'
          : null;
        report.ownershipAfter = numeric(String(match.sp_stock_lmp_cnt ?? ''));
        report.ownershipChange = numeric(String(match.sp_stock_lmp_irds_cnt ?? ''));
        report.ownershipRateAfter = numeric(String(match.sp_stock_lmp_rate ?? ''));
      }
      report.rawJson = {
        ...(report.rawJson ?? {}),
        crosscheck,
      };
      await reportRepository.save(report);
      return;
    }

    if (filing.detailType === 'D001') {
      const reportRepository = manager.getRepository(LargeHolderReportEntity);
      const report = await reportRepository.findOne({
        where: { filingId: filing.id },
      });
      if (!report) return;
      report.rawJson = {
        ...(report.rawJson ?? {}),
        crosscheck,
      };
      await reportRepository.save(report);
    }
  }

  private async replaceProjection(
    manager: EntityManager,
    filingId: string,
    companyId: string,
    parsed: ParsedOpenDartDisclosure,
    crosscheck: Record<string, unknown>,
    effectiveState: EffectiveFilingState,
  ): Promise<void> {
    if (parsed.detailType === 'D002') {
      const staleRelations = await manager.getRepository(FilingRelationEntity).find({
        where: {
          fromFilingId: filingId,
          relationType: FilingRelationType.EXECUTION_CANDIDATE,
        },
      });
      await this.dismissStaleRelationReviews(manager, staleRelations);
      await manager.getRepository(FilingRelationEntity).delete({
        fromFilingId: filingId,
        relationType: FilingRelationType.EXECUTION_CANDIDATE,
      });
      const oldReports = await manager
        .getRepository(InsiderReportEntity)
        .find({ where: { filingId } });
      if (oldReports.length > 0) {
        const oldTransactions = await manager.getRepository(InsiderTransactionEntity).find({
          where: { insiderReportId: In(oldReports.map((row) => row.id)) },
        });
        if (oldTransactions.length > 0) {
          await manager.getRepository(PlanExecutionMatchEntity).delete({
            insiderTransactionId: In(oldTransactions.map((row) => row.id)),
          });
        }
        await manager
          .getRepository(InsiderTransactionEntity)
          .delete({ insiderReportId: In(oldReports.map((row) => row.id)) });
        await manager.getRepository(InsiderReportEntity).delete({ filingId });
      }
      const match = Array.isArray(crosscheck.exactReceiptMatches)
        ? (crosscheck.exactReceiptMatches[0] as Record<string, unknown> | undefined)
        : undefined;
      const reporter = await manager.getRepository(InsiderReportEntity).save({
        filingId,
        reporterName:
          projectionText(parsed.reporterName ?? String(match?.repror ?? '확인 필요'), 255) ||
          '확인 필요',
        relationship: projectionText(parsed.relationshipRaw, 255),
        position: projectionText(
          parsed.positionRaw ?? (String(match?.isu_exctv_ofcps ?? '') || null),
          255,
        ),
        isRegisteredExecutive: match?.isu_exctv_rgist_at
          ? String(match.isu_exctv_rgist_at).toUpperCase() === 'Y'
          : null,
        isMajorShareholder: match?.isu_main_shrholdr
          ? String(match.isu_main_shrholdr).toUpperCase() === 'Y'
          : null,
        ownershipBefore: null,
        ownershipAfter: numeric(String(match?.sp_stock_lmp_cnt ?? '')),
        ownershipChange: numeric(String(match?.sp_stock_lmp_irds_cnt ?? '')),
        ownershipRateAfter: numeric(String(match?.sp_stock_lmp_rate ?? '')),
        rawJson: { parsedSummary: jsonRecord(parsed), crosscheck },
      });
      const transactions: InsiderTransactionEntity[] = [];
      for (const row of parsed.transactions) {
        transactions.push(
          await manager.getRepository(InsiderTransactionEntity).save({
            insiderReportId: reporter.id,
            eventDate: row.eventDate,
            securityTypeRaw: projectionText(row.securityTypeRaw, 500) ?? '',
            methodRaw: projectionText(row.methodRaw, 500) ?? '',
            nature: row.nature,
            direction: row.direction,
            quantity: row.quantity,
            unitPrice: row.unitPrice,
            amount: row.amount,
            currency: row.currency === 'KRW' ? 'KRW' : null,
            sharesAfter: row.sharesAfter,
            parserConfidence: row.confidence.toFixed(6),
            rawJson: jsonRecord(row),
          }),
        );
      }
      if (effectiveState === EffectiveFilingState.ACTIVE) {
        await this.linkPlanExecutionCandidates(
          manager,
          filingId,
          companyId,
          reporter.reporterName,
          transactions,
        );
      }
      return;
    }

    if (parsed.detailType === 'D005') {
      const staleRelations = await manager.getRepository(FilingRelationEntity).find({
        where: {
          toFilingId: filingId,
          relationType: FilingRelationType.EXECUTION_CANDIDATE,
        },
      });
      await this.dismissStaleRelationReviews(manager, staleRelations);
      await manager.getRepository(FilingRelationEntity).delete({
        toFilingId: filingId,
        relationType: FilingRelationType.EXECUTION_CANDIDATE,
      });
      const oldPlans = await manager.getRepository(TradePlanEntity).find({ where: { filingId } });
      if (oldPlans.length > 0) {
        await manager
          .getRepository(TradePlanItemEntity)
          .delete({ tradePlanId: In(oldPlans.map((row) => row.id)) });
        await manager.getRepository(TradePlanEntity).delete({ filingId });
      }
      const dates = parsed.planItems
        .flatMap((row) => [row.plannedStartDate, row.plannedEndDate])
        .filter((date): date is string => Boolean(date))
        .sort();
      const plan = await manager.getRepository(TradePlanEntity).save({
        filingId,
        reporterName: projectionText(parsed.reporterName, 255) ?? '확인 필요',
        plannedStartDate: dates[0] ?? null,
        plannedEndDate: dates.at(-1) ?? null,
        planStatus:
          effectiveState === EffectiveFilingState.CANCELLED
            ? 'CANCELLED'
            : effectiveState === EffectiveFilingState.WITHDRAWN
              ? 'WITHDRAWN'
              : effectiveState === EffectiveFilingState.SUPERSEDED
                ? 'SUPERSEDED'
                : 'PLANNED',
        rawJson: jsonRecord(parsed),
      });
      for (const row of parsed.planItems) {
        await manager.getRepository(TradePlanItemEntity).save({
          tradePlanId: plan.id,
          securityTypeRaw: projectionText(row.securityTypeRaw || null, 500),
          methodRaw: projectionText(row.methodRaw || null, 500),
          plannedQuantity: row.quantity,
          plannedUnitPrice: row.priceMin && row.priceMin === row.priceMax ? row.priceMin : null,
          plannedAmount: null,
          rawJson: jsonRecord(row),
        });
      }
      if (effectiveState === EffectiveFilingState.ACTIVE) {
        await this.linkExistingExecutionCandidates(manager, companyId, plan.reporterName);
      }
      return;
    }

    const oldReports = await manager
      .getRepository(LargeHolderReportEntity)
      .find({ where: { filingId } });
    if (oldReports.length > 0) {
      await manager
        .getRepository(LargeHoldingChangeEntity)
        .delete({ largeHolderReportId: In(oldReports.map((row) => row.id)) });
      await manager.getRepository(LargeHolderReportEntity).delete({ filingId });
    }
    const report = await manager.getRepository(LargeHolderReportEntity).save({
      filingId,
      reporterName: projectionText(parsed.reporterName, 255) ?? '확인 필요',
      reportReasonRaw: parsed.reportReasonRaw,
      holdingPurposeRaw: parsed.reportTypeRaw,
      sharesBefore: null,
      sharesAfter: parsed.sharesAfter,
      ownershipRateBefore: null,
      ownershipRateAfter: parsed.ownershipRateAfter,
      rawJson: { parsed: jsonRecord(parsed), crosscheck },
    });
    for (const row of parsed.changes) {
      await manager.getRepository(LargeHoldingChangeEntity).save({
        largeHolderReportId: report.id,
        eventDate: row.eventDate,
        methodRaw: projectionText(row.methodRaw || null, 500),
        direction: row.direction ?? Direction.UNKNOWN,
        shareChange: row.quantity,
        amount: null,
        rawJson: jsonRecord(row),
      });
    }
  }

  /**
   * D005는 계획이고 D002는 보유 변동 보고입니다. 두 문서의 필드가 일치해도
   * 관리자가 확정하기 전까지는 검토 가능한 후보 관계로 남깁니다.
   * 따라서 이 메서드는 의도적으로 FULFILLS_PLAN 관계를
   * 생성하지 않습니다.
   */
  private async linkPlanExecutionCandidates(
    manager: EntityManager,
    executionFilingId: string,
    companyId: string,
    reporterName: string,
    transactions: readonly InsiderTransactionEntity[],
  ): Promise<void> {
    const normalizedReporter = confirmedReporterKey(reporterName);
    if (!normalizedReporter || transactions.length === 0) return;

    const planFilings = await manager.getRepository(FilingEntity).find({
      where: {
        companyId,
        detailType: 'D005',
        effectiveState: EffectiveFilingState.ACTIVE,
      },
      order: { rceptDate: 'DESC', firstObservedAt: 'DESC' },
      take: 100,
    });
    if (planFilings.length === 0) return;

    const plans = await manager.getRepository(TradePlanEntity).find({
      where: {
        filingId: In(planFilings.map((filing) => filing.id)),
        planStatus: 'PLANNED',
      },
    });
    const eligiblePlans = plans.filter(
      (plan) => confirmedReporterKey(plan.reporterName) === normalizedReporter,
    );
    if (eligiblePlans.length === 0) return;

    const planItems = await manager.getRepository(TradePlanItemEntity).find({
      where: { tradePlanId: In(eligiblePlans.map((plan) => plan.id)) },
    });
    const planById = new Map<string, TradePlanEntity>(eligiblePlans.map((plan) => [plan.id, plan]));
    const filingById = new Map<string, FilingEntity>(
      planFilings.map((filing) => [filing.id, filing]),
    );
    const relationRepository = manager.getRepository(FilingRelationEntity);
    const matchRepository = manager.getRepository(PlanExecutionMatchEntity);
    const existingMatches = await matchRepository.find({
      where: { tradePlanItemId: In(planItems.map((item) => item.id)) },
    });
    const matchedTransactions =
      existingMatches.length === 0
        ? []
        : await manager.getRepository(InsiderTransactionEntity).find({
            where: {
              id: In(existingMatches.map((match) => match.insiderTransactionId)),
            },
          });
    const matchedTransactionById = new Map<string, InsiderTransactionEntity>(
      matchedTransactions.map((transaction) => [transaction.id, transaction]),
    );
    const consumedByItem = new Map<string, bigint>();
    const reservedByItem = new Map<string, bigint>();
    for (const match of existingMatches.filter((candidate) =>
      isConfirmedPlanExecutionMatch(candidate),
    )) {
      const matched = matchedTransactionById.get(match.insiderTransactionId);
      const quantity = matched?.quantity ? absoluteInteger(matched.quantity) : null;
      if (quantity !== null) {
        consumedByItem.set(
          match.tradePlanItemId,
          (consumedByItem.get(match.tradePlanItemId) ?? 0n) + BigInt(quantity),
        );
      }
    }
    for (const match of existingMatches) {
      if (!isPendingPlanExecutionMatch(match)) continue;
      const matched = matchedTransactionById.get(match.insiderTransactionId);
      const quantity = matched?.quantity ? absoluteInteger(matched.quantity) : null;
      if (quantity !== null && BigInt(quantity) > 0n) {
        reservedByItem.set(
          match.tradePlanItemId,
          (reservedByItem.get(match.tradePlanItemId) ?? 0n) + BigInt(quantity),
        );
      }
    }

    for (const transaction of [...transactions].sort(
      (left, right) =>
        (left.eventDate ?? '').localeCompare(right.eventDate ?? '') ||
        left.id.localeCompare(right.id),
    )) {
      if (
        !transaction.eventDate ||
        transaction.nature === 'UNKNOWN' ||
        transaction.direction === Direction.UNKNOWN ||
        transaction.quantity === null
      ) {
        continue;
      }
      const actualSecurity = normalizeMatchText(transaction.securityTypeRaw);
      const actualQuantity = absoluteInteger(transaction.quantity);
      if (!actualSecurity || actualQuantity === null || BigInt(actualQuantity) <= 0n) {
        continue;
      }
      const actualMagnitude = BigInt(actualQuantity);
      const transactionMatches = existingMatches.filter(
        (match) => match.insiderTransactionId === transaction.id,
      );
      if (transactionMatches.some(isConfirmedPlanExecutionMatch)) {
        continue;
      }
      // 새 계획이나 재파싱된 계획이 나타날 때마다 대기 중인 후보를 다시 계산합니다.
      // 어떤 D005 공시가 먼저 도착했는지에 따라 탐색 결과가 달라지지 않도록
      // 이 거래의 기존 예약을 먼저 제거합니다.
      for (const match of transactionMatches) {
        if (!isPendingPlanExecutionMatch(match)) continue;
        const current = reservedByItem.get(match.tradePlanItemId) ?? 0n;
        reservedByItem.set(
          match.tradePlanItemId,
          current > actualMagnitude ? current - actualMagnitude : 0n,
        );
      }
      const discardPendingExcept = async (retainedItemIds: ReadonlySet<string>): Promise<void> => {
        const discardIds = transactionMatches
          .filter(
            (match) =>
              isPendingPlanExecutionMatch(match) && !retainedItemIds.has(match.tradePlanItemId),
          )
          .map((match) => match.id);
        if (discardIds.length > 0) {
          await matchRepository.delete({ id: In(discardIds) });
        }
      };

      const candidates: Array<{
        readonly item: TradePlanItemEntity;
        readonly planFiling: FilingEntity;
        readonly plannedMagnitude: bigint;
        readonly actualMagnitude: bigint;
        readonly alreadyConsumed: bigint;
        readonly sameDayReceiptAmbiguous: boolean;
      }> = [];
      for (const item of planItems) {
        if (
          transactionMatches.some(
            (match) =>
              match.tradePlanItemId === item.id &&
              !isPendingPlanExecutionMatch(match) &&
              !isConfirmedPlanExecutionMatch(match),
          )
        ) {
          continue;
        }
        const plan = planById.get(item.tradePlanId);
        const planFiling = plan ? filingById.get(plan.filingId) : undefined;
        const plannedStartDate = planItemDate(item, 'plannedStartDate');
        const plannedEndDate = planItemDate(item, 'plannedEndDate');
        if (
          !plan ||
          !planFiling ||
          !plannedStartDate ||
          !plannedEndDate ||
          transaction.eventDate < plannedStartDate ||
          transaction.eventDate > plannedEndDate ||
          planFiling.rceptDate > transaction.eventDate ||
          !item.methodRaw ||
          !item.securityTypeRaw ||
          item.plannedQuantity === null
        ) {
          continue;
        }
        const plannedQuantity = canonicalInteger(item.plannedQuantity);
        if (plannedQuantity === null) continue;
        const plannedMagnitude = BigInt(absoluteInteger(plannedQuantity)!);
        const alreadyConsumed = consumedByItem.get(item.id) ?? 0n;
        const remaining = plannedMagnitude - alreadyConsumed;
        if (remaining <= 0n || actualMagnitude > remaining) {
          continue;
        }
        const plannedClassification = classifyTransactionMethod(item.methodRaw, plannedQuantity, {
          quantityIsAbsolute: true,
        });
        if (
          plannedClassification.nature === 'UNKNOWN' ||
          plannedClassification.direction === Direction.UNKNOWN ||
          plannedClassification.nature !== transaction.nature ||
          plannedClassification.direction !== transaction.direction ||
          normalizeMatchText(item.securityTypeRaw) !== actualSecurity
        ) {
          continue;
        }
        candidates.push({
          item,
          planFiling,
          plannedMagnitude,
          actualMagnitude,
          alreadyConsumed,
          sameDayReceiptAmbiguous: planFiling.rceptDate === transaction.eventDate,
        });
      }

      const viableCandidates = candidates.filter((candidate) => {
        const remainingAfterReservations =
          candidate.plannedMagnitude -
          candidate.alreadyConsumed -
          (reservedByItem.get(candidate.item.id) ?? 0n);
        return candidate.actualMagnitude <= remainingAfterReservations;
      });
      const retainedItemIds = new Set(viableCandidates.map((candidate) => candidate.item.id));
      await discardPendingExcept(retainedItemIds);
      if (viableCandidates.length === 0) {
        continue;
      }
      for (const candidate of viableCandidates) {
        const isExactSingleExecution =
          candidate.alreadyConsumed === 0n &&
          candidate.actualMagnitude === candidate.plannedMagnitude;
        const hasAlternatives = viableCandidates.length > 1;
        const confidence = hasAlternatives
          ? '0.600000'
          : candidate.sameDayReceiptAmbiguous
            ? '0.650000'
            : isExactSingleExecution
              ? '0.900000'
              : '0.750000';
        const matchedFields = [
          'companyId',
          'reporterName',
          hasAlternatives ? `alternativePlanItem:${viableCandidates.length}` : 'uniquePlanItem',
          'eventDateWithinPlanWindow',
          candidate.sameDayReceiptAmbiguous
            ? 'planReceiptSameDateOrderUnknown'
            : 'planReceiptBeforeEventDate',
          'transactionNature',
          'direction',
          'securityType',
          isExactSingleExecution ? 'quantityExact' : 'quantityWithinRemainingPlan',
        ];
        if (!transactionMatches.some((match) => match.tradePlanItemId === candidate.item.id)) {
          await matchRepository.save({
            tradePlanItemId: candidate.item.id,
            insiderTransactionId: transaction.id,
            relationType: FilingRelationType.EXECUTION_CANDIDATE,
            confidence,
            source: RelationSource.HEURISTIC,
            confirmedByAdminId: null,
            confirmedAt: null,
            reviewDecision: RelationReviewDecision.PENDING,
            reviewedByAdminId: null,
            reviewedAt: null,
            matchedFieldsJson: matchedFields,
          });
        }
        reservedByItem.set(
          candidate.item.id,
          (reservedByItem.get(candidate.item.id) ?? 0n) + candidate.actualMagnitude,
        );
        let filingRelation = await relationRepository.findOne({
          where: {
            fromFilingId: executionFilingId,
            toFilingId: candidate.planFiling.id,
            relationType: FilingRelationType.EXECUTION_CANDIDATE,
          },
        });
        if (!filingRelation) {
          filingRelation = await relationRepository.save({
            fromFilingId: executionFilingId,
            toFilingId: candidate.planFiling.id,
            relationType: FilingRelationType.EXECUTION_CANDIDATE,
            confidence,
            source: RelationSource.HEURISTIC,
            reviewRequired: true,
            reviewDecision: RelationReviewDecision.PENDING,
            reviewedByAdminId: null,
            reviewedAt: null,
            matchedFieldsJson: matchedFields,
          });
        }
        const reviewRepository = manager.getRepository(ReviewEntity);
        const dedupeKey = `plan-execution:${filingRelation.id}`;
        if (
          !(await reviewRepository.findOne({
            where: {
              subjectType: 'FILING_RELATION',
              subjectId: filingRelation.id,
              dedupeKey,
            },
          }))
        ) {
          await reviewRepository.save({
            subjectType: 'FILING_RELATION',
            subjectId: filingRelation.id,
            dedupeKey,
            reason: hasAlternatives
              ? `D002 소유변동에 호환되는 D005 계획 항목이 ${viableCandidates.length}개입니다. 특정 후보를 명시해 관리자 검토해야 합니다.`
              : 'D005 거래계획과 D002 소유변동의 유일한 실행 후보입니다. 자동 이행 확정 없이 관리자 검토가 필요합니다.',
            status: ReviewTaskStatus.OPEN,
            classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
            resolution: null,
            resolvedByAdminId: null,
            resolvedAt: null,
          });
        }
      }
    }
    await this.reconcileExecutionCandidateRelations(
      manager,
      executionFilingId,
      transactions.map((transaction) => transaction.id),
    );
  }

  private async reconcileExecutionCandidateRelations(
    manager: EntityManager,
    executionFilingId: string,
    executionTransactionIds: readonly string[],
  ): Promise<void> {
    const relationRepository = manager.getRepository(FilingRelationEntity);
    const relations = await relationRepository.find({
      where: {
        fromFilingId: executionFilingId,
        relationType: FilingRelationType.EXECUTION_CANDIDATE,
        reviewDecision: RelationReviewDecision.PENDING,
      },
    });
    if (relations.length === 0) return;
    const plans = await manager.getRepository(TradePlanEntity).find({
      where: { filingId: In(relations.map((relation) => relation.toFilingId)) },
    });
    const items =
      plans.length === 0
        ? []
        : await manager.getRepository(TradePlanItemEntity).find({
            where: { tradePlanId: In(plans.map((plan) => plan.id)) },
          });
    const planIdsByFiling = new Map<string, string[]>();
    for (const plan of plans) {
      const ids = planIdsByFiling.get(plan.filingId) ?? [];
      ids.push(plan.id);
      planIdsByFiling.set(plan.filingId, ids);
    }
    const stale: FilingRelationEntity[] = [];
    for (const relation of relations) {
      const planIds = new Set(planIdsByFiling.get(relation.toFilingId) ?? []);
      const itemIds = items.filter((item) => planIds.has(item.tradePlanId)).map((item) => item.id);
      const remaining =
        itemIds.length === 0 || executionTransactionIds.length === 0
          ? 0
          : await manager.getRepository(PlanExecutionMatchEntity).count({
              where: {
                tradePlanItemId: In(itemIds),
                insiderTransactionId: In([...executionTransactionIds]),
                relationType: FilingRelationType.EXECUTION_CANDIDATE,
                reviewDecision: RelationReviewDecision.PENDING,
              },
            });
      if (remaining === 0) stale.push(relation);
    }
    await this.dismissStaleRelationReviews(manager, stale);
    if (stale.length > 0) {
      await relationRepository.delete({ id: In(stale.map((row) => row.id)) });
    }
  }

  private async linkExistingExecutionCandidates(
    manager: EntityManager,
    companyId: string,
    reporterName: string,
  ): Promise<void> {
    const normalizedReporter = confirmedReporterKey(reporterName);
    if (!normalizedReporter) return;
    const executionFilings = await manager.getRepository(FilingEntity).find({
      where: {
        companyId,
        detailType: 'D002',
        effectiveState: EffectiveFilingState.ACTIVE,
      },
      order: { rceptDate: 'DESC', firstObservedAt: 'DESC' },
      take: 500,
    });
    if (executionFilings.length === 0) return;
    const reports = await manager.getRepository(InsiderReportEntity).find({
      where: { filingId: In(executionFilings.map((filing) => filing.id)) },
    });
    const matchingReports = reports.filter(
      (report) => confirmedReporterKey(report.reporterName) === normalizedReporter,
    );
    if (matchingReports.length === 0) return;
    const transactions = await manager.getRepository(InsiderTransactionEntity).find({
      where: {
        insiderReportId: In(matchingReports.map((report) => report.id)),
      },
    });
    const filingById = new Map<string, FilingEntity>(
      executionFilings.map((filing) => [filing.id, filing]),
    );
    for (const report of matchingReports) {
      if (!filingById.has(report.filingId)) continue;
      await this.linkPlanExecutionCandidates(
        manager,
        report.filingId,
        companyId,
        report.reporterName,
        transactions.filter((transaction) => transaction.insiderReportId === report.id),
      );
    }
  }

  private async dismissStaleRelationReviews(
    manager: EntityManager,
    relations: readonly FilingRelationEntity[],
  ): Promise<void> {
    if (relations.length === 0) return;
    const repository = manager.getRepository(ReviewEntity);
    const reviews = await repository.find({
      where: {
        subjectType: 'FILING_RELATION',
        subjectId: In(relations.map((relation) => relation.id)),
        status: ReviewTaskStatus.OPEN,
      },
    });
    const resolvedAt = new Date();
    for (const review of reviews) {
      review.status = ReviewTaskStatus.DISMISSED;
      review.resolution = JSON.stringify({
        resolution: 'SUPERSEDED_BY_REPARSE',
      });
      review.resolvedByAdminId = null;
      review.resolvedAt = resolvedAt;
    }
    if (reviews.length > 0) await repository.save(reviews);
  }

  private async materializeParsedEvent(
    manager: EntityManager,
    filing: FilingEntity,
    parsed: ParsedOpenDartDisclosure,
    parseRunId: string,
    parseStatus: ParseStatus,
    suppressAlerts: boolean,
    projectionApplied = true,
  ): Promise<void> {
    const run = await manager.getRepository(ParseRunEntity).findOne({
      where: { id: parseRunId, filingId: filing.id },
    });
    if (!run) throw new Error('A parsed event requires its persisted parse run.');
    assertParseTypeInvariant(filing, run, parsed.detailType);
    await updateParseReviewLifecycle(
      manager,
      filing.id,
      parseRunId,
      projectionApplied
        ? '원문 파서의 확신도가 낮거나 경고가 있어 사람의 검토가 필요합니다.'
        : '새 파싱 결과를 검토 자료로 보존했습니다. 품질 게이트 또는 수동 확정 관계 보호로 활성 결과를 교체하지 않았습니다.',
      parseStatus !== ParseStatus.SUCCEEDED || !projectionApplied,
    );
    if (!projectionApplied) return;
    if (run.validationStatus === 'REJECTED') {
      throw new OpenDartPayloadError(
        'Rejected parse cannot materialize an event.',
        'PARSE_VALIDATION_REJECTED',
      );
    }
    const eventRepository = manager.getRepository(EventClusterEntity);
    const dedupeKey = `opendart:filing:${filing.id}`;
    let event = await eventRepository.findOne({ where: { dedupeKey } });
    const dateOnlyValues =
      parsed.detailType === 'D002'
        ? parsed.transactions.map((row) => row.eventDate)
        : parsed.detailType === 'D001'
          ? parsed.changes.map((row) => row.eventDate)
          : [];
    const earliestDate = dateOnlyValues.filter((date): date is string => Boolean(date)).sort()[0];
    const state =
      filing.effectiveState === EffectiveFilingState.CANCELLED ||
      filing.effectiveState === EffectiveFilingState.WITHDRAWN
        ? EventState.CANCELLED
        : filing.effectiveState === EffectiveFilingState.SUPERSEDED
          ? EventState.SUPERSEDED
          : parseStatus === ParseStatus.SUCCEEDED
            ? EventState.VERIFIED
            : EventState.REVIEW_REQUIRED;
    const summary = this.parsedSummary(parsed);
    if (!event) {
      event = eventRepository.create({
        canonicalEventType:
          parsed.detailType === 'D001'
            ? EventType.LARGE_HOLDER
            : parsed.detailType === 'D005'
              ? EventType.TRADE_PLAN
              : EventType.INSIDER_OWNERSHIP,
        companyId: filing.companyId,
        firstObservedAt: filing.firstObservedAt,
        dedupeKey,
      });
    }
    // 공시·거래 날짜는 날짜만 있는 값입니다. 자정 시각을 임의로 만들지 않고
    // 공시와 거래 기록에 정확한 날짜를 그대로 보존합니다.
    event.canonicalEventType =
      parsed.detailType === 'D001'
        ? EventType.LARGE_HOLDER
        : parsed.detailType === 'D005'
          ? EventType.TRADE_PLAN
          : EventType.INSIDER_OWNERSHIP;
    event.occurredAt = null;
    event.publishedAt = null;
    event.processedAt = new Date();
    event.state = state;
    event.evidenceGrade = EvidenceGrade.A;
    event.summary = summary;
    event.metadataJson = {
      rceptNo: filing.rceptNo,
      detailType: filing.detailType,
      phase: 'PARSED',
      parseRunId,
      parseStatus,
      projectionApplied,
      earliestEventDate: earliestDate ?? null,
      disclaimer: '투자 매매 신호가 아닌 공식 공시 관찰 근거',
    };
    event = await eventRepository.save(event);
    const membershipRepository = manager.getRepository(EventClusterItemEntity);
    if (
      !(await membershipRepository.findOne({
        where: {
          eventClusterId: event.id,
          itemType: 'FILING',
          itemId: filing.id,
        },
      }))
    ) {
      await membershipRepository.save({
        eventClusterId: event.id,
        itemType: 'FILING',
        itemId: filing.id,
        isPrimary: true,
        provenanceJson: { source: 'OPENDART', phase: 'DOCUMENT' },
      });
    }

    if (suppressAlerts || !shouldDeliverFilingAlert(filing)) {
      return;
    }

    const idempotencyKey = `${event.id}:WEB:parsed:${parseRunId}:${parseStatus}:v1`;
    const alertRepository = manager.getRepository(AlertEntity);
    if (await alertRepository.findOne({ where: { idempotencyKey } })) return;
    const payload = {
      phase: 'PARSED',
      filingId: filing.id,
      parseRunId,
      detailType: filing.detailType,
      rceptNo: filing.rceptNo,
      reportName: filing.reportName,
      summary,
      parseStatus,
      evidenceGrade: EvidenceGrade.A,
      officialUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${filing.rceptNo}`,
      message: '공식 공시 원문 확인 결과이며 투자 매매 신호가 아닙니다.',
    };
    const alert = await alertRepository.save({
      eventClusterId: event.id,
      idempotencyKey,
      status: AlertStatus.PENDING,
      alertVersion: 2,
      payloadJson: payload,
    });
    await manager.getRepository(AlertOutboxEntity).save({
      alertId: alert.id,
      channel: DeliveryChannel.WEB,
      idempotencyKey,
      status: AlertStatus.PENDING,
      payload,
      availableAt: new Date(),
      attempts: 0,
      lastError: null,
    });
  }

  private parsedSummary(parsed: ParsedOpenDartDisclosure): string {
    if (parsed.detailType === 'D005') {
      const first = parsed.planItems[0];
      return `[D005 거래 예정] ${parsed.reporterName ?? '신고자 확인 필요'} — ${first?.methodRaw || '방법 확인 필요'} ${first?.quantity ?? '수량 확인 필요'}`;
    }
    if (parsed.detailType === 'D001') {
      return `[D001 5% 대량보유 변동] ${parsed.reporterName ?? '보고자 확인 필요'} — ${parsed.reportReasonRaw ?? '사유 확인 필요'}`;
    }
    const first = parsed.transactions[0];
    const market =
      first?.nature === 'MARKET_BUY' || first?.nature === 'MARKET_SELL'
        ? '시장거래 확인'
        : '비시장성 또는 미확정 변동';
    return `[D002 소유변동 확인] ${parsed.reporterName ?? '신고자 확인 필요'} — ${first?.methodRaw || '방법 확인 필요'} ${first?.quantity ?? '수량 확인 필요'} (${market})`;
  }

  private async recordParseFailureReview(
    filing: FilingEntity,
    parseRunId: string,
    errorCode: string,
    message: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const lockedFiling = await manager
        .getRepository(FilingEntity)
        .createQueryBuilder('filing')
        .setLock('pessimistic_write')
        .where('filing.id = :id', { id: filing.id })
        .getOne();
      if (!lockedFiling) return;
      const event = await manager.getRepository(EventClusterEntity).findOne({
        where: { dedupeKey: `opendart:filing:${lockedFiling.id}` },
      });
      if (event && !lockedFiling.activeParseRunId) {
        event.state =
          lockedFiling.effectiveState === EffectiveFilingState.CANCELLED ||
          lockedFiling.effectiveState === EffectiveFilingState.WITHDRAWN
            ? EventState.CANCELLED
            : lockedFiling.effectiveState === EffectiveFilingState.SUPERSEDED
              ? EventState.SUPERSEDED
              : EventState.REVIEW_REQUIRED;
        event.summary = `[${lockedFiling.detailType} 원문 분석 실패] ${lockedFiling.reportName}`;
        event.metadataJson = {
          ...(event.metadataJson ?? {}),
          phase: 'PARSE_FAILED',
          parseRunId,
          errorCode,
        };
        await manager.getRepository(EventClusterEntity).save(event);
      }
      const run = await manager
        .getRepository(ParseRunEntity)
        .findOne({ where: { id: parseRunId } });
      const issues = manager.getRepository(ParseIssueEntity);
      await issues.delete({ parseRunId });
      for (const candidate of run?.candidateErrorsJson ?? []) {
        await issues.save({
          parseRunId,
          severity: 'ERROR',
          code: String(candidate['errorCode'] ?? 'XML_CANDIDATE_REJECTED').slice(0, 128),
          message: String(candidate['originalMessage'] ?? message).slice(0, 20_000),
          contextJson: candidate,
        });
      }
      await updateParseReviewLifecycle(
        manager,
        lockedFiling.id,
        parseRunId,
        `${errorCode}: ${message}`,
        true,
      );
    });
  }
}

function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .replace(/[\s·ㆍ()（）\u005b\u005d{}]/g, '')
    .toLowerCase();
}

function confirmedReporterKey(value: string | null | undefined): string | null {
  const normalized = normalizeMatchText(value);
  return !normalized || ['확인필요', '미상', 'unknown', 'n/a', 'na'].includes(normalized)
    ? null
    : normalized;
}

function planItemDate(
  item: TradePlanItemEntity,
  field: 'plannedStartDate' | 'plannedEndDate',
): string | null {
  const value = item.rawJson?.[field];
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : null;
}

function canonicalInteger(value: string): string | null {
  const match = /^([+-]?\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2] && /[1-9]/.test(match[2]))) return null;
  return BigInt(match[1]!).toString();
}

function absoluteInteger(value: string): string | null {
  const integer = canonicalInteger(value);
  if (integer === null) return null;
  const normalized = BigInt(integer);
  return (normalized < 0n ? -normalized : normalized).toString();
}

function isConfirmedPlanExecutionMatch(match: PlanExecutionMatchEntity): boolean {
  if (
    match.reviewDecision === RelationReviewDecision.REJECTED ||
    match.reviewDecision === RelationReviewDecision.UNKNOWN
  ) {
    return false;
  }
  return (
    match.reviewDecision === RelationReviewDecision.CONFIRMED &&
    (match.relationType === FilingRelationType.FULFILLS_PLAN ||
      match.source === RelationSource.MANUAL ||
      match.confirmedAt !== null ||
      match.confirmedByAdminId !== null)
  );
}

function isPendingPlanExecutionMatch(match: PlanExecutionMatchEntity): boolean {
  return (
    match.reviewDecision === RelationReviewDecision.PENDING && !isConfirmedPlanExecutionMatch(match)
  );
}
