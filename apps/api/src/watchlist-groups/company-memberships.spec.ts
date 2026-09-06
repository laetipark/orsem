import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import type { EntityManager } from 'typeorm';
import type { Request } from 'express';
import {
  companyWatchlistMembershipsSchema,
  saveCompanyWatchlistMembershipsSchema,
} from '@orsem/contracts';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import {
  WatchlistAccessService,
  type GroupActor,
  type GroupRow,
  type RoomRow,
} from './watchlist-access.service';
import { WatchlistGroupsService } from './watchlist-groups.service';
import { WatchlistGroupsController } from './watchlist-groups.controller';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: GroupActor = { kind: 'MEMBER', id: id(1), key: `MEMBER:${id(1)}` };
const other: GroupActor = { kind: 'ADMIN', id: id(2), key: `ADMIN:${id(2)}` };
const companyId = id(3);
const personalId = id(10);
const roomGroupId = id(11);
const privateId = id(12);
const roomId = id(20);
type Member = { role: string; can_manage_groups: number; can_manage_stocks: number };
interface State {
  groups: GroupRow[];
  items: Array<{ group_id: string; company_id: string; position: number }>;
  rooms: Array<RoomRow & { members: Record<string, Member> }>;
  logs: Array<{ groupId: string; details: { before: string[]; after: string[] } }>;
  personalRevision: number;
}
function setup() {
  let state: State = {
    groups: [
      { id: personalId, owner_key: actor.key, room_id: null, name: '내 그룹' },
      { id: roomGroupId, owner_key: other.key, room_id: roomId, name: '함께 보는 종목' },
      { id: privateId, owner_key: other.key, room_id: null, name: '다른 사람의 비공개 그룹' },
    ].map((group) => ({
      ...group,
      revision: 3,
      position: 0,
      updated_at: '2026-09-06T00:00:00.000Z',
      itemCount: 0,
    })),
    items: [],
    rooms: [
      {
        id: roomId,
        owner_key: other.key,
        name: '시장 관찰방',
        description: '',
        ownerLabel: '소유자',
        revision: 9,
        memberCount: 2,
        memberRole: 'MEMBER',
        can_manage_groups: 0,
        can_manage_stocks: 1,
        members: {
          [actor.key]: { role: 'MEMBER', can_manage_groups: 0, can_manage_stocks: 1 },
          [other.key]: { role: 'ADMIN', can_manage_groups: 1, can_manage_stocks: 1 },
        },
      },
    ],
    logs: [],
    personalRevision: 0,
  };
  const active = new Set([actor.key, other.key]);
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  let failAuditGroup: string | null = null;
  let transactions = 0;
  const query = async (sql: string, args: unknown[] = []): Promise<unknown[]> => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id FROM members') || sql.startsWith('SELECT id FROM admins')) {
      const kind = sql.includes('FROM members') ? 'MEMBER' : 'ADMIN';
      return active.has(`${kind}:${args[0]}`) ? [{ id: args[0] }] : [];
    }
    if (sql === 'SELECT id FROM companies WHERE id=?')
      return args[0] === companyId ? [{ id: companyId }] : [];
    if (sql.startsWith('SELECT g.*,r.name roomName')) {
      assert.match(sql, /g\.room_id IS NULL AND g\.owner_key=\?/u);
      assert.match(sql, /rm\.actor_key IS NOT NULL/u);
      assert.match(sql, /r.owner_key=CONCAT\('MEMBER:',m.id\).*m.status='APPROVED'/su);
      assert.doesNotMatch(sql, /LIMIT|quotes|candles/iu);
      const key = args[3];
      return state.groups.flatMap((group) => {
        const room = state.rooms.find((r) => r.id === group.room_id);
        const member = room?.members[String(key)];
        if (
          group.room_id ? !room || !member || !active.has(room.owner_key) : group.owner_key !== key
        )
          return [];
        return [
          {
            ...group,
            roomName: room?.name ?? null,
            itemCount: String(state.items.filter((i) => i.group_id === group.id).length),
            selected: state.items.some((i) => i.group_id === group.id && i.company_id === args[0])
              ? '1'
              : '0',
            canManageStocks:
              !room ||
              room.owner_key === key ||
              member?.role === 'ADMIN' ||
              member?.can_manage_stocks
                ? '1'
                : '0',
          },
        ];
      });
    }
    if (sql.startsWith('SELECT room_id,owner_key')) {
      const row = state.groups.find((g) => g.id === args[0]);
      return row ? [{ room_id: row.room_id, owner_key: row.owner_key }] : [];
    }
    if (sql.startsWith('INSERT IGNORE INTO watchlist_personal_spaces')) return [];
    if (sql.startsWith('SELECT revision FROM watchlist_personal_spaces'))
      return [{ revision: state.personalRevision }];
    if (sql.startsWith('SELECT r.*')) {
      const room = state.rooms.find((r) => r.id === args[1]);
      const member = room?.members[String(args[0])];
      if (!room || !member || !active.has(room.owner_key)) return [];
      return [{ ...room, ...member, memberRole: member.role }];
    }
    if (sql.startsWith('SELECT g.*')) {
      const row = state.groups.find((g) => g.id === args[0]);
      return row
        ? [{ ...row, itemCount: state.items.filter((i) => i.group_id === row.id).length }]
        : [];
    }
    if (sql.startsWith('SELECT company_id,position')) {
      assert.match(sql, /FOR UPDATE$/u);
      return state.items
        .filter((i) => i.group_id === args[0])
        .sort((a, b) => a.position - b.position);
    }
    if (sql.startsWith('INSERT INTO watchlist_group_items')) {
      state.items.push({
        group_id: String(args[1]),
        company_id: String(args[2]),
        position: Number(args[3]),
      });
      return [];
    }
    if (sql.startsWith('DELETE FROM watchlist_group_items')) {
      state.items = state.items.filter((i) => i.group_id !== args[0] || i.company_id !== args[1]);
      return [];
    }
    if (sql.startsWith('UPDATE watchlist_groups')) {
      state.groups.find((g) => g.id === args[0])!.revision++;
      return [];
    }
    if (sql.startsWith('UPDATE watchlist_rooms')) {
      state.rooms.find((r) => r.id === args[0])!.revision++;
      return [];
    }
    if (sql.startsWith('UPDATE watchlist_personal_spaces')) {
      state.personalRevision++;
      return [];
    }
    if (sql.startsWith('INSERT INTO watchlist_change_logs')) {
      if (args[3] === failAuditGroup) throw new Error('Synthetic audit failure');
      state.logs.push({ groupId: String(args[3]), details: JSON.parse(String(args[5])) });
      return [];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const manager = { query } as unknown as EntityManager;
  const access = new WatchlistAccessService({
    requireDataSource: () => ({
      async transaction<T>(work: (m: EntityManager) => Promise<T>): Promise<T> {
        transactions++;
        const snapshot = structuredClone(state);
        try {
          return await work(manager);
        } catch (error) {
          state = snapshot;
          throw error;
        }
      },
    }),
  } as unknown as DatabaseRuntimeService);
  const service = new WatchlistGroupsService(access, {
    observe: () => {
      throw new Error('Membership lookup must not request observations');
    },
  } as never);
  return {
    service,
    active,
    calls,
    get state() {
      return state;
    },
    get transactions() {
      return transactions;
    },
    failAudit: (group: string) => {
      failAuditGroup = group;
    },
  };
}

