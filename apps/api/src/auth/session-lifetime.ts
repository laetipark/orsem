import type { SessionData } from 'express-session';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SHORT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_MAX_MS = 7 * DAY_MS;
const MEMBER_SESSION_MAX_MS = 30 * DAY_MS;

type Identity = Pick<SessionData, 'adminId' | 'memberId' | 'sessionStartedAt'>;

/** Keep the browser cookie, Redis TTL and both authentication checks in agreement. */
export function authenticatedSessionIsValid(value: Identity, now = Date.now()): boolean {
  if (Boolean(value.adminId) === Boolean(value.memberId)) return false;
  const startedAt = Date.parse(value.sessionStartedAt ?? '');
  const lifetime = value.adminId ? ADMIN_SESSION_MAX_MS : MEMBER_SESSION_MAX_MS;
  return Number.isFinite(startedAt) && startedAt <= now + 60_000 && now - startedAt < lifetime;
}

export function sessionCookieLifetime(value: Identity, now = Date.now()): number {
  if (!value.adminId && !value.memberId) return SHORT_SESSION_IDLE_MS;
  if (!authenticatedSessionIsValid(value, now)) return 0;
  const lifetime = value.adminId ? ADMIN_SESSION_MAX_MS : MEMBER_SESSION_MAX_MS;
  const idle = value.adminId ? SHORT_SESSION_IDLE_MS : MEMBER_SESSION_MAX_MS;
  return Math.min(idle, Math.max(0, Date.parse(value.sessionStartedAt!) + lifetime - now));
}

export function applySessionCookieLifetime(value: SessionData): void {
  value.cookie.maxAge = sessionCookieLifetime(value);
}
