import test from 'node:test';
import assert from 'node:assert/strict';
import { RightsMode } from '@orsem/contracts';
import { newsSummaryLine } from './news-summary-line';
const item = {
  title: '공식 발표 원제목',
  description: null,
  translation: null,
  source: 'NEWS_RSS',
  rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
};
test('summary uses provided metadata without changing the source or substituting a headline', () => {
  const original = { ...item, description: '실제 요약 '.repeat(30) };
  assert.equal(newsSummaryLine(original, true), original.description.trim());
  assert.equal(newsSummaryLine(item, true), '요약 미제공');
  assert.equal(newsSummaryLine({ ...original, source: 'NAVER' }, false), original.description);
  assert.equal(
    newsSummaryLine(
      { ...original, source: 'GDELT', rightsMode: RightsMode.STORE_METADATA_ONLY },
      false,
    ),
    '요약 미제공',
  );
});
