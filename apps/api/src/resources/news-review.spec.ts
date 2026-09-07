import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NEWS_IR_SOURCE_PROFILES } from '@orsem/contracts';
import {
  CompanyEntity,
  FilingEntity,
  NewsSourceCompanyEntity,
  SourceItemEntity,
  type ReviewEntity,
} from '@orsem/database';
import type { EntityManager } from 'typeorm';
import { resolveNewsReview } from './news-review';

const sourceId = '00000000-0000-4000-8000-000000000001';
const filingId = '00000000-0000-4000-8000-000000000002';
const companyId = '00000000-0000-4000-8000-000000000003';
const hash = 'a'.repeat(64);
function context(official?: SourceItemEntity) {
  const source: SourceItemEntity = Object.assign(new SourceItemEntity(), {
    id: sourceId,
    source: 'IR',
    sourceKind: 'COMPANY_IR',
    rawHash: hash,
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    sourcePolicyJson: NEWS_IR_SOURCE_PROFILES['samsung-global'].policy,
    rawMetadataJson: {
      officialReferences: [
        {
          kind: 'FILING',
          id: filingId,
          sourceHash: hash,
          matchMethod: 'COMPANY_TIME',
          status: 'RELATED',
        },
      ],
    },
  });
  const saved: unknown[] = [];
  const relations: unknown[] = [];
  const manager = {
    getRepository(entity: unknown) {
      if (entity === SourceItemEntity)
        return {
          findOne: async ({ where }: { where: { id: string } }) =>
            where.id === sourceId ? source : official,
          save: async (row: unknown) => {
            saved.push(row);
            return row;
          },
        };
      if (entity === FilingEntity)
        return { findOneBy: async () => ({ id: filingId, source: 'OPENDART' }) };
      if (entity === CompanyEntity)
        return { find: async () => [{ id: companyId, isListed: true }] };
      if (entity === NewsSourceCompanyEntity)
        return {
          find: async () => [],
          create: (row: unknown) => row,
          save: async (row: unknown) => relations.push(row),
        };
      throw new Error('Unexpected domain mutation');
    },
  } as unknown as EntityManager;
  return {
    source,
    saved,
    relations,
    manager,
    review: { id: 'review', subjectId: sourceId } as ReviewEntity,
  };
}

test('manual official confirmation changes the link and preserves review evidence without promoting an event', async () => {
  const c = context();
  const audit = await resolveNewsReview(
    c.manager,
    c.review,
    {
      resolution: 'CONFIRMED',
      sourceHash: hash,
      officialTarget: { kind: 'FILING', id: filingId },
      note: '직접 대조',
    },
    'admin',
    new Date('2026-09-07T00:00:00Z'),
  );
  assert.equal(c.source.rawMetadataJson?.officialVerification, 'CONFIRMED');
  assert.equal(
    (c.source.rawMetadataJson?.officialReferences as Record<string, unknown>[])[0]?.status,
    'CONFIRMED',
  );
  assert.equal(audit.sourceHash, hash);
  assert.equal(audit.reviewedByAdminId, 'admin');
  assert.ok(audit.previous);
  assert.equal(c.saved.length, 1);
});

test('manual company resolution writes the existing company relationship only', async () => {
  const c = context();
  await resolveNewsReview(
    c.manager,
    c.review,
    { resolution: 'CONFIRMED', sourceHash: hash, companyIds: [companyId] },
    'admin',
    new Date(),
  );
  assert.deepEqual(c.source.rawMetadataJson?.manualCompanyIds, [companyId]);
  assert.equal((c.relations[0] as { matchMethod: string }).matchMethod, 'MANUAL_REVIEW');
  assert.equal(c.source.rawMetadataJson?.officialVerification, 'LINKED');
});

test('an existing public SEC source is confirmable and a changed target hash is rejected', async () => {
  const official = Object.assign(new SourceItemEntity(), {
    id: filingId,
    source: 'SEC',
    sourceKind: 'OFFICIAL_DISCLOSURE',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    sourcePolicyJson: null,
    rawHash: 'b'.repeat(64),
  });
  for (const targetHash of [official.rawHash, 'c'.repeat(64)]) {
    const c = context(official);
    c.source.rawMetadataJson!.officialReferences = [
      {
        kind: 'SOURCE_ITEM',
        id: filingId,
        sourceHash: hash,
        targetHash,
        matchMethod: 'EXPLICIT_ID',
        status: 'RELATED',
      },
    ];
    const resolve = () =>
      resolveNewsReview(
        c.manager,
        c.review,
        {
          resolution: 'CONFIRMED',
          sourceHash: hash,
          officialTarget: { kind: 'SOURCE_ITEM', id: filingId },
        },
        'admin',
        new Date(),
      );
    if (targetHash === official.rawHash) {
      await resolve();
      assert.equal(c.source.rawMetadataJson!.officialVerification, 'CONFIRMED');
    } else {
      await assert.rejects(resolve);
      assert.equal(c.saved.length, 0);
    }
  }
});

test('stale hash, absent selection and unregistered official targets cannot close a review', async () => {
  for (const input of [
    { resolution: 'CONFIRMED' as const, sourceHash: 'b'.repeat(64), companyIds: [companyId] },
    { resolution: 'CONFIRMED' as const, sourceHash: hash },
    {
      resolution: 'CONFIRMED' as const,
      sourceHash: hash,
      officialTarget: { kind: 'FILING' as const, id: companyId },
    },
  ]) {
    const c = context();
    await assert.rejects(() => resolveNewsReview(c.manager, c.review, input, 'admin', new Date()));
    assert.equal(c.saved.length, 0);
  }
});
