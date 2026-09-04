import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const code = readFileSync(new NodeURL('../../public/sw.js', import.meta.url), 'utf8');
function worker() {
  const listeners = new Map<string, (event: any) => void>();
  const showNotification = vi.fn(async () => undefined);
  const clients = {
    matchAll: vi.fn(async () => [] as any[]),
    openWindow: vi.fn(async () => undefined),
    claim: vi.fn(async () => undefined),
  };
  runInNewContext(code, {
    URL,
    URLSearchParams,
    location: { origin: 'https://orsem.example' },
    registration: { showNotification },
    clients,
    skipWaiting: async () => undefined,
    addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler),
  });
  async function dispatch(name: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> | undefined;
    listeners.get(name)!({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
  }
  return { listeners, showNotification, clients, dispatch };
}

describe('notification-only service worker', () => {
  it('never intercepts or caches authenticated pages and APIs', () => {
    expect([...worker().listeners.keys()]).toEqual([
      'install',
      'activate',
      'push',
      'notificationclick',
    ]);
  });
  it('shows bounded text and rejects unsafe notification destinations', async () => {
    const w = worker();
    await w.dispatch('push', {
      data: {
        json: () => ({
          title: 'A'.repeat(500),
          body: 'B'.repeat(1000),
          url: 'https://attacker.example/',
          tag: 'event-1',
        }),
      },
    });
    expect(w.showNotification).toHaveBeenCalledWith(
      'A'.repeat(120),
      expect.objectContaining({
        body: 'B'.repeat(500),
        data: { url: '/settings/notifications' },
        tag: 'event-1',
      }),
    );
  });
  it('focuses an existing app window on the allowed target and discards query strings', async () => {
    const w = worker();
    const focused = { focus: vi.fn(async () => undefined) };
    const client = { url: 'https://orsem.example/markets', navigate: vi.fn(async () => focused) };
    w.clients.matchAll.mockResolvedValue([client]);
    const close = vi.fn();
    await w.dispatch('notificationclick', {
      notification: {
        close,
        data: { url: '/events/12345678-1234-4234-8234-123456789abc?unused=1' },
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(client.navigate).toHaveBeenCalledWith(
      'https://orsem.example/events/12345678-1234-4234-8234-123456789abc',
    );
    expect(focused.focus).toHaveBeenCalledOnce();
    expect(w.clients.openWindow).not.toHaveBeenCalled();
  });
  it('opens the safe settings screen when an API route is supplied and no app window exists', async () => {
    const w = worker();
    await w.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { url: '/api/v1/auth/logout' } },
    });
    expect(w.clients.openWindow).toHaveBeenCalledWith(
      'https://orsem.example/settings/notifications',
    );
  });
  it('preserves only the bounded news query on the internal search screen', async () => {
    const w = worker();
    await w.dispatch('notificationclick', {
      notification: {
        close: vi.fn(),
        data: { url: '/search?type=news&q=Apple%20news&redirect=https://other.test' },
      },
    });
    expect(w.clients.openWindow).toHaveBeenCalledWith(
      'https://orsem.example/search?type=news&q=Apple+news',
    );
  });
  it.each([
    '/search?type=news&q=',
    '/search?type=companies&q=Apple',
    `/search?type=news&q=${'x'.repeat(121)}`,
    '/search?type=news&q=%00Apple',
  ])('rejects an invalid news destination %s', async (url) => {
    const w = worker();
    await w.dispatch('notificationclick', { notification: { close: vi.fn(), data: { url } } });
    expect(w.clients.openWindow).toHaveBeenCalledWith(
      'https://orsem.example/settings/notifications',
    );
  });
});