test('company membership lookup includes beyond-page selections and scopes every request to its actor', async () => {
  const f = setup();
  f.state.items = Array.from({ length: 30 }, (_, i) => ({
    group_id: personalId,
    company_id: i === 29 ? companyId : id(100 + i),
    position: i,
  }));
  f.state.items.push({ group_id: roomGroupId, company_id: companyId, position: 0 });
  f.state.rooms[0]!.members[actor.key]!.can_manage_stocks = 0;
  const result = companyWatchlistMembershipsSchema.parse(
    await f.service.companyMemberships(actor, companyId),
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]!.selected, true);
  assert.equal(result.items[0]!.itemCount, 30);
  assert.equal(result.items[0]!.canManageStocks, true);
  assert.equal(result.items[1]!.roomName, '시장 관찰방');
  assert.equal(result.items[1]!.selected, true);
  assert.equal(result.items[1]!.canManageStocks, false);
  const otherResult = await f.service.companyMemberships(other, companyId);
  assert.deepEqual(otherResult.items.map((i) => i.id).sort(), [roomGroupId, privateId].sort());
  assert.ok(otherResult.items.every((i) => i.canManageStocks));
  assert.ok(!f.calls.some(({ sql }) => /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)));
});

test('revoked actor, revoked owner and removed room member cannot retain membership access', async () => {
  const f = setup();
  f.active.delete(other.key);
  assert.deepEqual(
    (await f.service.companyMemberships(actor, companyId)).items.map((i) => i.id),
    [personalId],
  );
  await assert.rejects(
    () =>
      f.service.saveCompanyMemberships(actor, companyId, {
        changes: [{ groupId: roomGroupId, revision: 3, selected: true }],
      }),
    NotFoundException,
  );
  f.active.add(other.key);
  delete f.state.rooms[0]!.members[actor.key];
  assert.equal((await f.service.companyMemberships(actor, companyId)).items.length, 1);
  await assert.rejects(
    () =>
      f.service.saveCompanyMemberships(actor, companyId, {
        changes: [{ groupId: roomGroupId, revision: 3, selected: true }],
      }),
    NotFoundException,
  );
  f.active.delete(actor.key);
  await assert.rejects(() => f.service.companyMemberships(actor, companyId), ForbiddenException);
});

