import assert from 'node:assert/strict';
import test from 'node:test';
import { availableNewsContentSql, representativeNewsSql } from './news-query';
import { contentSummary, publicNewsContent, type NewsContentRecord } from './news-content';

const fetchedAt = new Date('2026-09-05T00:00:00.000Z');
const content: NewsContentRecord = {
  sourceItemId: '10000000-0000-4000-8000-000000000001',
  status: 'AVAILABLE',
  language: 'en',
  blocksJson: [{ type: 'PARAGRAPH', text: 'Original body' }],
  contentHash: 'a'.repeat(64),
  fetchedAt,
  rightsPolicyJson: {
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    metadataStorageAllowed: true,
    displayAllowed: true,
    fullTextStorageAllowed: true,
    aiAllowed: true,
  },
  translationJson: {
    version: 1,
    status: 'COMPLETED',
    inputHash: 'a'.repeat(64),
    provider: 'LOCAL',
    model: 'local-test',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    blocks: [{ type: 'PARAGRAPH', text: '번역 본문' }],
    attemptedAt: fetchedAt.toISOString(),
    translatedAt: fetchedAt.toISOString(),
    attempts: 1,
    nextAttemptAt: null,
  },
};

test('공개 뉴스 본문은 같은 해시의 완료 번역만 원문과 묶어 반환한다', () => {
  const detail = publicNewsContent(content);
  assert.equal(detail?.sourceItemId, content.sourceItemId);
  assert.deepEqual(detail?.original.blocks, content.blocksJson);
  assert.equal(detail?.translation?.blocks[0]?.type, 'PARAGRAPH');
  assert.deepEqual(contentSummary(content), {
    contentState: 'AVAILABLE',
    contentSourceId: content.sourceItemId,
    contentLanguage: 'en',
    translated: true,
  });
  assert.equal(
    publicNewsContent({
      ...content,
      translationJson: { ...(content.translationJson as object), inputHash: 'b'.repeat(64) },
    }),
    null,
  );
  assert.equal(
    publicNewsContent({
      ...content,
      rightsPolicyJson: { ...(content.rightsPolicyJson as object), displayAllowed: false },
    }),
    null,
  );
  assert.equal(
    publicNewsContent({
      ...content,
      translationJson: {
        ...(content.translationJson as object),
        blocks: [
          { type: 'PARAGRAPH', text: '번역 본문' },
          { type: 'PARAGRAPH', text: '추가된 문단' },
        ],
      },
    }),
    null,
  );
  assert.equal(
    contentSummary({
      ...content,
      blocksJson: [{ type: 'LIST', ordered: false, items: ['First', 'Second'] }],
      translationJson: {
        ...(content.translationJson as object),
        blocks: [{ type: 'LIST', ordered: false, items: ['첫째'] }],
      },
    }).translated,
    false,
  );
});

test('목록 SQL은 본문과 영문 제목 번역을 모두 요구하고 그룹 대표에도 같은 게이트를 쓴다', () => {
  const available = availableNewsContentSql('content', 'source');
  assert.match(available, /content\.status = 'AVAILABLE'/u);
  assert.match(available, /content\.content_hash/u);
  assert.match(available, /content\.rights_policy_json/u);
  assert.match(available, /source\.source_policy_json/u);
  assert.match(available, /fullTextStorageAllowed/u);
  assert.match(available, /aiAllowed/u);
  assert.match(available, /source\.raw_hash/u);
  assert.match(available, /source\.translation_json/u);
  assert.match(available, /JSON_LENGTH\(content\.blocks_json\)/u);
  assert.match(representativeNewsSql({}), /duplicate_content/u);
});
