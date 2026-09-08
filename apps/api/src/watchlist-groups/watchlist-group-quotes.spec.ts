import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import type { EntityManager } from 'typeorm';
import { watchlistGroupQuotesSchema, type Company } from '@orsem/contracts';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { CompanyObservationService } from './company-observation.service';
import { WatchlistAccessService, type GroupRow } from './watchlist-access.service';
import { WatchlistGroupsController } from './watchlist-groups.controller';
import { WatchlistGroupsService } from './watchlist-groups.service';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reader = id(1),
  owner = id(2),
  personal = id(3),
  shared = id(4),
  foreign = id(5),
  room = id(6);
const now = new Date('2026-09-08T01:00:00.000Z');
const request = { session: { memberId: reader } } as Request;

function context(count = 2, configured = true) {
  const active = new Set([reader, owner]);
  let joined = true;
  let inTransaction = false;
  let groupReads = 0,
    companyReads = 0,
    cacheReads = 0,
    closeReads = 0,
    queueRequests = 0;
  const companies: Company[] = Array.from({ length: count }, (_, index) => ({
    id: id(index + 100),
    market: 'KOSPI',
    nameKo: `기업 ${index + 1}`,
    nameEn: null,
    stockCode: String(index + 1).padStart(6, '0'),
    ticker: null,
    corpCode: null,
    cik: null,
    isListed: true,
    updatedAt: now.toISOString(),
  }));
  const groups: GroupRow[] = [
    { id: personal, owner_key: `MEMBER:${reader}`, room_id: null },
    { id: shared, owner_key: `MEMBER:${owner}`, room_id: room },
    { id: foreign, owner_key: `MEMBER:${owner}`, room_id: null },
  ].map((group) => ({
    ...group,
    name: group.id,
    revision: 1,
    position: 0,
    updated_at: now,
    itemCount: companies.length,
  }));
  const manager = {
    async query(sql: string, args: unknown[] = []) {
      assert.equal(inTransaction, true);
      if (sql.startsWith('SELECT id FROM members'))
        return active.has(String(args[0])) ? [{ id: args[0] }] : [];
      if (sql.startsWith('SELECT room_id')) {
        groupReads++;
        return groups.filter((group) => group.id === args[0]);
      }
      if (sql.startsWith('SELECT r.*')) {
        assert.match(sql, /JOIN watchlist_room_members/);
        assert.deepEqual(args, [`MEMBER:${reader}`, room]);
        return joined && active.has(owner)
          ? [
              {
                id: room,
                owner_key: `MEMBER:${owner}`,
                name: '읽기 전용 공유방',
                description: '',
                revision: 1,
                ownerLabel: '방장',
                memberCount: 2,
                memberRole: 'MEMBER',
                can_manage_groups: 0,
                can_manage_stocks: 0,
              },
            ]
          : [];
      }
      if (sql.startsWith('INSERT IGNORE')) return [];
      if (sql.startsWith('SELECT revision')) return [{ revision: 1 }];
      if (sql.startsWith('SELECT g.*')) return groups.filter((group) => group.id === args[0]);
      if (sql.startsWith('SELECT c.id')) {
        companyReads++;
        assert.match(sql, /WHERE i.group_id=\? ORDER BY i.position,i.id LIMIT 200$/);
        assert.equal(args.length, 1);
        assert.ok(args[0] === personal || args[0] === shared);
        return companies;
      }
      if (sql.startsWith('WITH sessions')) {
        closeReads++;
        assert.doesNotMatch(sql, /filings|event_cluster|watchlist/);
        assert.deepEqual(
          args.slice(0, -2),
          companies.map((company) => company.id),
        );
        return companies.flatMap((company) => [
          { company_id: company.id, session_date: '2026-09-07', close: '100' },
          { company_id: company.id, session_date: '2026-09-04', close: '80' },
        ]);
      }
      throw new Error(`Unexpected quote query: ${sql}`);
    },
  } as unknown as EntityManager;
  const database = {
    requireDataSource: () => ({
      manager,
      transaction: async (work: (m: EntityManager) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await work(manager);
        } finally {
          inTransaction = false;
        }
      },
    }),
  } as unknown as DatabaseRuntimeService;
  const observations = new CompanyObservationService(
    database,
    {
      readMarketQuotes: async (ids: string[]) => {
        assert.equal(inTransaction, true);
        cacheReads++;
        assert.deepEqual(
          ids,
          companies.map((company) => company.id),
        );
        return {
          available: true,
          values: companies.map((company) =>
            JSON.stringify({
              companyId: company.id,
              symbol: company.stockCode,
              source: 'TOSS_KR_INTEGRATED',
              currency: 'KRW',
              price: '130',
              providerAt: now.toISOString(),
              observedAt: now.toISOString(),
              rightsMode: 'PRIVATE_DISPLAY_ONLY',
              lossy: true,
            }),
          ),
        };
      },
    } as never,
    loadAppConfig({
      NODE_ENV: 'test',
      FIXTURE_MODE: 'false',
      ...(configured ? { TOSS_CLIENT_ID: 'synthetic', TOSS_CLIENT_SECRET: 'synthetic' } : {}),
    }),
  );
  const controller = new WatchlistGroupsController(
    new WatchlistGroupsService(new WatchlistAccessService(database), observations),
    {
      requestGroupTossCandles: () => {
        queueRequests++;
        throw new Error('Quote polling must not schedule provider work');
      },
    } as never,
    {} as never,
    {} as never,
  );
  return {
    controller,
    companies,
    active,
    counts: () => ({ groupReads, companyReads, cacheReads, closeReads, queueRequests }),
    leave: () => {
      joined = false;
    },
    remove: () =>
      groups.splice(
        groups.findIndex((group) => group.id === shared),
        1,
      ),
  };
}

