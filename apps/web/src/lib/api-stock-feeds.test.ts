import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it('never falls back to the whole news feed when recent history is empty', async () => {
  expect(await api.news({ companyIds: [], scope: 'company' })).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('passes multiple recent companies under company scope and keeps pagination', async () => {
  const signal = new AbortController().signal;
  await api.news(
    { companyIds: ['one', 'two'], scope: 'company', cursor: 'next', limit: 20 },
    signal,
  );
  const [url, init] = fetchMock.mock.calls[0]!;
  const parsed = new URL(String(url), 'http://test.local');
  expect(parsed.pathname).toBe('/api/v1/news');
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    companyIds: 'one,two',
    scope: 'company',
    cursor: 'next',
    limit: '20',
  });
  expect(init).toMatchObject({ signal, cache: 'no-store', credentials: 'include' });
});

it('requests arbitrary recently viewed companies through the general quote endpoint', async () => {
  await api.companyQuotes(['one', 'two']);
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/companies/quotes?ids=one%2Ctwo');
  fetchMock.mockClear();
  expect((await api.companyQuotes([])).items).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('requests one scoped group quote batch with credentials, no cache and cancellation', async () => {
  const signal = new AbortController().signal;
  await api.watchlistGroupQuotes('group/id', signal);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/watchlist-groups/group%2Fid/quotes');
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({
    signal,
    cache: 'no-store',
    credentials: 'include',
  });
});

it('keeps group and optional company filters on both news and filings requests', async () => {
  await api.watchlistGroupNews('group/id', { companyId: 'one', cursor: 'next' });
  await api.watchlistGroupFilings('group/id', 'one');
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/watchlist-groups/group%2Fid/news?limit=20&companyId=one&cursor=next',
    '/api/v1/watchlist-groups/group%2Fid/filings?companyId=one',
  ]);
});
