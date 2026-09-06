import { GdeltMetadataConnector } from './gdelt-approved-fixture';
import { ProcessingStatus, RightsMode } from '@orsem/contracts';
import { NEWS_IR_SOURCE_PROFILES } from '@orsem/contracts';
import type { DataSource } from 'typeorm';
import type { Queue } from 'bullmq';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  PublisherNewsRssConnector,
  RegisteredIrFeedConnector,
  parseIrRssFeed,
  type FeedCheckpoint,
  type FeedCheckpointStore,
  type FeedTransport,
} from '../src/connectors/connector-adapters';
import { matchNewsCompany } from '../src/connectors/news-company-matching';
import { NewsDiscoveryService } from '../src/connectors/news-discovery.service';
import { OutboxDispatcherService } from '../src/queues/outbox-dispatcher.service';
import { discoverLinksJobSchema } from '../src/queues/job-data';
import type { PushFanoutService } from '../src/push/push-fanout.service';
import type { PushDeliveryService } from '../src/push/push-delivery.service';
import type { AlertOutboxDispatcherService } from '../src/queues/alert-outbox-dispatcher.service';

const xml =
  '<rss><channel><item><title>Company results</title><link>https://www.federalreserve.gov/newsevents/pressreleases/test.htm</link><pubDate>Fri, 04 Sep 2026 09:00:00 +0900</pubDate></item></channel></rss>';
const bytes = (value: string) => new TextEncoder().encode(value);
const articleTransport: FeedTransport = async () => ({
  status: 200,
  bytes: bytes('<html><main id="article"><p>Official full article.</p></main></html>'),
  etag: null,
  lastModified: null,
});

function cache() {
  const saved = new Map<string, FeedCheckpoint>();
  const store: FeedCheckpointStore = {
    load: jest.fn(async (_connector, url) => saved.get(url) ?? null),
    save: jest.fn(async (_connector, url, value) => {
      saved.set(url, value);
    }),
    recordFailure: jest.fn(async () => undefined),
  };
  return store;
}

