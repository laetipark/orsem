import { queryOptions } from '@tanstack/react-query';
import { api, isTemporaryApiError } from './api';

export function sessionQueryOptions() {
  let consecutiveFailures = 0;
  return queryOptions({
    queryKey: ['session'],
    queryFn: async ({ signal }) => {
      try {
        const session = await api.session(signal);
        consecutiveFailures = 0;
        return session;
      } catch (error) {
        consecutiveFailures = isTemporaryApiError(error) ? consecutiveFailures + 1 : 0;
        throw error;
      }
    },
    // Surface an outage immediately; recover without requiring a page reload.
    retry: false,
    refetchInterval: (query) =>
      isTemporaryApiError(query.state.error)
        ? Math.min(5_000 * 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 3), 30_000)
        : 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
