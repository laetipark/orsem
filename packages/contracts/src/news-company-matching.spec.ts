import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNewsCompanyMatcher,
  newsBadgeCompanyAliases,
  newsCompanyAliases,
  type NewsBadgeCompanyNames,
} from './news-company-matching';

const samsung: NewsBadgeCompanyNames = {
  id: 'samsung',
  nameKo: '삼성전자',
  nameEn: 'Samsung Electronics Co., Ltd.',
  market: 'KOSPI',
  isListed: true,
  stockCode: '005930',
  ticker: null,
};
const nvidia: NewsBadgeCompanyNames = {
  id: 'nvidia',
  nameKo: '엔비디아',
  nameEn: 'NVIDIA Corporation',
  market: 'NASDAQ',
  isListed: 1,
  stockCode: null,
  ticker: 'NVDA',
};

test('automatic news badges exclude ordinary-word unlisted companies without changing legacy relevance matching', () => {
  const unlisted = ['자금', '대해', '모든', '보라', '지지'].map((name) => ({
    ...samsung,
    id: name,
    nameKo: name,
    nameEn: null,
    market: 'OTHER',
    isListed: false,
    stockCode: null,
    ticker: name,
  }));
  const summary = '모든 정책에 대해 자금 지원을 보라, 금리 인하 지지 의견';
  const match = createNewsCompanyMatcher(newsBadgeCompanyAliases([samsung, ...unlisted]));
  assert.deepEqual(match(summary), []);
  assert.deepEqual(match(`${summary}. 삼성전자의 투자 계획`), ['samsung']);
  // Persisted/manual relevance uses its existing matcher; the badge-only filter is opt-in.
  assert.deepEqual(
    createNewsCompanyMatcher(newsCompanyAliases(unlisted))(summary),
    unlisted.map((company) => company.id).sort(),
  );
});

test('badges require a current listing, a supported exchange, and a valid security symbol', () => {
  const rejected = [
    { ...samsung, isListed: false },
    { ...samsung, isListed: undefined },
    { ...samsung, isListed: 'true' },
    { ...samsung, market: 'OTHER' },
    { ...samsung, stockCode: null },
    { ...samsung, stockCode: '자금' },
    { ...nvidia, ticker: null },
    { ...nvidia, ticker: 'OTHER 회사' },
    { ...nvidia, market: 'OTC' },
  ];
  for (const company of rejected) assert.deepEqual(newsBadgeCompanyAliases([company]), []);
  const match = createNewsCompanyMatcher(
    newsBadgeCompanyAliases([samsung, { ...nvidia, isListed: '1' }]),
  );
  assert.deepEqual(match('삼성전자와 NVIDIA Corporation 실적 발표'), ['nvidia', 'samsung']);
  assert.deepEqual(match('($NVDA) and (005930) earnings'), ['nvidia', 'samsung']);
  assert.deepEqual(match('삼성전자서비스와 NVDA 관련 시장 분석'), []);
});

test('English acronyms in parentheses are not badge evidence but explicit securities remain valid', () => {
  const dynex = {
    ...nvidia,
    id: 'dynex',
    nameKo: '다이넥스캐피탈',
    nameEn: 'Dynex Capital Inc.',
    market: 'NYSE',
    ticker: 'DX',
  };
  const companies = [samsung, nvidia, dynex];
  const match = createNewsCompanyMatcher(newsBadgeCompanyAliases(companies));
  assert.deepEqual(match('삼성전자 DX 동행노조, 디바이스경험(DX) 부문 소식'), ['samsung']);
  assert.deepEqual(match('디바이스경험(DX)과 용어(NVDA)에 대한 설명'), []);
  assert.deepEqual(match('$DX 및 $NVDA 주가 비교'), ['dynex', 'nvidia']);
  assert.deepEqual(match('NYSE:DX 및 NASDAQ:NVDA 소식'), ['dynex', 'nvidia']);
  assert.deepEqual(match('Dynex Capital Inc. 실적 발표'), ['dynex']);
  assert.deepEqual(match('삼성전자(005930) 소식'), ['samsung']);
  // Ordinary SYMBOL aliases retain the worker's existing parentheses behavior.
  assert.deepEqual(createNewsCompanyMatcher(newsCompanyAliases(companies))('(DX)'), ['dynex']);
});
