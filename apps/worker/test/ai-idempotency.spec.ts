import {
  ClassificationReviewResult,
  Direction,
  ProcessingStatus,
  ReviewTaskStatus,
  TransactionNature,
} from '@orsem/contracts';
import {
  AiRunEntity,
  FilingEntity,
  ParseRunEntity,
  ProcessingOutboxEntity,
  ReviewEntity,
} from '@orsem/database';
import type { ParsedOpenDartDisclosure } from '@orsem/opendart-parser';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  AiClassificationReview,
  CompatibleClassifierClient,
} from '../src/ai/compatible-classifier.client';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  AI_REVIEW_MIN_PROCESSING_LEASE_MS,
  AI_REVIEW_OUTBOX_REARM_COOLDOWN_MS,
  MAX_AI_REVIEW_OUTBOX_REARMS,
  FilingEnrichmentService,
  aiReviewProcessingLeaseMs,
  decideAiRunClaim,
  isAiRunIdentityConflict,
  planAiReviewOutboxRearm,
} from '../src/opendart/filing-enrichment.service';

const FILING_ID = '00000000-0000-4000-8000-000000000101';
const PARSE_RUN_ID = '00000000-0000-4000-8000-000000000102';
const AI_RUN_ID = '00000000-0000-4000-8000-000000000103';
const OUTBOX_ID = '00000000-0000-4000-8000-000000000104';
const REVIEW_ID = '00000000-0000-4000-8000-000000000105';
const MODEL = 'local-test-model';

function parsedDisclosure(): ParsedOpenDartDisclosure {
  return {
    parserVersion: 'test-parser',
    source: {
      archiveSha256: 'a'.repeat(64),
      archiveByteLength: 123,
      selectedEntryName: 'report.xml',
      candidateEntries: ['report.xml'],
    },
    warnings: [],
    tablesScanned: 1,
    detailType: 'D002',
    reporterName: null,
    relationshipRaw: null,
    positionRaw: null,
    transactions: [
      {
        rowIndex: 0,
        eventDate: null,
        securityTypeRaw: '보통주',
        methodRaw: '기타 증가',
        nature: TransactionNature.UNKNOWN,
        direction: Direction.INCREASE,
        quantity: '1',
        quantityUnitRaw: null,
        unitPrice: null,
        amount: null,
        amountSource: null,
        currency: null,
        sharesAfter: null,
        confidence: 0.25,
        warnings: [],
      },
    ],
  };
}

function aiRun(status: ProcessingStatus, updatedAt = new Date()): AiRunEntity {
  return {
    id: AI_RUN_ID,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    subjectType: 'PARSE_RUN',
    subjectId: PARSE_RUN_ID,
    provider: 'OPENAI_COMPATIBLE',
    model: MODEL,
    promptHash: '',
    status,
    inputProvenanceJson: {},
    outputJson: null,
    errorMessage: status === ProcessingStatus.FAILED ? 'prior failure' : null,
  };
}

function outbox(
  status: ProcessingStatus,
  updatedAt = new Date(),
  rearmCount = 0,
): ProcessingOutboxEntity {
  return {
    id: OUTBOX_ID,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    kind: 'REVIEW_PARSE_WITH_AI',
    dedupeKey: 'ai-review:test',
    payloadJson: {
      filingId: FILING_ID,
      parseRunId: PARSE_RUN_ID,
      ...(rearmCount > 0 ? { aiReviewRearm: { count: rearmCount } } : {}),
    },
    status,
    availableAt: new Date(updatedAt),
    attempts: 1,
    lockedAt: null,
    lastError: status === ProcessingStatus.FAILED ? 'queue exhausted' : null,
  };
}

function reviewTask(): ReviewEntity {
  const now = new Date();
  return {
    id: REVIEW_ID,
    createdAt: now,
    updatedAt: now,
    subjectType: 'FILING',
    subjectId: FILING_ID,
    dedupeKey: `parse:${PARSE_RUN_ID}`,
    reason: '결정론적 분류 검토 필요',
    status: ReviewTaskStatus.OPEN,
    classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
    resolution: null,
    resolvedByAdminId: null,
    resolvedAt: null,
  };
}

interface HarnessOptions {
  readonly initialAiRun?: AiRunEntity | null;
  readonly initialOutbox?: ProcessingOutboxEntity | null;
  readonly initialReview?: ReviewEntity | null;
  readonly conflictOnFirstAiInsert?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const parsed = parsedDisclosure();
  const filing = {
    id: FILING_ID,
    detailType: 'D002',
    source: 'OPENDART',
    rceptNo: '20260903000001',
    rceptDate: '2026-09-03',
    firstObservedAt: new Date('2026-09-03T00:00:00.000Z'),
  } as FilingEntity;
  const parseRun = {
    id: PARSE_RUN_ID,
    filingId: FILING_ID,
    parserVersion: parsed.parserVersion,
    rawSha256: parsed.source.archiveSha256,
    classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
    resultJson: { parsed },
  } as unknown as ParseRunEntity;
  let persistedAiRun = options.initialAiRun ?? null;
  let persistedOutbox = options.initialOutbox ?? null;
  let persistedReview = options.initialReview ?? null;
  let shouldConflict = options.conflictOnFirstAiInsert === true;

