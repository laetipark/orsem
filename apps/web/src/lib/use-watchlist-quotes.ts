import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { CompanyQuote, WatchlistGroupItem } from '../types';
import { api } from './api';
import { mergeWatchlistQuotes, type WatchlistQuoteBatch } from './watchlist-quote-merge';

export interface WatchlistQuotesOptions {
  actor: string;
  roomId?: string;
  groupId?: string;
  recentIds?: readonly string[];
  companyIds?: readonly string[];
  fallbackItems?: readonly CompanyQuote[];
  enabled: boolean;
}

export function useWatchlistQuotes({
  actor,
  roomId,
  groupId,
  recentIds = [],
  companyIds,
  fallbackItems = [],
  enabled,
}: WatchlistQuotesOptions) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const canPoll = enabled && Boolean(groupId || recentIds.length);
  const queryKey = groupId
    ? ['watchlist-v2', actor, 'quotes', roomId ?? 'personal', groupId]
    : ['company-quotes', actor, 'floating', recentIds];
  const queryHash = hashKey(queryKey);
  const query = useQuery<WatchlistQuoteBatch>({
    queryKey,
    queryFn: ({ signal }) =>
      groupId ? api.watchlistGroupQuotes(groupId, signal) : api.companyQuotes(recentIds, signal),
    enabled: canPoll,
    refetchInterval: canPoll ? 2_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    structuralSharing: (previous, next) =>
      mergeWatchlistQuotes(
        previous as WatchlistQuoteBatch | undefined,
        next as WatchlistQuoteBatch,
        fallbackItems,
        groupId ? companyIds : recentIds,
      ),
  });

  useEffect(() => {
    if (!canPoll) return;
    return () => {
      // Disabling an observer does not cancel its request automatically. Match the
      // captured key so a selection change never cancels the next group's fetch.
      void queryClient.cancelQueries({ predicate: (entry) => entry.queryHash === queryHash });
    };
  }, [canPoll, queryClient, queryHash]);

  useEffect(() => {
    if (!canPoll) return;
    setNow(Date.now());
    // Keep the age moving even if the next network request never completes.
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [canPoll]);

  return {
    ...query,
    elapsedSinceFetchMs: query.dataUpdatedAt ? Math.max(0, now - query.dataUpdatedAt) : 0,
  };
}

export function staleWatchlistPrice(
  price: WatchlistGroupItem['displayPrice'],
  unavailable: boolean,
  freshness?: { asOf: string; elapsedMs: number },
): WatchlistGroupItem['displayPrice'] {
  // Compare source times to the server's response time; only elapsed time uses
  // the browser clock, whose absolute time can differ substantially.
  const age = freshness
    ? Math.max(0, Date.parse(freshness.asOf) - Date.parse(price.providerAt ?? '')) +
      Math.max(0, freshness.elapsedMs)
    : 0;
  const expired = freshness !== undefined && (!Number.isFinite(age) || age > 15_000);
  if ((!unavailable && !expired) || (price.status !== 'LIVE' && price.basis !== 'LIVE')) {
    return price;
  }
  return {
    ...price,
    status: price.status === 'LIVE' ? 'STALE' : price.status,
    basis: price.basis === 'LIVE' ? 'STALE' : price.basis,
  };
}
