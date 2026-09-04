import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoginReturn,
  loginUrl,
  rememberLoginReturn,
  safeLoginReturn,
  savedLoginReturn,
} from './login-return';

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());
const eventPath = '/events/12345678-1234-4234-8234-123456789abc';
describe('notification login return', () => {
  it('allows known same-origin screens and rejects external, API and malformed destinations', () => {
    expect(safeLoginReturn(eventPath)).toBe(eventPath);
    expect(safeLoginReturn('/settings/notifications')).toBe('/settings/notifications');
    for (const value of [
      'https://attacker.example/events',
      '//attacker.example',
      '/\\attacker.example',
      'javascript:alert(1)',
      '/api/v1/auth/logout',
      '/events/not-a-uuid',
      '/login?returnTo=/events',
    ])
      expect(safeLoginReturn(value)).toBeNull();
  });
  it('preserves the target through both login pages and one OAuth round trip, then expires it', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    rememberLoginReturn(eventPath);
    expect(savedLoginReturn()).toBe(eventPath);
    expect(loginUrl('/admin/login', eventPath)).toContain('returnTo=%2Fevents%2F');
    vi.mocked(Date.now).mockReturnValue(now + 31 * 60_000);
    expect(savedLoginReturn()).toBeNull();
    clearLoginReturn();
    expect(savedLoginReturn()).toBeNull();
  });
});
