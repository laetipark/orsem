import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanyQuote } from '../types';
import { api } from './api';
import {
  staleWatchlistPrice,
  useWatchlistQuotes,
  type WatchlistQuotesOptions,
} from './use-watchlist-quotes';

vi.mock('./api', () => ({
  api: {
    watchlistGroupQuotes: vi.fn(),
    companyQuotes: vi.fn(),
  },
}));

const livePrice: CompanyQuote['displayPrice'] = {
  price: '71200',
  currency: 'KRW',
  status: 'LIVE',
  basis: 'LIVE',
  source: 'TOSS_KR',
  sessionDate: '2026-09-08',
  providerAt: '2026-09-08T02:00:00.000Z',
  referenceClose: 70000,
  referenceDate: '2026-09-07',
  change: 1200,
  changePercent: 1.714,
};
const quotes = {
  asOf: '2026-09-08T02:00:01.000Z',
  items: [{ companyId: 'company-1', displayPrice: livePrice }],
};
const clients: QueryClient[] = [];

function setup(options: Partial<WatchlistQuotesOptions> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  clients.push(client);
  const initialProps: WatchlistQuotesOptions = {
    actor: 'member-1',
    groupId: 'group-1',
    enabled: true,
    ...options,
  };
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    initialProps,
    ...renderHook((props: WatchlistQuotesOptions) => useWatchlistQuotes(props), {
      initialProps,
      wrapper,
    }),
  };
}

async function advance(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  vi.mocked(api.watchlistGroupQuotes).mockResolvedValue(quotes);
  vi.mocked(api.companyQuotes).mockResolvedValue(quotes);
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('fetches immediately, polls once every two seconds and releases data on unmount', async () => {
  const { result, client, unmount } = setup();
  await advance();
  expect(result.current.data).toEqual(quotes);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(1);
  await advance(1_999);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(2);
  await advance(2_000);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(3);
  unmount();
  await advance(4_000);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(3);
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});

it('does not overlap slow requests', async () => {
  let finish!: (value: typeof quotes) => void;
  vi.mocked(api.watchlistGroupQuotes).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = setup();
  await advance(6_000);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(quotes);
  });
  await advance();
  expect(result.current.data).toEqual(quotes);
  await advance(2_000);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(2);
});

it('cancels an in-flight request while hidden and fetches immediately when enabled again', async () => {
  const signals: AbortSignal[] = [];
  vi.mocked(api.watchlistGroupQuotes).mockImplementation((_id, signal) => {
    signals.push(signal!);
    return new Promise(() => undefined);
  });
  const { initialProps, rerender, unmount } = setup();
  expect(signals).toHaveLength(1);
  rerender({ ...initialProps, enabled: false });
  expect(signals[0]?.aborted).toBe(true);
  await advance(6_000);
  expect(signals).toHaveLength(1);
  rerender(initialProps);
  expect(signals).toHaveLength(2);
  expect(signals[1]?.aborted).toBe(false);
  unmount();
  expect(signals[1]?.aborted).toBe(true);
});

it('cancels only the previous selection when switching group, room, or actor', async () => {
  const signals: AbortSignal[] = [];
  vi.mocked(api.watchlistGroupQuotes).mockImplementation((_id, signal) => {
    signals.push(signal!);
    return new Promise(() => undefined);
  });
  const { initialProps, rerender, client } = setup();
  const unrelatedSignal: AbortSignal[] = [];
  void client
    .fetchQuery({
      queryKey: ['watchlist-v2', 'someone-else', 'quotes', 'personal', 'other-group'],
      queryFn: ({ signal }) => {
        unrelatedSignal.push(signal);
        return new Promise(() => undefined);
      },
    })
    .catch(() => undefined);
  rerender({ ...initialProps, groupId: 'group-2' });
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  rerender({ ...initialProps, groupId: 'group-2', roomId: 'room-2' });
  expect(signals[1]?.aborted).toBe(true);
  expect(signals[2]?.aborted).toBe(false);
  rerender({ ...initialProps, groupId: 'group-2', roomId: 'room-2', actor: 'member-2' });
  expect(signals[2]?.aborted).toBe(true);
  expect(signals[3]?.aborted).toBe(false);
  expect(unrelatedSignal[0]?.aborted).toBe(false);
  await advance();
});

it('does not show quotes from the previous selection while the next group loads', async () => {
  const { result, initialProps, rerender } = setup();
  await advance();
  expect(result.current.data).toEqual(quotes);
  vi.mocked(api.watchlistGroupQuotes).mockImplementation(() => new Promise(() => undefined));
  rerender({ ...initialProps, groupId: 'group-2' });
  expect(result.current.data).toBeUndefined();
});

