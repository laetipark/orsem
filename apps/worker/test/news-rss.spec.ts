import { ConnectorStatus, ProcessingStatus, RightsMode } from '@orsem/contracts';
import {
  ConnectorHealthEntity,
  IngestionRunEntity,
  NewsItemEntity,
  NewsArticleEntity,
  SourceCheckpointEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { Queue } from 'bullmq';
import type { DataSource } from 'typeorm';
import type { CompatibleClassifierClient } from '../src/ai/compatible-classifier.client';
import { loadWorkerConfig } from '../src/config/worker-config';
import { parseNewsRssFeed, PublisherNewsRssConnector } from '../src/connectors/connector-adapters';
import { ConnectorHealthService } from '../src/connectors/connector-health.service';
import { NewsDiscoveryService } from '../src/connectors/news-discovery.service';
import type { PushFanoutService } from '../src/push/push-fanout.service';
import { discoverLinksJobSchema } from '../src/queues/job-data';
import { WorkerSchedulerService } from '../src/scheduling/worker-scheduler.service';

const config = loadWorkerConfig({ NEWS_RSS_FEEDS: 'etoday-market', GDELT_ENABLED: 'false' });
const job = discoverLinksJobSchema.parse({ connectors: ['NEWS_RSS'], reason: 'SCHEDULED' });
const rss = (items: string) => `<rss version="2.0"><channel>${items}</channel></rss>`;
const article = (title = '시장 &amp; 기업') => `<item><title>${title}</title>
  <link>https://www.etoday.co.kr/news/view/123?x=1&amp;y=2</link><guid>source-guid</guid>
  <pubDate>Fri, 04 Sep 2026 09:15:00 +0900</pubDate>
  <description>Do not store this summary.</description><content>Do not store this body.</content></item>`;

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
    expect(
      loadWorkerConfig({ NEWS_RSS_FEEDS: ' etoday-market,etoday-market ' }).newsRssFeeds,
    ).toEqual(['etoday-market']);
    expect(() => loadWorkerConfig({ NEWS_RSS_FEEDS: 'https://127.0.0.1/rss' })).toThrow();
    expect(() => loadWorkerConfig({ NEWS_RSS_FEEDS: 'unreviewed-publisher' })).toThrow();
    const adapter = new PublisherNewsRssConnector([], 1000);
    const fetch = jest.spyOn(adapter, 'fetchFeed');
    expect(await adapter.check()).toMatchObject({ status: ConnectorStatus.UNCONFIGURED });
    expect(await adapter.discoverLinks()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps source metadata, UTC publication and rights without summaries or bodies', () => {
    const { candidates } = parseNewsRssFeed('etoday-market', rss(article()));
    expect(candidates[0]).toMatchObject({
      connector: 'NEWS_RSS',
      title: '시장 & 기업',
      publishedAt: '2026-09-04T00:15:00.000Z',
      url: 'https://www.etoday.co.kr/news/view/123?x=1&y=2',
      sourceName: '이투데이',
      rightsMode: RightsMode.STORE_METADATA_ONLY,
      metadata: {
        originalTitle: '시장 &amp; 기업',
        originalGuid: 'source-guid',
        originalPublishedAt: 'Fri, 04 Sep 2026 09:15:00 +0900',
        marketRegion: 'kr',
        rightsContext: 'NONCOMMERCIAL_RSS_READER',
        rightsPolicyUrl: 'https://www.etoday.co.kr/rss/',
      },
    });
    expect(JSON.stringify(candidates)).not.toMatch(/Do not store|description|content/u);
    expect(candidates[0]?.externalId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses URL identity across title/GUID changes and duplicate feed entries', () => {
    const first = parseNewsRssFeed('etoday-market', rss(article())).candidates[0]!;
    const revised = article('수정한 제목').replace('source-guid', 'different-guid');
    const parsed = parseNewsRssFeed('etoday-market', rss(revised + article()));
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.externalId).toBe(first.externalId);
    expect(parsed.candidates[0]?.title).toBe('수정한 제목');
  });

  it('supports Atom links while preserving dates without inventing an instant', () => {
    const parsed = parseNewsRssFeed(
      'etoday-market',
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
      'etoday-market',
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
        'etoday-market',
        '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
      ),
    ).toThrow();
    expect(() => parseNewsRssFeed('etoday-market', '<html>unavailable</html>')).toThrow();
    expect(() => parseNewsRssFeed('etoday-market', '<rss><channel></rss>')).toThrow(
      /malformed XML/u,
    );
    expect(() => parseNewsRssFeed('etoday-market', ' '.repeat(5 * 1024 * 1024 + 1))).toThrow(
      /size limit/u,
    );
  });

  it('fetches once per feed, never probes on health checks and reports complete failures', async () => {
    const adapter = new PublisherNewsRssConnector(['etoday-market', 'etoday-market'], 1000);
    const fetch = jest.spyOn(adapter, 'fetchFeed').mockRejectedValue(new Error('unavailable'));
    await adapter.check();
    expect(fetch).not.toHaveBeenCalled();
    await expect(adapter.discoverLinks()).rejects.toThrow('1 feed(s) failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(adapter.discoveryMetadata).toMatchObject({ failedFeedCount: 1 });
  });

  it('does not report a feed containing only malformed items as successful empty data', async () => {
    const adapter = new PublisherNewsRssConnector(['etoday-market'], 1000);
    jest
      .spyOn(adapter, 'fetchFeed')
      .mockResolvedValue(
        parseNewsRssFeed('etoday-market', rss('<item><title>missing link</title></item>')),
      );
    await expect(adapter.discoverLinks()).rejects.toThrow('1 malformed item(s) skipped');
  });
});

describe('publisher RSS ingestion', () => {
  it('groups one article across feeds while retaining both provenance records and all aggregate feed items', async () => {
    const db = memoryDatabase();
    const push = { enqueueNews: jest.fn() };
    const service = new NewsDiscoveryService(
      db.dataSource,
      loadWorkerConfig({ NEWS_RSS_FEEDS: 'etoday-market,etoday-finance' }),
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
        parseNewsRssFeed(id, id === 'etoday-market' ? feed(0, 301) : feed(300, 601)),
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
      .mockResolvedValueOnce(parseNewsRssFeed('etoday-market', rss(article())))
      .mockResolvedValueOnce(parseNewsRssFeed('etoday-market', rss(article('제목 수정'))));
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
      rightsMode: RightsMode.STORE_METADATA_ONLY,
      rawObjectUri: null,
      provenanceUrl: 'https://www.etoday.co.kr/news/view/123?x=1&y=2',
    });
    expect(db.rows(NewsItemEntity)[0]?.description).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(push.enqueueNews).not.toHaveBeenCalled();
  });

  it('records malformed-item partial success and all-feed failure without a false success checkpoint', async () => {
    const db = memoryDatabase();
    const service = new NewsDiscoveryService(db.dataSource, config, jest.fn(), {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    jest
      .spyOn(PublisherNewsRssConnector.prototype, 'fetchFeed')
      .mockResolvedValueOnce(
        parseNewsRssFeed('etoday-market', rss(article() + '<item><title>invalid</title></item>')),
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
