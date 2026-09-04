import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalNewsUrl,
  isNewsAiAllowed,
  NEWS_RSS_FEEDS,
  NEWS_RSS_FEED_IDS,
} from './news-sources';

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

test('every enabled RSS feed has a private reader policy, without fulltext, AI or notifications', () => {
  for (const id of NEWS_RSS_FEED_IDS) {
    const feed = NEWS_RSS_FEEDS[id];
    assert.equal(new URL(feed.url).protocol, 'https:');
    assert.equal(feed.policy.metadataStorageAllowed, true);
    assert.equal(feed.policy.displayAllowed, true);
    assert.equal(feed.policy.fullTextStorageAllowed, false);
    assert.equal(feed.policy.aiAllowed, false);
    assert.equal(feed.policy.notifyAllowed, false);
    assert.ok(feed.policy.policyUrl);
  }
});
