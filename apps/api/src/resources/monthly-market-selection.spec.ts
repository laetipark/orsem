import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompanyInformationApiService,
  nextMonthlySelectionAt,
} from './company-information.service';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';

test('monthly refresh dates use the next calendar month at midnight KST, including year rollover', () => {
  assert.equal(nextMonthlySelectionAt('2026-09'), '2026-09-30T15:00:00.000Z');
  assert.equal(nextMonthlySelectionAt('2026-12'), '2026-12-31T15:00:00.000Z');
  assert.equal(nextMonthlySelectionAt('2028-02'), '2028-02-29T15:00:00.000Z');
  for (const invalid of [null, undefined, '', '2026-13', '2026-00', '2026-9'])
    assert.equal(nextMonthlySelectionAt(invalid), null);
});

test('market selection preserves a failed region’s last complete snapshot and reports currency, source and monthly schedule', async () => {
  const listed = {
    id: '11111111-1111-4111-a111-111111111111',
    rank: 1,
    marketCap: '987654321012345',
    nameKo: '검증된 종목',
    nameEn: 'Verified company',
    market: 'NASDAQ',
    stockCode: null,
    ticker: 'TEST',
    isListed: true,
  };
  const service = new CompanyInformationApiService(
    {
      requireDataSource: () => ({
        query: async (sql: string) => {
          if (sql.includes('SELECT st.region'))
            return [
              {
                region: 'us',
                status: 'VALIDATION_PENDING',
                reason: '새 자료 검증 대기',
                snapshotId: 'snapshot',
                basisDate: '2026-08-31',
                lastSuccessAt: '2026-09-01T00:00:00.000Z',
                sourceUrl: 'https://openapi.tossinvest.com/',
                metadata: {
                  selectionMonth: '2026-09',
                  sourceName: '토스증권',
                  method: '발행주식수 × 제공자 가격',
                },
              },
            ];
          if (sql.includes('FROM market_cap_memberships')) {
            assert.match(sql, /m\.rank_no AS `rank`,/u);
            return [listed];
          }
          if (sql.includes('alpaca_assets')) return [];
          return [listed];
        },
      }),
    } as never,
    loadAppConfig({ NODE_ENV: 'test' }),
    new FixtureStoreService(),
  );
  const result = await service.selection();
  const kr = result.regions.find((region) => region.region === 'kr')!;
  const us = result.regions.find((region) => region.region === 'us')!;
  assert.equal(kr.status, 'UNCONFIGURED');
  assert.equal(kr.currency, 'KRW');
  assert.deepEqual(kr.items, []);
  assert.equal(kr.nextRefreshAt, null);
  assert.equal(us.status, 'VALIDATION_PENDING');
  assert.equal(us.currency, 'USD');
  assert.equal(us.sourceName, '토스증권');
  assert.equal(us.refreshCadence, 'MONTHLY');
  assert.equal(us.nextRefreshAt, '2026-09-30T15:00:00.000Z');
  assert.equal(us.items[0]?.marketCap, listed.marketCap);
  assert.equal(us.items[0]?.rank, 1);
  assert.equal(us.items[0]?.canonicalPath, '/companies/TEST');
  assert.equal(us.basisDate, '2026-08-31');
});
