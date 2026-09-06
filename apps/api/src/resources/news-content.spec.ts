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

test('news list and representative selection depend only on allowed metadata', () => {
  const available = availableNewsContentSql('content', 'source');
  assert.match(available, /metadataStorageAllowed/u);
  assert.match(available, /displayAllowed/u);
  assert.doesNotMatch(available, /content\.|fullText|translation/u);
  assert.doesNotMatch(representativeNewsSql({}), /news_article_contents|duplicate_content/u);
});

test('summary validation and detail materialization agree across malformed blocks and translation metadata', () => {
  const translated = content.translationJson as Record<string, unknown>;
  const cases: NewsContentRecord[] = [
    { ...content, blocksJson: [{ type: 'PARAGRAPH', text: '   ' }] },
    { ...content, blocksJson: [{ type: 'HEADING', level: 1, text: 'Invalid heading' }] },
    { ...content, blocksJson: Array(2_001).fill({ type: 'PARAGRAPH', text: 'Too many' }) },
    { ...content, blocksJson: '{broken' },
    { ...content, translationJson: { ...translated, status: 'PROCESSING' } },
    { ...content, translationJson: { ...translated, sourceLanguage: 'ko' } },
    { ...content, translationJson: { ...translated, attempts: 0 } },
    { ...content, translationJson: { ...translated, translatedAt: 'not-an-instant' } },
    {
      ...content,
      translationJson: { ...translated, blocks: [{ type: 'QUOTE', text: '다른 구조' }] },
    },
    {
      ...content,
      translationJson: { ...translated, blocks: [{ type: 'PARAGRAPH', text: 'x'.repeat(20_001) }] },
    },
    {
      ...content,
      blocksJson: [{ type: 'HEADING', level: 2, text: 'Heading' }],
      translationJson: { ...translated, blocks: [{ type: 'HEADING', level: 3, text: '제목' }] },
    },
    {
      ...content,
      blocksJson: [{ type: 'LIST', ordered: false, items: ['One'] }],
      translationJson: {
        ...translated,
        blocks: [{ type: 'LIST', ordered: true, items: ['하나'] }],
      },
    },
    { ...content, rightsPolicyJson: { ...(content.rightsPolicyJson as object), aiAllowed: false } },
  ];
  for (const candidate of cases) {
    assert.equal(contentSummary(candidate).translated, false);
    assert.equal(publicNewsContent(candidate), null);
  }
});

test('details sanitize and detach original and translated blocks without changing stored source data', () => {
  const original = [
    { type: 'HEADING', level: 2, text: '  Heading  ', private: 'internal' },
    { type: 'LIST', ordered: false, items: [' One ', ' Two '], raw: 'internal' },
  ];
  const translated = [
    { type: 'HEADING', level: 2, text: '  제목  ', private: 'internal' },
    { type: 'LIST', ordered: false, items: [' 하나 ', ' 둘 '], raw: 'internal' },
  ];
  const candidate = {
    ...content,
    blocksJson: original,
    translationJson: {
      ...(content.translationJson as object),
      blocks: translated,
      private: 'internal',
    },
  };
  const snapshot = JSON.stringify(candidate);
  assert.equal(contentSummary(candidate).translated, true);
  const detail = publicNewsContent(candidate)!;
  assert.deepEqual(detail.original.blocks, [
    { type: 'HEADING', level: 2, text: 'Heading' },
    { type: 'LIST', ordered: false, items: ['One', 'Two'] },
  ]);
  assert.deepEqual(detail.translation!.blocks, [
    { type: 'HEADING', level: 2, text: '제목' },
    { type: 'LIST', ordered: false, items: ['하나', '둘'] },
  ]);
  assert.notEqual(detail.original.blocks, original);
  assert.notEqual(detail.translation!.blocks, translated);
  const list = detail.original.blocks[1]!;
  if (list.type === 'LIST') list.items[0] = 'Changed only in response';
  assert.equal(JSON.stringify(candidate), snapshot);
  assert.equal(
    contentSummary({
      ...candidate,
      blocksJson: JSON.stringify(original),
      translationJson: JSON.stringify(candidate.translationJson),
    }).translated,
    true,
  );
});
