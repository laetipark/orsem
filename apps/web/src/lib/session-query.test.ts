import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { sessionQueryOptions } from './session-query';
import type { Session } from '../types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const anonymous: Session = {
  authenticated: false,
  canAccess: false,
  user: null,
  csrfToken: 'test',
  setupRequired: false,
};

it('automatically recovers with capped backoff and resets the delay after success', async () => {
  vi.useFakeTimers();
  const unavailable = new ApiError(503, 'UNAVAILABLE', '서버 연결 실패');
  const session = vi.spyOn(api, 'session').mockRejectedValue(unavailable);
  const client = new QueryClient();
  const observer = new QueryObserver(client, sessionQueryOptions());
  const stop = observer.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(session).toHaveBeenCalledOnce();
  for (const [index, delay] of [5_000, 10_000, 20_000, 30_000, 30_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(session).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(session).toHaveBeenCalledTimes(index + 2);
  }
  session.mockResolvedValue(anonymous);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(observer.getCurrentResult().data).toEqual(anonymous);
  expect(session).toHaveBeenCalledTimes(7);
  session.mockRejectedValue(unavailable);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(session).toHaveBeenCalledTimes(7);
  await vi.advanceTimersByTimeAsync(1);
  expect(session).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(session).toHaveBeenCalledTimes(9);
  stop();
  client.clear();
});

it.each([401, 403])('does not apply outage retry backoff to a %i rejection', async (status) => {
  vi.useFakeTimers();
  const session = vi
    .spyOn(api, 'session')
    .mockRejectedValue(new ApiError(status, 'DENIED', '권한 없음'));
  const client = new QueryClient();
  const observer = new QueryObserver(client, sessionQueryOptions());
  const stop = observer.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(session).toHaveBeenCalledOnce();
  stop();
  client.clear();
});
