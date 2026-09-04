import {
  ClassificationReviewResult,
  Direction,
  ProcessingStatus,
  TransactionNature,
} from '@orsem/contracts';
import type { Job, Queue } from 'bullmq';
import type { DataSource } from 'typeorm';
import type { AiClassificationReview } from '../src/ai/compatible-classifier.client';
import type { FilingEnrichmentService } from '../src/opendart/filing-enrichment.service';
import {
  aggregateAiReviewClassification,
  MAX_AI_REVIEW_ROWS,
  preserveAiClassificationResult,
  reviewAiCandidatesSequentially,
  selectUnknownAiReviewCandidates,
  type UnknownAiReviewCandidate,
} from '../src/opendart/filing-enrichment.service';
import { AiReviewProcessor } from '../src/processors/ai-review.processor';
import { FilingProcessor } from '../src/processors/filing.processor';
import { reviewParseWithAiJobSchema } from '../src/queues/job-data';
import { OutboxDispatcherService } from '../src/queues/outbox-dispatcher.service';
import { JobName } from '../src/queues/queue.constants';

const FILING_ID = '00000000-0000-4000-8000-000000000001';
const PARSE_RUN_ID = '00000000-0000-4000-8000-000000000002';

function aiReview(
  result: ClassificationReviewResult,
  suggestion: AiClassificationReview['suggestion'] = {
    nature: TransactionNature.OTHER,
    direction: Direction.INCREASE,
    confidence: 0.95,
    rationale: '검토',
    evidence: [],
  },
): AiClassificationReview {
  return { result, suggestion, reasons: [] };
}

function unknownCandidate(rowIndex: number): UnknownAiReviewCandidate {
  return {
    rowIndex,
    methodRaw: `기타 ${rowIndex}`,
    securityTypeRaw: '보통주',
    quantity: String(rowIndex + 1),
    deterministicNature: TransactionNature.UNKNOWN,
    deterministicDirection: Direction.INCREASE,
    eventDate: null,
    plannedStartDate: null,
    plannedEndDate: null,
  };
}

