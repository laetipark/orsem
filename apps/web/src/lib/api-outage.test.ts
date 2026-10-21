import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([502, 503, 504])('turns an HTML gateway %i into a Korean service error', async (status) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status })),
  );
  await expect(api.session()).rejects.toMatchObject({
    statusCode: status,
    code: 'HTTP_ERROR',
    message: '서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.',
  });
});

it('keeps the HTTP status authoritative even when the error body disagrees', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ statusCode: 503, message: '권한 없음' }), { status: 403 }),
      ),
  );
  await expect(api.session()).rejects.toMatchObject({ statusCode: 403, message: '권한 없음' });
});

it('handles an empty JSON error body without throwing a decoding error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 502 })));
  await expect(api.session()).rejects.toMatchObject({ statusCode: 502, code: 'HTTP_ERROR' });
});

it('turns a network fetch failure into a readable error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(api.session()).rejects.toMatchObject({
    statusCode: 0,
    code: 'NETWORK_ERROR',
    message: '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  });
});

function stalledFetch() {
  const abort = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              abort();
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    ),
  );
  return abort;
}

it('aborts a stalled session request after 15 seconds so recovery can start', async () => {
  vi.useFakeTimers();
  const abort = stalledFetch();
  const result = api.session().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(abort).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(abort).toHaveBeenCalledOnce();
  expect(await result).toBeInstanceOf(ApiError);
  expect(await result).toMatchObject({ statusCode: 408, code: 'REQUEST_TIMEOUT' });
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves caller cancellation and clears the session timeout', async () => {
  vi.useFakeTimers();
  const abort = stalledFetch();
  const controller = new AbortController();
  const result = api.session(controller.signal).catch((error: unknown) => error);
  controller.abort();
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
