import assert from 'node:assert/strict';
import test from 'node:test';
import { disclosureTypeLabels, displayDisclosureText } from './disclosure-labels';

test('labels every disclosure domain without altering identifiers or source input', () => {
  const source = '[D002] D001·D003/D004/D005 D002공시 D00100 XD002 D005_raw D099';
  assert.equal(
    displayDisclosureText(source),
    '[임원·주요주주 보유] 대량보유 공시·의결권 위임 권유/공개매수/주식 거래계획 임원·주요주주 보유공시 D00100 XD002 D005_raw D099',
  );
  assert.equal(source, '[D002] D001·D003/D004/D005 D002공시 D00100 XD002 D005_raw D099');
  assert.equal(Object.keys(disclosureTypeLabels).length, 5);
});
