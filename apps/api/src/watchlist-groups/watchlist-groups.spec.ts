import { CompanyObservationService } from './company-observation.service';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { EntityManager } from 'typeorm';
import {
  addWatchlistGroupItemSchema,
  createWatchlistGroupSchema,
  reorderWatchlistGroupItemsSchema,
  updateWatchlistGroupSchema,
  watchlistGroupPageQuerySchema,
  type Company,
} from '@orsem/contracts';
import type { AuthService } from '../auth/auth.service';
import type { MemberService } from '../auth/member.service';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import type { WorkerQueueService } from '../operations/worker-queue.service';
import { AdminSessionGuard, CsrfGuard, OriginGuard } from '../security/security';
import type { SessionRuntimeService } from '../security/session-runtime.service';
import { WatchlistGroupsController } from './watchlist-groups.controller';
import { groupActor, WatchlistGroupsService, type GroupActor } from './watchlist-groups.service';
import { groupDisplayPrice, recentKstWindow } from './watchlist-group-observations';

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const owner: GroupActor = { kind: 'MEMBER', id: ids[0]!, key: `MEMBER:${ids[0]}` };
const reader: GroupActor = { kind: 'MEMBER', id: ids[1]!, key: `MEMBER:${ids[1]}` };
const groupId = ids[2]!;
const company: Company = {
  id: ids[0]!,
  nameKo: '테스트 회사',
  nameEn: 'Test Company',
  market: 'KRX',
  corpCode: null,
  stockCode: '000001',
  ticker: null,
  cik: null,
  isListed: true,
  updatedAt: '2026-09-05T00:00:00.000Z',
};
const config = loadAppConfig({
  NODE_ENV: 'test',
  TOSS_CLIENT_ID: 'synthetic',
  TOSS_CLIENT_SECRET: 'synthetic',
  WEB_ORIGIN: 'https://orsem.example.test',
});
const closes = [
  { sessionDate: '2026-09-04', close: 120 },
  { sessionDate: '2026-09-03', close: 100 },
  { sessionDate: '2026-09-02', close: 80 },
];
const quote = (at: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    companyId: company.id,
    symbol: '000001',
    source: 'TOSS_KR',
    currency: 'KRW',
    price: '130',
    providerAt: at,
    observedAt: at,
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    lossy: true,
    ...extra,
  });

test('a weekend closing price compares Friday to Thursday, never an older cached trade', () => {
  const value = groupDisplayPrice(
    company,
    { available: true, value: quote('2026-09-03T06:30:00.000Z', { price: '999' }) },
    closes,
    true,
    new Date('2026-09-05T01:00:00Z'),
  );
  assert.equal(value.basis, 'CLOSE');
  assert.equal(value.price, '120');
  assert.equal(value.sessionDate, '2026-09-04');
  assert.equal(value.referenceDate, '2026-09-03');
  assert.equal(value.change, 20);
  assert.equal(value.changePercent, 20);
  assert.equal(value.providerAt, null);
});
test('today LIVE and STALE quotes take precedence and compare to the previous session', () => {
  for (const seconds of [5, 120]) {
    const now = new Date('2026-09-07T00:30:00Z');
    const value = groupDisplayPrice(
      company,
      { available: true, value: quote(new Date(now.getTime() - seconds * 1000).toISOString()) },
      closes,
      true,
      now,
    );
    assert.equal(value.basis, seconds === 5 ? 'LIVE' : 'STALE');
    assert.equal(value.price, '130');
    assert.equal(value.referenceClose, 120);
  }
});
test('closes survive cache outage and missing credentials while incomplete today bars stay excluded', () => {
  const bars = [{ sessionDate: '2026-09-05', close: 200 }, ...closes];
  for (const configured of [true, false]) {
    const value = groupDisplayPrice(
      company,
      { available: false, value: null },
      bars,
      configured,
      new Date('2026-09-05T01:00:00Z'),
    );
    assert.equal(value.price, '120');
    assert.equal(value.basis, 'CLOSE');
    assert.equal(value.status, configured ? 'UNAVAILABLE' : 'NOT_CONFIGURED');
  }
});
test('foreign, wrong-owner, zero and future quote values never become live observations', () => {
  for (const extra of [
    { source: 'TOSS_US', currency: 'USD' },
    { companyId: reader.id },
    { price: '0' },
    { rightsMode: 'LINK_ONLY' },
    { providerAt: '2030-01-01T00:00:00.000Z' },
  ]) {
    const value = groupDisplayPrice(
      company,
      { available: true, value: quote('2026-09-05T01:00:00.000Z', extra) },
      [],
      true,
      new Date('2026-09-05T01:00:00Z'),
    );
    assert.equal(value.basis, 'NONE');
    assert.equal(value.price, null);
    assert.equal(value.status, 'UNAVAILABLE');
  }
});
test('US keeps its existing quote-only policy even when completed USD closes exist', () => {
  const value = groupDisplayPrice(
    { ...company, market: 'NASDAQ' },
    { available: true, value: null },
    [{ sessionDate: '2026-09-04', close: 120 }],
    true,
    new Date('2026-09-06T01:00:00Z'),
  );
  assert.equal(value.currency, 'USD');
  assert.equal(value.source, null);
  assert.equal(value.price, null);
  assert.equal(value.basis, 'NONE');
  assert.equal(value.changePercent, null);
});
test('recent activity includes exactly seven KST calendar dates across a UTC month boundary', () => {
  assert.deepEqual(recentKstWindow(new Date('2026-08-31T15:00:00Z')), {
    start: '2026-08-26',
    end: '2026-09-01',
    startInstant: '2026-08-25T15:00:00.000Z',
    endInstant: '2026-09-01T15:00:00.000Z',
  });
});
test('group inputs enforce ownership-only fields, page limits and unique partial order IDs', () => {
  assert.equal(
    createWatchlistGroupSchema.safeParse({ name: '그룹', ownerKey: owner.key }).success,
    false,
  );
  assert.equal(createWatchlistGroupSchema.safeParse({ name: '  ' }).success, false);
  assert.equal(updateWatchlistGroupSchema.safeParse({}).success, false);
  assert.equal(updateWatchlistGroupSchema.safeParse({ canEdit: true }).success, false);
  assert.equal(
    addWatchlistGroupItemSchema.safeParse({ companyId: company.id, priority: 'P1' }).success,
    false,
  );
  assert.equal(watchlistGroupPageQuerySchema.safeParse({ limit: 22 }).success, false);
  assert.equal(watchlistGroupPageQuerySchema.safeParse({ offset: -1 }).success, false);
  assert.equal(
    reorderWatchlistGroupItemsSchema.safeParse({ companyIds: [company.id, company.id] }).success,
    false,
  );
  assert.equal(
    reorderWatchlistGroupItemsSchema.safeParse({ companyIds: [company.id] }).success,
    true,
  );
});
test('group actors are derived only from the authenticated session identity', () => {
  const request = (session: Record<string, unknown>) => ({ session }) as unknown as Request;
  assert.deepEqual(
    groupActor(request({ memberId: reader.id, role: 'ADMIN', ownerKey: owner.key })),
    reader,
  );
  assert.throws(() => groupActor(request({})), UnauthorizedException);
  assert.throws(
    () => groupActor(request({ memberId: reader.id, adminId: owner.id })),
    UnauthorizedException,
  );
});

