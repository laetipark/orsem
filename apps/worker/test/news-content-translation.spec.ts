import 'reflect-metadata';
import { RightsMode } from '@orsem/contracts';
import { NewsItemEntity, SourceItemEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { NewsTranslationService, translationInput } from '../src/ai/news-translation.service';
import type { LocalNewsTranslationClient } from '../src/ai/local-news-translation.client';
import { loadWorkerConfig } from '../src/config/worker-config';

describe('metadata translation has no body dependency', () => {
  const source = Object.assign(new SourceItemEntity(), {
    source: 'NEWS_RSS',
    title: 'Federal Reserve announces results',
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    sourcePolicyJson: {
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      metadataStorageAllowed: true,
      displayAllowed: true,
      aiAllowed: true,
      fullTextStorageAllowed: false,
    },
  });

  it('uses only title and supplied summary under metadata/display/AI permission', () => {
    const news = Object.assign(new NewsItemEntity(), {
      description: 'Official summary 12%.',
      tickersJson: [],
    });
    expect(translationInput(source, news)).toEqual({
      title: source.title,
      description: 'Official summary 12%.',
      tickers: [],
    });
    expect(
      translationInput(source, Object.assign(news, { description: null }))?.description,
    ).toBeNull();
    expect(
      translationInput(Object.assign(new SourceItemEntity(), source, { source: 'NAVER' }), news),
    ).toBeNull();
  });

  it('does not select, join, claim or translate body rows during a scheduled batch', async () => {
    const query: Record<string, jest.Mock> = {};
    for (const method of [
      'select',
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'limit',
    ])
      query[method] = jest.fn().mockReturnValue(query);
    query.getRawMany = jest.fn().mockResolvedValue([]);
    const getRepository = jest.fn((entity: unknown) => {
      if (entity !== SourceItemEntity) throw new Error('Body repository forbidden');
      return { createQueryBuilder: () => query };
    });
    const client = { translate: jest.fn() };
    const service = new NewsTranslationService(
      { getRepository } as unknown as DataSource,
      loadWorkerConfig({ NEWS_TRANSLATION_ENABLED: 'true' }),
      client as unknown as LocalNewsTranslationClient,
    );
    expect(await service.translateBatch()).toEqual({
      completed: 0,
      failed: 0,
      skipped: 0,
      stale: 0,
    });
    expect(query.innerJoin).toHaveBeenCalledTimes(1);
    expect(query.innerJoin).toHaveBeenCalledWith(
      NewsItemEntity,
      'news',
      'news.sourceItemId = source.id',
    );
    const predicates = query
      .andWhere!.mock.calls.flat()
      .filter((value) => typeof value === 'string')
      .join(' ');
    expect(predicates).not.toMatch(/fullText|content\./u);
    expect(client.translate).not.toHaveBeenCalled();
  });
});
