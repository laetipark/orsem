import { RightsMode } from '@orsem/contracts';
import { NEWS_IR_SOURCE_PROFILES } from '@orsem/contracts';
import {
  parseIrRssFeed,
  PublisherNewsRssConnector,
  RegisteredIrFeedConnector,
  type FeedTransport,
} from '../src/connectors/connector-adapters';
import {
  htmlToNewsContentBlocks,
  newsContentPlainText,
} from '../src/connectors/news-content-blocks';
import { loadWorkerConfig } from '../src/config/worker-config';

const rss = (item: string) => `<rss version="2.0"><channel>${item}</channel></rss>`;

describe('reviewed news content extraction', () => {
  it('turns HTML into bounded semantic text blocks without retaining active or attributed markup', () => {
    const blocks = htmlToNewsContentBlocks(
      `
      <main id="article"><script>steal()</script><h1 onclick="x">Title</h1>
      <p>Hello&nbsp;<a href="https://secret.invalid">world</a>.</p>
      <ol><li>First 12%</li><li>Second</li></ol><blockquote>Quoted</blockquote>
      <iframe src="https://secret.invalid">hidden</iframe></main>`,
      { roots: [{ id: 'article' }] },
    );
    expect(blocks).toEqual([
      { type: 'HEADING', level: 2, text: 'Title' },
      { type: 'PARAGRAPH', text: 'Hello world .' },
      { type: 'LIST', ordered: true, items: ['First 12%', 'Second'] },
      { type: 'QUOTE', text: 'Quoted' },
    ]);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toMatch(/script|onclick|href|iframe|secret|steal/u);
  });

  it('fails extraction instead of publishing silently truncated content', () => {
    expect(() => htmlToNewsContentBlocks(`<p>${'x'.repeat(3_501)}</p>`)).toThrow(/size limit/u);
    expect(() =>
      htmlToNewsContentBlocks(
        Array.from({ length: 601 }, (_, index) => `<p>paragraph ${index}</p>`).join(''),
      ),
    ).toThrow(/structural size limit/u);
  });

  it('uses Samsung content:encoded and interprets its +0000 wall clock as Asia/Seoul', () => {
    const parsed = parseIrRssFeed(
      NEWS_IR_SOURCE_PROFILES['samsung-global'].url,
      `<?xml version="1.0" encoding="UTF-8"?>
      <?xml-stylesheet type="text/xsl" href="/global/feed-style.xsl"?>
      ${rss(`<item><title>Samsung announces 12% growth</title>
        <link>https://news.samsung.com/global/example</link>
        <pubDate>Fri, 04 Sep 2026 09:15:00 +0000</pubDate>
        <description><![CDATA[Short excerpt]]></description>
        <content:encoded><![CDATA[<h2>Results</h2><p>Revenue increased 12%.</p>]]></content:encoded>
      </item>`)}`,
    );
    expect(parsed.candidates[0]).toMatchObject({
      connector: 'IR',
      publishedAt: '2026-09-04T00:15:00.000Z',
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      metadata: { description: 'Short excerpt' },
      content: {
        status: 'AVAILABLE',
        language: 'en',
        blocks: [
          { type: 'HEADING', level: 2, text: 'Results' },
          { type: 'PARAGRAPH', text: 'Revenue increased 12%.' },
        ],
      },
    });
    expect(JSON.stringify(parsed.candidates)).not.toContain('<p>');
    expect(JSON.stringify(parsed.candidates)).not.toContain('xml-stylesheet');
  });

  it('continues to reject non-stylesheet, oversized, DTD and ENTITY declarations', () => {
    const item = rss(`<item><title>Samsung result</title>
      <link>https://news.samsung.com/global/example</link>
      <content:encoded><![CDATA[<p>Official content.</p>]]></content:encoded></item>`);
    const feedUrl = NEWS_IR_SOURCE_PROFILES['samsung-global'].url;
    const unsafePrefixes = [
      '<?feed-transform href="/unsafe.xsl"?>',
      `<?xml-stylesheet ${'x'.repeat(4_096)}?>`,
      '<!DOCTYPE rss SYSTEM "https://example.com/unsafe.dtd">',
      '<!ENTITY unsafe SYSTEM "file:///etc/passwd">',
    ];

    for (const prefix of unsafePrefixes) {
      expect(() => parseIrRssFeed(feedUrl, `${prefix}${item}`)).toThrow();
    }
  });

  it('uses feed descriptions only as excerpts and fetches full Fed content from its exact host', async () => {
    const feed = rss(`<item><title>Federal Reserve issues statement</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/test20260904a.htm</link>
      <pubDate>Fri, 04 Sep 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[One sentence excerpt.]]></description></item>`);
    const transport: FeedTransport = async (_connector, operation) => ({
      status: 200,
      bytes: new TextEncoder().encode(
        operation === 'fed-press'
          ? feed
          : '<html><main id="article"><h1>Statement</h1><p>The rate remains at 5%.</p><script>bad()</script></main></html>',
      ),
      etag: null,
      lastModified: null,
    });
    const adapter = new PublisherNewsRssConnector(
      ['fed-press'],
      1_000,
      undefined,
      transport,
      transport,
    );
    const result = await adapter.fetchFeed('fed-press');
    expect(result.candidates[0]?.metadata.description).toBe('One sentence excerpt.');
    expect(result.candidates[0]?.content).toMatchObject({ status: 'AVAILABLE', language: 'en' });
    expect(newsContentPlainText(result.candidates[0]!.content!.blocks!)).toContain(
      'The rate remains at 5%.',
    );
  });

  it('maps only the exact BLS feed alias to the exact root content URL', async () => {
    const blsFeed = (link: string) =>
      rss(`<item><title>Major Economic Indicators Latest Numbers</title>
      <link>${link}</link>
      <pubDate>Fri, 04 Sep 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[Latest official indicator values.]]></description></item>`);
    const feedTransport: FeedTransport = async () => ({
      status: 200,
      bytes: new TextEncoder().encode(blsFeed('https://www.bls.gov/bls/')),
      etag: null,
      lastModified: null,
    });
    const requestedUrls: string[] = [];
    const articleTransport = jest.fn(async (_connector, _operation, url: URL) => {
      requestedUrls.push(url.toString());
      return {
        status: 200,
        bytes: new TextEncoder().encode(
          '<html><div id="homepage"><h1>Latest Numbers</h1><p>Payroll employment rose.</p></div></html>',
        ),
        etag: null,
        lastModified: null,
      };
    }) as unknown as jest.MockedFunction<FeedTransport>;
    const adapter = new PublisherNewsRssConnector(
      ['bls-latest'],
      1_000,
      undefined,
      feedTransport,
      articleTransport,
    );

    const result = await adapter.fetchFeed('bls-latest');

    expect(result.candidates[0]?.content).toMatchObject({ status: 'AVAILABLE', language: 'en' });
    expect(newsContentPlainText(result.candidates[0]!.content!.blocks!)).toContain(
      'Payroll employment rose.',
    );
    expect(result.candidates[0]?.url).toBe('https://www.bls.gov/bls/');
    expect(result.candidates[0]?.metadata.originalLink).toBe('https://www.bls.gov/bls/');
    expect(requestedUrls).toEqual(['https://www.bls.gov/']);

    const blockedLinks = [
      'https://www.bls.gov/bls/x',
      'https://www.bls.gov/bls/?from=rss',
      'https://www.bls.gov/bls/#latest',
      'https://www.bls.gov:443/bls/',
      'https://www.bls.gov/bls',
      'https://www.bls.gov/',
    ];
    for (const link of blockedLinks) {
      const blockedAdapter = new PublisherNewsRssConnector(
        ['bls-latest'],
        1_000,
        undefined,
        async () => ({
          status: 200,
          bytes: new TextEncoder().encode(blsFeed(link)),
          etag: null,
          lastModified: null,
        }),
        articleTransport,
      );
      const blocked = await blockedAdapter.fetchFeed('bls-latest');
      expect(blocked.candidates[0]?.content).toMatchObject({
        status: 'FAILED',
        failureCode: 'ARTICLE_URL_NOT_APPROVED',
      });
    }
    expect(articleTransport).toHaveBeenCalledTimes(1);
  });

  it('marks off-profile article URLs failed without fetching them', async () => {
    const feed = rss(`<item><title>Off host item</title>
      <link>https://example.com/newsevents/pressreleases/test.htm</link>
      <pubDate>Fri, 04 Sep 2026 10:00:00 GMT</pubDate></item>`);
    const feedTransport: FeedTransport = async () => ({
      status: 200,
      bytes: new TextEncoder().encode(feed),
      etag: null,
      lastModified: null,
    });
    const articleTransport = jest.fn() as jest.MockedFunction<FeedTransport>;
    const adapter = new PublisherNewsRssConnector(
      ['fed-press'],
      1_000,
      undefined,
      feedTransport,
      articleTransport,
    );
    const result = await adapter.fetchFeed('fed-press');
    expect(result.candidates[0]?.content).toMatchObject({
      status: 'FAILED',
      failureCode: 'ARTICLE_URL_NOT_APPROVED',
    });
    expect(adapter.discoveryFailureCount).toBe(1);
    expect(adapter.discoveryMetadata).toMatchObject({ contentFailureCount: 1 });
    expect(articleTransport).not.toHaveBeenCalled();
  });

  it('rejects Microsoft and arbitrary IR feeds during configuration', () => {
    const microsoft = 'https://microsoft.gcs-web.com/rss/news-releases.xml';
    expect(() => new RegisteredIrFeedConnector([microsoft], 1_000)).toThrow(/registry/u);
    expect(() => loadWorkerConfig({ IR_FEED_URLS: microsoft })).toThrow(/registry/u);
    expect(() =>
      loadWorkerConfig({ IR_FEED_URLS: NEWS_IR_SOURCE_PROFILES['samsung-global'].url }),
    ).not.toThrow();
    expect(loadWorkerConfig({}).gdeltEnabled).toBe(false);
  });
});
