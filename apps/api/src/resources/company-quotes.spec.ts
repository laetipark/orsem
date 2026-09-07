import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { companyQuotesSchema, type Company } from '@orsem/contracts';
import type { CompanyEntity } from '@orsem/database';
import type { EntityManager, FindOperator } from 'typeorm';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { AdminSessionGuard } from '../security/security';
import { CompanyObservationService } from '../watchlist-groups/company-observation.service';
import { OrsemDataService } from './orsem-data.service';
import { CompaniesController } from './resource.controllers';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-09-07T01:00:00.000Z');
const companies: Company[] = [
  { id: id(1), market: 'KOSPI' as const, stockCode: '000001', ticker: null },
  { id: id(2), market: 'NASDAQ' as const, stockCode: null, ticker: 'TEST' },
].map((company) => ({
  ...company,
  corpCode: null,
  cik: null,
  nameKo: company.id,
  nameEn: null,
  isListed: true,
  updatedAt: now.toISOString(),
}));

function context() {
  let companyReads = 0,
    cacheReads = 0,
    closeReads = 0;
  const config = loadAppConfig({
    NODE_ENV: 'test',
    FIXTURE_MODE: 'false',
    TOSS_CLIENT_ID: 'synthetic',
    TOSS_CLIENT_SECRET: 'synthetic',
  });
  const manager = {
    query: async (sql: string, args: unknown[]) => {
      closeReads++;
      assert.match(sql, /FROM price_bars/);
      assert.doesNotMatch(sql, /filings|event_cluster|watchlist/);
      return args.includes(companies[0]!.id)
        ? [
            { company_id: companies[0]!.id, session_date: '2026-09-04', close: '120' },
            { company_id: companies[0]!.id, session_date: '2026-09-03', close: '100' },
            { company_id: companies[0]!.id, session_date: '2026-09-02', close: '80' },
            { company_id: companies[1]!.id, session_date: '2026-09-04', close: '100' },
          ]
        : [];
    },
  } as unknown as EntityManager;
  const source = {
    manager,
    getRepository: () => ({
      findBy: async ({ id: requested }: { id: FindOperator<string> }) => {
        companyReads++;
        const ids = requested.value as unknown as string[];
        // Returning database order instead of input order exercises the response ordering.
        return [...companies]
          .reverse()
          .filter((company) => ids.includes(company.id))
          .map((company) => ({ ...company, updatedAt: now }) as CompanyEntity);
      },
      createQueryBuilder: () => {
        throw new Error('Do not query legacy watchlist membership');
      },
    }),
  };
  const database = {
    dataSource: source,
    requireDataSource: () => source,
  } as unknown as DatabaseRuntimeService;
  const data = new OrsemDataService(config, database, new FixtureStoreService());
  const observations = new CompanyObservationService(
    database,
    {
      readMarketQuotes: async (ids: string[]) => {
        cacheReads++;
        return {
          available: true,
          values: ids.map((companyId) =>
            JSON.stringify({
              companyId,
              symbol: companyId === companies[0]!.id ? '000001' : 'TEST',
              source: companyId === companies[0]!.id ? 'TOSS_KR' : 'TOSS_US',
              currency: companyId === companies[0]!.id ? 'KRW' : 'USD',
              price: companyId === companies[0]!.id ? '999' : '90',
              providerAt:
                companyId === companies[0]!.id ? '2026-09-03T01:00:00.000Z' : now.toISOString(),
              observedAt: now.toISOString(),
              rightsMode: 'PRIVATE_DISPLAY_ONLY',
              lossy: true,
            }),
          ),
        };
      },
    } as never,
    config,
  );
  const controller = new CompaniesController(
    data,
    {} as never,
    {} as never,
    observations,
    {} as never,
  );
  return {
    controller,
    data,
    observations,
    counts: () => ({ companyReads, cacheReads, closeReads }),
  };
}

test('general companies and mixed missing IDs return one batched quote set with a consistent display basis', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const state = context();
  const result = companyQuotesSchema.parse(
    await state.controller.quotes({ ids: [id(1), id(99), id(2)].join(',') }),
  );
  assert.deepEqual(
    result.items.map((item) => item.companyId),
    [id(1), id(2)],
  );
  assert.deepEqual(state.counts(), { companyReads: 1, cacheReads: 1, closeReads: 1 });
  assert.equal(result.asOf, now.toISOString());
  assert.deepEqual(
    { ...result.items[0]!.displayPrice },
    {
      price: '120',
      currency: 'KRW',
      status: 'STALE',
      basis: 'CLOSE',
      source: 'TOSS_KR',
      sessionDate: '2026-09-04',
      providerAt: null,
      referenceClose: 100,
      referenceDate: '2026-09-03',
      change: 20,
      changePercent: 20,
    },
  );
  assert.equal(result.items[1]!.displayPrice.basis, 'LIVE');
  assert.equal(result.items[1]!.displayPrice.price, '90');
  assert.equal(result.items[1]!.displayPrice.change, -10);
  assert.equal(result.items[1]!.displayPrice.changePercent, -10);
  assert.equal(result.items[1]!.displayPrice.referenceDate, '2026-09-04');
});

test('empty and entirely removed histories return empty prices without quote or close requests', async () => {
  const state = context();
  assert.deepEqual((await state.controller.quotes({ ids: '' })).items, []);
  assert.deepEqual(state.counts(), { companyReads: 0, cacheReads: 0, closeReads: 0 });
  assert.deepEqual((await state.controller.quotes({ ids: id(99) })).items, []);
  assert.deepEqual(state.counts(), { companyReads: 1, cacheReads: 0, closeReads: 0 });
});

test('invalid or oversized batches fail before any lookup and fixture prices require no live database', async () => {
  const state = context();
  for (const ids of [
    'invalid',
    `${id(1)},${id(1)}`,
    Array.from({ length: 21 }, (_, index) => id(index)).join(','),
  ])
    await assert.rejects(() => state.controller.quotes({ ids }), BadRequestException);
  assert.deepEqual(state.counts(), { companyReads: 0, cacheReads: 0, closeReads: 0 });
  const fixture = new CompanyObservationService(
    {} as never,
    {} as never,
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
  );
  const result = await fixture.prices(companies, now);
  assert.ok(
    result.items.every(
      (item) => item.displayPrice.price === null && item.displayPrice.status === 'NOT_CONFIGURED',
    ),
  );
});

test('the general quote route requires an approved authenticated reader and returns private no-store', async () => {
  let approved = true;
  const guard = new AdminSessionGuard(
    new Reflector(),
    {} as never,
    {
      getMember: async () => ({ role: 'VIEWER', status: approved ? 'APPROVED' : 'PENDING' }),
    } as never,
  );
  const execution = (session: Record<string, unknown>) =>
    ({
      getHandler: () => CompaniesController.prototype.quotes,
      getClass: () => CompaniesController,
      switchToHttp: () => ({ getRequest: () => ({ method: 'GET', session }) }),
    }) as unknown as ExecutionContext;
  await assert.rejects(() => guard.canActivate(execution({})), UnauthorizedException);
  const session = { memberId: id(1), sessionStartedAt: new Date().toISOString() };
  assert.equal(await guard.canActivate(execution(session)), true);
  approved = false;
  await assert.rejects(() => guard.canActivate(execution(session)), ForbiddenException);
  assert.deepEqual(Reflect.getMetadata(HEADERS_METADATA, CompaniesController.prototype.quotes), [
    { name: 'Cache-Control', value: 'private, no-store' },
  ]);
});
