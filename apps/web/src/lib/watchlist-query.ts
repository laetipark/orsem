import { queryOptions } from '@tanstack/react-query';
import { api } from './api';

export function watchlistRoomsQuery(actor: string) {
  return queryOptions({
    queryKey: ['watchlist-v2', actor, 'rooms'],
    queryFn: ({ signal }) => api.watchlistRooms(signal),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function watchlistGroupsQuery(actor: string, roomId?: string) {
  return queryOptions({
    queryKey: ['watchlist-v2', actor, 'groups', roomId ?? 'personal'],
    queryFn: ({ signal }) => api.watchlistGroups(signal, roomId),
    refetchIntervalInBackground: false,
    retry: false,
  });
}
