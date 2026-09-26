import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthService } from '../auth/auth.service';
import type { MemberService } from '../auth/member.service';
import { loadAppConfig } from '../config/app-config';
import {
  AdminSessionGuard,
  CsrfGuard,
  DeviceRoute,
  OriginGuard,
  Public,
  ReadOnlyMemberAccess,
  OwnNotificationAccess,
  ServiceRoute,
} from './security';

class TestRoutes {
  @ReadOnlyMemberAccess()
  memberRead() {}

  privateResource() {}

  @Public()
  publicRoute() {}

  @ServiceRoute()
  serviceRoute() {}

  @DeviceRoute()
  deviceRoute() {}

  @OwnNotificationAccess()
  ownNotification() {}
}

interface TestMember {
  id: string;
  provider: 'KAKAO';
  role: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  reviewedAt: string | null;
}

function harness() {
  let admin: { id: string; email: string; totpEnabled: boolean } | null = {
    id: 'admin-1',
    email: 'admin@example.test',
    totpEnabled: true,
  };
  let member: TestMember | null = {
    id: 'member-1',
    provider: 'KAKAO',
    role: 'VIEWER',
    status: 'APPROVED',
    displayName: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: null,
    reviewedAt: '2026-09-01T00:00:00.000Z',
  };
  const adminLookups: string[] = [];
  const memberLookups: string[] = [];
  const auth = {
    async getAdmin(id: string) {
      adminLookups.push(id);
      return admin?.id === id ? admin : null;
    },
  } as unknown as AuthService;
  const members = {
    async getMember(id: string) {
      memberLookups.push(id);
      return member?.id === id ? member : null;
    },
  } as unknown as MemberService;
  return {
    guard: new AdminSessionGuard(new Reflector(), auth, members),
    adminLookups,
    memberLookups,
    revokeAdmin: () => {
      admin = null;
    },
    setMember: (changes: Partial<TestMember> | null) => {
      member = changes === null ? null : { ...member!, ...changes };
    },
  };
}

function httpContext(
  sessionValues: Record<string, unknown> = {},
  method = 'GET',
  route: keyof TestRoutes = 'memberRead',
  headers: Record<string, string> = {},
) {
  let destroyed = 0;
  const session = {
    sessionStartedAt: new Date().toISOString(),
    ...sessionValues,
    destroy(callback: (error?: Error) => void) {
      destroyed += 1;
      callback();
    },
  };
  const request = {
    method,
    session,
    header: (name: string) => headers[name.toLowerCase()],
  };
  const context = {
    getHandler: () => TestRoutes.prototype[route],
    getClass: () => TestRoutes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, destroyed: () => destroyed };
}

const denied = (error: unknown): boolean =>
  error instanceof HttpException && [401, 403].includes(error.getStatus());

for (const method of ['GET', 'HEAD']) {
  test(`approved Kakao VIEWER can use an explicitly allowed ${method} resource`, async () => {
    const subject = harness();
    const { context } = httpContext({ memberId: 'member-1' }, method);
    assert.equal(await subject.guard.canActivate(context), true);
    assert.deepEqual(subject.memberLookups, ['member-1']);
    assert.deepEqual(subject.adminLookups, []);
  });
}

for (const status of ['PENDING', 'REJECTED', 'MISSING'] as const) {
  test(`${status} member cannot read private data even on a member-read route`, async () => {
    const subject = harness();
    subject.setMember(status === 'MISSING' ? null : { status });
    const { context } = httpContext({ memberId: 'member-1' });
    await assert.rejects(() => subject.guard.canActivate(context), denied);
  });
}

test('approved member cannot read an unannotated private route or claim admin through session role', async () => {
  const subject = harness();
  const { context } = httpContext(
    { memberId: 'member-1', role: 'ADMIN', status: 'APPROVED' },
    'GET',
    'privateResource',
  );
  await assert.rejects(() => subject.guard.canActivate(context), denied);
});

for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
  test(`member-read metadata never authorizes a member ${method} mutation`, async () => {
    const subject = harness();
    const { context } = httpContext(
      { memberId: 'member-1', csrfToken: 'valid' },
      method,
      'memberRead',
      {
        'x-csrf-token': 'valid',
      },
    );
    await assert.rejects(() => subject.guard.canActivate(context), denied);
  });
}

test('a malformed non-VIEWER member role cannot become an administrator', async () => {
  const subject = harness();
  subject.setMember({ role: 'ADMIN' });
  await assert.rejects(
    () => subject.guard.canActivate(httpContext({ memberId: 'member-1' }).context),
    denied,
  );
});

test('member approval is rechecked on every request and revocation applies to an existing session', async () => {
  const subject = harness();
  const { context } = httpContext({ memberId: 'member-1' });
  assert.equal(await subject.guard.canActivate(context), true);
  subject.setMember({ status: 'REJECTED' });
  await assert.rejects(() => subject.guard.canActivate(context), denied);
  assert.deepEqual(subject.memberLookups, ['member-1', 'member-1']);
});

test('active admins retain private mutation access while inactive admins immediately lose it', async () => {
  const subject = harness();
  const { context } = httpContext({ adminId: 'admin-1' }, 'POST', 'privateResource');
  assert.equal(await subject.guard.canActivate(context), true);
  subject.revokeAdmin();
  await assert.rejects(() => subject.guard.canActivate(context), denied);
  assert.deepEqual(subject.adminLookups, ['admin-1', 'admin-1']);
  assert.deepEqual(subject.memberLookups, []);
});

