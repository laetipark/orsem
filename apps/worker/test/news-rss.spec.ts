import { createHash } from 'node:crypto';
import {
  canonicalNewsUrl,
  ConnectorStatus,
  NEWS_IR_SOURCE_PROFILES,
  NEWS_RSS_FEEDS,
  ProcessingStatus,
  RightsMode,
} from '@orsem/contracts';
import {
  ConnectorHealthEntity,
  IngestionRunEntity,
  IrSourceEntity,
  NewsItemEntity,
  NewsArticleEntity,
  NewsArticleContentEntity,
  SourceCheckpointEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { Queue } from 'bullmq';
import type { DataSource } from 'typeorm';
import type { CompatibleClassifierClient } from '../src/ai/compatible-classifier.client';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  type FeedTransport,
  type FeedCheckpointStore,
  type NewsRssFeedId,
  parseIrRssFeed,
  parseNewsRssFeed,
  PublisherNewsRssConnector,
  RegisteredIrFeedConnector,
} from '../src/connectors/connector-adapters';
import { ConnectorHealthService } from '../src/connectors/connector-health.service';
import { NewsDiscoveryService } from '../src/connectors/news-discovery.service';
import type { PushFanoutService } from '../src/push/push-fanout.service';
import { discoverLinksJobSchema } from '../src/queues/job-data';
import { WorkerSchedulerService } from '../src/scheduling/worker-scheduler.service';

const config = loadWorkerConfig({ NEWS_RSS_FEEDS: 'fed-press', GDELT_ENABLED: 'false' });
const job = discoverLinksJobSchema.parse({ connectors: ['NEWS_RSS'], reason: 'SCHEDULED' });
const rss = (items: string) => `<rss version="2.0"><channel>${items}</channel></rss>`;
const article = (title = '시장 &amp; 기업') => `<item><title>${title}</title>
  <link>https://www.federalreserve.gov/newsevents/pressreleases/123?x=1&amp;y=2</link><guid>source-guid</guid>
  <pubDate>Fri, 04 Sep 2026 09:15:00 +0900</pubDate>
  <description>Do not store this summary.</description><content>Do not store this body.</content></item>`;

function withOfficialContent(feedId: NewsRssFeedId, parsed: ReturnType<typeof parseNewsRssFeed>) {
  return {
    ...parsed,
    candidates: parsed.candidates.map((candidate) => ({
      ...candidate,
      content: {
        status: 'AVAILABLE' as const,
        blocks: [{ type: 'PARAGRAPH' as const, text: 'Official full article.' }],
        contentHash: 'c'.repeat(64),
        language: 'en',
        fetchedAt: '2026-09-05T00:00:00.000Z',
        failureCode: null,
        rightsPolicy: NEWS_RSS_FEEDS[feedId].policy,
      },
    })),
  };
}

function memoryDatabase() {
  const collections = new Map<unknown, Record<string, unknown>[]>();
  const repositories = new Map<
    unknown,
    {
      find: jest.Mock;
      findOne: jest.Mock;
      create: jest.Mock;
      save: jest.Mock;
      update: jest.Mock;
      createQueryBuilder: jest.Mock;
      findOneByOrFail: jest.Mock;
    }
  >();
  let nextId = 1;
  const rows = (target: unknown) => {
    if (!collections.has(target)) collections.set(target, []);
    return collections.get(target)!;
  };
  const repository = (target: unknown) => {
    if (!repositories.has(target))
      repositories.set(target, {
        findOneByOrFail: jest.fn(async (where: Record<string, unknown>) =>
          rows(target).find((row) =>
            Object.entries(where).every(([key, value]) => row[key] === value),
          ),
        ),
        update: jest.fn(async (id: string, values: Record<string, unknown>) => {
          Object.assign(
            rows(target).find((row) => row.id === id)!,
            values,
          );
          return { affected: 1 };
        }),
        createQueryBuilder: jest.fn(() => {
          let incoming: Record<string, unknown>;
          const builder = {
            insert: () => builder,
            values: (value: Record<string, unknown>) => {
              incoming = value;
              return builder;
            },
            orIgnore: () => builder,
            execute: async () => {
              if (!rows(target).some((row) => row.urlHash === incoming.urlHash))
                rows(target).push(incoming);
            },
          };
          return builder;
        }),
        find: jest.fn(async () => rows(target)),
        findOne: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            rows(target).find((row) =>
              Object.entries(where).every(([key, value]) => row[key] === value),
            ) ?? null,
        ),
        create: jest.fn((values: Record<string, unknown>) => ({ id: String(nextId++), ...values })),
        save: jest.fn(async (row: Record<string, unknown>) => {
          const existing = rows(target).findIndex((value) => value.id === row.id);
          if (existing < 0) rows(target).push(row);
          else rows(target)[existing] = row;
          return row;
        }),
      });
    return repositories.get(target)!;
  };
  const manager = { getRepository: repository };
  const dataSource = {
    ...manager,
    transaction: async (callback: (manager: unknown) => unknown) => callback(manager),
  } as unknown as DataSource;
  return { dataSource, rows, repository };
}

