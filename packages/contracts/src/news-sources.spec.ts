import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalNewsUrl,
  DEFAULT_REGISTERED_IR_POLICY,
  isNewsAiAllowed,
  isNewsDisplayAllowed,
  isNewsFullTextCollectionAllowed,
  NEWS_IR_SOURCE_PROFILE_IDS,
  NEWS_IR_SOURCE_PROFILES,
  NEWS_RSS_FEEDS,
  NEWS_RSS_FEED_IDS,
  NEWS_SOURCE_RESEARCH_CANDIDATES,
} from './news-sources';
import { newsDetailSchema } from './schemas';

test('article identity strips tracking and fragments, preserving article selectors and protocol', () => {
  assert.equal(
    canonicalNewsUrl('https://EXAMPLE.com:443/story?id=11&utm_source=feed#top'),
    'https://example.com/story?id=11',
  );
  assert.notEqual(
    canonicalNewsUrl('https://example.com/story?id=11'),
    canonicalNewsUrl('https://example.com/story?id=12'),
  );
  assert.notEqual(
    canonicalNewsUrl('https://example.com/a'),
    canonicalNewsUrl('http://example.com/a'),
  );
  assert.throws(() => canonicalNewsUrl('javascript:alert(1)'));
  assert.throws(() => canonicalNewsUrl('https://user:secret@example.com/a'));
});

test('AI requires explicit permission and NAVER cannot be opted in through metadata', () => {
  assert.equal(isNewsAiAllowed({ source: 'NAVER', sourcePolicyJson: { aiAllowed: true } }), false);
  for (const value of [
    undefined,
    null,
    {},
    { aiAllowed: 'UNKNOWN' },
    { aiAllowed: 'true' },
    { aiAllowed: false },
  ]) {
    assert.equal(isNewsAiAllowed({ source: 'IR', sourcePolicyJson: value }), false);
  }
  assert.equal(isNewsAiAllowed({ source: 'IR', sourcePolicyJson: { aiAllowed: true } }), true);
});

test('only approved official RSS feeds are executable and explicitly allow content', () => {
  assert.deepEqual(NEWS_RSS_FEED_IDS, [
    'fed-press',
    'fed-speeches',
    'bls-latest',
    'eia-today',
    'eia-press',
  ]);
  assert.deepEqual(Object.keys(NEWS_RSS_FEEDS), [...NEWS_RSS_FEED_IDS]);
  assert.equal(Object.isFrozen(NEWS_RSS_FEED_IDS), true);
  assert.equal(Object.isFrozen(NEWS_RSS_FEEDS), true);
  for (const id of NEWS_RSS_FEED_IDS) {
    const feed = NEWS_RSS_FEEDS[id];
    assert.equal(Object.isFrozen(feed), true);
    assert.equal(new URL(feed.url).protocol, 'https:');
    assert.equal(feed.policy.metadataStorageAllowed, true);
    assert.equal(feed.policy.displayAllowed, true);
    assert.equal(feed.policy.fullTextStorageAllowed, true);
    assert.equal(feed.policy.aiAllowed, true);
    assert.equal(feed.policy.notifyAllowed, false);
    assert.ok(feed.policy.policyUrl);
  }
});

test('only the exact Samsung profile promotes arbitrary IR feeds to content collection', () => {
  assert.deepEqual(NEWS_IR_SOURCE_PROFILE_IDS, ['samsung-global']);
  assert.deepEqual(Object.keys(NEWS_IR_SOURCE_PROFILES), [...NEWS_IR_SOURCE_PROFILE_IDS]);
  assert.equal(Object.isFrozen(NEWS_IR_SOURCE_PROFILE_IDS), true);
  assert.equal(Object.isFrozen(NEWS_IR_SOURCE_PROFILES), true);
  assert.equal(isNewsDisplayAllowed(DEFAULT_REGISTERED_IR_POLICY), false);
  assert.equal(isNewsFullTextCollectionAllowed(DEFAULT_REGISTERED_IR_POLICY), false);
  const samsung = NEWS_IR_SOURCE_PROFILES['samsung-global'];
  assert.equal(Object.isFrozen(samsung), true);
  assert.equal(samsung.url, 'https://news.samsung.com/global/feed');
  assert.equal(samsung.publishedAtMode, 'SOURCE_LOCAL_TIME');
  assert.equal(samsung.publishedTimeZone, 'Asia/Seoul');
  assert.equal(isNewsDisplayAllowed(samsung.policy), true);
  assert.equal(isNewsFullTextCollectionAllowed(samsung.policy), true);
  assert.equal(samsung.policy.aiAllowed, true);
  assert.equal(samsung.policy.publicRedistributionAllowed, false);
});

test('research candidates cannot enter either runtime feed allowlist', () => {
  const activeUrls = new Set<string>([
    ...NEWS_RSS_FEED_IDS.map((id) => NEWS_RSS_FEEDS[id].url),
    ...NEWS_IR_SOURCE_PROFILE_IDS.map((id) => NEWS_IR_SOURCE_PROFILES[id].url),
  ]);
  assert.equal(activeUrls.size, 6);
  for (const candidate of NEWS_SOURCE_RESEARCH_CANDIDATES) {
    assert.equal(activeUrls.has(candidate.url), false, `${candidate.publisher} became executable`);
  }
  const runtimeRegistry = JSON.stringify({ NEWS_RSS_FEEDS, NEWS_IR_SOURCE_PROFILES });
  assert.doesNotMatch(runtimeRegistry, /etoday|이투데이|microsoft\.gcs|GDELT/iu);
});

test('news detail exposes sanitized blocks and keeps content translation separate', () => {
  const parsed = newsDetailSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    articleId: '00000000-0000-4000-8000-000000000002',
    contentState: 'AVAILABLE',
    contentSourceId: '00000000-0000-4000-8000-000000000001',
    contentLanguage: 'en',
    translated: true,
    source: 'IR',
    externalId: null,
    url: 'https://news.samsung.com/global/example',
    title: 'Example title',
    sourceName: 'Samsung Global Newsroom',
    author: null,
    publishedAt: '2026-09-04T03:30:00.000Z',
    firstObservedAt: '2026-09-04T05:30:00.000Z',
    processedAt: '2026-09-04T05:30:01.000Z',
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    provenanceUrl: 'https://news.samsung.com/global/example',
    tickers: [],
    tags: ['IR'],
    content: {
      sourceItemId: '00000000-0000-4000-8000-000000000001',
      original: {
        language: 'en',
        blocks: [
          { type: 'HEADING', level: 2, text: 'Result' },
          { type: 'PARAGRAPH', text: 'Original body.' },
        ],
        fetchedAt: '2026-09-04T05:31:00.000Z',
      },
      translation: {
        language: 'ko',
        blocks: [{ type: 'PARAGRAPH', text: '번역 본문.' }],
        translatedAt: '2026-09-04T05:32:00.000Z',
        provider: 'LOCAL',
        model: 'local-model',
      },
    },
  });
  assert.equal(parsed.content?.translation?.blocks[0]?.type, 'PARAGRAPH');
  assert.equal(parsed.translated, true);
  assert.ok(parsed.content);
  assert.equal(
    newsDetailSchema.safeParse({
      ...parsed,
      content: {
        ...parsed.content,
        original: { ...parsed.content.original, blocks: [] },
      },
    }).success,
    false,
  );
});