test('an invalid admin session cannot fall back to an approved member identity', async () => {
  const subject = harness();
  subject.revokeAdmin();
  const { context } = httpContext({ adminId: 'admin-1', memberId: 'member-1' });
  await assert.rejects(() => subject.guard.canActivate(context), denied);
});

for (const identity of [{ memberId: 'member-1' }, { adminId: 'admin-1' }]) {
  for (const sessionStartedAt of [
    undefined,
    'invalid-date',
    new Date(Date.now() - ('memberId' in identity ? 31 : 8) * 86_400_000).toISOString(),
  ]) {
    test(`${Object.keys(identity)[0]} requires a valid, unexpired absolute session start (${sessionStartedAt ?? 'missing'})`, async () => {
      const subject = harness();
      const request = httpContext({ ...identity, sessionStartedAt });
      await assert.rejects(
        () => subject.guard.canActivate(request.context),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
      );
      assert.equal(request.destroyed(), 1);
    });
  }
}

test('approved member access lasts beyond seven days without extending administrator access', async () => {
  const subject = harness();
  const sessionStartedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  assert.equal(
    await subject.guard.canActivate(
      httpContext({ memberId: 'member-1', sessionStartedAt }).context,
    ),
    true,
  );
  await assert.rejects(
    () => subject.guard.canActivate(httpContext({ adminId: 'admin-1', sessionStartedAt }).context),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
  );
});

test('anonymous users cannot access an annotated member-read route', async () => {
  const subject = harness();
  await assert.rejects(() => subject.guard.canActivate(httpContext().context), denied);
});

for (const route of ['publicRoute', 'serviceRoute', 'deviceRoute'] as const) {
  test(`${route} retains its existing session-guard exemption`, async () => {
    const subject = harness();
    const { context } = httpContext({}, 'POST', route);
    assert.equal(await subject.guard.canActivate(context), true);
    assert.deepEqual(subject.adminLookups, []);
    assert.deepEqual(subject.memberLookups, []);
  });
}

test('public member logout still requires a valid CSRF token and allowed origin', () => {
  const reflector = new Reflector();
  const csrf = new CsrfGuard(reflector);
  const origin = new OriginGuard(
    reflector,
    loadAppConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'https://orsem.example.test' }),
  );
  const session = { memberId: 'member-1', csrfToken: 'expected-token' };
  assert.throws(
    () => csrf.canActivate(httpContext(session, 'POST', 'publicRoute').context),
    denied,
  );
  assert.equal(
    csrf.canActivate(
      httpContext(session, 'POST', 'publicRoute', { 'x-csrf-token': 'expected-token' }).context,
    ),
    true,
  );
  assert.throws(
    () =>
      origin.canActivate(
        httpContext(session, 'POST', 'publicRoute', { origin: 'https://untrusted.example.test' })
          .context,
      ),
    denied,
  );
  assert.equal(
    origin.canActivate(
      httpContext(session, 'POST', 'publicRoute', { origin: 'https://orsem.example.test' }).context,
    ),
    true,
  );
});

test('approved members can mutate only explicitly scoped own-notification routes', async () => {
  const subject = harness();
  for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
    assert.equal(
      await subject.guard.canActivate(
        httpContext({ memberId: 'member-1' }, method, 'ownNotification').context,
      ),
      true,
    );
  }
  await assert.rejects(
    () =>
      subject.guard.canActivate(
        httpContext({ memberId: 'member-1' }, 'PUT', 'ownNotification').context,
      ),
    denied,
  );
  await assert.rejects(
    () =>
      subject.guard.canActivate(
        httpContext({ memberId: 'member-1' }, 'PATCH', 'privateResource').context,
      ),
    denied,
  );
  subject.setMember({ status: 'REJECTED' });
  await assert.rejects(
    () =>
      subject.guard.canActivate(
        httpContext({ memberId: 'member-1' }, 'POST', 'ownNotification').context,
      ),
    denied,
  );
  await assert.rejects(
    () => subject.guard.canActivate(httpContext({}, 'POST', 'ownNotification').context),
    denied,
  );
});

test('own notification metadata never exempts mutations from CSRF or same-origin checks', () => {
  const reflector = new Reflector();
  const csrf = new CsrfGuard(reflector);
  const origin = new OriginGuard(
    reflector,
    loadAppConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'https://orsem.example.test' }),
  );
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const session = { memberId: 'member-1', csrfToken: 'expected-token' };
    assert.throws(
      () => csrf.canActivate(httpContext(session, method, 'ownNotification').context),
      denied,
    );
    assert.equal(
      csrf.canActivate(
        httpContext(session, method, 'ownNotification', { 'x-csrf-token': 'expected-token' })
          .context,
      ),
      true,
    );
    assert.throws(
      () =>
        origin.canActivate(
          httpContext(session, method, 'ownNotification', {
            origin: 'https://untrusted.example.test',
          }).context,
        ),
      denied,
    );
    assert.equal(
      origin.canActivate(
        httpContext(session, method, 'ownNotification', { origin: 'https://orsem.example.test' })
          .context,
      ),
      true,
    );
  }
});