it('refreshes immediately on resume even with a cached successful response', async () => {
  const { initialProps, rerender } = setup();
  await advance();
  rerender({ ...initialProps, enabled: false });
  await advance(8_000);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(1);
  rerender(initialProps);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(2);
});

it('uses the recent-companies endpoint and keeps an identical ID selection stable', async () => {
  const recentQuotes = {
    ...quotes,
    items: [{ companyId: 'a', displayPrice: livePrice }],
  };
  vi.mocked(api.companyQuotes).mockResolvedValue(recentQuotes);
  const { client, initialProps, rerender } = setup({ groupId: undefined, recentIds: ['a', 'b'] });
  await advance();
  expect(api.companyQuotes).toHaveBeenCalledWith(['a', 'b'], expect.any(AbortSignal));
  expect(api.watchlistGroupQuotes).not.toHaveBeenCalled();
  rerender({ ...initialProps, recentIds: ['a', 'b'] });
  await advance();
  expect(api.companyQuotes).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(['company-quotes', 'member-1', 'floating', ['a', 'b']])).toEqual(
    recentQuotes,
  );
  rerender({ ...initialProps, recentIds: ['b'] });
  expect(api.companyQuotes).toHaveBeenCalledTimes(2);
});

it.each(['group', 'recent'] as const)(
  'updates only usable %s quotes and resumes unavailable stocks when their prices recover',
  async (scope) => {
    const fetchQuotes = vi.mocked(scope === 'group' ? api.watchlistGroupQuotes : api.companyQuotes);
    const secondPrice = { ...livePrice, price: '82000', change: 12000 };
    fetchQuotes.mockResolvedValue({
      ...quotes,
      items: [...quotes.items, { companyId: 'company-2', displayPrice: secondPrice }],
    });
    const { result } = setup(
      scope === 'group'
        ? { companyIds: ['company-1', 'company-2'] }
        : { groupId: undefined, recentIds: ['company-1', 'company-2'] },
    );
    await advance();
    const updatedPrice = {
      ...livePrice,
      price: '71300',
      change: 1300,
      providerAt: '2026-09-08T02:00:02.000Z',
    };
    fetchQuotes.mockResolvedValue({
      asOf: '2026-09-08T02:00:03.000Z',
      items: [
        { companyId: 'company-1', displayPrice: updatedPrice },
        {
          companyId: 'company-2',
          displayPrice: { ...secondPrice, price: null, basis: 'NONE', status: 'UNAVAILABLE' },
        },
      ],
    });
    await advance(2_000);
    expect(result.current.data?.items).toEqual([
      { companyId: 'company-1', displayPrice: updatedPrice },
      {
        companyId: 'company-2',
        displayPrice: { ...secondPrice, status: 'STALE', basis: 'STALE' },
      },
    ]);
    expect(result.current.isError).toBe(false);

    const recoveredPrice = {
      ...secondPrice,
      price: '82100',
      change: 12100,
      providerAt: '2026-09-08T02:00:04.000Z',
    };
    fetchQuotes.mockResolvedValue({
      asOf: '2026-09-08T02:00:05.000Z',
      items: [{ companyId: 'company-2', displayPrice: recoveredPrice }],
    });
    await advance(2_000);
    expect(result.current.data?.items).toEqual([
      {
        companyId: 'company-1',
        displayPrice: { ...updatedPrice, status: 'STALE', basis: 'STALE' },
      },
      { companyId: 'company-2', displayPrice: recoveredPrice },
    ]);
    expect(fetchQuotes).toHaveBeenCalledTimes(3);
  },
);

it('retains the initial displayed price on an unavailable response and drops removed group members', async () => {
  vi.mocked(api.watchlistGroupQuotes).mockResolvedValue({ ...quotes, items: [] });
  const { result, initialProps, rerender } = setup({
    companyIds: ['company-1'],
    fallbackItems: quotes.items,
  });
  await advance();
  expect(result.current.data?.items).toEqual([
    { companyId: 'company-1', displayPrice: { ...livePrice, status: 'STALE', basis: 'STALE' } },
  ]);
  // A later metadata refresh with no usable price cannot erase the retained quote.
  rerender({ ...initialProps, fallbackItems: [] });
  await advance(2_000);
  expect(result.current.data?.items[0]?.displayPrice.price).toBe('71200');
  rerender({ ...initialProps, companyIds: [], fallbackItems: [] });
  await advance(2_000);
  expect(result.current.data?.items).toEqual([]);
});

