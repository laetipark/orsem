import { ReviewTaskStatus } from '@orsem/contracts';
import { ParseRunEntity, ReviewEntity } from '@orsem/database';
import type { EntityManager } from 'typeorm';
import { updateParseReviewLifecycle } from '../src/opendart/parse-review-lifecycle';

function setup() {
  const reviews: ReviewEntity[] = [];
  let newest = 'run1';
  const repository = {
    find: jest.fn(async () => [...reviews].reverse()),
    create: (value: Partial<ReviewEntity>) => value as ReviewEntity,
    save: jest.fn(async (value: ReviewEntity) => {
      const otherOpen = reviews.filter(
        (row) => row.id !== value.id && row.status === 'OPEN' && row.reviewGroup === 'PARSE',
      );
      if (value.status === 'OPEN' && otherOpen.length)
        throw new Error('active_parse_subject collision');
      if (!reviews.some((row) => row.id === value.id)) reviews.push(value);
      return value;
    }),
  };
  const manager = {
    getRepository: (entity: unknown) =>
      entity === ParseRunEntity
        ? { findOne: async () => ({ id: newest }) }
        : entity === ReviewEntity
          ? repository
          : undefined,
  } as unknown as EntityManager;
  return {
    manager,
    reviews,
    next: (value: string) => {
      newest = value;
    },
  };
}

describe('one current parse review per filing', () => {
  it('supersedes two older runs without deleting their evidence and resolves the third successful run', async () => {
    const state = setup();
    await updateParseReviewLifecycle(state.manager, 'filing', 'run1', 'partial1', true);
    const first = state.reviews[0]!;
    state.next('run2');
    await updateParseReviewLifecycle(state.manager, 'filing', 'run2', 'failed2', true);
    expect(first.status).toBe(ReviewTaskStatus.SUPERSEDED);
    expect(first.supersededByReviewId).toBe(state.reviews[1]!.id);
    expect(state.reviews.filter((row) => row.status === 'OPEN')).toHaveLength(1);
    state.next('run3');
    await updateParseReviewLifecycle(state.manager, 'filing', 'run3', 'success', false);
    expect(state.reviews).toHaveLength(3);
    expect(state.reviews.filter((row) => row.status === 'OPEN')).toHaveLength(0);
    expect(state.reviews[1]!.supersededByReviewId).toBe(state.reviews[2]!.id);
    expect(state.reviews[2]!.reopenedFromReviewId).toBe(state.reviews[1]!.id);
    expect(state.reviews[2]!.status).toBe(ReviewTaskStatus.RESOLVED);
  });

  it('does not let a late retry reopen an older review or overwrite a human resolution', async () => {
    const state = setup();
    await updateParseReviewLifecycle(state.manager, 'filing', 'run1', 'partial1', true);
    state.reviews[0]!.status = ReviewTaskStatus.RESOLVED;
    state.reviews[0]!.resolvedByAdminId = 'admin';
    state.reviews[0]!.resolution = 'manual decision';
    await updateParseReviewLifecycle(state.manager, 'filing', 'run1', 'retry', true);
    expect(state.reviews[0]!.resolution).toBe('manual decision');
    state.next('run2');
    await updateParseReviewLifecycle(state.manager, 'filing', 'run2', 'new raw', true);
    await updateParseReviewLifecycle(state.manager, 'filing', 'run1', 'late retry', true);
    expect(state.reviews.filter((row) => row.status === 'OPEN')).toHaveLength(1);
    expect(state.reviews.find((row) => row.status === 'OPEN')!.parseRunId).toBe('run2');
    expect(state.reviews[0]!.resolution).toBe('manual decision');
  });
});
