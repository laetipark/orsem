import { randomUUID } from 'node:crypto';
import { ClassificationReviewResult, ReviewTaskStatus } from '@orsem/contracts';
import { ParseRunEntity, ReviewEntity } from '@orsem/database';
import type { EntityManager } from 'typeorm';

/** Caller holds the filing lock; one current parse review is open per filing. */
export async function updateParseReviewLifecycle(
  manager: EntityManager,
  filingId: string,
  parseRunId: string,
  reason: string,
  needsReview: boolean,
): Promise<void> {
  const newestRun = await manager.getRepository(ParseRunEntity).findOne({
    where: { filingId },
    order: { createdAt: 'DESC', id: 'DESC' },
  });
  if (newestRun && newestRun.id !== parseRunId) return;

  const repository = manager.getRepository(ReviewEntity);
  const reviews = (
    await repository.find({
      where: { subjectType: 'FILING', subjectId: filingId },
      order: { createdAt: 'DESC', id: 'DESC' },
    })
  ).filter((review) => review.reviewGroup === 'PARSE' || review.dedupeKey.startsWith('parse:'));
  let current = reviews.find((review) => review.dedupeKey === `parse:${parseRunId}`);
  const now = new Date();
  if (!current) {
    current = await repository.save(
      repository.create({
        id: randomUUID(),
        subjectType: 'FILING',
        subjectId: filingId,
        dedupeKey: `parse:${parseRunId}`,
        reviewGroup: 'PARSE',
        parseRunId,
        supersededByReviewId: null,
        reopenedFromReviewId: reviews[0]?.id ?? null,
        reason,
        // Insert closed before superseding the previous OPEN row to respect the unique key.
        status: ReviewTaskStatus.RESOLVED,
        classificationResult: needsReview
          ? ClassificationReviewResult.REVIEW_REQUIRED
          : ClassificationReviewResult.RULE_CONFIRMED,
        resolution: null,
        resolvedByAdminId: null,
        resolvedAt: null,
      }),
    );
  }
  for (const previous of reviews) {
    if (previous.id === current.id || previous.status !== ReviewTaskStatus.OPEN) continue;
    previous.status = ReviewTaskStatus.SUPERSEDED;
    previous.supersededByReviewId = current.id;
    previous.reviewGroup = 'PARSE';
    previous.resolution = JSON.stringify({ resolution: 'SUPERSEDED_BY_PARSE', parseRunId });
    previous.resolvedAt = now;
    await repository.save(previous);
  }
  if (current.resolvedByAdminId) return;
  current.reviewGroup = 'PARSE';
  current.parseRunId = parseRunId;
  current.reason = reason;
  current.status = needsReview ? ReviewTaskStatus.OPEN : ReviewTaskStatus.RESOLVED;
  current.classificationResult = needsReview
    ? ClassificationReviewResult.REVIEW_REQUIRED
    : ClassificationReviewResult.RULE_CONFIRMED;
  current.resolution = needsReview
    ? null
    : JSON.stringify({ resolution: 'AUTOMATIC_RECHECK_SUCCEEDED' });
  current.resolvedAt = needsReview ? null : now;
  await repository.save(current);
}