function context(
  method: string,
  session: Record<string, unknown>,
  headers: Record<string, string> = {},
): ExecutionContext {
  const request = {
    method,
    session: { sessionStartedAt: new Date().toISOString(), destroy: () => undefined, ...session },
    header: (key: string) => headers[key],
  };
  return {
    getHandler: () => WatchlistGroupsController.prototype.create,
    getClass: () => WatchlistGroupsController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
test('approved members can use group mutations while pending/rejected and anonymous users cannot', async () => {
  let status = 'APPROVED';
  const guard = new AdminSessionGuard(
    new Reflector(),
    { getAdmin: async () => null } as unknown as AuthService,
    { getMember: async () => ({ role: 'VIEWER', status }) } as unknown as MemberService,
  );
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    assert.equal(await guard.canActivate(context(method, { memberId: reader.id })), true);
  for (const blocked of ['PENDING', 'REJECTED']) {
    status = blocked;
    await assert.rejects(
      () => guard.canActivate(context('POST', { memberId: reader.id })),
      ForbiddenException,
    );
  }
  await assert.rejects(() => guard.canActivate(context('GET', {})), UnauthorizedException);
});
test('group mutation permissions do not bypass CSRF or same-origin enforcement', () => {
  const csrf = new CsrfGuard(new Reflector());
  const origin = new OriginGuard(new Reflector(), config);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const session = { memberId: reader.id, csrfToken: 'expected' };
    assert.throws(() => csrf.canActivate(context(method, session)), ForbiddenException);
    assert.equal(csrf.canActivate(context(method, session, { 'x-csrf-token': 'expected' })), true);
    assert.throws(
      () => origin.canActivate(context(method, session, { origin: 'https://other.example.test' })),
      ForbiddenException,
    );
  }
});

test('a full page batches quotes and observations, caps history and deduplicates activity without losing counts', async () => {
  const companies = Array.from({ length: 21 }, (_, index) => ({
    ...company,
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }));
  const calls: string[] = [];
  let quoteReads = 0;
  const row = {
    id: groupId,
    owner_key: owner.key,
    name: '종목 그룹',
    is_shared: true,
    position: 0,
    updated_at: new Date(),
    ownerLabel: '소유자',
    itemCount: 23,
  };
  const manager = {
    async query(sql: string, args: unknown[]) {
      calls.push(sql);
      if (sql.startsWith('SELECT id FROM members')) return [{ id: reader.id }];
      if (sql.includes('FROM watchlist_groups g')) return [row];
      if (sql.startsWith('SELECT c.id,c.market')) {
        assert.deepEqual(args, [groupId, 21, 0]);
        return companies.map((company, index) => ({
          ...company,
          isListed: index === 1 ? '0' : '1',
        }));
      }
      if (sql.startsWith('WITH sessions')) {
        assert.match(sql, /b.rights_mode='PRIVATE_DISPLAY_ONLY'/u);
        assert.match(sql, /b.session_date<\?/u);
        return companies.flatMap((company) =>
          Array.from({ length: 21 }, (_, index) => ({
            company_id: company.id,
            session_date: `2026-08-${String(30 - index).padStart(2, '0')}`,
            close: String(130 - index),
          })),
        );
      }
      if (sql.startsWith('WITH scoped')) {
        assert.match(sql, /source_policy_json,'\$\.displayAllowed'/u);
        assert.match(sql, /s.source<>'NAVER'/u);
        assert.match(sql, /DATE\(CONVERT_TZ\(e.occurred_at/u);
        assert.equal(args.length, 30);
        assert.equal(args.at(-1), 3);
        const activity = (
          id: string,
          kind: string,
          date: string,
          displayable: number,
          url: string,
          count: string,
        ) => ({
          id,
          company_id: companies[0]!.id,
          kind,
          title: '소스 제목',
          date,
          eventDate: kind === 'EVENT' ? '2026-08-01' : null,
          displayable: String(displayable),
          url,
          kindCount: count,
        });
        return [
          activity(
            ids[0]!,
            'FILING',
            '2026-09-06',
            0,
            'https://www.sec.gov/Archives/example.htm',
            '8',
          ),
          activity(ids[1]!, 'EVENT', '2026-09-06', 1, '/events/x', '4'),
          activity(ids[2]!, 'FILING', '2026-09-05', 1, 'javascript:alert(1)', '8'),
          activity(
            companies[1]!.id,
            'FILING',
            '2026-09-04',
            1,
            'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260904000001',
            '8',
          ),
          activity(companies[2]!.id, 'EVENT', '2026-09-03', 1, '/events/x', '4'),
        ];
      }
      throw new Error('Unexpected observation query');
    },
  } as unknown as EntityManager;
  const service = new CompanyObservationService(
    {
      requireDataSource: () => ({
        transaction: async (action: (value: EntityManager) => Promise<unknown>) => action(manager),
      }),
    } as unknown as DatabaseRuntimeService,
    {
      readMarketQuotes: async (requested: string[]) => {
        quoteReads++;
        assert.deepEqual(
          requested,
          companies.map((company) => company.id),
        );
        return { available: true, values: requested.map(() => null) };
      },
    } as unknown as SessionRuntimeService,
    config,
  );
  const page = await service.observe(manager, companies);
  assert.equal(quoteReads, 1);
  assert.equal(calls.length, 2);
  assert.equal(page.items.length, 21);
  assert.equal(page.items[0]!.sparkline.length, 20);
  assert.equal(page.items[0]!.sparkline[0]!.sessionDate, '2026-08-11');
  assert.equal(page.items[0]!.sparkline[19]!.sessionDate, '2026-08-30');
  const activity = page.items[0]!.recentActivity;
  assert.equal(activity.filingCount, 8);
  assert.equal(activity.eventCount, 4);
  assert.equal(activity.items.length, 3);
  assert.equal(
    activity.items.some((item) => item.id === ids[0]),
    false,
  );
  assert.equal(activity.items[0]!.eventDate, '2026-08-01');
  assert.equal(activity.items[1]!.url, `/companies/${companies[0]!.id}`);
  assert.match(activity.items[2]!.url, /^https:\/\/dart\.fss\.or\.kr\//u);
  assert.deepEqual(page.items[1]!.recentActivity, { filingCount: 0, eventCount: 0, items: [] });
});

test('candle refresh is requested only after an authorized page and queue failure does not hide it', async () => {
  let allowed = false;
  let refreshes = 0;
  const result = { items: [{ company }] };
  const controller = new WatchlistGroupsController(
    {
      items: async () => {
        if (!allowed) throw new NotFoundException();
        return result;
      },
    } as unknown as WatchlistGroupsService,
    {
      requestGroupTossCandles: async (ids: string[]) => {
        refreshes++;
        assert.deepEqual(ids, [company.id]);
        throw new Error('Queue unavailable');
      },
    } as unknown as WorkerQueueService,
    {} as never,
    {} as never,
  );
  const request = { session: { memberId: reader.id } } as unknown as Request;
  await assert.rejects(() => controller.items(request, groupId, {}), NotFoundException);
  assert.equal(refreshes, 0);
  allowed = true;
  assert.equal(await controller.items(request, groupId, {}), result);
  assert.equal(refreshes, 1);
});

test('unknown markets cannot infer KRW, accept Korean quotes or substitute domestic closes', () => {
  for (const value of [null, quote('2026-09-05T01:00:00.000Z')]) {
    const price = groupDisplayPrice(
      { ...company, market: 'OTHER' },
      { available: true, value },
      closes,
      true,
      new Date('2026-09-05T01:00:00Z'),
    );
    assert.equal(price.price, null);
    assert.equal(price.currency, null);
    assert.equal(price.basis, 'NONE');
    assert.equal(price.source, null);
    assert.equal(price.referenceClose, null);
  }
});
