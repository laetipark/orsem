import assert from 'node:assert/strict';
import test from 'node:test';
import {
  newsCompanyIdsQuerySchema,
  newsCompanyIdsSchema,
  watchlistGroupNewsQuerySchema,
  watchlistGroupFilingsQuerySchema,
  companyQuotesQuerySchema,
  companyQuotesSchema,
  watchlistGroupQuotesSchema,
} from './index';

const ids = Array.from(
  { length: 201 },
  (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
);

test('recent-company queries allow an explicit empty list and at most 20 unique UUIDs', () => {
  assert.deepEqual(newsCompanyIdsQuerySchema.parse(''), []);
  assert.deepEqual(newsCompanyIdsQuerySchema.parse(ids.slice(0, 20).join(',')), ids.slice(0, 20));
  for (const value of [
    ids.slice(0, 21).join(','),
    `${ids[0]},${ids[0]}`,
    'undefined',
    `${ids[0]},`,
  ])
    assert.equal(newsCompanyIdsQuerySchema.safeParse(value).success, false);
  assert.equal(newsCompanyIdsSchema.safeParse(ids.slice(0, 200)).success, true);
  assert.equal(newsCompanyIdsSchema.safeParse(ids).success, false);
});

test('general quote batches share the public twenty-UUID cap and reject unknown query controls', () => {
  assert.deepEqual(companyQuotesQuerySchema.parse({ ids: '' }), { ids: [] });
  assert.deepEqual(companyQuotesQuerySchema.parse({ ids: ids.slice(0, 20).join(',') }), {
    ids: ids.slice(0, 20),
  });
  for (const input of [
    {},
    { ids: ids.slice(0, 21).join(',') },
    { ids: `${ids[0]},${ids[0]}` },
    { ids: 'bad' },
    { ids: ids[0], scope: 'all' },
  ])
    assert.equal(companyQuotesQuerySchema.safeParse(input).success, false);
});

test('authorized group quote responses support 200 companies without expanding general quotes', () => {
  const response = (count: number) => ({
    asOf: '2026-09-08T00:00:00.000Z',
    items: ids.slice(0, count).map((companyId) => ({
      companyId,
      displayPrice: {
        price: null,
        currency: 'KRW',
        status: 'WAITING',
        basis: 'NONE',
        source: null,
        sessionDate: null,
        providerAt: null,
        referenceClose: null,
        referenceDate: null,
        change: null,
        changePercent: null,
      },
    })),
  });
  assert.equal(watchlistGroupQuotesSchema.safeParse(response(0)).success, true);
  assert.equal(watchlistGroupQuotesSchema.safeParse(response(200)).success, true);
  assert.equal(watchlistGroupQuotesSchema.safeParse(response(201)).success, false);
  assert.equal(companyQuotesSchema.safeParse(response(20)).success, true);
  assert.equal(companyQuotesSchema.safeParse(response(21)).success, false);
});

test('group feed inputs cannot supply their own company set or actor identity', () => {
  assert.deepEqual(watchlistGroupNewsQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(watchlistGroupNewsQuerySchema.parse({ companyId: ids[0], limit: '100' }), {
    companyId: ids[0],
    limit: 100,
  });
  for (const input of [
    { companyIds: ids },
    { ownerKey: 'MEMBER:another' },
    { roomId: ids[0] },
    { limit: 101 },
  ])
    assert.equal(watchlistGroupNewsQuerySchema.safeParse(input).success, false);
  assert.deepEqual(watchlistGroupFilingsQuerySchema.parse({}), {});
  assert.equal(watchlistGroupFilingsQuerySchema.safeParse({ companyId: 'bad' }).success, false);
  assert.equal(watchlistGroupFilingsQuerySchema.safeParse({ limit: 100 }).success, false);
});
