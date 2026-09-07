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
import type { Company } from '@orsem/contracts';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { WatchlistAccessService, type GroupRow } from './watchlist-access.service';
import { WatchlistGroupsService } from './watchlist-groups.service';
import { WatchlistGroupsController } from './watchlist-groups.controller';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reader = id(1),
  owner = id(2),
  personal = id(3),
  shared = id(4),
  foreign = id(5),
  room = id(6);
const request = { session: { memberId: reader } } as Request;
const companies: Company[] = [20, 21].map((n) => ({
  id: id(n),
  market: 'KOSPI',
  nameKo: `기업 ${n}`,
  nameEn: null,
  stockCode: String(n).padStart(6, '0'),
  ticker: null,
  corpCode: null,
  cik: null,
  isListed: true,
  updatedAt: '2026-09-07T00:00:00.000Z',
}));

function context() {
  const active = new Set([reader, owner]);
  let joined = true;
  let selected = companies;
  let inTransaction = false;
  const groups: GroupRow[] = [
    { id: personal, owner_key: `MEMBER:${reader}`, room_id: null },
    { id: shared, owner_key: `MEMBER:${owner}`, room_id: room },
    { id: foreign, owner_key: `MEMBER:${owner}`, room_id: null },
  ].map((group) => ({
    ...group,
    name: group.id,
    revision: 1,
    position: 0,
    updated_at: '2026-09-07T00:00:00.000Z',
    itemCount: selected.length,
  }));
  const manager = {
    async query(sql: string, args: unknown[] = []) {
      if (sql.startsWith('SELECT id FROM members'))
        return active.has(String(args[0])) ? [{ id: args[0] }] : [];
      if (sql.startsWith('SELECT room_id')) return groups.filter((group) => group.id === args[0]);
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
      if (sql.startsWith('SELECT g.*'))
        return groups
          .filter((group) => group.id === args[0])
          .map((group) => ({ ...group, itemCount: selected.length }));
      if (sql.startsWith('SELECT c.id')) {
        assert.match(sql, /ORDER BY i.position,i.id LIMIT 200/);
        return selected;
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as EntityManager;
  const access = new WatchlistAccessService({
    requireDataSource: () => ({
      transaction: async (work: (m: EntityManager) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await work(manager);
        } finally {
          inTransaction = false;
        }
      },
    }),
  } as unknown as DatabaseRuntimeService);
  const newsCalls: Record<string, unknown>[] = [];
  const providerCalls: Record<string, unknown>[] = [];
  const filingCalls: Company[][] = [];
  const controller = new WatchlistGroupsController(
    new WatchlistGroupsService(access, {} as never),
    {
      requestGroupTossCandles: () => {
        throw new Error('Feed must not schedule candles');
      },
    } as never,
    {
      listNews: async (query: Record<string, unknown>) => {
        assert.equal(inTransaction, false);
        newsCalls.push(query);
        return { items: [], nextCursor: null, pageInfo: { hasMore: false, nextCursor: null } };
      },
      filingsForCompanies: async (values: Company[]) => {
        assert.equal(inTransaction, false);
        filingCalls.push(values);
        return { asOf: '2026-09-07T00:00:00.000Z', companyCount: values.length, items: [] };
      },
    } as never,
    {
      feed: async (query: Record<string, unknown>, actorKey: string) => {
        assert.equal(inTransaction, false);
        assert.equal(actorKey, `MEMBER:${reader}`);
        providerCalls.push(query);
        return { groups: [], fetchedAt: null, status: 'UNCONFIGURED', nextRequestAt: null };
      },
    } as never,
  );
  return {
    controller,
    newsCalls,
    providerCalls,
    filingCalls,
    active,
    leave: () => {
      joined = false;
    },
    empty: () => {
      selected = [];
    },
  };
}

test('group news permits read-only room members, returns all filters and scopes aggregation before listing', async () => {
  const { controller, newsCalls, providerCalls } = context();
  const result = await controller.news(request, shared, {});
  assert.equal(result.group.canManageStocks, false);
  assert.equal(result.group.kind, 'ROOM');
  assert.deepEqual(
    result.companies.map((company) => company.id),
    companies.map((company) => company.id),
  );
  assert.equal(result.companyCount, 2);
  assert.deepEqual(newsCalls, [
    {
      limit: 20,
      companyIds: companies.map((company) => company.id),
      scope: 'company',
      audience: 'MEMBER_UI',
    },
  ]);
  assert.deepEqual(providerCalls, [
    { companyIds: companies.map((company) => company.id), scope: 'company' },
  ]);
  assert.equal('events' in result, false);
});

test('a company filter scopes both feeds while preserving the full group picker', async () => {
  const { controller, newsCalls, providerCalls, filingCalls } = context();
  const result = await controller.news(request, personal, {
    companyId: companies[1]!.id,
    limit: '6',
  });
  assert.equal(result.companies.length, 2);
  assert.equal(result.companyCount, 1);
  assert.equal(newsCalls[0]!.companyId, companies[1]!.id);
  assert.equal(newsCalls[0]!.companyIds, undefined);
  assert.equal(providerCalls[0]!.companyId, companies[1]!.id);
  const filings = await controller.filings(request, shared, { companyId: companies[0]!.id });
  assert.deepEqual(filingCalls, [[companies[0]]]);
  assert.equal(filings.companies.length, 2);
  assert.equal(filings.companyCount, 1);
});

test('private groups, missing groups, departed members and inactive owners never reach news providers', async () => {
  for (const operation of [
    'foreign',
    'missing',
    'departed',
    'inactive-owner',
    'inactive-reader',
    'signed-out',
  ] as const) {
    const state = context();
    if (operation === 'departed') state.leave();
    if (operation === 'inactive-owner') state.active.delete(owner);
    if (operation === 'inactive-reader') state.active.delete(reader);
    const r = operation === 'signed-out' ? ({ session: {} } as Request) : request;
    const target = operation === 'foreign' ? foreign : operation === 'missing' ? id(99) : shared;
    const ErrorClass =
      operation === 'signed-out'
        ? UnauthorizedException
        : operation === 'inactive-reader'
          ? ForbiddenException
          : NotFoundException;
    await assert.rejects(() => state.controller.news(r, target, {}), ErrorClass);
    await assert.rejects(() => state.controller.filings(r, target, {}), ErrorClass);
    assert.deepEqual(state.newsCalls, []);
    assert.deepEqual(state.providerCalls, []);
    assert.deepEqual(state.filingCalls, []);
  }
});

test('foreign company filters fail without broadening and empty groups do not request provider news', async () => {
  const state = context();
  await assert.rejects(
    () => state.controller.news(request, shared, { companyId: id(99) }),
    BadRequestException,
  );
  await assert.rejects(
    () => state.controller.filings(request, shared, { companyId: id(99) }),
    BadRequestException,
  );
  assert.equal(state.newsCalls.length, 0);
  state.empty();
  const result = await state.controller.news(request, shared, {});
  assert.equal(result.companyCount, 0);
  assert.deepEqual(state.newsCalls[0]!.companyIds, []);
  assert.deepEqual(result.providerGroups, []);
  assert.deepEqual(state.providerCalls, []);
});

test('private feed headers and cursor requests preserve existing provider pagination rules', async () => {
  const { controller, providerCalls, newsCalls } = context();
  for (const method of [
    WatchlistGroupsController.prototype.news,
    WatchlistGroupsController.prototype.filings,
  ])
    assert.deepEqual(Reflect.getMetadata(HEADERS_METADATA, method), [
      { name: 'Cache-Control', value: 'private, no-store' },
    ]);
  const cursor = Buffer.from(
    JSON.stringify({ sort: '2026-09-07T00:00:00.000Z', id: id(99) }),
  ).toString('base64url');
  await controller.news(request, shared, { cursor });
  assert.equal(newsCalls[0]!.cursor, cursor);
  assert.deepEqual(providerCalls, []);
});
