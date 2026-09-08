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

function fundamentalsService(options: {
  market?: string;
  eps?: string | null;
  epsBasis?: string;
  bps?: string | null;
  unit?: string;
  price?: string;
  currency?: string;
  common?: boolean;
  missingStockMetadata?: boolean;
}) {
  let requested = false;
  const insert = {
    insert() {
      return this;
    },
    values(value: unknown) {
      requested = Boolean(value);
      return this;
    },
    orIgnore() {
      return this;
    },
    async execute() {},
  };
  const field = (key: string, value: string | null | undefined, basis: string) => ({
    key,
    label: key.toUpperCase(),
    value: value ?? null,
    unit: options.unit ?? 'KRW',
    basis,
    source: '공식 공시',
    sourceUrl: 'https://opendart.fss.or.kr/',
    observedAt: '2026-09-07T00:00:00Z',
  });
  const db = {
    getRepository: () => ({ createQueryBuilder: () => insert }),
    query: async (sql: string) => {
      if (sql.startsWith('SELECT id,corp_code'))
        return [
          {
            id: rows[0]!.id,
            corpCode: options.market ? null : '00126380',
            cik: null,
            market: options.market ?? 'KOSPI',
          },
        ];
      if (sql.includes('FROM company_information_snapshots'))
        return [
          {
            fields: [
              field('eps', options.eps, options.epsBasis ?? '2025년 연간 · 보통주 기본 EPS'),
              field('bps', options.bps, '2026년 반기 · 동일 기준일 보통주 자본 ÷ 유통주식수'),
            ],
          },
        ];
      if (sql.startsWith('WITH sessions'))
        return options.price
          ? [
              {
                close: options.price,
                currency: options.currency ?? 'KRW',
                sessionDate: '2026-09-04',
                observedAt: '2026-09-04T07:00:00Z',
                barAt: '2026-09-04T06:30:00Z',
              },
            ]
          : [];
      if (sql.includes("connector='TOSS'") && options.missingStockMetadata) return [];
      if (sql.includes("connector='TOSS'"))
        return [
          {
            metadata: {
              rawPayload: { securityType: 'STOCK', isCommonShare: options.common ?? true },
            },
          },
        ];
      return [];
    },
  };
  return {
    api: new CompanyInformationApiService(
      { requireDataSource: () => db } as never,
      loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
      new FixtureStoreService(),
    ),
    requested: () => requested,
  };
}

test('calculates PER and PBR from confirmed per-share values in the same currency and retains their basis', async () => {
  const { api } = fundamentalsService({ eps: '6605', bps: '10000', price: '100000' });
  const result = await api.company(rows[0]!.id);
  assert.equal(result.fields.find((f) => f.key === 'per')?.value, '15.14');
  assert.equal(result.fields.find((f) => f.key === 'pbr')?.value, '10.00');
  assert.match(result.fields.find((f) => f.key === 'pbr')!.basis, /2026년 반기/);
});

test('does not calculate valuation ratios with mismatched currencies, preferred shares, missing prices or invalid denominators', async () => {
  for (const options of [
    { eps: '10', bps: '20', unit: 'USD', price: '1000', currency: 'KRW' },
    { eps: '10', bps: '20', price: '1000', common: false },
    { eps: '10', bps: '20', price: '1000', missingStockMetadata: true },
    { eps: '10', bps: '20' },
    { eps: '-10', bps: '0', price: '1000' },
    { eps: 'NaN', bps: 'Infinity', price: '1000' },
  ]) {
    const { api } = fundamentalsService(options);
    const result = await api.company(rows[0]!.id);
    assert.equal(result.fields.find((f) => f.key === 'per')?.value, null);
    assert.equal(result.fields.find((f) => f.key === 'pbr')?.value, null);
  }
  const { api } = fundamentalsService({ eps: '10', epsBasis: '2026년 1분기', price: '1000' });
  assert.equal((await api.company(rows[0]!.id)).fields.find((f) => f.key === 'per')?.value, null);
});

test('queues a US company-information request even while issuer mapping is still pending', async () => {
  const service = fundamentalsService({
    market: 'NASDAQ',
    eps: '5',
    bps: '20',
    price: '100',
    unit: 'USD',
    currency: 'USD',
  });
  const result = await service.api.company(rows[0]!.id);
  assert.equal(service.requested(), true);
  assert.equal(result.fields.find((f) => f.key === 'per')?.value, '20.00');
  assert.equal(result.fields.find((f) => f.key === 'pbr')?.value, '5.00');
});
