import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthAuditLogEntity, MemberEntity, PushDeliveryEntity } from '@orsem/database';
import type { FindOperator } from 'typeorm';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { MemberService } from './member.service';

function harness(existingStatus?: MemberEntity['status']) {
  const now = new Date();
  let row: MemberEntity | null = existingStatus
    ? Object.assign(new MemberEntity(), {
        id: '00000000-0000-4000-8000-000000000001',
        provider: 'KAKAO',
        providerSubject: '123456',
        role: 'VIEWER',
        status: existingStatus,
        displayName: '기존 이름',
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
        reviewedAt: now,
        reviewedByAdminId: 'review-admin',
      })
    : null;
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const pushCancellations: Array<{
    where: Record<string, unknown>;
    values: Record<string, unknown>;
  }> = [];
  let inTransaction = false;
  const builder = {
    insert() {
      return this;
    },
    values(value: Record<string, unknown>) {
      inserts.push(value);
      return this;
    },
    orIgnore() {
      return this;
    },
    async execute() {
      row ??= Object.assign(new MemberEntity(), inserts.at(-1), {
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: now,
        updatedAt: now,
      });
    },
    setLock() {
      return this;
    },
    where() {
      return this;
    },
    async getOne() {
      return row;
    },
  };
  const repository = {
    createQueryBuilder: () => builder,
    findOneByOrFail: async () => {
      if (!row) throw new Error('missing');
      return row;
    },
    findOneBy: async () => row,
    update: async (_where: unknown, values: Record<string, unknown>) => {
      updates.push(values);
      Object.assign(row!, values);
    },
    save: async (value: MemberEntity) => {
      row = value;
      return value;
    },
  };
  const source = {
    getRepository: (entity: unknown) => {
      if (entity === MemberEntity) return repository;
      if (entity === PushDeliveryEntity)
        return {
          update: async (where: Record<string, unknown>, values: Record<string, unknown>) => {
            assert.equal(inTransaction, true);
            assert.equal(row?.status, 'REJECTED');
            pushCancellations.push({ where, values });
          },
        };
      assert.equal(
        entity,
        AuthAuditLogEntity,
        'Kakao sign-in must never query or mutate local administrators',
      );
      return {
        save: async (value: Record<string, unknown>) => {
          audits.push(value);
          return value;
        },
      };
    },
    transaction: async (callback: (manager: unknown) => Promise<unknown>): Promise<unknown> => {
      inTransaction = true;
      try {
        return await callback(source);
      } finally {
        inTransaction = false;
      }
    },
  };
  const database = {
    dataSource: source,
    requireDataSource: () => source,
  } as unknown as DatabaseRuntimeService;
  return {
    service: new MemberService(database),
    inserts,
    updates,
    audits,
    pushCancellations,
    row: () => row,
  };
}

test('new Kakao identities are pending viewers and cannot link to administrator email', async () => {
  const h = harness();
  const member = await h.service.signInKakao('900719925474099312345', 'admin@example.com\u0000');
  assert.equal(member.role, 'VIEWER');
  assert.equal(member.status, 'PENDING');
  assert.equal(member.displayName, 'admin@example.com');
  assert.equal(h.inserts[0]!.providerSubject, '900719925474099312345');
  assert.equal(h.inserts[0]!.reviewedByAdminId, null);
  assert.deepEqual(Object.keys(h.updates[0]!).sort(), ['displayName', 'lastLoginAt']);
  assert.equal(h.audits[0]!.adminId, null);
  assert.deepEqual(h.audits[0]!.metadataJson, { memberId: member.id });
});

for (const status of ['APPROVED', 'REJECTED'] as const) {
  test(`repeat Kakao sign-in preserves ${status} status and approval audit`, async () => {
    const h = harness(status);
    const previous = h.row()!.reviewedAt;
    const member = await h.service.signInKakao('123456', null);
    assert.equal(member.status, status);
    assert.equal(member.role, 'VIEWER');
    assert.equal(member.displayName, '기존 이름');
    assert.equal(h.row()!.reviewedAt, previous);
    assert.equal(h.row()!.reviewedByAdminId, 'review-admin');
    assert.deepEqual(Object.keys(h.updates[0]!), ['lastLoginAt']);
  });
}

test('member review remains read-only and records the acting administrator and prior status', async () => {
  const h = harness('PENDING');
  const member = await h.service.review(h.row()!.id, 'APPROVED', 'reviewing-admin');
  assert.equal(member.status, 'APPROVED');
  assert.equal(member.role, 'VIEWER');
  assert.equal(h.row()!.reviewedByAdminId, 'reviewing-admin');
  assert.deepEqual(h.audits[0]!.metadataJson, {
    memberId: member.id,
    previousStatus: 'PENDING',
    status: 'APPROVED',
  });
  assert.equal(h.audits[0]!.adminId, 'reviewing-admin');
  assert.deepEqual(h.pushCancellations, []);
});

test('revoking approval atomically cancels only that member pending and claimed push deliveries', async () => {
  const h = harness('APPROVED');
  const id = h.row()!.id;
  const member = await h.service.review(id, 'REJECTED', 'reviewing-admin');
  assert.equal(member.status, 'REJECTED');
  assert.equal(h.pushCancellations.length, 1);
  const { where, values } = h.pushCancellations[0]!;
  assert.equal(where.ownerKey, `MEMBER:${id}`);
  assert.deepEqual((where.status as FindOperator<string[]>).value, ['PENDING', 'SENDING']);
  assert.equal(values.status, 'CANCELLED');
  assert.equal(values.leaseUntil, null);
  assert.match(String(values.lastError), /승인/u);
  assert.deepEqual(h.audits[0]!.metadataJson, {
    memberId: id,
    previousStatus: 'APPROVED',
    status: 'REJECTED',
  });
});

test('invalid provider subjects are rejected before persistence', async () => {
  const h = harness();
  for (const subject of ['0', '-1', '1e12', '1.2', '01', 'a', '1'.repeat(65)])
    await assert.rejects(h.service.signInKakao(subject, null));
  assert.equal(h.inserts.length, 0);
});
