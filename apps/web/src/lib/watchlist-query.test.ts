import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { watchlistGroupsQuery, watchlistRoomsQuery } from './watchlist-query';

const clients: QueryClient[] = [];

afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.restoreAllMocks();
});

it('shares a room request across views and cancels it only after the last view leaves', () => {
  let signal: AbortSignal | undefined;
  const request = vi.spyOn(api, 'watchlistRooms').mockImplementation((requestSignal) => {
    signal = requestSignal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  });
  const client = new QueryClient();
  clients.push(client);
  const sidebar = new QueryObserver(client, watchlistRoomsQuery('actor-a'));
  const panel = new QueryObserver(client, watchlistRoomsQuery('actor-a'));
  const stopSidebar = sidebar.subscribe(() => undefined);
  const stopPanel = panel.subscribe(() => undefined);

  expect(request).toHaveBeenCalledOnce();
  expect(signal?.aborted).toBe(false);
  stopSidebar();
  expect(signal?.aborted).toBe(false);
  stopPanel();
  expect(signal?.aborted).toBe(true);
  expect(client.getQueryData(['watchlist-v2', 'actor-a', 'rooms'])).toBeUndefined();
});

it('keeps group results separate for each account and room while reusing the same scope', async () => {
  const request = vi.spyOn(api, 'watchlistGroups').mockImplementation(async () => ({
    items: [],
    revision: request.mock.calls.length,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  }));
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  clients.push(client);

  const personal = await client.fetchQuery(watchlistGroupsQuery('actor-a'));
  const room = await client.fetchQuery(watchlistGroupsQuery('actor-a', 'room-one'));
  const otherActor = await client.fetchQuery(watchlistGroupsQuery('actor-b', 'room-one'));
  const cachedPersonal = await client.fetchQuery(watchlistGroupsQuery('actor-a'));

  expect([personal.revision, room.revision, otherActor.revision]).toEqual([1, 2, 3]);
  expect(cachedPersonal).toBe(personal);
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls.map(([, roomId]) => roomId)).toEqual([
    undefined,
    'room-one',
    'room-one',
  ]);
  expect(request.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
  expect(client.getQueryData(['watchlist-v2', 'actor-a', 'groups', 'personal'])).toBe(personal);
  expect(client.getQueryData(['watchlist-v2', 'actor-a', 'groups', 'room-one'])).toBe(room);
  expect(client.getQueryData(['watchlist-v2', 'actor-b', 'groups', 'room-one'])).toBe(otherActor);
});