describe('market news collection boundaries', () => {
  it('commits validators only after persistence and reuses them across worker instances for 304', async () => {
    const store = cache();
    const transport = jest
      .fn<ReturnType<FeedTransport>, Parameters<FeedTransport>>()
      .mockResolvedValueOnce({
        status: 200,
        bytes: bytes(xml),
        etag: '"v1"',
        lastModified: 'Fri, 04 Sep 2026 00:00:00 GMT',
      })
      .mockResolvedValueOnce({
        status: 304,
        bytes: bytes('this is not XML'),
        etag: null,
        lastModified: null,
      });
    const first = new PublisherNewsRssConnector(
      ['fed-press'],
      1000,
      store,
      transport,
      articleTransport,
    );
    expect(await first.discoverLinks()).toHaveLength(1);
    expect(store.save).not.toHaveBeenCalled();
    await first.commitFeedCheckpoints();
    expect(store.save).toHaveBeenCalledTimes(1);
    const restarted = new PublisherNewsRssConnector(
      ['fed-press'],
      1000,
      store,
      transport,
      articleTransport,
    );
    expect(await restarted.discoverLinks()).toEqual([]);
    expect(transport.mock.calls[1]?.[3]).toMatchObject({
      'If-None-Match': '"v1"',
      'If-Modified-Since': 'Fri, 04 Sep 2026 00:00:00 GMT',
    });
    await restarted.commitFeedCheckpoints();
    expect(store.save).toHaveBeenLastCalledWith(
      'NEWS_RSS',
      expect.any(String),
      expect.objectContaining({ httpStatus: 304, etag: '"v1"' }),
    );
    expect(restarted.discoveryMetadata.notModifiedCount).toBe(1);
  });

  it('retains healthy feed checkpoints but never commits validators for malformed or truncated feeds', async () => {
    const store = cache();
    const invalid = xml.replace('</channel>', '<item><title>Missing link</title></item></channel>');
    const transport = jest
      .fn<ReturnType<FeedTransport>, Parameters<FeedTransport>>()
      .mockResolvedValueOnce({
        status: 200,
        bytes: bytes(xml),
        etag: '"healthy"',
        lastModified: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        bytes: bytes(invalid),
        etag: '"partial"',
        lastModified: null,
      });
    const adapter = new PublisherNewsRssConnector(
      ['fed-press', 'fed-speeches'],
      1000,
      store,
      transport,
      articleTransport,
    );
    expect(await adapter.discoverLinks()).toHaveLength(2);
    expect(adapter.discoveryFailureCount).toBe(1);
    await adapter.commitFeedCheckpoints();
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith(
      'NEWS_RSS',
      expect.stringContaining('press_all'),
      expect.objectContaining({ etag: '"healthy"' }),
    );
    expect(store.recordFailure).toHaveBeenCalledWith(
      'NEWS_RSS',
      expect.stringContaining('speeches_and_testimony'),
      expect.stringContaining('1 malformed'),
      expect.any(Date),
    );
    const many =
      '<rss><channel>' +
      Array.from(
        { length: 501 },
        (_, i) =>
          `<item><title>Result ${i}</title><link>https://example.com/news/${i}</link></item>`,
      ).join('') +
      '</channel></rss>';
    transport.mockResolvedValueOnce({
      status: 200,
      bytes: bytes(many),
      etag: '"truncated"',
      lastModified: null,
    });
    const capped = new PublisherNewsRssConnector(
      ['fed-press'],
      1000,
      store,
      transport,
      articleTransport,
    );
    expect(await capped.discoverLinks()).toHaveLength(500);
    await capped.commitFeedCheckpoints();
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(capped.discoveryWasTruncated).toBe(true);
  });

  it('parses IR entries independently and preserves date-only fields without a fabricated publication instant', async () => {
    const parsed = parseIrRssFeed(
      NEWS_IR_SOURCE_PROFILES['samsung-global'].url,
      xml
        .replace(
          'https://www.federalreserve.gov/newsevents/pressreleases/test.htm',
          'https://news.samsung.com/global/test',
        )
        .replace(
          '</item>',
          '<content:encoded><![CDATA[<p>Full newsroom article.</p>]]></content:encoded></item>',
        )
        .replace('Fri, 04 Sep 2026 09:00:00 +0900', '2026-09-04')
        .replace('</channel>', '<item><title>Bad item</title></item></channel>'),
    );
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.skippedItems).toBe(1);
    expect(parsed.candidates[0]).toMatchObject({
      publishedAt: null,
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      sourceKind: 'COMPANY_IR',
      sourcePolicy: { aiAllowed: true, notifyAllowed: false },
      metadata: { originalPublishedAt: '2026-09-04' },
    });
    const transport = jest
      .fn<ReturnType<FeedTransport>, Parameters<FeedTransport>>()
      .mockRejectedValue(new Error('failed'));
    const store = cache();
    const adapter = new RegisteredIrFeedConnector(
      [NEWS_IR_SOURCE_PROFILES['samsung-global'].url],
      1000,
      store,
      transport,
    );
    await expect(adapter.discoverLinks()).rejects.toThrow('no healthy feed items');
    expect(store.recordFailure).toHaveBeenCalledTimes(1);
    await adapter.check();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('never represents GDELT crawl time as publication and rejects unsafe domain filters', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          articles: [
            {
              title: 'Company news',
              url: 'https://example.com/1',
              seendate: '20260904T120000Z',
              domain: 'example.com',
            },
          ],
        }),
      ),
    );
    const [article] = await new GdeltMetadataConnector(true, fetcher, 1000).search('company');
    expect(article).toMatchObject({
      publishedAt: null,
      metadata: {
        originalSeenDate: '20260904T120000Z',
        observedBySourceAt: '2026-09-04T12:00:00.000Z',
      },
    });
    expect(
      loadWorkerConfig({ GDELT_NEWS_DOMAINS: 'publisher.example' }).gdeltApprovedDomains,
    ).toEqual(['publisher.example']);
    expect(() => loadWorkerConfig({ GDELT_NEWS_DOMAINS: 'http://localhost:80' })).toThrow();
    expect(() => new GdeltMetadataConnector(true, fetcher, 1000, ['localhost'])).toThrow(
      'Invalid GDELT domain filter',
    );
  });

  it('only links an unambiguous title alias and does not mistake prose for a stock ticker', () => {
    const aliases = [
      { companyId: 'one', alias: '삼성전자', aliasType: 'NAME' },
      { companyId: 'two', alias: '삼성전기', aliasType: 'NAME' },
      { companyId: 'three', alias: 'ETN', aliasType: 'TICKER' },
    ];
    expect(matchNewsCompany('삼성전자는 실적 발표', aliases)).toBe('one');
    expect(matchNewsCompany('삼성전자·삼성전기 실적 발표', aliases)).toBeNull();
    expect(matchNewsCompany('반도체 산업 전망', aliases)).toBeNull();
    expect(matchNewsCompany('ETN 시장 동향', aliases)).toBeNull();
    expect(matchNewsCompany('Eaton (ETN) results', aliases)).toBe('three');
  });

  it('finishes a pending NAVER discovery job without reading the database or making a request', async () => {
    const database = { getRepository: jest.fn() };
    const fetcher = jest.fn();
    const service = new NewsDiscoveryService(
      database as unknown as DataSource,
      loadWorkerConfig({ NAVER_CLIENT_ID: 'key', NAVER_CLIENT_SECRET: 'secret' }),
      fetcher,
      {} as PushFanoutService,
    );
    expect(
      await service.discover(
        discoverLinksJobSchema.parse({
          connectors: ['NAVER'],
          priorities: ['P1'],
          reason: 'SCHEDULED',
        }),
      ),
    ).toEqual([]);
    expect(database.getRepository).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('completes a retired NAVER outbox row without dispatching any queue work', async () => {
    const row = {
      id: 'outbox',
      kind: 'DISCOVER_NEWS_LINKS',
      payloadJson: { connectors: ['NAVER'] },
      attempts: 0,
      status: ProcessingStatus.PENDING,
    };
    const query: Record<string, jest.Mock> = {};
    for (const name of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'setLock',
      'setOnLocked',
      'take',
    ])
      query[name] = jest.fn(() => query);
    query.getMany = jest.fn(async () => [row]);
    const repository = { update: jest.fn(), save: jest.fn(), createQueryBuilder: () => query };
    const manager = { getRepository: () => repository };
    const database = {
      ...manager,
      transaction: async (callback: (value: typeof manager) => unknown) => callback(manager),
    };
    const queue = { add: jest.fn() };
    const service = new OutboxDispatcherService(
      database as unknown as DataSource,
      queue as unknown as Queue,
      queue as unknown as Queue,
      queue as unknown as Queue,
      {
        dispatch: jest.fn(async () => ({ claimed: 0, dispatched: 0 })),
      } as unknown as AlertOutboxDispatcherService,
      {
        dispatch: jest.fn(async () => ({ configured: false, claimed: 0, sent: 0 })),
      } as unknown as PushDeliveryService,
    );
    expect(await service.dispatch()).toMatchObject({ processing: { claimed: 1, dispatched: 1 } });
    expect(queue.add).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenLastCalledWith(
      { id: 'outbox', status: ProcessingStatus.PROCESSING },
      { status: ProcessingStatus.COMPLETED, lockedAt: null, lastError: null },
    );
  });
});
