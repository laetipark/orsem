import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { expireNews, useNewsCacheExpiry } from './news-cache';

const now = Date.parse('2026-09-24T00:00:00Z');
const resultSet = (expiresAt = now + 10_000) => ({
  queryId: 'topic:kr-equities',
  queryLabel: '국내 증시',
  expiresAt: new Date(expiresAt).toISOString(),
  items: [
    {
      title: '<b>원문</b> &amp; 제목',
      description: '제공된 설명',
      link: 'https://example.test/news',
    },
  ],
});
afterEach(() => vi.useRealTimers());

it('removes expired provider result sets and their raw items without changing stored news or live provider sequence', () => {
  const current = resultSet();
  const stored = [{ id: 'stored', title: '보관 허용 뉴스' }];
  const value = { pages: [{ items: stored, providerResultSets: [resultSet(now), current] }] };
  const clean = expireNews(value, now) as typeof value;
  expect(clean.pages[0]!.providerResultSets).toEqual([current]);
  expect(clean.pages[0]!.providerResultSets[0]).toBe(current);
  expect(clean.pages[0]!.items).toBe(stored);
  expect(expireNews(clean, now)).toBe(clean);
});

it('purges raw results at the expiry boundary while the page remains mounted and idle', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['news', 'company-panel', 'company-id'];
  const value = { pages: [{ items: [{ id: 'stored' }], providerResultSets: [resultSet()] }] };
  client.setQueryData(key, value);
  const { unmount } = renderHook(useNewsCacheExpiry, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  act(() => vi.advanceTimersByTime(9_999));
  expect(client.getQueryData(key)).toBe(value);
  act(() => vi.advanceTimersByTime(1));
  const clean = client.getQueryData<typeof value>(key)!;
  expect(clean.pages[0]!.providerResultSets).toEqual([]);
  expect(clean.pages[0]!.items).toBe(value.pages[0]!.items);
  unmount();
  client.clear();
});

it('reschedules on new query data and purges immediately when a sleeping tab becomes visible', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const client = new QueryClient();
  const key = ['dashboard', 'personal-news'];
  const { unmount } = renderHook(useNewsCacheExpiry, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  act(() => client.setQueryData(key, { providerResultSets: [resultSet()] }));
  vi.setSystemTime(now + 20_000);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(client.getQueryData(key)).toEqual({ providerResultSets: [] });
  unmount();
  client.clear();
});

it('preserves server freshness when expiring results so returning to stale news still refetches', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  const key = ['news', 'market'];
  const value = { items: [{ id: 'stored' }], providerResultSets: [resultSet()] };
  const fetchedAt = now - 40_000;
  client.setQueryData(key, value, { updatedAt: fetchedAt });
  const { unmount } = renderHook(useNewsCacheExpiry, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  act(() => vi.advanceTimersByTime(10_000));
  expect(client.getQueryData(key)).toEqual({ items: value.items, providerResultSets: [] });
  expect(client.getQueryState(key)?.dataUpdatedAt).toBe(fetchedAt);
  const fetch = vi.fn(async () => ({ ...value, providerResultSets: [resultSet(now + 60_000)] }));
  await act(async () => {
    await client.fetchQuery({ queryKey: key, queryFn: fetch });
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(client.getQueryState(key)?.dataUpdatedAt).toBe(now + 10_000);
  unmount();
  client.clear();
});

it('immediately strips expired incoming results without a cache update loop and keeps the next deadline', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const client = new QueryClient();
  const key = ['watchlist-v2', 'member', 'group-news', 'group'];
  const { unmount } = renderHook(useNewsCacheExpiry, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  const updates = vi.fn();
  const stop = client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'success') updates();
  });
  const current = resultSet(now + 10_000);
  act(() => {
    client.setQueryData(key, { providerResultSets: [resultSet(now - 1), current] });
  });
  expect(client.getQueryData(key)).toEqual({ providerResultSets: [current] });
  expect(updates).toHaveBeenCalledTimes(2);
  act(() => vi.advanceTimersByTime(10_000));
  expect(client.getQueryData(key)).toEqual({ providerResultSets: [] });
  expect(updates).toHaveBeenCalledTimes(3);
  expect(client.getQueryState(key)?.dataUpdatedAt).toBe(now);
  stop();
  unmount();
  client.clear();
});
