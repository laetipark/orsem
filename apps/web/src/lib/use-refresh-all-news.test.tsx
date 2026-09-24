import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRefreshAllNews } from './use-refresh-all-news';

interface Page {
  items: string[];
  nextCursor: string | null;
}

let client: QueryClient;
function wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

it('restarts from the first page and follows every cursor while replacing the previous cached pages', async () => {
  const fetchPage = vi
    .fn<(cursor: string | null, signal: AbortSignal) => Promise<Page>>()
    .mockResolvedValueOnce({ items: ['latest'], nextCursor: 'older' })
    .mockResolvedValueOnce({ items: ['older'], nextCursor: 'oldest' })
    .mockResolvedValueOnce({ items: ['oldest'], nextCursor: null });
  const queryKey = ['news', 'group'];
  client.setQueryData(queryKey, {
    pages: [{ items: ['stale'], nextCursor: null }],
    pageParams: [null],
  });
  const { result } = renderHook(() => useRefreshAllNews({ queryKey, fetchPage }), { wrapper });

  await act(() => result.current.refreshAll());

  expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'older', 'oldest']);
  expect(client.getQueryData(queryKey)).toEqual({
    pages: [
      { items: ['latest'], nextCursor: 'older' },
      { items: ['older'], nextCursor: 'oldest' },
      { items: ['oldest'], nextCursor: null },
    ],
    pageParams: [null, 'older', 'oldest'],
  });
  expect(result.current.isRefreshing).toBe(false);
  expect(result.current.error).toBeNull();
});

it('ignores repeated clicks until the existing refresh finishes', async () => {
  let resolve!: (page: Page) => void;
  const fetchPage = vi.fn(() => new Promise<Page>((done) => (resolve = done)));
  const { result } = renderHook(() => useRefreshAllNews({ queryKey: ['news'], fetchPage }), {
    wrapper,
  });
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.refreshAll();
    void result.current.refreshAll();
  });
  await waitFor(() => expect(fetchPage).toHaveBeenCalledOnce());
  expect(result.current.isRefreshing).toBe(true);
  await act(async () => {
    resolve({ items: ['one'], nextCursor: null });
    await pending;
  });
  expect(result.current.isRefreshing).toBe(false);
});

it('retains fetched pages after a failure and retries from the first page', async () => {
  const fetchPage = vi
    .fn<(cursor: string | null, signal: AbortSignal) => Promise<Page>>()
    .mockResolvedValueOnce({ items: ['first'], nextCursor: 'second' })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({ items: ['new first'], nextCursor: 'new second' })
    .mockResolvedValueOnce({ items: ['new second'], nextCursor: null });
  const { result } = renderHook(() => useRefreshAllNews({ queryKey: ['news'], fetchPage }), {
    wrapper,
  });
  await act(() => result.current.refreshAll());
  expect(client.getQueryData<InfiniteData<Page>>(['news'])?.pages).toEqual([
    { items: ['first'], nextCursor: 'second' },
  ]);
  expect(result.current.error?.message).toBe('network');
  expect(result.current.isRefreshing).toBe(false);

  await act(() => result.current.refreshAll());
  expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([
    null,
    'second',
    null,
    'new second',
  ]);
  expect(result.current.error).toBeNull();
  expect(client.getQueryData<InfiniteData<Page>>(['news'])?.pages.at(-1)?.items).toEqual([
    'new second',
  ]);
});

it('aborts a previous scope and discards its late response after a filter change', async () => {
  let resolveOld!: (page: Page) => void;
  let oldSignal!: AbortSignal;
  const fetchOld = vi.fn((_cursor: string | null, signal: AbortSignal) => {
    oldSignal = signal;
    return new Promise<Page>((done) => (resolveOld = done));
  });
  const fetchNew = vi.fn(async () => ({ items: ['new group'], nextCursor: null }));
  const { result, rerender } = renderHook(
    ({ group }) =>
      useRefreshAllNews({
        queryKey: ['news', group],
        fetchPage: group === 'old' ? fetchOld : fetchNew,
      }),
    { wrapper, initialProps: { group: 'old' } },
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.refreshAll();
  });
  await waitFor(() => expect(fetchOld).toHaveBeenCalledOnce());
  rerender({ group: 'new' });
  expect(oldSignal.aborted).toBe(true);
  expect(result.current.isRefreshing).toBe(false);
  await act(() => result.current.refreshAll());
  await act(async () => {
    resolveOld({ items: ['old group'], nextCursor: 'ignored' });
    await pending;
  });
  expect(client.getQueryData(['news', 'old'])).toBeUndefined();
  expect(client.getQueryData<InfiniteData<Page>>(['news', 'new'])?.pages[0]?.items).toEqual([
    'new group',
  ]);
  expect(fetchOld).toHaveBeenCalledOnce();
});

it('aborts refreshes on unmount and stops repeated cursor cycles', async () => {
  const fetchPage = vi.fn<(cursor: string | null, signal: AbortSignal) => Promise<Page>>(
    async () => ({ items: ['one'], nextCursor: 'same' }),
  );
  const { result, unmount } = renderHook(
    () => useRefreshAllNews({ queryKey: ['news'], fetchPage }),
    { wrapper },
  );
  await act(() => result.current.refreshAll());
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(result.current.error?.message).toContain('반복');
  let signal!: AbortSignal;
  fetchPage.mockImplementation(
    (...args: unknown[]) =>
      new Promise<Page>((_resolve, reject) => {
        signal = args[1] as AbortSignal;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.refreshAll();
  });
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal.aborted).toBe(true);
  await pending;
});

it('clears cancelled progress when a disabled feed becomes enabled again', async () => {
  let signal!: AbortSignal;
  const fetchPage = vi
    .fn<(cursor: string | null, signal: AbortSignal) => Promise<Page>>()
    .mockImplementationOnce(
      (_cursor, requestSignal) =>
        new Promise<Page>((_resolve, reject) => {
          signal = requestSignal;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    )
    .mockResolvedValueOnce({ items: ['resumed'], nextCursor: null });
  const { result, rerender } = renderHook(
    ({ enabled }) => useRefreshAllNews({ queryKey: ['news'], fetchPage, enabled }),
    { wrapper, initialProps: { enabled: true } },
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.refreshAll();
  });
  await waitFor(() => expect(signal).toBeDefined());
  rerender({ enabled: false });
  await act(async () => {
    await pending;
  });
  expect(signal.aborted).toBe(true);
  rerender({ enabled: true });
  expect(result.current.isRefreshing).toBe(false);
  await act(() => result.current.refreshAll());
  expect(client.getQueryData<InfiniteData<Page>>(['news'])?.pages[0]?.items).toEqual(['resumed']);
});
