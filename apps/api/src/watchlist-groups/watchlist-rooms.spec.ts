import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { WatchlistAccessService, type GroupActor, type RoomRow } from './watchlist-access.service';
import { WatchlistRoomsService } from './watchlist-rooms.service';
import { WatchlistGroupsService } from './watchlist-groups.service';
import { groupCreateV2Schema, groupItemsSaveSchema, groupSaveSchema } from '@orsem/contracts';
const owner: GroupActor = {
  kind: 'MEMBER',
  id: '11111111-1111-4111-8111-111111111111',
  key: 'MEMBER:11111111-1111-4111-8111-111111111111',
};
const other: GroupActor = {
  kind: 'ADMIN',
  id: '22222222-2222-4222-8222-222222222222',
  key: 'ADMIN:22222222-2222-4222-8222-222222222222',
};
const roomId = '33333333-3333-4333-8333-333333333333';
function accessWith(query: (sql: string, args?: unknown[]) => Promise<unknown[]>) {
  const manager = { query } as EntityManager;
  return {
    manager,
    access: new WatchlistAccessService({
      requireDataSource: () =>
        ({
          transaction: async (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
        }) as never,
    } as unknown as DatabaseRuntimeService),
  };
}
const base: RoomRow = {
  id: roomId,
  owner_key: owner.key,
  name: '방',
  description: '',
  revision: 3,
  ownerLabel: '소유자',
  memberCount: 2,
  memberRole: 'MEMBER',
  can_manage_groups: '0',
  can_manage_stocks: '0',
};
test('room permissions are independent, SQL string zero is false and global ADMIN has no room privilege', () => {
  const { access } = accessWith(async () => []);
  const none = access.roomView(base, other);
  assert.equal(none.role, 'MEMBER');
  assert.equal(none.canManageGroups, false);
  assert.equal(none.canManageStocks, false);
  assert.equal(none.canManageMembers, false);
  for (const groups of [false, true])
    for (const stocks of [false, true]) {
      const view = access.roomView(
        { ...base, can_manage_groups: groups ? '1' : '0', can_manage_stocks: stocks ? '1' : '0' },
        other,
      );
      assert.equal(view.canManageGroups, groups);
      assert.equal(view.canManageStocks, stocks);
      assert.equal(view.canManageMembers, false);
    }
  for (const view of [
    access.roomView(base, owner),
    access.roomView({ ...base, memberRole: 'ADMIN' }, other),
  ])
    assert.ok(view.canManageGroups && view.canManageStocks && view.canManageMembers);
});
test('unapproved actor is rejected before any room query and admin status does not skip membership', async () => {
  const calls: string[] = [];
  const { access } = accessWith(async (sql) => {
    calls.push(sql);
    return [];
  });
  await assert.rejects(
    () => access.transaction(other, (m) => access.room(m, other, roomId)),
    ForbiddenException,
  );
  assert.equal(calls.length, 1);
  const { access: active } = accessWith(async (sql) =>
    sql.startsWith('SELECT id FROM admins') ? [{ id: other.id }] : [],
  );
  await assert.rejects(
    () => active.transaction(other, (m) => active.room(m, other, roomId)),
    NotFoundException,
  );
});
test('private groups cannot be read through another actor and room reads require active owner', async () => {
  const { access, manager } = accessWith(async (sql) =>
    sql.startsWith('SELECT room_id') ? [{ room_id: null, owner_key: owner.key }] : [],
  );
  await assert.rejects(() => access.group(manager, other, roomId), NotFoundException);
  const { access: a, manager: m } = accessWith(async (sql) => {
    assert.match(sql, /r.owner_key=CONCAT/);
    assert.match(sql, /r.id=\?/);
    assert.match(sql, /rm.actor_key=\?/);
    return [];
  });
  await assert.rejects(() => a.room(m, owner, roomId), NotFoundException);
});
test('legacy follow and isShared mutation paths cannot revive broad sharing', () => {
  const service = new WatchlistGroupsService({} as never, {} as never);
  assert.throws(() => service.retired(), GoneException);
  assert.equal(groupCreateV2Schema.safeParse({ name: '그룹', isShared: true }).success, false);
  assert.equal(groupCreateV2Schema.safeParse({ name: '그룹', ownerKey: other.key }).success, false);
});

test('missing watch scopes and groups have explicit codes distinct from unregistered HTTP routes', async () => {
  const { access, manager } = accessWith(async () => []);
  const rejected = (code: string) => (error: unknown) => {
    assert.ok(error instanceof NotFoundException);
    assert.equal(error.getStatus(), 404);
    assert.equal((error.getResponse() as { code?: string }).code, code);
    return true;
  };
  await assert.rejects(
    () => access.room(manager, owner, roomId),
    rejected('WATCH_SCOPE_NOT_FOUND'),
  );
  await assert.rejects(
    () => access.group(manager, owner, roomId),
    rejected('WATCH_GROUP_NOT_FOUND'),
  );
  const { access: removed, manager: removedManager } = accessWith(async (sql) => {
    if (sql.startsWith('SELECT room_id')) return [{ room_id: null, owner_key: owner.key }];
    if (sql.startsWith('SELECT revision')) return [{ revision: 1 }];
    return [];
  });
  await assert.rejects(
    () => removed.group(removedManager, owner, roomId),
    rejected('WATCH_GROUP_NOT_FOUND'),
  );
  assert.equal(
    (
      new NotFoundException('Cannot GET /api/v1/watchlist-groups/example/news').getResponse() as {
        code?: string;
      }
    ).code,
    undefined,
  );
});
test('all-page edits allow 200 unique companies, reject duplicates and require a revision', () => {
  const ids = Array.from(
    { length: 200 },
    (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
  assert.equal(groupItemsSaveSchema.safeParse({ revision: 0, companyIds: ids }).success, true);
  assert.equal(
    groupItemsSaveSchema.safeParse({ revision: 0, companyIds: [...ids, ids[0]] }).success,
    false,
  );
  assert.equal(groupItemsSaveSchema.safeParse({ companyIds: [] }).success, false);
  assert.equal(
    groupSaveSchema.safeParse({
      revision: 0,
      groups: [
        { id: roomId, name: '가' },
        { id: roomId, name: '나' },
      ],
    }).success,
    false,
  );
});
test('stale revisions and groups-only removal of populated groups perform no mutation', async () => {
  const writes: string[] = [];
  const a = new WatchlistAccessService({} as never);
  const scope = {
    roomId,
    revision: 4,
    canManageGroups: true,
    canManageStocks: false,
    canManageMembers: false,
  };
  const manager = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT')) return [{ id: roomId, name: '그룹', itemCount: 2 }];
      writes.push(sql);
      return [];
    },
  } as unknown as EntityManager;
  a.transaction = async (_actor, fn) => fn(manager);
  a.scope = async () => scope;
  const service = new WatchlistGroupsService(a, {} as never);
  await assert.rejects(
    () => service.saveGroups(owner, { roomId, revision: 3, groups: [] }),
    ConflictException,
  );
  await assert.rejects(
    () => service.saveGroups(owner, { roomId, revision: 4, groups: [] }),
    ForbiddenException,
  );
  assert.deepEqual(writes, []);
});
test('room admins cannot promote admins, demote another admin, remove owner or transfer ownership', async () => {
  const writes: string[] = [];
  const a = new WatchlistAccessService({} as never);
  const manager = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT'))
        return [{ role: 'ADMIN', owner_key: owner.key, actor_key: owner.key }];
      writes.push(sql);
      return [];
    },
  } as unknown as EntityManager;
  a.transaction = async (_actor, fn) => fn(manager);
  a.room = async () => ({ ...a.roomView({ ...base, memberRole: 'ADMIN' }, other) });
  const service = new WatchlistRoomsService(a);
  await assert.rejects(
    () =>
      service.member(other, roomId, owner.key, {
        role: 'MEMBER',
        canManageGroups: false,
        canManageStocks: false,
        revision: 3,
      }),
    ForbiddenException,
  );
  await assert.rejects(
    () =>
      service.member(other, roomId, other.key, {
        role: 'ADMIN',
        canManageGroups: true,
        canManageStocks: true,
        revision: 3,
      }),
    ForbiddenException,
  );
  await assert.rejects(() => service.removeMember(other, roomId, owner.key, 3), ConflictException);
  await assert.rejects(() => service.transfer(other, roomId, owner.key, 3), ForbiddenException);
  assert.deepEqual(writes, []);
});
