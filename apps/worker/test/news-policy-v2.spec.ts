import {
  NEWS_EXTERNAL_API_POLICIES,
  NEWS_IR_SOURCE_PROFILES,
  newsPolicyAllowsAudience,
  unreviewedNewsPolicy,
  type NewsSourcePolicy,
} from '@orsem/contracts';
import {
  assertFeedResponseHeaders,
  parseIrRssFeed,
  parseNewsRssFeed,
  type DiscoveryCandidate,
} from '../src/connectors/connector-adapters';
import {
  newsCandidateHash,
  newsCandidateMetadata,
  newsCandidateSummary,
} from '../src/connectors/news-candidate-policy';

const approved: NewsSourcePolicy = {
  ...unreviewedNewsPolicy('fixture-v1', 'https://policy.example.test'),
  rightsStatus: 'METADATA_ONLY',
  metadataStorageAllowed: true,
  displayAllowed: true,
  summaryStorageAllowed: false,
  aiAllowed: false,
};
const candidate: DiscoveryCandidate = {
  connector: 'MARKETAUX',
  externalId: 'synthetic-1',
  title: 'Example company release',
  url: 'https://publisher.example.test/news/1',
  publishedAt: '2026-09-07T00:00:00Z',
  sourceName: 'Example Publisher',
  tickers: ['TEST'],
  tags: [],
  rightsMode: approved.rightsMode,
  sourcePolicy: approved,
  metadata: { providerArticleId: 'synthetic-1', collectedAt: '2026-09-07T00:01:00Z' },
};

describe('new metadata policy persistence boundary', () => {
  it('keeps unknown/currently revoked sources closed even with an approved stored snapshot', () => {
    for (const policy of Object.values(NEWS_EXTERNAL_API_POLICIES)) {
      expect(newsPolicyAllowsAudience(policy, 'ADMIN_UI')).toBe(false);
      expect(newsPolicyAllowsAudience({ ...approved, policyId: policy.policyId }, 'ADMIN_UI')).toBe(
        false,
      );
    }
    expect(newsPolicyAllowsAudience(approved, 'ADMIN_UI', approved)).toBe(true);
    for (const audience of ['MEMBER_UI', 'SHARED_ROOM', 'BOT'] as const)
      expect(newsPolicyAllowsAudience(approved, audience, approved)).toBe(false);
  });
  it('drops forbidden body, image and unapproved summary fields at persistence', () => {
    const input = {
      ...candidate,
      summary: 'unlicensed summary',
      metadata: {
        ...candidate.metadata,
        body: 'private body',
        image: 'https://publisher.example.test/image',
        description: 'unlicensed summary',
        providerFields: { category: 'company', content: 'nested body', image: 'nested image' },
      },
    };
    const metadata = newsCandidateMetadata(input, approved);
    expect(metadata).toEqual({ ...candidate.metadata, providerFields: { category: 'company' } });
    expect(newsCandidateSummary(input, approved)).toBeNull();
  });
  it('polling does not change source identity but a permitted editorial change does', () => {
    const first = newsCandidateHash(candidate, candidate.metadata, null);
    expect(
      newsCandidateHash(
        candidate,
        {
          ...candidate.metadata,
          collectedAt: '2026-09-08T00:00:00Z',
          firstObservedAt: '2026-09-08T00:00:00Z',
        },
        null,
      ),
    ).toBe(first);
    expect(newsCandidateHash(candidate, candidate.metadata, 'Approved changed summary')).not.toBe(
      first,
    );
  });
});

describe('RSS extension boundaries', () => {
  it('cannot activate a conditional IR or Korean publisher merely by selecting its URL', () => {
    for (const id of [
      'nvidia-ir-press',
      'broadcom-ir-news',
      'palo-alto-networks-ir-news',
    ] as const) {
      expect(NEWS_IR_SOURCE_PROFILES[id].enabled).toBe(false);
      expect(() =>
        parseIrRssFeed(NEWS_IR_SOURCE_PROFILES[id].url, '<rss><channel/></rss>'),
      ).toThrow();
    }
    expect(() => parseNewsRssFeed('hankyung-finance-rss', '<rss><channel/></rss>')).toThrow();
  });
  it('requires XML media types and refuses compressed responses including gzip bombs', () => {
    for (const media of ['application/rss+xml', 'application/atom+xml; charset=utf-8', 'text/xml'])
      expect(() => assertFeedResponseHeaders(media, undefined)).not.toThrow();
    for (const media of [undefined, 'text/html', 'application/json'])
      expect(() => assertFeedResponseHeaders(media, undefined)).toThrow();
    expect(() => assertFeedResponseHeaders('application/rss+xml', 'gzip')).toThrow();
  });
  it('preserves Atom updated separately and never substitutes it for publication', () => {
    const item = parseNewsRssFeed(
      'fed-press',
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Example update</title><link href="https://www.federalreserve.gov/example"/><updated>2026-09-07T01:02:03Z</updated></entry></feed>',
    ).candidates[0]!;
    expect(item.publishedAt).toBeNull();
    expect(item.updatedAt).toBe('2026-09-07T01:02:03.000Z');
    expect(item.metadata.originalUpdatedAt).toBe('2026-09-07T01:02:03Z');
    expect(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(item.updatedAt!)),
    ).toBe('10:02');
  });
  it('isolates oversized descriptions without retaining content', () => {
    const result = parseNewsRssFeed(
      'fed-press',
      `<rss><channel><item><title>Example</title><link>https://www.federalreserve.gov/example</link><description>${'x'.repeat(64001)}</description></item></channel></rss>`,
    );
    expect(result.candidates).toEqual([]);
    expect(result.skippedItems).toBe(1);
  });
});
