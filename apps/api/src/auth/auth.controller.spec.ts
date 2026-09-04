import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { sessionSchema } from '@orsem/contracts';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { MemberService } from './member.service';

const memberId = '00000000-0000-4000-8000-000000000001';
const adminId = '00000000-0000-4000-8000-000000000002';
function harness(status: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING') {
  let regenerations = 0;
  const request = { header: () => undefined } as unknown as Request;
  const session = () => {
    request.session = {
      regenerate: (callback: (error?: Error) => void) => {
        regenerations++;
        session();
        callback();
      },
    } as unknown as Request['session'];
  };
  session();
  const admin = { id: adminId, email: 'admin@example.com', totpEnabled: true };
  const auth = {
    setupRequired: async () => false,
    getAdmin: async (id: string) => (id === adminId ? admin : null),
    authenticate: async () => admin,
  } as unknown as AuthService;
  const members = {
    getMember: async () => ({
      id: memberId,
      provider: 'KAKAO',
      role: 'VIEWER',
      status,
      displayName: null,
    }),
  } as unknown as MemberService;
  return {
    controller: new AuthController(auth, members),
    request,
    auth,
    regenerations: () => regenerations,
  };
}

for (const status of ['PENDING', 'APPROVED', 'REJECTED'] as const) {
  test(`session exposes ${status} Kakao identity separately from data access`, async () => {
    const h = harness(status);
    h.request.session.memberId = memberId;
    h.request.session.sessionStartedAt = new Date().toISOString();
    const response = sessionSchema.parse(await h.controller.session(h.request));
    assert.equal(response.authenticated, true);
    assert.equal(response.canAccess, status === 'APPROVED');
    assert.equal(response.user?.role, 'VIEWER');
    assert.equal(response.user?.provider, 'KAKAO');
    assert.equal(response.user?.email, null);
    assert.equal(response.user?.status, status);
  });
}

test('administrator login replaces member session and retains the administrator MFA result', async () => {
  const h = harness();
  h.request.session.memberId = memberId;
  h.request.session.csrfToken = 'old-csrf';
  const response = sessionSchema.parse(
    await h.controller.login(
      { email: 'admin@example.com', password: 'long-test-password', totpCode: '123456' },
      h.request,
    ),
  );
  assert.equal(response.canAccess, true);
  assert.equal(response.user?.role, 'ADMIN');
  assert.equal(response.user?.totpEnabled, true);
  assert.equal(h.request.session.memberId, undefined);
  assert.equal(h.request.session.adminId, adminId);
  assert.equal(h.regenerations(), 1);
  assert.notEqual(response.csrfToken, 'old-csrf');
});

test('failed administrator MFA never upgrades a member session', async () => {
  const h = harness();
  h.request.session.memberId = memberId;
  h.auth.authenticate = async () => {
    throw new Error('MFA_REQUIRED');
  };
  await assert.rejects(
    h.controller.login({ email: 'admin@example.com', password: 'long-test-password' }, h.request),
    /MFA_REQUIRED/u,
  );
  assert.equal(h.request.session.adminId, undefined);
  assert.equal(h.regenerations(), 0);
});

test('member logout creates an anonymous session and new CSRF token', async () => {
  const h = harness();
  h.request.session.memberId = memberId;
  h.request.session.csrfToken = 'old-csrf';
  const response = sessionSchema.parse(await h.controller.logout(h.request));
  assert.equal(response.authenticated, false);
  assert.equal(response.canAccess, false);
  assert.equal(response.user, null);
  assert.equal(h.request.session.memberId, undefined);
  assert.equal(h.request.session.adminId, undefined);
  assert.equal(h.regenerations(), 1);
  assert.notEqual(response.csrfToken, 'old-csrf');
});

test('mixed or expired authentication state is replaced before rendering the public session', async () => {
  for (const mode of ['mixed', 'expired'] as const) {
    const h = harness('APPROVED');
    h.request.session.memberId = memberId;
    h.request.session.sessionStartedAt =
      mode === 'expired'
        ? new Date(Date.now() - 8 * 86400_000).toISOString()
        : new Date().toISOString();
    if (mode === 'mixed') h.request.session.adminId = adminId;
    const response = sessionSchema.parse(await h.controller.session(h.request));
    assert.equal(response.authenticated, false);
    assert.equal(response.canAccess, false);
    assert.equal(h.regenerations(), 1);
  }
});
