import { QueryClient } from '@tanstack/react-query';

export function createQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });
  // Large page data is reusable while navigating, then released once unused.
  for (const key of [
    'news',
    'news-detail',
    'search',
    'events',
    'event',
    'company',
    'company-timeline',
    'company-live-price',
    'market-history',
  ]) {
    client.setQueryDefaults([key], { gcTime: 120_000 });
  }
  return client;
}