test('one save adds and removes atomically while preserving every other stock and its ordering', async () => {
  const f = setup();
  f.state.items = [
    { group_id: personalId, company_id: id(100), position: 0 },
    { group_id: personalId, company_id: id(101), position: 5 },
    { group_id: roomGroupId, company_id: id(102), position: 1 },
    { group_id: roomGroupId, company_id: companyId, position: 3 },
    { group_id: roomGroupId, company_id: id(103), position: 7 },
  ];
  await f.service.saveCompanyMemberships(actor, companyId, {
    changes: [
      { groupId: roomGroupId, revision: 3, selected: false },
      { groupId: personalId, revision: 3, selected: true },
    ],
  });
  assert.equal(f.transactions, 1);
  assert.deepEqual(
    f.state.items.filter((i) => i.group_id === personalId).map((i) => [i.company_id, i.position]),
    [
      [id(100), 0],
      [id(101), 5],
      [companyId, 6],
    ],
  );
  assert.deepEqual(
    f.state.items.filter((i) => i.group_id === roomGroupId).map((i) => [i.company_id, i.position]),
    [
      [id(102), 1],
      [id(103), 7],
    ],
  );
  assert.equal(f.state.groups.find((g) => g.id === personalId)!.revision, 4);
  assert.equal(f.state.groups.find((g) => g.id === roomGroupId)!.revision, 4);
  assert.equal(f.state.logs.length, 2);
  assert.deepEqual(f.state.logs[0]!.details.after, [id(100), id(101), companyId]);
  const unchanged = structuredClone(f.state);
  await f.service.saveCompanyMemberships(actor, companyId, {
    changes: [{ groupId: personalId, revision: 4, selected: true }],
  });
  assert.deepEqual(f.state, unchanged);
});