it('does not fetch for an empty selection or when disabled', async () => {
  const { initialProps, rerender } = setup({ groupId: undefined, recentIds: [] });
  await advance(4_000);
  rerender({ ...initialProps, groupId: 'group-1', enabled: false });
  await advance(4_000);
  expect(api.watchlistGroupQuotes).not.toHaveBeenCalled();
  expect(api.companyQuotes).not.toHaveBeenCalled();
});

it('skips interval fetches when the browser document is hidden', async () => {
  setup();
  await advance();
  act(() => focusManager.setFocused(false));
  await advance(4_000);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(1);
});

it('keeps the last quote and error without retries until the next polling interval', async () => {
  const { result } = setup();
  await advance();
  const error = new Error('시세를 확인할 수 없습니다');
  vi.mocked(api.watchlistGroupQuotes).mockRejectedValue(error);
  await advance(2_000);
  expect(result.current.data).toEqual(quotes);
  expect(result.current.error).toBe(error);
  expect(result.current.dataUpdatedAt).toBeLessThan(result.current.errorUpdatedAt);
  await advance(1_500);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(2);
  await advance(500);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(3);
});

it('ages the last successful quote into stale while the next request hangs', async () => {
  vi.setSystemTime(new Date('2035-03-02T09:00:00.000Z'));
  const { result } = setup();
  await advance();
  const dataUpdatedAt = result.current.dataUpdatedAt;
  vi.mocked(api.watchlistGroupQuotes).mockImplementation(() => new Promise(() => undefined));
  const currentPrice = () =>
    staleWatchlistPrice(result.current.data!.items[0]!.displayPrice, result.current.isError, {
      asOf: result.current.data!.asOf,
      elapsedMs: result.current.elapsedSinceFetchMs,
    });
  // A client clock years ahead must not make a fresh server quote stale.
  expect(currentPrice().status).toBe('LIVE');
  await advance(13_999);
  expect(result.current.elapsedSinceFetchMs).toBe(14_000);
  expect(currentPrice().status).toBe('LIVE');
  await advance(1_000);
  expect(currentPrice()).toEqual({ ...livePrice, status: 'STALE', basis: 'STALE' });
  expect(result.current.dataUpdatedAt).toBe(dataUpdatedAt);
  expect(result.current.isFetching).toBe(true);
  expect(result.current.isError).toBe(false);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(2);
});

it('stops the age clock while disabled and accounts for time away on resume', async () => {
  const { result, initialProps, rerender } = setup();
  await advance(1_000);
  const ageBeforeHiding = result.current.elapsedSinceFetchMs;
  rerender({ ...initialProps, enabled: false });
  await advance(20_000);
  expect(result.current.elapsedSinceFetchMs).toBe(ageBeforeHiding);
  vi.mocked(api.watchlistGroupQuotes).mockImplementation(() => new Promise(() => undefined));
  rerender(initialProps);
  expect(result.current.elapsedSinceFetchMs).toBeGreaterThanOrEqual(21_000);
  expect(api.watchlistGroupQuotes).toHaveBeenCalledTimes(2);
});

it.each([null, 'invalid timestamp'])(
  'treats a live quote with missing or invalid source time (%s) as stale',
  (providerAt) => {
    expect(
      staleWatchlistPrice({ ...livePrice, providerAt }, false, {
        asOf: quotes.asOf,
        elapsedMs: 0,
      }),
    ).toEqual({ ...livePrice, providerAt, status: 'STALE', basis: 'STALE' });
  },
);

it('uses the response and source time for freshness and does not advance a future source timestamp', () => {
  expect(
    staleWatchlistPrice(livePrice, false, {
      asOf: '2026-09-08T02:00:16.000Z',
      elapsedMs: 0,
    }).status,
  ).toBe('STALE');
  expect(
    staleWatchlistPrice(livePrice, false, {
      asOf: '2026-09-08T01:59:59.000Z',
      elapsedMs: 15_001,
    }).status,
  ).toBe('STALE');
  expect(staleWatchlistPrice(livePrice, false, { asOf: 'invalid', elapsedMs: 0 }).status).toBe(
    'STALE',
  );
});

it('downgrades a failed live quote without changing its value, currency, or provenance', () => {
  expect(staleWatchlistPrice(livePrice, true)).toEqual({
    ...livePrice,
    status: 'STALE',
    basis: 'STALE',
  });
  expect(staleWatchlistPrice(livePrice, false)).toBe(livePrice);
  const closePrice = { ...livePrice, status: 'WAITING' as const, basis: 'CLOSE' as const };
  expect(staleWatchlistPrice(closePrice, true)).toBe(closePrice);
  expect(livePrice.status).toBe('LIVE');
});
