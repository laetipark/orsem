import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, setCsrfToken } from './api';

const input = { changes: [{ groupId: 'group-1', revision: 4, selected: true }] };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setCsrfToken(null);
});

it('reads actor-dependent memberships without HTTP caching and preserves cancellation', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ companyId: 'company/one', items: [] }));
  const controller = new AbortController();
  await api.companyWatchlistMemberships('company/one', controller.signal);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    '/api/v1/watchlist-groups/company-memberships/company%2Fone',
    expect.objectContaining({
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal,
    }),
  );
});

it('aborts a stalled PUT after 15 seconds and never automatically repeats the write', async () => {
  vi.useFakeTimers();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
    const signal = options?.signal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  });
  const outcome = api.saveCompanyWatchlistMemberships('company/one', input).then(
    () => null,
    (error: unknown) => error,
  );
  const signal = fetcher.mock.calls[0]![1]!.signal;
  await vi.advanceTimersByTimeAsync(14_999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the deadline after success and keeps the protected JSON request unchanged', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 204 }));
  setCsrfToken('membership-csrf');
  await api.saveCompanyWatchlistMemberships('company/one', input);
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/v1/watchlist-groups/company-memberships/company%2Fone');
  expect(options).toMatchObject({ method: 'PUT', credentials: 'include' });
  expect(JSON.parse(String(options!.body))).toEqual(input);
  expect(new Headers(options!.headers).get('X-CSRF-Token')).toBe('membership-csrf');
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(options!.signal?.aborted).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('also clears the deadline on a confirmed conflict without retrying', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json(
        { code: 'REVISION_CONFLICT', message: '그룹이 변경되었습니다.' },
        { status: 409 },
      ),
    );
  await expect(api.saveCompanyWatchlistMemberships('company/one', input)).rejects.toBeInstanceOf(
    ApiError,
  );
  expect(vi.getTimerCount()).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
