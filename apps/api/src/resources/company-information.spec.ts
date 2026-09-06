import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyInformationApiService } from './company-information.service';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { loadAppConfig } from '../config/app-config';
const rows = [
  {
    id: '11111111-1111-4111-a111-111111111111',
    market: 'KOSPI',
    stockCode: '005930',
    ticker: null,
    isListed: true,
  },
  {
    id: '22222222-2222-4222-a222-222222222222',
    market: 'NASDAQ',
    stockCode: null,
    ticker: 'MSFT',
    isListed: true,
  },
  {
    id: '33333333-3333-4333-a333-333333333333',
    market: 'NYSE',
    stockCode: null,
    ticker: 'BRK.B',
    isListed: true,
  },
];
function service(companies = rows, reused: unknown[] = []) {
  const runtime = {
    requireDataSource: () => ({
      query: async (sql: string, params: string[]) => {
        if (sql.includes('alpaca_assets')) return reused;
        if (sql.includes('LIMIT 2'))
          return companies.filter(
            (c) =>
              (c.stockCode === params[0] || c.ticker === params[0]) &&
              (!params[2] || c.market === params[2]),
          );
        return companies;
      },
    }),
  };
  return new CompanyInformationApiService(
    runtime as never,
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
    new FixtureStoreService(),
  );
}
test('canonical codes preserve leading zeroes, dot tickers and round-trip to stable UUIDs', async () => {
  const api = service();
  const paths = await api.canonicalPaths(rows);
  assert.equal(paths.get(rows[0]!.id), '/companies/005930');
  assert.equal(paths.get(rows[1]!.id), '/companies/MSFT');
  assert.equal(paths.get(rows[2]!.id), '/companies/BRK.B');
  for (const row of rows)
    assert.equal(await api.resolveId(paths.get(row.id)!.split('/').at(-1)!), row.id);
  assert.equal(await api.resolveId(rows[0]!.id), rows[0]!.id);
  await assert.rejects(() => api.resolveId('missing'));
  await assert.rejects(() => api.resolveId('../MSFT'));
});
test('off-page duplicate symbols require an exchange; unlisted, reused and unsupported markets keep UUID', async () => {
  const duplicate = { ...rows[1]!, id: '44444444-4444-4444-a444-444444444444', market: 'NYSE' };
  const api = service([...rows, duplicate]);
  assert.equal((await api.canonicalPaths([rows[1]!])).get(rows[1]!.id), '/companies/NASDAQ:MSFT');
  await assert.rejects(() => api.resolveId('MSFT'));
  assert.equal(await api.resolveId('NASDAQ:MSFT'), rows[1]!.id);
  for (const company of [
    { ...rows[1]!, isListed: false },
    { ...rows[1]!, market: 'OTHER' },
  ])
    assert.equal(
      (await service([company]).canonicalPaths([company])).get(company.id),
      `/companies/${company.id}`,
    );
  const reused = service(rows, [{ exchange: 'NASDAQ', symbol: 'MSFT' }]);
  assert.equal((await reused.canonicalPaths(rows)).get(rows[1]!.id), `/companies/${rows[1]!.id}`);
  await assert.rejects(() => reused.resolveId('MSFT'));
});
test('fixture symbols resolve without opening a database', async () => {
  const fixtures = new FixtureStoreService();
  const api = new CompanyInformationApiService(
    {
      requireDataSource: () => {
        throw Error('must not connect');
      },
    } as never,
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    fixtures,
  );
  const c = fixtures.companies.find((c) => c.stockCode === '005930')!;
  assert.equal(await api.resolveId('005930'), c.id);
});

test('Korean ETF numeric and alphanumeric codes round-trip without borrowing issuer identities', async () => {
  const etfs = ['069500', '00AB12'].map((stockCode, index) => ({
    ...rows[0]!,
    id: `${index + 7}7777777-7777-4777-a777-777777777777`,
    market: index ? 'KRX' : 'KOSPI',
    stockCode,
    corpCode: null,
    cik: null,
    ticker: null,
  }));
  const api = service([...rows, ...etfs]);
  const paths = await api.canonicalPaths(etfs);
  for (const etf of etfs) {
    assert.equal(paths.get(etf.id), `/companies/${etf.stockCode}`);
    assert.equal(await api.resolveId(etf.stockCode.toLowerCase()), etf.id);
    assert.equal(await api.resolveId(`${etf.market}:${etf.stockCode}`), etf.id);
    assert.equal(etf.corpCode, null);
    assert.equal(etf.cik, null);
    assert.equal(etf.ticker, null);
  }
  assert.equal(await api.resolveId('005930'), rows[0]!.id);
});