test('conflict, read-only room, foreign private group and full group fail before membership changes', async () => {
  for (const condition of ['stale', 'read-only', 'private', 'full'] as const) {
    const f = setup();
    if (condition === 'read-only') f.state.rooms[0]!.members[actor.key]!.can_manage_stocks = 0;
    if (condition === 'full')
      f.state.items = Array.from({ length: 200 }, (_, i) => ({
        group_id: roomGroupId,
        company_id: id(100 + i),
        position: i,
      }));
    const before = structuredClone(f.state);
    await assert.rejects(
      () =>
        f.service.saveCompanyMemberships(actor, companyId, {
          changes: [
            { groupId: personalId, revision: 3, selected: true },
            {
              groupId: condition === 'private' ? privateId : roomGroupId,
              revision: condition === 'stale' ? 2 : 3,
              selected: true,
            },
          ],
        }),
      condition === 'read-only'
        ? ForbiddenException
        : condition === 'private'
          ? NotFoundException
          : ConflictException,
    );
    assert.deepEqual(f.state, before);
    assert.ok(!f.calls.some(({ sql }) => sql.startsWith('INSERT INTO watchlist_group_items')));
  }
});

test('persistence failure rolls back prior membership, revisions and audit records', async () => {
  const f = setup();
  const before = structuredClone(f.state);
  f.failAudit(roomGroupId);
  await assert.rejects(
    () =>
      f.service.saveCompanyMemberships(actor, companyId, {
        changes: [
          { groupId: personalId, revision: 3, selected: true },
          { groupId: roomGroupId, revision: 3, selected: true },
        ],
      }),
    /Synthetic audit failure/u,
  );
  assert.deepEqual(f.state, before);
  assert.ok(f.calls.some(({ sql }) => sql.startsWith('INSERT INTO watchlist_group_items')));
});

test('unknown company is rejected before group data is read or changed', async () => {
  const f = setup();
  await assert.rejects(() => f.service.companyMemberships(actor, id(999)), NotFoundException);
  await assert.rejects(
    () =>
      f.service.saveCompanyMemberships(actor, id(999), {
        changes: [{ groupId: personalId, revision: 3, selected: true }],
      }),
    NotFoundException,
  );
  assert.ok(!f.calls.some(({ sql }) => sql.includes('watchlist_groups')));
});

test('membership input is bounded, distinct and excludes caller-controlled ownership and permission', () => {
  const value = { groupId: personalId, revision: 3, selected: true };
  for (const input of [
    { changes: [] },
    { changes: [value, value] },
    { changes: Array.from({ length: 101 }, (_, i) => ({ ...value, groupId: id(100 + i) })) },
    { changes: [{ ...value, revision: -1 }] },
    { changes: [{ ...value, selected: 'true' }] },
    { changes: [{ ...value, canManageStocks: true }] },
    { changes: [value], ownerKey: actor.key },
  ])
    assert.equal(saveCompanyWatchlistMembershipsSchema.safeParse(input).success, false);
  assert.equal(saveCompanyWatchlistMembershipsSchema.safeParse({ changes: [value] }).success, true);
});

test('membership controller validates the session and input without scheduling candle work', async () => {
  assert.deepEqual(
    Reflect.getMetadata(HEADERS_METADATA, WatchlistGroupsController.prototype.companyMemberships),
    [{ name: 'Cache-Control', value: 'private, no-store' }],
  );
  let reads = 0;
  let saves = 0;
  const controller = new WatchlistGroupsController(
    {
      companyMemberships: async (a: GroupActor, company: string) => {
        assert.deepEqual(a, actor);
        assert.equal(company, companyId);
        reads++;
        return { companyId, items: [] };
      },
      saveCompanyMemberships: async (a: GroupActor, company: string) => {
        assert.deepEqual(a, actor);
        assert.equal(company, companyId);
        saves++;
      },
    } as never,
    {
      requestGroupTossCandles: () => {
        throw new Error('No quote refresh');
      },
    } as never,
  );
  const request = { session: { memberId: actor.id } } as unknown as Request;
  await controller.companyMemberships(request, companyId);
  await controller.saveCompanyMemberships(request, companyId, {
    changes: [{ groupId: personalId, revision: 3, selected: true }],
  });
  assert.throws(() =>
    controller.saveCompanyMemberships(request, companyId, { changes: [], ownerKey: other.key }),
  );
  assert.equal(reads, 1);
  assert.equal(saves, 1);
});
