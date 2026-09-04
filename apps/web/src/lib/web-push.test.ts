import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentDeviceId, disconnectPushOnLogout, storeCurrentDevice } from './web-push';

describe('logout push revocation', () => {
  const unsubscribe = vi.fn();
  const revoke = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    storeCurrentDevice('user-1', 'device-1');
    unsubscribe.mockReset();
    revoke.mockReset();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn(async () => ({
          pushManager: { getSubscription: vi.fn(async () => ({ unsubscribe })) },
        })),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stops logout and retains the device reference if neither side confirms revocation', async () => {
    revoke.mockRejectedValue(new Error('offline'));
    unsubscribe.mockResolvedValue(false);
    await expect(disconnectPushOnLogout('user-1', revoke)).rejects.toThrow('로그아웃을 중단');
    expect(currentDeviceId('user-1')).toBe('device-1');
  });
  it('allows logout after browser revocation even when the session has expired', async () => {
    revoke.mockRejectedValue(new Error('unauthorized'));
    unsubscribe.mockResolvedValue(true);
    await disconnectPushOnLogout('user-1', revoke);
    expect(currentDeviceId('user-1')).toBeNull();
  });
  it('allows logout after server deletion even if browser revocation fails', async () => {
    revoke.mockResolvedValue(undefined);
    unsubscribe.mockRejectedValue(new Error('browser failure'));
    await disconnectPushOnLogout('user-1', revoke);
    expect(currentDeviceId('user-1')).toBeNull();
  });
  it('allows logout when the browser has no subscription', async () => {
    revoke.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn(async () => undefined) },
    });
    await disconnectPushOnLogout('user-1', revoke);
    expect(currentDeviceId('user-1')).toBeNull();
  });
});
