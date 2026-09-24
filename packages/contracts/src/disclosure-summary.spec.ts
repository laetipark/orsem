import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDisclosureSummary } from './disclosure-summary';

const buy = {
  nature: 'MARKET_BUY',
  direction: 'INCREASE',
  quantity: '1000',
  methodRaw: '장내매수',
  securityTypeRaw: '보통주',
};
const parsed = {
  detailType: 'D002',
  reporterName: '홍길동',
  positionRaw: '대표이사',
  transactions: [buy],
};

test('completed summaries include company, reporter and exact grouped signed quantities', () => {
  assert.equal(
    formatDisclosureSummary(parsed, '삼성전자'),
    '[매수신호] (삼성전자) 홍길동 대표이사 +1,000주 장내매수',
  );
  assert.equal(
    formatDisclosureSummary(
      { ...parsed, transactions: [buy, { ...buy, quantity: '2000' }] },
      '삼성전자',
    ),
    '[매수신호] (삼성전자) 홍길동 대표이사 +3,000주 장내매수',
  );
  assert.match(
    formatDisclosureSummary({
      ...parsed,
      transactions: [{ ...buy, quantity: '9223372036854775807' }],
    })!,
    /\+9,223,372,036,854,775,807주/,
  );
});

test('sell, mixed trades and different securities keep their distinct facts', () => {
  const sell = {
    ...buy,
    nature: 'MARKET_SELL',
    direction: 'DECREASE',
    quantity: '-200',
    methodRaw: '장내매도',
  };
  assert.equal(
    formatDisclosureSummary({ ...parsed, transactions: [sell] }, '삼성전자'),
    '[매도신호] (삼성전자) 홍길동 대표이사 -200주 장내매도',
  );
  assert.match(
    formatDisclosureSummary({ ...parsed, transactions: [buy, sell] })!,
    /^\[매수신호\] \[매도신호\].*\+1,000주 장내매수 · -200주 장내매도$/,
  );
  assert.match(
    formatDisclosureSummary({
      ...parsed,
      transactions: [buy, { ...buy, securityTypeRaw: '우선주' }],
    })!,
    /보통주 \+1,000주 장내매수 · 우선주 \+1,000주 장내매수$/,
  );
});

test('positive quantities, gifts, conflicts, missing quantities and plans are never buy signals', () => {
  for (const row of [
    { ...buy, nature: 'GIFT', methodRaw: '수증' },
    { ...buy, nature: 'UNKNOWN', methodRaw: '기타 증가' },
    { ...buy, quantity: null },
    { ...buy, quantity: '0' },
    { ...buy, quantity: '-1', direction: 'DECREASE' },
  ]) {
    assert.match(formatDisclosureSummary({ ...parsed, transactions: [row] })!, /^\[소유변동\]/);
  }
  assert.equal(
    formatDisclosureSummary({ ...parsed, detailType: 'D005', planItems: [buy] }, '삼성전자'),
    '[주식 거래계획] (삼성전자) 홍길동 대표이사 1,000주 장내매수 예정',
  );
  assert.equal(
    formatDisclosureSummary(
      { detailType: 'D001', reporterName: '홍길동', reportReasonRaw: '담보계약 변경' },
      '삼성전자',
    ),
    '[대량보유 공시] (삼성전자) 홍길동 담보계약 변경',
  );
  assert.equal(formatDisclosureSummary({ detailType: 'UNKNOWN' }), null);
});
