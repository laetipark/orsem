import assert from 'node:assert/strict';
import test from 'node:test';
import { NEWS_EXTERNAL_API_POLICIES, NEWS_IR_SOURCE_PROFILES } from '@orsem/contracts';
import { newsAudienceAllows, newsAudienceForActor, newsAudienceSql } from './news-access';
import {
  companyRelevanceSql,
  newsFiltersSql,
  representativeNewsSql,
  NEWS_GROUP_SORT,
  NEWS_GROUP_ID,
  eventAudienceSql,
} from './news-query';

test('unreviewed provider and forged approved snapshot remain unavailable to every audience', () => {
  for (const audience of ['ADMIN_UI', 'MEMBER_UI', 'BOT', 'SHARED_ROOM'] as const) {
    const policy = NEWS_EXTERNAL_API_POLICIES.MARKETAUX;
    assert.equal(
      newsAudienceAllows({ source: 'MARKETAUX', sourcePolicyJson: policy }, audience),
      false,
    );
    assert.equal(
      newsAudienceAllows(
        {
          source: 'MARKETAUX',
          sourcePolicyJson: {
            ...policy,
            rightsStatus: 'APPROVED',
            metadataStorageAllowed: true,
            displayAllowed: true,
          },
        },
        audience,
      ),
      false,
    );
    assert.equal(
      newsAudienceAllows(
        { source: 'MARKETAUX', sourcePolicyJson: NEWS_IR_SOURCE_PROFILES['samsung-global'].policy },
        audience,
      ),
      false,
    );
  }
});

test('existing approved sources retain audience behavior and administrator status is server-derived', () => {
  assert.equal(
    newsAudienceAllows({
      source: 'IR',
      sourcePolicyJson: NEWS_IR_SOURCE_PROFILES['samsung-global'].policy,
    }),
    true,
  );
  assert.equal(newsAudienceForActor({ kind: 'MEMBER', id: 'm', key: 'MEMBER:m' }), 'MEMBER_UI');
  assert.equal(newsAudienceForActor({ kind: 'ADMIN', id: 'a', key: 'ADMIN:a' }), 'ADMIN_UI');
});

test('audience checks cover sibling relevance, personal matching and representative selection before pagination', () => {
  const relevance = companyRelevanceSql('source', true, true, 'BOT');
  assert.match(relevance, /relevance_source\.source_policy_json, '\$\.allowedAudiences'/);
  assert.match(relevance, /"BOT"/);
  const personal = newsFiltersSql('source', {
    personalActorKey: 'MEMBER:m',
    audience: 'MEMBER_UI',
  });
  assert.match(personal, /personal_source\.source_policy_json, '\$\.allowedAudiences'/);
  assert.match(
    representativeNewsSql({ audience: 'SHARED_ROOM' }),
    /duplicate\.source_policy_json, '\$\.allowedAudiences'/,
  );
  assert.doesNotMatch(NEWS_GROUP_SORT, /article\./);
  assert.equal(NEWS_GROUP_ID, 'source.id');
  assert.match(eventAudienceSql('event', 'SHARED_ROOM'), /audience_news\.source_item_id/);
  assert.match(eventAudienceSql('event', 'SHARED_ROOM'), /"SHARED_ROOM"/);
  assert.match(eventAudienceSql('event'), /false\) = false/);
  assert.throws(() => newsAudienceSql('source;DROP TABLE'), /Invalid/);
});
