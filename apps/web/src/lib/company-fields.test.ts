import { expect, it } from 'vitest';
import { companyFieldValue, financialNumber } from './company-fields';
import { companyPath } from './company-path';
import { safeLoginReturn } from './login-return';
const field = {
  key: 'industry',
  label: '업종',
  value: '002640',
  unit: null,
  basis: '',
  source: '',
  sourceUrl: '',
  observedAt: null,
};
it('formats financial amounts, dates and identifiers by their semantics', () => {
  expect(companyFieldValue(field)).toBe('002640');
  expect(companyFieldValue({ ...field, key: 'established', value: '19690113' })).toBe('1969.01.13');
  expect(companyFieldValue({ ...field, key: 'fiscalMonth', value: '12' })).toBe('12월');
  expect(financialNumber('12345.000000')).toBe('12,345');
  expect(companyFieldValue({ ...field, value: null })).toBe('—');
});
it('uses server-confirmed addresses and keeps UUIDs when identity is insufficient', () => {
  expect(companyPath({ id: 'uuid', ticker: 'MSFT', market: 'NASDAQ' })).toBe('/companies/uuid');
  expect(companyPath({ id: 'uuid', canonicalPath: '/companies/MSFT' })).toBe('/companies/MSFT');
  expect(companyPath({ id: 'uuid', canonicalPath: '//evil.com' })).toBe('/companies/uuid');
});
it('allows stock and news login returns while rejecting encoded separators and external destinations', () => {
  for (const path of [
    '/companies/005930?tab=prices',
    '/companies/NASDAQ:MSFT',
    '/companies/BRK.B',
    '/news',
  ])
    expect(safeLoginReturn(path)).toBe(path);
  for (const path of ['//evil.com', '/companies/a%2fb', '/companies/a%5cb', 'https://evil.com'])
    expect(safeLoginReturn(path)).toBeNull();
});
