import { QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient } from './query-client';
import { api } from './api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('collects inactive article and chart data after two minutes without removing active queries', async () => {
  vi.useFakeTimers();
  const client = createQueryClient();
  const key = ['news-detail', 'test-article'];
  client.setQueryData(key, { title: '시험 기사' });
  client.setQueryData(['company-timeline', 'test', '1M', '1d'], { prices: [] });
  const observer = new QueryObserver(client, { queryKey: key, enabled: false });
  const stop = observer.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(120_001);
  expect(client.getQueryData(key)).toEqual({ title: '시험 기사' });
  expect(client.getQueryData(['company-timeline', 'test', '1M', '1d'])).toBeUndefined();
  stop();
  await vi.advanceTimersByTimeAsync(119_999);
  expect(client.getQueryData(key)).toBeDefined();
  await vi.advanceTimersByTimeAsync(2);
  expect(client.getQueryData(key)).toBeUndefined();
  client.clear();
});

it('cancels the underlying article fetch when its last viewer leaves', async () => {
  let signal: AbortSignal | undefined;
  const abort = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          abort();
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }),
  );
  const client = createQueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ['news-detail', 'test-article'],
    queryFn: ({ signal: requestSignal }) => api.newsDetail('test-article', requestSignal),
  });
  const stop = observer.subscribe(() => undefined);
  expect(signal?.aborted).toBe(false);
  stop();
  expect(signal?.aborted).toBe(true);
  expect(abort).toHaveBeenCalledOnce();
  expect(client.getQueryData(['news-detail', 'test-article'])).toBeUndefined();
  client.clear();
});
