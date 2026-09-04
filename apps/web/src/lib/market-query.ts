import { queryOptions } from '@tanstack/react-query';
import type { Region } from '../types';
import { api } from './api';

export function marketOverviewQuery(region: Region) {
  return queryOptions({
    queryKey: ['markets', region],
    queryFn: () => api.markets(region),
    refetchInterval: 60_000,
  });
}
