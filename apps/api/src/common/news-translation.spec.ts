import assert from 'node:assert/strict';
import test from 'node:test';
import { RightsMode } from '@orsem/contracts';
import { publicNewsDescription, publicNewsTranslation } from './news-translation';

const now = '2026-09-04T03:00:00.000Z';
const stored = {
  version: 1,
  status: 'COMPLETED',
  inputHash: 'a'.repeat(64),
  sourceLanguage: 'en',
  targetLanguage: 'ko',
  provider: 'LOCAL',
  model: 'test-local-model',
  title: '한국어로 옮긴 제목',
  description: '한국어로 옮긴 요약',
  translatedAt: now,
  attemptedAt: now,
  attempts: 1,
  nextAttemptAt: null,
  internalError: '공개하지 않는 내부 값',
};
const source = {
  source: 'IR',
  rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
  rawHash: stored.inputHash,
  translationJson: stored,
};

test('완료된 최신 원문 번역의 공개 필드만 반환하고 원본은 변경하지 않는다', () => {
  const before = structuredClone(source);
  for (const provider of ['IR', 'NAVER', 'GDELT']) {
    const result = publicNewsTranslation({ ...source, source: provider });
    assert.deepEqual(result, {
      language: 'ko',
      title: stored.title,
      description: stored.description,
      translatedAt: now,
      provider: 'LOCAL',
      model: stored.model,
    });
  }
  assert.deepEqual(source, before);
});

test('대기·실패·원문 변경·다른 출처·제한된 권리의 번역은 노출하지 않는다', () => {
  for (const status of ['PROCESSING', 'FAILED', 'SKIPPED', 'completed'])
    assert.equal(
      publicNewsTranslation({ ...source, translationJson: { ...stored, status } }),
      null,
    );
  for (const rawHash of [null, undefined, '', 'b'.repeat(64)])
    assert.equal(publicNewsTranslation({ ...source, rawHash }), null);
  for (const provider of ['SEC', 'OPENDART', 'UNKNOWN'])
    assert.equal(publicNewsTranslation({ ...source, source: provider }), null);
  for (const rightsMode of [RightsMode.LINK_ONLY, RightsMode.NO_REDISTRIBUTION])
    assert.equal(publicNewsTranslation({ ...source, rightsMode }), null);
});

test('번역 JSON 형식을 검증하고 MariaDB 문자열 응답도 같은 기준으로 처리한다', () => {
  assert.deepEqual(
    publicNewsTranslation({ ...source, translationJson: JSON.stringify(stored) }),
    publicNewsTranslation(source),
  );
  for (const translationJson of [null, '{', [], 'null', 1])
    assert.equal(publicNewsTranslation({ ...source, translationJson }), null);
  for (const patch of [
    { version: 2 },
    { inputHash: 'not-a-hash' },
    { title: null },
    { title: ' ' },
    { model: '' },
    { provider: 'EXTERNAL' },
    { sourceLanguage: 'ko' },
    { targetLanguage: 'en' },
    { description: { text: 'bad' } },
    { translatedAt: 'not-a-date' },
    { attemptedAt: 'not-a-date' },
    { attempts: 0 },
    { nextAttemptAt: 42 },
  ])
    assert.equal(
      publicNewsTranslation({ ...source, translationJson: { ...stored, ...patch } }),
      null,
    );
});

test('메타데이터 전용 뉴스는 제목만 번역하고 원문·번역 설명의 권리를 함께 지킨다', () => {
  const metadata = { ...source, rightsMode: RightsMode.STORE_METADATA_ONLY };
  assert.equal(publicNewsTranslation(metadata)?.title, stored.title);
  assert.equal(publicNewsTranslation(metadata)?.description, null);
  for (const rightsMode of Object.values(RightsMode)) {
    const allowed =
      rightsMode === RightsMode.OFFICIAL_PUBLIC_DATA ||
      rightsMode === RightsMode.PRIVATE_DISPLAY_ONLY;
    assert.equal(
      publicNewsDescription(rightsMode, 'Original summary'),
      allowed ? 'Original summary' : null,
    );
  }
  assert.equal(publicNewsDescription(RightsMode.OFFICIAL_PUBLIC_DATA, { raw: true }), null);
});
