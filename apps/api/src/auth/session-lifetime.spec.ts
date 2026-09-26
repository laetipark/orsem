import assert from 'node:assert/strict';
import test from 'node:test';
import session from 'express-session';
import type { SessionData } from 'express-session';
import {
  authenticatedSessionIsValid,
  applySessionCookieLifetime,
  sessionCookieLifetime,
} from './session-lifetime';

const now = Date.parse('2026-09-16T12:00:00Z');
const day = 86400_000;

test('member lifetime is capped at thirty days without changing administrator or anonymous policy', () => {
  const sessionStartedAt = new Date(now).toISOString();
  assert.equal(sessionCookieLifetime({}, now), 12 * 3600_000);
  assert.equal(sessionCookieLifetime({ adminId: 'admin', sessionStartedAt }, now), 12 * 3600_000);
  assert.equal(sessionCookieLifetime({ memberId: 'member', sessionStartedAt }, now), 30 * day);
  assert.equal(
    sessionCookieLifetime({ memberId: 'member', sessionStartedAt }, now + 29 * day),
    day,
  );
  assert.equal(sessionCookieLifetime({ memberId: 'member', sessionStartedAt }, now + 30 * day), 0);
  assert.equal(
    authenticatedSessionIsValid({ adminId: 'admin', sessionStartedAt }, now + 7 * day),
    false,
  );
  assert.equal(
    authenticatedSessionIsValid({ memberId: 'member', sessionStartedAt }, now + 7 * day),
    true,
  );
});

test('invalid or mixed identities never receive a longer cookie lifetime', () => {
  for (const value of [
    { memberId: 'member' },
    { memberId: 'member', sessionStartedAt: 'invalid-date' },
    { memberId: 'member', sessionStartedAt: new Date(now + 60_001).toISOString() },
    { adminId: 'admin', memberId: 'member', sessionStartedAt: new Date(now).toISOString() },
  ]) {
    assert.equal(authenticatedSessionIsValid(value, now), false);
    assert.equal(sessionCookieLifetime(value, now), 0);
  }
});

test('an existing short-lived member cookie is upgraded without resetting the original sign-in time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const value: SessionData = {
    memberId: 'member',
    sessionStartedAt: new Date(now - day).toISOString(),
    cookie: Object.assign(new session.Cookie(), {
      maxAge: 12 * 3600_000,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    }),
  };
  const originalStart = value.sessionStartedAt;
  applySessionCookieLifetime(value);
  assert.equal(value.cookie.originalMaxAge, 29 * day);
  assert.equal(value.cookie.expires?.getTime(), now + 29 * day);
  assert.equal(value.sessionStartedAt, originalStart);
  assert.equal(value.cookie.httpOnly, true);
  assert.equal(value.cookie.secure, true);
  assert.equal(value.cookie.sameSite, 'lax');
});