describe('durable AI review pipeline', () => {
  it('validates the exact filing/parse-run job identity', () => {
    expect(
      reviewParseWithAiJobSchema.parse({ filingId: FILING_ID, parseRunId: PARSE_RUN_ID }),
    ).toEqual({ filingId: FILING_ID, parseRunId: PARSE_RUN_ID });
    expect(
      reviewParseWithAiJobSchema.safeParse({ filingId: 'not-a-uuid', parseRunId: PARSE_RUN_ID })
        .success,
    ).toBe(false);
  });

  it('selects only UNKNOWN D002 rows and caps one filing at 16', () => {
    const unknownRows = Array.from({ length: MAX_AI_REVIEW_ROWS + 2 }, (_, rowIndex) => ({
      rowIndex,
      methodRaw: `기타 ${rowIndex}`,
      securityTypeRaw: '보통주',
      nature: TransactionNature.UNKNOWN,
      direction: Direction.INCREASE,
      quantity: String(rowIndex + 1),
    }));
    const selection = selectUnknownAiReviewCandidates({
      detailType: 'D002',
      transactions: [
        ...unknownRows,
        {
          rowIndex: 99,
          methodRaw: '장내매수',
          securityTypeRaw: '보통주',
          nature: TransactionNature.MARKET_BUY,
          direction: Direction.INCREASE,
          quantity: '1',
        },
      ],
    } as unknown as Parameters<typeof selectUnknownAiReviewCandidates>[0]);

    expect(selection.candidates).toHaveLength(MAX_AI_REVIEW_ROWS);
    expect(selection.totalEligibleRows).toBe(MAX_AI_REVIEW_ROWS + 2);
    expect(selection.truncated).toBe(true);
    expect(selection.candidates.map((row) => row.rowIndex)).toEqual(
      Array.from({ length: MAX_AI_REVIEW_ROWS }, (_, index) => index),
    );
  });

  it('also selects uncertain D005 plans but never D001 rows', () => {
    const d005 = selectUnknownAiReviewCandidates({
      detailType: 'D005',
      planItems: [
        {
          rowIndex: 3,
          methodRaw: '기타 처분',
          securityTypeRaw: '보통주',
          nature: TransactionNature.UNKNOWN,
          direction: Direction.UNKNOWN,
          quantity: '10',
        },
      ],
    } as unknown as Parameters<typeof selectUnknownAiReviewCandidates>[0]);
    const d001 = selectUnknownAiReviewCandidates({
      detailType: 'D001',
      changes: [
        {
          rowIndex: 1,
          methodRaw: '기타',
          securityTypeRaw: '보통주',
          direction: Direction.UNKNOWN,
          quantity: '10',
        },
      ],
    } as unknown as Parameters<typeof selectUnknownAiReviewCandidates>[0]);

    expect(d005.candidates.map((row) => row.rowIndex)).toEqual([3]);
    expect(d001.candidates).toEqual([]);
  });

  it('calls the local classifier sequentially', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const reviews = await reviewAiCandidatesSequentially(
      [unknownCandidate(0), unknownCandidate(1), unknownCandidate(2)],
      async (candidate) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        order.push(candidate.rowIndex);
        active -= 1;
        return aiReview(ClassificationReviewResult.AI_SUGGESTED);
      },
    );

    expect(reviews).toHaveLength(3);
    expect(maxActive).toBe(1);
    expect(order).toEqual([0, 1, 2]);
  });

  it('aggregates conservatively and keeps truncated work review-required', () => {
    expect(
      aggregateAiReviewClassification([
        aiReview(ClassificationReviewResult.AI_CONFIRMED),
        aiReview(ClassificationReviewResult.AI_CONFIRMED),
      ]),
    ).toBe(ClassificationReviewResult.AI_CONFIRMED);
    expect(
      aggregateAiReviewClassification([
        aiReview(ClassificationReviewResult.AI_CONFIRMED),
        aiReview(ClassificationReviewResult.AI_SUGGESTED),
      ]),
    ).toBe(ClassificationReviewResult.AI_SUGGESTED);
    expect(
      aggregateAiReviewClassification([
        aiReview(ClassificationReviewResult.AI_SUGGESTED),
        aiReview(ClassificationReviewResult.REVIEW_REQUIRED, null),
      ]),
    ).toBe(ClassificationReviewResult.REVIEW_REQUIRED);
    expect(
      aggregateAiReviewClassification([aiReview(ClassificationReviewResult.AI_CONFIRMED)], true),
    ).toBe(ClassificationReviewResult.REVIEW_REQUIRED);
  });

  it('preserves AI classification across later deterministic rewrites', () => {
    expect(
      preserveAiClassificationResult(
        ClassificationReviewResult.AI_SUGGESTED,
        ClassificationReviewResult.RULE_CONFIRMED,
      ),
    ).toBe(ClassificationReviewResult.AI_SUGGESTED);
    expect(
      preserveAiClassificationResult(
        ClassificationReviewResult.REVIEW_REQUIRED,
        ClassificationReviewResult.RULE_CONFIRMED,
      ),
    ).toBe(ClassificationReviewResult.RULE_CONFIRMED);
  });

  it('routes the AI job to the isolated review handler', async () => {
    const enrichment = {
      enrich: jest.fn(),
      applyDeferredProjection: jest.fn(),
      reviewParseWithAi: jest.fn().mockResolvedValue({
        status: ProcessingStatus.FAILED,
        aiRunId: 'audit-id',
      }),
    } as unknown as FilingEnrichmentService;
    const processor = new AiReviewProcessor(enrichment);

    await expect(
      processor.process({
        name: JobName.REVIEW_PARSE_WITH_AI,
        data: { filingId: FILING_ID, parseRunId: PARSE_RUN_ID },
      } as Job<unknown>),
    ).resolves.toMatchObject({ status: ProcessingStatus.FAILED, aiRunId: 'audit-id' });
    expect(enrichment.reviewParseWithAi).toHaveBeenCalledWith({
      filingId: FILING_ID,
      parseRunId: PARSE_RUN_ID,
    });
    expect(enrichment.enrich).not.toHaveBeenCalled();
    expect(enrichment.applyDeferredProjection).not.toHaveBeenCalled();
  });

  it('keeps AI review jobs off the deterministic filing processor', async () => {
    const enrichment = {
      enrich: jest.fn(),
      applyDeferredProjection: jest.fn(),
      reviewParseWithAi: jest.fn(),
    } as unknown as FilingEnrichmentService;
    const processor = new FilingProcessor(enrichment);

    await expect(
      processor.process({
        name: JobName.REVIEW_PARSE_WITH_AI,
        data: { filingId: FILING_ID, parseRunId: PARSE_RUN_ID },
      } as Job<unknown>),
    ).rejects.toThrow('Unsupported filing job: review-parse-with-ai');
    expect(enrichment.reviewParseWithAi).not.toHaveBeenCalled();
  });

  it('dispatches the durable AI outbox kind onto the dedicated AI-review queue', async () => {
    const row = {
      id: 'outbox-id',
      kind: 'REVIEW_PARSE_WITH_AI',
      dedupeKey: `ai-review:${PARSE_RUN_ID}:hash`,
      payloadJson: { filingId: FILING_ID, parseRunId: PARSE_RUN_ID },
      status: ProcessingStatus.PENDING,
      availableAt: new Date(),
      lockedAt: null,
      attempts: 0,
      lastError: null,
    };
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      setOnLocked: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([row]),
    };
    const repository = {
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };
    const dataSource = {
      getRepository: jest.fn(() => repository),
      transaction: jest.fn(async (callback: (manager: unknown) => unknown) =>
        callback({ getRepository: () => repository }),
      ),
    } as unknown as DataSource;
    const filingQueue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const aiReviewQueue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const connectorQueue = { add: jest.fn() } as unknown as Queue;
    const alertDispatcher = {
      dispatch: jest.fn().mockResolvedValue({ claimed: 0, dispatched: 0 }),
    };
    const dispatcher = new OutboxDispatcherService(
      dataSource,
      filingQueue,
      aiReviewQueue,
      connectorQueue,
      alertDispatcher as never,
      {
        dispatch: jest.fn().mockResolvedValue({ configured: false, claimed: 0, sent: 0 }),
      } as never,
    );

    await expect(dispatcher.dispatch()).resolves.toMatchObject({
      processing: { claimed: 1, dispatched: 1 },
    });
    expect(aiReviewQueue.add).toHaveBeenCalledWith(
      JobName.REVIEW_PARSE_WITH_AI,
      { filingId: FILING_ID, parseRunId: PARSE_RUN_ID },
      expect.objectContaining({ attempts: 9 }),
    );
    expect(filingQueue.add).not.toHaveBeenCalled();
    expect(connectorQueue.add).not.toHaveBeenCalled();
  });
});
