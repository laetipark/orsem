import { isNewsDisplayAllowed, NEWS_IR_SOURCE_PROFILES, NEWS_RSS_FEEDS } from '@orsem/contracts';
import {
  parseIrRssFeed,
  PublisherNewsRssConnector,
  RegisteredIrFeedConnector,
  type FeedTransport,
  type NewsRssFeedId,
} from '../src/connectors/connector-adapters';
import { htmlToNewsContentBlocks } from '../src/connectors/news-content-blocks';

const rss = (item: string) => `<rss version="2.0"><channel>${item}</channel></rss>`;

describe('news collection uses publisher metadata only', () => {
  it('cleans supplied summary markup without keeping active content', () => {
    expect(
      htmlToNewsContentBlocks(
        '<p>Summary <a href="https://example.test">link</a></p><script>secret()</script>',
      ),
    ).toEqual([{ type: 'PARAGRAPH', text: 'Summary link' }]);
  });

  it('discards Samsung embedded bodies while preserving its original timestamp and description', () => {
    const parsed = parseIrRssFeed(
      NEWS_IR_SOURCE_PROFILES['samsung-global'].url,
      `<?xml version="1.0"?><?xml-stylesheet href="/feed.xsl"?>${rss(`<item>
        <title>Samsung announces results</title><link>https://news.samsung.com/global/example</link>
        <pubDate>Fri, 04 Sep 2026 09:15:00 +0000</pubDate>
        <description><![CDATA[<p>Supplied excerpt 12%.</p>]]></description>
        <content:encoded><![CDATA[<p>NEVER RETAIN EMBEDDED BODY.</p>]]></content:encoded>
      </item>`)}`,
    );
    expect(parsed.candidates[0]).toMatchObject({
      publishedAt: '2026-09-04T00:15:00.000Z',
      metadata: {
        originalPublishedAt: 'Fri, 04 Sep 2026 09:15:00 +0000',
        description: 'Supplied excerpt 12%.',
      },
      sourcePolicy: NEWS_IR_SOURCE_PROFILES['samsung-global'].policy,
    });
    expect(parsed.candidates[0]?.content).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('NEVER RETAIN');
  });

  it('does not invent a summary from embedded bodies or from the title', () => {
    const parsed = parseIrRssFeed(
      NEWS_IR_SOURCE_PROFILES['samsung-global'].url,
      rss(`<item>
      <title>Samsung official results</title><link>https://news.samsung.com/global/example</link>
      <content:encoded><![CDATA[<p>Full article only.</p>]]></content:encoded></item>`),
    );
    expect(parsed.candidates[0]?.metadata.description).toBeNull();
    expect(parsed.candidates[0]?.content).toBeUndefined();
  });

  it.each(
    (Object.keys(NEWS_RSS_FEEDS) as NewsRssFeedId[]).filter((id) => {
      const feed = NEWS_RSS_FEEDS[id];
      return (!('enabled' in feed) || feed.enabled) && isNewsDisplayAllowed(feed.policy);
    }),
  )('%s fetches only the RSS feed, never the article URL', async (feedId) => {
    const feed = NEWS_RSS_FEEDS[feedId];
    const requests: string[] = [];
    const transport: FeedTransport = async (_connector, _operation, url) => {
      requests.push(url.toString());
      return {
        status: 200,
        etag: null,
        lastModified: null,
        bytes: new TextEncoder().encode(
          rss(`<item>
          <title>Official publisher release</title><link>https://example.test/do-not-fetch</link>
          <pubDate>Fri, 04 Sep 2026 09:00:00 EST</pubDate><description>Publisher supplied summary.</description>
          <content:encoded><![CDATA[<p>Ignored body.</p>]]></content:encoded></item>`),
        ),
      };
    };
    const articleTransport = jest.fn().mockRejectedValue(new Error('Article fetch forbidden'));
    const connector = new PublisherNewsRssConnector(
      [feedId],
      1_000,
      undefined,
      transport,
      articleTransport,
    );
    const result = await connector.fetchFeed(feedId);
    expect(requests).toEqual([feed.url]);
    expect(articleTransport).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({
      publishedAt: '2026-09-04T14:00:00.000Z',
      sourcePolicy: feed.policy,
      metadata: { description: 'Publisher supplied summary.' },
    });
    expect(result.candidates[0]?.content).toBeUndefined();
    expect(connector.discoveryFailureCount).toBe(0);
  });

  it.each(
    (Object.keys(NEWS_RSS_FEEDS) as NewsRssFeedId[]).filter((id) => {
      const feed = NEWS_RSS_FEEDS[id];
      return 'enabled' in feed && feed.enabled === false;
    }),
  )('%s makes zero HTTP requests while its registry policy is disabled', async (feedId) => {
    const transport = jest.fn();
    const connector = new PublisherNewsRssConnector([feedId], 1000, undefined, transport);
    await expect(connector.discoverLinks()).resolves.toEqual([]);
    await expect(connector.fetchFeed(feedId)).rejects.toThrow(/not enabled/u);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(Object.values(NEWS_IR_SOURCE_PROFILES).filter((profile) => !profile.enabled))(
    'rejects the disabled $publisher official IR profile before any HTTP request',
    (profile) => {
      const transport = jest.fn();
      expect(
        () => new RegisteredIrFeedConnector([profile.url], 1000, undefined, transport),
      ).toThrow(/registry/u);
      expect(() =>
        parseIrRssFeed(profile.url, rss('<item><title>Unapproved</title></item>')),
      ).toThrow();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('continues to reject DTD, ENTITY and unapproved processing instructions', () => {
    const item = rss(
      '<item><title>Samsung result</title><link>https://news.samsung.com/global/example</link></item>',
    );
    for (const prefix of [
      '<?feed-transform href="/unsafe.xsl"?>',
      '<!DOCTYPE rss SYSTEM "https://example.test/unsafe.dtd">',
      '<!ENTITY unsafe SYSTEM "file:///etc/passwd">',
    ]) {
      expect(() =>
        parseIrRssFeed(NEWS_IR_SOURCE_PROFILES['samsung-global'].url, `${prefix}${item}`),
      ).toThrow();
    }
  });
});