  const filingRepository = {
    findOne: jest.fn().mockResolvedValue(filing),
  };
  const parseQueryBuilder = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockImplementation(async () => parseRun),
  };
  const parseRepository = {
    findOne: jest.fn().mockResolvedValue(parseRun),
    createQueryBuilder: jest.fn(() => parseQueryBuilder),
    save: jest.fn().mockImplementation(async (value: ParseRunEntity) => value),
  };
  const aiRepository = {
    findOne: jest.fn().mockImplementation(async (query: { where: Record<string, unknown> }) => {
      if (!persistedAiRun) return null;
      const expectedId = query.where['id'];
      if (typeof expectedId === 'string' && expectedId !== persistedAiRun.id) return null;
      return persistedAiRun;
    }),
    create: jest.fn().mockImplementation((value: Partial<AiRunEntity>) => ({
      ...value,
      id: AI_RUN_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    save: jest.fn().mockImplementation(async (value: AiRunEntity) => {
      if (shouldConflict && !persistedAiRun) {
        shouldConflict = false;
        persistedAiRun = aiRun(ProcessingStatus.PROCESSING);
        persistedAiRun.inputProvenanceJson = {
          processingClaim: { token: 'competing-owner' },
        };
        throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      }
      value.updatedAt = new Date();
      persistedAiRun = value;
      return value;
    }),
  };
  const outboxRepository = {
    findOne: jest.fn().mockImplementation(async () => persistedOutbox),
    save: jest.fn().mockImplementation(async (value: ProcessingOutboxEntity) => {
      value.id ??= OUTBOX_ID;
      value.createdAt ??= new Date();
      value.updatedAt = new Date();
      persistedOutbox = value;
      return value;
    }),
  };
  const reviewRepository = {
    findOne: jest.fn().mockImplementation(async () => persistedReview),
    save: jest.fn().mockImplementation(async (value: ReviewEntity) => {
      persistedReview = value;
      return value;
    }),
  };
  const repositoryFor = (target: unknown): unknown => {
    if (target === FilingEntity) return filingRepository;
    if (target === ParseRunEntity) return parseRepository;
    if (target === AiRunEntity) return aiRepository;
    if (target === ProcessingOutboxEntity) return outboxRepository;
    if (target === ReviewEntity) return reviewRepository;
    throw new Error('Unexpected repository target in AI idempotency test.');
  };
  const manager = { getRepository: repositoryFor } as unknown as EntityManager;
  let transactionTail: Promise<void> = Promise.resolve();
  const transaction = jest.fn(
    (callback: (transactionManager: EntityManager) => Promise<unknown>): Promise<unknown> => {
      const result = transactionTail.then(() => callback(manager));
      transactionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  );
  const dataSource = {
    getRepository: repositoryFor,
    transaction,
  } as unknown as DataSource;
  const config = loadWorkerConfig({
    AI_ENABLED: 'true',
    AI_MODEL: MODEL,
    AI_BASE_URL: 'http://127.0.0.1:11434/v1',
    AI_TIMEOUT_MS: '120000',
  });

  return {
    parsed,
    dataSource,
    config,
    aiRepository,
    outboxRepository,
    parseRepository,
    reviewRepository,
    getAiRun: () => persistedAiRun,
    getOutbox: () => persistedOutbox,
    getParseRun: () => parseRun,
    getReview: () => persistedReview,
  };
}

function serviceWith(
  harness: ReturnType<typeof createHarness>,
  classifier: Pick<CompatibleClassifierClient, 'enabled' | 'suggest'>,
): FilingEnrichmentService {
  return new FilingEnrichmentService(
    harness.dataSource,
    null as never,
    null as never,
    null as never,
    classifier as CompatibleClassifierClient,
    harness.config,
  );
}

describe('AI run idempotency and durable recovery', () => {
  it('keeps active work leased, but reclaims FAILED and stale PROCESSING runs', () => {
    const now = new Date('2026-09-03T12:00:00.000Z');
    const leaseMs = aiReviewProcessingLeaseMs(120_000, 16);

    expect(leaseMs).toBe(37 * 60_000);
    expect(leaseMs).toBeGreaterThanOrEqual(AI_REVIEW_MIN_PROCESSING_LEASE_MS);
    expect(decideAiRunClaim(ProcessingStatus.COMPLETED, now, now, leaseMs)).toBe('COMPLETED');
    expect(decideAiRunClaim(ProcessingStatus.FAILED, now, now, leaseMs)).toBe('CLAIM');
    expect(
      decideAiRunClaim(
        ProcessingStatus.PROCESSING,
        new Date(now.getTime() - leaseMs + 1),
        now,
        leaseMs,
      ),
    ).toBe('IN_FLIGHT');
    expect(
      decideAiRunClaim(
        ProcessingStatus.PROCESSING,
        new Date(now.getTime() - leaseMs),
        now,
        leaseMs,
      ),
    ).toBe('CLAIM');
  });

  it('recognizes direct and TypeORM-wrapped MySQL identity conflicts', () => {
    expect(isAiRunIdentityConflict({ code: 'ER_DUP_ENTRY' })).toBe(true);
    expect(isAiRunIdentityConflict({ driverError: { errno: 1062 } })).toBe(true);
    expect(isAiRunIdentityConflict({ code: 'ER_LOCK_DEADLOCK' })).toBe(false);
  });

  it('re-arms terminal outbox rows with a cooldown and a hard generation bound', () => {
    const now = new Date('2026-09-03T12:00:00.000Z');
    const failedRun = aiRun(ProcessingStatus.FAILED, now);
    const completedOutbox = outbox(ProcessingStatus.COMPLETED, now);
    const decision = planAiReviewOutboxRearm({
      outbox: completedOutbox,
      aiRun: failedRun,
      now,
      processingLeaseMs: AI_REVIEW_MIN_PROCESSING_LEASE_MS,
    });

    expect(decision).toMatchObject({ count: 1, reason: 'FAILED_AI_RUN' });
    expect(decision?.availableAt.toISOString()).toBe(
      new Date(now.getTime() + AI_REVIEW_OUTBOX_REARM_COOLDOWN_MS).toISOString(),
    );
    expect(
      planAiReviewOutboxRearm({
        outbox: outbox(ProcessingStatus.FAILED, now, MAX_AI_REVIEW_OUTBOX_REARMS),
        aiRun: null,
        now,
        processingLeaseMs: AI_REVIEW_MIN_PROCESSING_LEASE_MS,
      }),
    ).toBeNull();
    expect(
      planAiReviewOutboxRearm({
        outbox: outbox(ProcessingStatus.COMPLETED, now),
        aiRun: aiRun(ProcessingStatus.COMPLETED, now),
        now,
        processingLeaseMs: AI_REVIEW_MIN_PROCESSING_LEASE_MS,
      }),
    ).toBeNull();
  });

  it('does not issue duplicate inference while another delivery owns a fresh lease', async () => {
    const harness = createHarness();
    let resolveReview: ((review: AiClassificationReview) => void) | undefined;
    const pendingReview = new Promise<AiClassificationReview>((resolve) => {
      resolveReview = resolve;
    });
    const classifier = {
      enabled: true,
      suggest: jest.fn(async () => pendingReview),
    };
    const service = serviceWith(harness, classifier);
    const first = service.reviewParseWithAi({ filingId: FILING_ID, parseRunId: PARSE_RUN_ID });
    while (classifier.suggest.mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await expect(
      service.reviewParseWithAi({ filingId: FILING_ID, parseRunId: PARSE_RUN_ID }),
    ).rejects.toThrow(/active lease/u);
    expect(classifier.suggest).toHaveBeenCalledTimes(1);

    resolveReview?.({
      result: ClassificationReviewResult.AI_SUGGESTED,
      suggestion: {
        nature: TransactionNature.OTHER,
        direction: Direction.INCREASE,
        confidence: 0.95,
        rationale: '원문 보조 검토',
        evidence: ['기타 증가'],
      },
      reasons: ['Human review is required before applying any AI suggestion.'],
    });
    await expect(first).resolves.toMatchObject({
      aiRunId: AI_RUN_ID,
      status: ProcessingStatus.COMPLETED,
      deduplicated: false,
    });
    expect(classifier.suggest).toHaveBeenCalledTimes(1);
  });

  it('reloads a canonical run after a concurrent unique insert wins', async () => {
    const harness = createHarness({ conflictOnFirstAiInsert: true });
    const classifier = { enabled: true, suggest: jest.fn() };
    const service = serviceWith(harness, classifier);

    await expect(
      service.reviewParseWithAi({ filingId: FILING_ID, parseRunId: PARSE_RUN_ID }),
    ).rejects.toThrow(/active lease/u);
    expect(classifier.suggest).not.toHaveBeenCalled();
    expect(harness.aiRepository.findOne).toHaveBeenCalledTimes(2);
  });

  it('fences a late owner after its lease is reclaimed by a newer run', async () => {
    const initialReview = reviewTask();
    const initialReason = initialReview.reason;
    const harness = createHarness({ initialReview });
    let resolveFirst: ((review: AiClassificationReview) => void) | undefined;
    let resolveSecond: ((review: AiClassificationReview) => void) | undefined;
    const firstReview = new Promise<AiClassificationReview>((resolve) => {
      resolveFirst = resolve;
    });
    const secondReview = new Promise<AiClassificationReview>((resolve) => {
      resolveSecond = resolve;
    });
    const classifier = {
      enabled: true,
      suggest: jest
        .fn()
        .mockImplementationOnce(async () => firstReview)
        .mockImplementationOnce(async () => secondReview),
    };
    const service = serviceWith(harness, classifier);

    const first = service.reviewParseWithAi({ filingId: FILING_ID, parseRunId: PARSE_RUN_ID });
    while (classifier.suggest.mock.calls.length < 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const firstClaim = harness.getAiRun()?.inputProvenanceJson['processingClaim'] as
      Record<string, unknown> | undefined;
    harness.getAiRun()!.updatedAt = new Date(
      Date.now() - aiReviewProcessingLeaseMs(harness.config.aiTimeoutMs, 1) - 1,
    );

    const second = service.reviewParseWithAi({ filingId: FILING_ID, parseRunId: PARSE_RUN_ID });
    while (classifier.suggest.mock.calls.length < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const secondClaim = harness.getAiRun()?.inputProvenanceJson['processingClaim'] as
      Record<string, unknown> | undefined;
    expect(secondClaim?.['token']).not.toBe(firstClaim?.['token']);

    resolveFirst?.({
      result: ClassificationReviewResult.AI_SUGGESTED,
      suggestion: {
        nature: TransactionNature.OTHER,
        direction: Direction.INCREASE,
        confidence: 0.95,
        rationale: '만료된 이전 claim의 결과',
        evidence: ['기타 증가'],
      },
      reasons: ['Human review is required before applying any AI suggestion.'],
    });
    await expect(first).resolves.toMatchObject({
      aiRunId: AI_RUN_ID,
      status: ProcessingStatus.PROCESSING,
      deduplicated: true,
    });

    expect(harness.getParseRun().classificationResult).toBe(
      ClassificationReviewResult.REVIEW_REQUIRED,
    );
    expect(harness.getReview()).toMatchObject({
      classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
      reason: initialReason,
    });
    expect(harness.parseRepository.save).not.toHaveBeenCalled();
    expect(harness.reviewRepository.save).not.toHaveBeenCalled();

    resolveSecond?.({
      result: ClassificationReviewResult.AI_CONFIRMED,
      suggestion: {
        nature: TransactionNature.UNKNOWN,
        direction: Direction.INCREASE,
        confidence: 0.9,
        rationale: '최신 claim의 결과',
        evidence: ['기타 증가'],
      },
      reasons: [],
    });
    await expect(second).resolves.toMatchObject({
      aiRunId: AI_RUN_ID,
      status: ProcessingStatus.COMPLETED,
      classificationResult: ClassificationReviewResult.AI_CONFIRMED,
      deduplicated: false,
    });
    expect(harness.getParseRun().classificationResult).toBe(
      ClassificationReviewResult.AI_CONFIRMED,
    );
    expect(harness.getReview()?.classificationResult).toBe(ClassificationReviewResult.AI_CONFIRMED);
    expect(harness.getReview()?.reason).toContain(`[AI:${AI_RUN_ID}]`);
  });

  it('re-arms a completed outbox for a failed AI run without resetting forever', async () => {
    const now = new Date();
    const harness = createHarness({
      initialAiRun: aiRun(ProcessingStatus.FAILED, now),
      initialOutbox: outbox(ProcessingStatus.COMPLETED, now),
    });
    const service = serviceWith(harness, { enabled: true, suggest: jest.fn() });
    const privateService = service as unknown as {
      enqueueAiReview(
        filingId: string,
        parseRunId: string,
        parsed: ParsedOpenDartDisclosure,
      ): Promise<void>;
    };

    await privateService.enqueueAiReview(FILING_ID, PARSE_RUN_ID, harness.parsed);

    const rearmed = harness.getOutbox();
    expect(rearmed).toMatchObject({
      status: ProcessingStatus.PENDING,
      attempts: 1,
      lockedAt: null,
    });
    expect(rearmed?.availableAt.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + AI_REVIEW_OUTBOX_REARM_COOLDOWN_MS,
    );
    expect(rearmed?.payloadJson['aiReviewRearm']).toMatchObject({
      count: 1,
      reason: 'FAILED_AI_RUN',
      previousOutboxStatus: ProcessingStatus.COMPLETED,
    });

    await privateService.enqueueAiReview(FILING_ID, PARSE_RUN_ID, harness.parsed);
    expect(harness.outboxRepository.save).toHaveBeenCalledTimes(1);
  });
});
