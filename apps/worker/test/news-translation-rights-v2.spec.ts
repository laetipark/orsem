import 'reflect-metadata';
import { RightsMode, type NewsSourcePolicy } from '@orsem/contracts';
import { NewsItemEntity, SourceItemEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import type { WorkerConfig } from '../src/config/worker-config';
import type { LocalNewsTranslationClient } from '../src/ai/local-news-translation.client';
import {
  NewsTranslationService,
  sourcePolicyAllowsTranslation,
  translationInput,
} from '../src/ai/news-translation.service';

const approved: NewsSourcePolicy = {
  policyVersion: 2,
  policyId: 'test-ir-policy',
  rightsStatus: 'METADATA_ONLY',
  rightsMode: RightsMode.STORE_METADATA_ONLY,
  metadataStorageAllowed: true,
  displayAllowed: true,
  aiAllowed: true,
  translationAllowed: true,
  summaryStorageAllowed: true,
  fullTextStorageAllowed: false,
  publicRedistributionAllowed: false,
  notifyAllowed: false,
  allowedAudiences: ['ADMIN_UI'],
  policyUrl: 'https://official.example/terms',
  checkedAt: '2026-09-07',
};
const source = (policy: NewsSourcePolicy = approved): SourceItemEntity =>
  Object.assign(new SourceItemEntity(), {
    id: 'source-a',
    source: 'IR',
    sourceKind: 'COMPANY_IR',
    sourcePolicyJson: policy,
    title: 'Example company announces quarterly results',
    rawHash: 'a'.repeat(64),
    rightsMode: policy.rightsMode,
    publishedAt: new Date('2026-09-07T00:00:00Z'),
    firstObservedAt: new Date('2026-09-07T00:05:00Z'),
  });
const news = Object.assign(new NewsItemEntity(), {
  description: 'Revenue increased 12%.',
  tickersJson: ['EXAMPLE'],
});

describe('v2 news translation rights', () => {
  it('requires approval of the stored snapshot and the currently registered source policy', () => {
    expect(sourcePolicyAllowsTranslation(source(), approved)).toBe(true);
    expect(translationInput(source(), news, approved)?.description).toBe(news.description);
    expect(sourcePolicyAllowsTranslation(source(), null)).toBe(false);
    // The synthetic policy is not in the actual allowlist: a claimed prior approval is insufficient.
    expect(sourcePolicyAllowsTranslation(source())).toBe(false);
    for (const rightsStatus of [
      'UNKNOWN',
      'BLOCKED',
      'REQUIRES_CONTRACT_REVIEW',
      'LINK_ONLY',
    ] as const) {
      expect(sourcePolicyAllowsTranslation(source({ ...approved, rightsStatus }), approved)).toBe(
        false,
      );
      expect(sourcePolicyAllowsTranslation(source(), { ...approved, rightsStatus })).toBe(false);
    }
    expect(
      sourcePolicyAllowsTranslation(source(), { ...approved, policyId: 'another-policy' }),
    ).toBe(false);
  });

  it('rejects absent, null, unknown and false AI/translation/storage/display permissions on either policy', () => {
    for (const permission of [
      'aiAllowed',
      'translationAllowed',
      'metadataStorageAllowed',
      'displayAllowed',
    ] as const)
      for (const value of [undefined, null, 'UNKNOWN', false] as const) {
        const changed = { ...approved, [permission]: value } as NewsSourcePolicy;
        expect(sourcePolicyAllowsTranslation(source(changed), approved)).toBe(false);
        expect(sourcePolicyAllowsTranslation(source(), changed)).toBe(false);
      }
    expect(
      sourcePolicyAllowsTranslation(source(), { ...approved, allowedAudiences: ['MEMBER_UI'] }),
    ).toBe(false);
    expect(
      sourcePolicyAllowsTranslation(
        source({ ...approved, rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY }),
        approved,
      ),
    ).toBe(false);
  });

  it('never sends a provided summary unless both snapshot and current summary permission are explicitly true', () => {
    for (const summaryStorageAllowed of [undefined, null, 'UNKNOWN', false] as const) {
      const changed = { ...approved, summaryStorageAllowed };
      expect(translationInput(source(changed), news, approved)).toMatchObject({
        title: source().title,
        description: null,
      });
      expect(translationInput(source(), news, changed)?.description).toBeNull();
    }
  });

  it('keeps legacy approved RSS behavior and continues to isolate NAVER and external API adapters', () => {
    const legacy = {
      ...approved,
      policyVersion: undefined,
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      policyId: undefined,
      translationAllowed: undefined,
      summaryStorageAllowed: undefined,
    };
    expect(translationInput(source(legacy), news)?.description).toBe(news.description);
    for (const provider of ['NAVER', 'MARKETAUX', 'ALPHAVANTAGE', 'FINNHUB'])
      expect(translationInput({ ...source(), source: provider }, news, approved)).toBeNull();
  });

  it('a stale queued selection cannot send a revoked source to the AI client or read its summary', async () => {
    const row = source({ ...approved, rightsStatus: 'UNKNOWN' });
    const predicates: unknown[] = [];
    const query: Record<string, unknown> = {};
    for (const method of [
      'select',
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'limit',
    ])
      query[method] = (predicate: unknown) => {
        predicates.push(predicate);
        return query;
      };
    query.getRawMany = async () => [{ id: row.id }];
    const repository = { createQueryBuilder: () => query, findOne: async () => row };
    const manager = {
      getRepository: jest.fn((entity) => {
        expect(entity).toBe(SourceItemEntity);
        return repository;
      }),
    };
    const database = {
      ...manager,
      transaction: async (callback: (value: typeof manager) => Promise<unknown>) =>
        callback(manager),
    } as unknown as DataSource;
    const client = { translate: jest.fn() };
    const service = new NewsTranslationService(
      database,
      { newsTranslationEnabled: true, newsTranslationBatchSize: 3 } as WorkerConfig,
      client as unknown as LocalNewsTranslationClient,
    );
    expect(await service.translateBatch()).toEqual({
      completed: 0,
      failed: 0,
      skipped: 0,
      stale: 0,
    });
    expect(client.translate).not.toHaveBeenCalled();
    expect(
      predicates.some(
        (predicate) => typeof predicate === 'string' && predicate.includes('aiAllowed'),
      ),
    ).toBe(true);
  });
});
