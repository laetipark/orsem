import {
  selectMarketLeaders,
  validateFscRows,
  type FscStock,
} from '../src/market-data/market-selection';
import { financialFields } from '../src/market-data/company-information';

const rows: FscStock[] = Array.from({ length: 22 }, (_, index) => ({
  basDt: '20260904',
  srtnCd: String(index).padStart(6, '0'),
  isinCd: `KR${String(index).padStart(10, '0')}`,
  itmsNm: `기업${index}`,
  mrktCtg: 'KOSPI',
  mrktTotAmt: String(1000 - index),
  clpr: String(1000 - index),
  lstgStCnt: '1',
}));
const companies = rows.map((r, i) => ({
  id: `company-${i}`,
  stockCode: r.srtnCd,
  corpCode: String(i).padStart(8, '0'),
}));
const types = rows.map((r) => ({ isinCode: r.isinCd, securityType: 'STOCK', isCommonShare: true }));
test('validates the complete date and preserves integer precision across issuer deduplication', () => {
  const large = rows.map((r) => ({
    ...r,
    mrktTotAmt: '99999999999999999999',
    clpr: '99999999999999999999',
  }));
  validateFscRows(large, '20260904', large.length);
  expect(selectMarketLeaders(large, companies, types)[0]!.marketCap).toBe('99999999999999999999');
  expect(
    selectMarketLeaders(
      rows,
      companies.map((c, i) => (i === 1 ? { ...c, corpCode: companies[0]!.corpCode } : c)),
      types,
    ),
  ).toHaveLength(20);
});
test('does not publish partial, mixed-date, duplicate or unknown-type rankings', () => {
  expect(() => validateFscRows(rows.slice(1), '20260904', 22)).toThrow();
  expect(() => validateFscRows([...rows.slice(1), rows[1]!], '20260904', 22)).toThrow();
  expect(() => validateFscRows(rows, '20260903', 22)).toThrow();
  expect(() => selectMarketLeaders(rows, companies, types.slice(1))).toThrow();
  expect(() =>
    selectMarketLeaders(
      rows,
      companies,
      types.map((r, i) => (i === 0 ? { ...r, securityType: 'NEW_TYPE' } : r)),
    ),
  ).toThrow();
});
test('excludes preferred shares and ETFs even if marked common, and accepts alphanumeric codes', () => {
  const selected = selectMarketLeaders(
    rows,
    companies,
    types.map((r, i) =>
      i === 0 ? { ...r, securityType: 'ETF' } : i === 1 ? { ...r, isCommonShare: false } : r,
    ),
  );
  expect(selected[0]!.companyId).toBe('company-2');
  validateFscRows([{ ...rows[0]!, srtnCd: '0009K0' }], '20260904', 1);
});
test('quarterly earnings use cumulative amounts and never derive EPS from total profit', () => {
  const fields = financialFields(
    {
      profile: null,
      dividends: null,
      statement: 'CFS',
      financials: {
        list: [
          {
            account_id: 'ifrs-full_Revenue',
            thstrm_amount: '100',
            thstrm_add_amount: '250',
            currency: 'KRW',
          },
        ],
      },
    },
    2026,
    '11012',
    '2026-09-06T00:00:00Z',
  );
  expect(fields.find((f) => f.key === 'revenue')).toMatchObject({
    value: '250',
    basis: '2026년 반기 · 연결 · 누적',
  });
  expect(fields.find((f) => f.key === 'eps')!.value).toBeNull();
});