afterEach(() => jest.restoreAllMocks());

describe('allowlisted publisher RSS', () => {
  it('is opt-in, deduplicates feed IDs and rejects arbitrary IDs or URLs', async () => {
    expect(loadWorkerConfig({}).newsRssFeeds).toEqual([]);
    expect(loadWorkerConfig({ NEWS_RSS_FEEDS: ' fed-press,fed-press ' }).newsRssFeeds).toEqual([
      'fed-press',
    ]);
    expect(() => loadWorkerConfig({ NEWS_RSS_FEEDS: 'https://127.0.0.1/rss' })).toThrow();
    expect(() => loadWorkerConfig({ NEWS_RSS_FEEDS: 'unreviewed-publisher' })).toThrow();
    const adapter = new PublisherNewsRssConnector([], 1000);
    const fetch = jest.spyOn(adapter, 'fetchFeed');
    expect(await adapter.check()).toMatchObject({ status: ConnectorStatus.UNCONFIGURED });
    expect(await adapter.discoverLinks()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps source metadata, UTC publication, rights and a safe feed excerpt', () => {
    const { candidates } = parseNewsRssFeed('fed-press', rss(article()));
    expect(candidates[0]).toMatchObject({
      connector: 'NEWS_RSS',
      title: '시장 & 기업',
      publishedAt: '2026-09-04T00:15:00.000Z',
      url: 'https://www.federalreserve.gov/newsevents/pressreleases/123?x=1&y=2',
      sourceName: 'Federal Reserve',
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      metadata: {
        originalTitle: '시장 &amp; 기업',
        originalGuid: 'source-guid',
        originalPublishedAt: 'Fri, 04 Sep 2026 09:15:00 +0900',
        marketRegion: 'us',
        rightsContext: 'OFFICIAL_RSS_READER',
        rightsPolicyUrl: 'https://www.federalreserve.gov/disclaimer.htm',
        description: 'Do not store this summary.',
      },
    });
    expect(JSON.stringify(candidates)).not.toContain('Do not store this body.');
    expect(candidates[0]?.externalId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('identifies the reader with contact information required by official feeds', async () => {
    const transport: FeedTransport = async (_connector, _operation, _url, headers) => {
      expect(headers['User-Agent']).toContain('https://orsem.laetipark.me');
      return {
        status: 200,
        bytes: new TextEncoder().encode(rss(article())),
        etag: null,
        lastModified: null,
      };
    };
    const adapter = new PublisherNewsRssConnector(['fed-press'], 1000, undefined, transport);

    await expect(adapter.fetchFeed('fed-press')).resolves.toMatchObject({ skippedItems: 0 });
  });

  it('uses URL identity across title/GUID changes and duplicate feed entries', () => {
    const first = parseNewsRssFeed('fed-press', rss(article())).candidates[0]!;
    const revised = article('수정한 제목').replace('source-guid', 'different-guid');
    const parsed = parseNewsRssFeed('fed-press', rss(revised + article()));
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.externalId).toBe(first.externalId);
    expect(parsed.candidates[0]?.title).toBe('수정한 제목');
  });

  it('supports Atom links while preserving dates without inventing an instant', () => {
    const parsed = parseNewsRssFeed(
      'fed-press',
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Atom article</title><link href="/news/view/456" rel="alternate"/>
      <id>atom-guid</id><published>2026-09-04</published><summary>not retained</summary></entry></feed>`,
    );
    expect(parsed.candidates[0]).toMatchObject({
      publishedAt: null,
      metadata: { originalPublishedAt: '2026-09-04', originalGuid: 'atom-guid' },
    });
  });

  it('isolates malformed/private-link items and rejects unsafe XML documents', () => {
    const parsed = parseNewsRssFeed(
      'fed-press',
      rss(
        article() +
          '<item><title>No link</title></item>' +
          '<item><title>Private link</title><link>https://127.0.0.1/secret</link></item>',
      ),
    );
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.skippedItems).toBe(2);
    expect(() =>
      parseNewsRssFeed(
        'fed-press',
        '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
      ),
    ).toThrow();
    expect(() => parseNewsRssFeed('fed-press', '<html>unavailable</html>')).toThrow();
    expect(() => parseNewsRssFeed('fed-press', '<rss><channel></rss>')).toThrow(/malformed XML/u);
    expect(() => parseNewsRssFeed('fed-press', ' '.repeat(5 * 1024 * 1024 + 1))).toThrow(
      /size limit/u,
    );
  });

  it('fetches once per feed, never probes on health checks and reports complete failures', async () => {
    const adapter = new PublisherNewsRssConnector(['fed-press', 'fed-press'], 1000);
    const fetch = jest.spyOn(adapter, 'fetchFeed').mockRejectedValue(new Error('unavailable'));
    await adapter.check();
    expect(fetch).not.toHaveBeenCalled();
    await expect(adapter.discoverLinks()).rejects.toThrow('1 feed(s) failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(adapter.discoveryMetadata).toMatchObject({ failedFeedCount: 1 });
  });

  it('does not report a feed containing only malformed items as successful empty data', async () => {
    const adapter = new PublisherNewsRssConnector(['fed-press'], 1000);
    jest
      .spyOn(adapter, 'fetchFeed')
      .mockResolvedValue(
        parseNewsRssFeed('fed-press', rss('<item><title>missing link</title></item>')),
      );
    await expect(adapter.discoverLinks()).rejects.toThrow('1 malformed item(s) skipped');
  });
});

describe('publisher RSS ingestion', () => {
  it('reuses a legacy completed translation when only feed metadata changes, preserving its original audit', async () => {
    const db = memoryDatabase();
    const service = new NewsDiscoveryService(db.dataSource, config, jest.fn(), {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    const original = withOfficialContent(
      'fed-press',
      parseNewsRssFeed('fed-press', rss(article('Federal Reserve announces official results'))),
    );
    const revised = structuredClone(original);
    revised.candidates[0]!.metadata = {
      ...revised.candidates[0]!.metadata,
      originalGuid: 'updated-guid-with-the-same-translation-input',
    };
    const fetch = jest.spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed');
    fetch.mockResolvedValueOnce(original).mockResolvedValueOnce(revised);
    await service.discover(job);
    const row = db.rows(SourceItemEntity)[0]!;
    const beforeHash = row.rawHash;
    const audit = {
      version: 1,
      status: 'COMPLETED',
      inputHash: beforeHash,
      title: '연방준비제도 공식 결과 발표',
      description: '공식 요약입니다.',
      translatedAt: '2026-09-04T00:00:00.000Z',
      provider: 'LOCAL',
      model: 'original-local-model',
      attempts: 1,
    };
    row.translationJson = audit;
    await service.discover(job);
    expect(row.rawHash).not.toBe(beforeHash);
    expect(row.translationJson).toEqual({
      ...audit,
      inputHash: row.rawHash,
      sourceTextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(db.rows(NewsArticleContentEntity)).toEqual([]);
    expect(db.repository(SourceItemEntity).findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(db.repository(NewsArticleContentEntity).findOne).not.toHaveBeenCalled();
  });

  it('keeps a prior translation bound to its old hash when the actual title changes', async () => {
    const db = memoryDatabase();
    const service = new NewsDiscoveryService(db.dataSource, config, jest.fn(), {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    const fetch = jest.spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed');
    for (const title of ['Federal Reserve announces results', 'Federal Reserve revises results']) {
      fetch.mockResolvedValueOnce(
        withOfficialContent('fed-press', parseNewsRssFeed('fed-press', rss(article(title)))),
      );
    }
    await service.discover(job);
    const row = db.rows(SourceItemEntity)[0]!;
    const audit = { version: 1, status: 'COMPLETED', inputHash: row.rawHash, title: '이전 결과' };
    row.translationJson = audit;
    await service.discover(job);
    expect(row.translationJson).toEqual(audit);
    expect(row.rawHash).not.toBe(audit.inputHash);
  });

  it('preserves manual metadata and existing body tombstones when feed text changes', async () => {
    const db = memoryDatabase();
    const service = new NewsDiscoveryService(db.dataSource, config, jest.fn(), {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    const original = parseNewsRssFeed('fed-press', rss(article()));
    const revised = parseNewsRssFeed('fed-press', rss(article('Revised official results')));
    jest
      .spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed')
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(revised);
    await service.discover(job);
    const row = db.rows(SourceItemEntity)[0]!;
    const manual = {
      version: 2,
      revisionId: 'manual-revision',
      sourceHash: row.rawHash,
      title: '수동 제목',
      description: '수동 요약',
    };
    row.manualTranslationJson = manual;
    const tombstone = {
      sourceItemId: row.id,
      status: 'PURGED',
      blocksJson: null,
      translationJson: null,
      contentHash: 'c'.repeat(64),
    };
    db.rows(NewsArticleContentEntity).push(tombstone);
    await service.discover(job);
    expect(row.manualTranslationJson).toEqual(manual);
    expect(db.rows(NewsArticleContentEntity)).toEqual([tombstone]);
    expect(db.repository(NewsArticleContentEntity).save).not.toHaveBeenCalled();
  });

  it('clears stale HTTP validators after a feed parser failure so the next poll retries the full feed', async () => {
    const db = memoryDatabase();
    const service = new NewsDiscoveryService(db.dataSource, config, jest.fn(), {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    const store = (
      service as unknown as { feedCheckpointStore(): FeedCheckpointStore }
    ).feedCheckpointStore();
    const url = NEWS_RSS_FEEDS['fed-press'].url;
    await store.save('NEWS_RSS', url, {
      etag: '"current"',
      lastModified: 'Fri, 04 Sep 2026 00:00:00 GMT',
      checkedAt: '2026-09-05T00:00:00.000Z',
      httpStatus: 200,
    });
    const previousSuccess = db.rows(SourceCheckpointEntity)[0]!.lastSuccessAt;
    await store.recordFailure?.(
      'NEWS_RSS',
      url,
      'official feed parse failure',
      new Date('2026-09-05T00:15:00.000Z'),
    );
    expect(db.rows(SourceCheckpointEntity)[0]).toMatchObject({ lastSuccessAt: previousSuccess });
    expect(db.rows(SourceCheckpointEntity)[0]!.metadataJson).toMatchObject({
      etag: null,
      lastModified: null,
      status: ConnectorStatus.DEGRADED,
      lastFailureAt: '2026-09-05T00:15:00.000Z',
    });
    await expect(store.load('NEWS_RSS', url)).resolves.toMatchObject({
      etag: null,
      lastModified: null,
    });
  });

  it('ignores legacy candidate bodies and stores only source metadata', async () => {
    const db = memoryDatabase();
    const service = new NewsDiscoveryService(db.dataSource, config, jest.fn(), {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    const parsed = parseNewsRssFeed('fed-press', rss(article()));
    const blocks = [{ type: 'PARAGRAPH' as const, text: 'Official body 12%.' }];
    jest.spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed').mockResolvedValue({
      ...parsed,
      candidates: parsed.candidates.map((candidate) => ({
        ...candidate,
        content: {
          status: 'AVAILABLE' as const,
          blocks,
          contentHash: 'c'.repeat(64),
          language: 'en',
          fetchedAt: '2026-09-05T00:00:00.000Z',
          failureCode: null,
          rightsPolicy: NEWS_RSS_FEEDS['fed-press'].policy,
        },
      })),
    });
    await service.discover(job);
    expect(db.rows(NewsArticleContentEntity)).toEqual([]);
    expect(db.repository(NewsArticleContentEntity).save).not.toHaveBeenCalled();
    expect(db.rows(NewsItemEntity)[0]).toMatchObject({
      title: '시장 & 기업',
      description: 'Do not store this summary.',
    });
    expect(JSON.stringify(db.rows(SourceItemEntity))).not.toContain('Official body 12%.');
  });

  it('groups one article across feeds while retaining both provenance records and all aggregate feed items', async () => {
    const db = memoryDatabase();
    const push = { enqueueNews: jest.fn() };
    const service = new NewsDiscoveryService(
      db.dataSource,
      loadWorkerConfig({ NEWS_RSS_FEEDS: 'fed-press,fed-speeches' }),
      jest.fn(),
      push as unknown as PushFanoutService,
    );
    const feed = (start: number, end: number) =>
      rss(
        Array.from({ length: end - start }, (_, offset) =>
          article(`News ${start + offset}`).replace('/123?', `/${start + offset}?`),
        ).join(''),
      );
    jest
      .spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed')
      .mockImplementation(async (id) =>
        withOfficialContent(
          id,
          parseNewsRssFeed(id, id === 'fed-press' ? feed(0, 301) : feed(300, 601)),
        ),
      );
    expect(await service.discover(job)).toMatchObject([
      { created: 602, status: ConnectorStatus.HEALTHY },
    ]);
    expect(db.rows(SourceItemEntity)).toHaveLength(602);
    expect(db.rows(NewsArticleEntity)).toHaveLength(601);
    const duplicate = db
      .rows(SourceItemEntity)
      .filter((source) => String(source.url).includes('/300?'));
    expect(duplicate).toHaveLength(2);
    expect(duplicate[0]?.newsArticleId).toBe(duplicate[1]?.newsArticleId);
    expect(duplicate[0]?.externalId).not.toBe(duplicate[1]?.externalId);
    expect(push.enqueueNews).not.toHaveBeenCalled();
  });

  it('upserts repeated articles, preserves first observation and never enqueues notifications', async () => {
    const db = memoryDatabase();
    const push = { enqueueNews: jest.fn() };
    const service = new NewsDiscoveryService(
      db.dataSource,
      config,
      jest.fn(),
      push as unknown as PushFanoutService,
    );
    const fetch = jest
      .spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed')
      .mockResolvedValueOnce(
        withOfficialContent('fed-press', parseNewsRssFeed('fed-press', rss(article()))),
      )
      .mockResolvedValueOnce(
        withOfficialContent('fed-press', parseNewsRssFeed('fed-press', rss(article('제목 수정')))),
      );
    expect(await service.discover(job)).toMatchObject([
      { status: ConnectorStatus.HEALTHY, created: 1 },
    ]);
    const firstObservedAt = db.rows(SourceItemEntity)[0]!.firstObservedAt;
    expect(firstObservedAt).toBeInstanceOf(Date);
    expect(await service.discover(job)).toMatchObject([
      { status: ConnectorStatus.HEALTHY, created: 0 },
    ]);
    expect(db.rows(SourceItemEntity)).toHaveLength(1);
    expect(db.rows(NewsItemEntity)).toHaveLength(1);
    expect(db.rows(SourceItemEntity)[0]).toMatchObject({
      title: '제목 수정',
      firstObservedAt,
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      rawObjectUri: null,
      provenanceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/123?x=1&y=2',
    });
    expect(db.rows(NewsItemEntity)[0]?.description).toBe('Do not store this summary.');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(push.enqueueNews).not.toHaveBeenCalled();
  });

  it('reuses the exact Samsung source by canonical URL when its SHA identity changes', async () => {
    const db = memoryDatabase();
    const feedUrl = NEWS_IR_SOURCE_PROFILES['samsung-global'].url;
    const articleUrl = 'https://news.samsung.com/global/example?utm_source=current';
    const canonicalUrl = canonicalNewsUrl(articleUrl);
    const articleId = 'samsung-article';
    const firstObservedAt = new Date('2026-09-01T00:00:00.000Z');
    const parsed = parseIrRssFeed(
      feedUrl,
      rss(`<item><title>Current Samsung title</title>
        <link>${articleUrl}</link>
        <pubDate>Fri, 04 Sep 2026 09:15:00 +0000</pubDate>
        <content:encoded><![CDATA[<p>Current Samsung article.</p>]]></content:encoded>
      </item>`),
    );
    const candidate = parsed.candidates[0]!;
    const currentCanonicalSha = createHash('sha256')
      .update(`${feedUrl}:${canonicalUrl}`)
      .digest('hex');
    expect(candidate.externalId).toBe(currentCanonicalSha);
    db.rows(NewsArticleEntity).push({
      id: articleId,
      canonicalUrl,
      urlHash: createHash('sha256').update(canonicalUrl).digest('hex'),
      sortAt: firstObservedAt,
      firstObservedAt,
    });
    db.rows(SourceItemEntity).push(
      {
        id: 'retired-ir-source',
        newsArticleId: articleId,
        source: 'IR',
        externalId: 'retired-feed-identity',
        rawHash: 'a'.repeat(64),
        url: 'https://news.samsung.com/global/example?utm_source=retired',
        title: 'Retired feed row',
        firstObservedAt: new Date('2026-08-31T00:00:00.000Z'),
        rawMetadataJson: { feedUrl: 'https://microsoft.example.test/feed.xml' },
      },
      {
        id: 'legacy-samsung-source',
        newsArticleId: articleId,
        source: 'IR',
        externalId: 'legacy-guid-identity',
        rawHash: 'b'.repeat(64),
        url: 'https://news.samsung.com/global/example?utm_source=legacy#fragment',
        title: 'Legacy Samsung title',
        firstObservedAt,
        rawMetadataJson: { feedUrl },
      },
    );
    jest
      .spyOn(RegisteredIrFeedConnector.prototype, 'fetchFeed')
      .mockResolvedValue(parsed.candidates);
    const service = new NewsDiscoveryService(
      db.dataSource,
      loadWorkerConfig({ IR_FEED_URLS: feedUrl, GDELT_ENABLED: 'false' }),
      jest.fn(),
      { enqueueNews: jest.fn() } as unknown as PushFanoutService,
    );

    await expect(
      service.discover(discoverLinksJobSchema.parse({ connectors: ['IR'], reason: 'SCHEDULED' })),
    ).resolves.toMatchObject([{ connector: 'IR', created: 0 }]);

    expect(db.rows(SourceItemEntity)).toHaveLength(2);
    expect(db.rows(SourceItemEntity).find((row) => row.id === 'retired-ir-source')).toMatchObject({
      externalId: 'retired-feed-identity',
      rawHash: 'a'.repeat(64),
    });
    const updatedSamsungSource = db
      .rows(SourceItemEntity)
      .find((row) => row.id === 'legacy-samsung-source');
    expect(updatedSamsungSource).toMatchObject({
      externalId: currentCanonicalSha,
      firstObservedAt,
      rawHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      title: 'Current Samsung title',
      url: articleUrl,
    });
    expect(updatedSamsungSource?.firstObservedAt).toBe(firstObservedAt);
    expect(updatedSamsungSource?.rawHash).not.toBe('b'.repeat(64));
    expect(db.rows(NewsItemEntity)).toHaveLength(1);
    expect(db.rows(NewsItemEntity)[0]).toMatchObject({
      sourceItemId: 'legacy-samsung-source',
      title: 'Current Samsung title',
    });
  });

  it('records malformed-item partial success and all-feed failure without a false success checkpoint', async () => {
    const db = memoryDatabase();
    const service = new NewsDiscoveryService(db.dataSource, config, jest.fn(), {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    jest
      .spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed')
      .mockResolvedValueOnce(
        withOfficialContent(
          'fed-press',
          parseNewsRssFeed('fed-press', rss(article() + '<item><title>invalid</title></item>')),
        ),
      )
      .mockRejectedValueOnce(new Error('unavailable'));
    expect(await service.discover(job)).toMatchObject([
      { status: ConnectorStatus.DEGRADED, created: 1 },
    ]);
    const checkpoint = db.rows(SourceCheckpointEntity)[0]!.lastSuccessAt;
    expect(db.rows(ConnectorHealthEntity)[0]?.metadataJson).toMatchObject({ skippedItemCount: 1 });
    expect(await service.discover(job)).toMatchObject([
      { status: ConnectorStatus.DEGRADED, created: 0 },
    ]);
    expect(db.rows(IngestionRunEntity).at(-1)?.status).toBe(ProcessingStatus.FAILED);
    expect(db.rows(SourceCheckpointEntity)[0]?.lastSuccessAt).toBe(checkpoint);
    expect(db.rows(ConnectorHealthEntity)[0]?.metadataJson).toMatchObject({ failedFeedCount: 1 });
  });

  it('uses stored discovery health without additional requests or overwriting ingestion timestamps', async () => {
    const db = memoryDatabase();
    const now = new Date('2026-09-04T00:00:00Z');
    db.rows(ConnectorHealthEntity).push({
      id: 'rss-health',
      connector: 'news_rss',
      metadataJson: { healthSource: 'NEWS_RSS_INGESTION' },
      status: ConnectorStatus.DEGRADED,
      message: 'feed failed',
      checkedAt: now,
      lastSuccessAt: null,
      lastFailureAt: now,
    });
    const fetch = jest.spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed');
    const classifier = {
      probeHealth: jest
        .fn()
        .mockResolvedValue({ status: ConnectorStatus.UNCONFIGURED, checkedAt: now }),
    };
    const service = new ConnectorHealthService(
      db.dataSource,
      config,
      jest.fn(),
      classifier as unknown as CompatibleClassifierClient,
    );
    const checks = await service.checkAll();
    expect(checks.find((check) => check.connector === 'NEWS_RSS')).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      message: 'feed failed',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      db.rows(ConnectorHealthEntity).find((row) => row.connector === 'news_rss')?.checkedAt,
    ).toBe(now);
    expect(db.repository(ConnectorHealthEntity).save).not.toHaveBeenCalledWith(
      expect.objectContaining({ connector: 'news_rss' }),
    );
  });

  it('degrades IR health and excludes registered rows outside the exact RSS/private contract', async () => {
    const db = memoryDatabase();
    const samsungUrl = NEWS_IR_SOURCE_PROFILES['samsung-global'].url;
    db.rows(IrSourceEntity).push(
      {
        id: 'wrong-rights',
        companyId: 'company-1',
        sourceType: 'RSS',
        url: samsungUrl,
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        isActive: true,
      },
      {
        id: 'wrong-type',
        companyId: 'company-1',
        sourceType: 'ATOM',
        url: samsungUrl,
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        isActive: true,
      },
    );
    const now = new Date('2026-09-04T00:00:00Z');
    const classifier = {
      probeHealth: jest
        .fn()
        .mockResolvedValue({ status: ConnectorStatus.UNCONFIGURED, checkedAt: now }),
    };
    const service = new ConnectorHealthService(
      db.dataSource,
      loadWorkerConfig({ GDELT_ENABLED: 'false' }),
      jest.fn(),
      classifier as unknown as CompatibleClassifierClient,
    );

    const checks = await service.checkAll();

    expect(checks.find((check) => check.connector === 'IR')).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      message:
        '2 active IR source(s) violate the exact Samsung RSS and PRIVATE_DISPLAY_ONLY contract.',
      metadata: { invalidRegisteredSources: 2 },
    });
  });

  it('keeps incompatible registered IR rows inert during discovery', async () => {
    const db = memoryDatabase();
    const row = {
      id: 'wrong-rights',
      companyId: 'company-1',
      sourceType: 'RSS',
      url: NEWS_IR_SOURCE_PROFILES['samsung-global'].url,
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      isActive: true,
      lastCheckedAt: null,
    };
    db.rows(IrSourceEntity).push(row);
    db.repository(IrSourceEntity).update.mockImplementation(
      async (_criteria: unknown, values: Record<string, unknown>) => {
        Object.assign(row, values);
        return { affected: 1 };
      },
    );
    const fetch = jest.fn();
    const service = new NewsDiscoveryService(
      db.dataSource,
      loadWorkerConfig({ GDELT_ENABLED: 'false' }),
      fetch,
      { enqueueNews: jest.fn() } as unknown as PushFanoutService,
    );

    await expect(
      service.discover(discoverLinksJobSchema.parse({ connectors: ['IR'], reason: 'SCHEDULED' })),
    ).resolves.toMatchObject([{ connector: 'IR', status: ConnectorStatus.UNCONFIGURED }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(row.lastCheckedAt).toBeInstanceOf(Date);
  });

  it.each(['legacy', 'hash'] as const)(
    'moves only approved %s schedule identities into the market-news queue',
    async (identity) => {
      const queue = (): Queue =>
        ({
          add: jest.fn().mockResolvedValue({}),
          getRepeatableJobs: jest.fn().mockResolvedValue([]),
          removeRepeatableByKey: jest.fn().mockResolvedValue(true),
        }) as unknown as Queue;
      const health = queue();
      const marketNews = queue();
      const common = {
        name: 'discover-news-links',
        pattern: '*/30 * * * *',
        tz: 'Asia/Seoul',
        endDate: null,
        next: 1788534000000,
      };
      const rssKey = identity === 'hash' ? 'eb93a621822e68d985e804f19c7fde3c' : 'rss-repeat';
      const irKey = identity === 'hash' ? '6e1f4988d68307b5eadf0ee641d81b71' : 'ir-repeat';
      jest.mocked(health.getRepeatableJobs).mockResolvedValue([
        {
          ...common,
          key: rssKey,
          ...(identity === 'legacy' ? { id: 'publisher-news-rss-thirty-minutes' } : {}),
        },
        {
          ...common,
          key: irKey,
          ...(identity === 'legacy' ? { id: 'registered-ir-thirty-minutes' } : {}),
        },
        { ...common, key: 'unmanaged', id: 'someone-elses-news-schedule' },
      ] as Awaited<ReturnType<Queue['getRepeatableJobs']>>);
      await new WorkerSchedulerService(
        queue(),
        queue(),
        health,
        queue(),
        config,
        queue(),
        marketNews,
      ).onModuleInit();
      expect(health.removeRepeatableByKey).toHaveBeenCalledWith(rssKey);
      expect(health.removeRepeatableByKey).toHaveBeenCalledWith(irKey);
      expect(health.removeRepeatableByKey).not.toHaveBeenCalledWith('unmanaged');
      expect(marketNews.add).toHaveBeenCalledWith(
        'discover-news-links',
        job,
        expect.objectContaining({
          jobId: 'publisher-news-rss-fifteen-minutes',
          repeat: { pattern: '*/15 * * * *', tz: 'Asia/Seoul' },
        }),
      );
      expect(health.add).not.toHaveBeenCalledWith(
        'discover-news-links',
        expect.objectContaining({ connectors: ['NAVER'] }),
        expect.anything(),
      );
      expect(marketNews.add).not.toHaveBeenCalledWith(
        'discover-news-links',
        expect.objectContaining({ connectors: ['GDELT'] }),
        expect.anything(),
      );
    },
  );
});