test('personal and read-only room groups return all 200 prices in one batch without activity or worker work', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const target of [personal, shared]) {
    const state = context(200);
    const result = watchlistGroupQuotesSchema.parse(await state.controller.quotes(request, target));
    assert.equal(result.asOf, now.toISOString());
    assert.deepEqual(
      result.items.map((item) => item.companyId),
      state.companies.map((company) => company.id),
    );
    assert.deepEqual(state.counts(), {
      groupReads: 1,
      companyReads: 1,
      cacheReads: 1,
      closeReads: 1,
      queueRequests: 0,
    });
    assert.equal(result.items[199]!.displayPrice.source, 'TOSS_KR_INTEGRATED');
    assert.equal(result.items[199]!.displayPrice.basis, 'LIVE');
    assert.equal(result.items[199]!.displayPrice.change, 30);
    assert.deepEqual(Object.keys(result), ['asOf', 'items']);
    assert.deepEqual(Object.keys(result.items[0]!), ['companyId', 'displayPrice']);
  }
});

test('group quotes recheck membership and group existence on every poll', async () => {
  for (const revoke of ['leave', 'remove'] as const) {
    const state = context();
    await state.controller.quotes(request, shared);
    state[revoke]();
    await assert.rejects(
      () => state.controller.quotes(request, shared),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundException);
        assert.equal(
          (error.getResponse() as { code: string }).code,
          revoke === 'leave' ? 'WATCH_SCOPE_NOT_FOUND' : 'WATCH_GROUP_NOT_FOUND',
        );
        return true;
      },
    );
    assert.equal(state.counts().companyReads, 1);
    assert.equal(state.counts().cacheReads, 1);
  }
});

test('unauthorized, foreign, missing and invalid group requests cannot read company or quote data', async () => {
  for (const operation of [
    'foreign',
    'missing',
    'inactive-reader',
    'inactive-owner',
    'signed-out',
    'invalid',
  ] as const) {
    const state = context();
    if (operation === 'inactive-reader') state.active.delete(reader);
    if (operation === 'inactive-owner') state.active.delete(owner);
    const r = operation === 'signed-out' ? ({ session: {} } as Request) : request;
    const target =
      operation === 'foreign'
        ? foreign
        : operation === 'missing'
          ? id(99)
          : operation === 'invalid'
            ? 'bad'
            : shared;
    const ErrorClass =
      operation === 'signed-out'
        ? UnauthorizedException
        : operation === 'inactive-reader'
          ? ForbiddenException
          : operation === 'invalid'
            ? BadRequestException
            : NotFoundException;
    await assert.rejects(() => state.controller.quotes(r, target), ErrorClass);
    assert.equal(state.counts().companyReads, 0);
    assert.equal(state.counts().cacheReads, 0);
    assert.equal(state.counts().closeReads, 0);
    assert.equal(state.counts().queueRequests, 0);
  }
});

test('empty groups skip prices and missing credentials retain the completed domestic close', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const empty = context(0);
  assert.deepEqual(await empty.controller.quotes(request, personal), {
    asOf: now.toISOString(),
    items: [],
  });
  assert.equal(empty.counts().cacheReads, 0);
  assert.equal(empty.counts().closeReads, 0);
  const unconfigured = context(1, false);
  const result = await unconfigured.controller.quotes(request, personal);
  assert.equal(result.items[0]!.displayPrice.status, 'NOT_CONFIGURED');
  assert.equal(result.items[0]!.displayPrice.basis, 'CLOSE');
  assert.equal(result.items[0]!.displayPrice.price, '100');
  assert.equal(unconfigured.counts().cacheReads, 0);
});

test('group quote polling responses are private and permit 90 requests per minute', () => {
  const handler = WatchlistGroupsController.prototype.quotes;
  assert.deepEqual(Reflect.getMetadata(HEADERS_METADATA, handler), [
    { name: 'Cache-Control', value: 'private, no-store' },
  ]);
  assert.deepEqual(Reflect.getMetadata('orsem:rate-limit', handler), {
    limit: 90,
    windowMs: 60_000,
  });
});
