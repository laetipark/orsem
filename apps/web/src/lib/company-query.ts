import { queryOptions } from '@tanstack/react-query';
import { api } from './api';

export const companyMarketRefreshInterval = 2_000;

export function companyQuery(address: string) {
  return queryOptions({
    queryKey: ['company', address],
    queryFn: ({ signal }) => api.company(address, signal),
    enabled: Boolean(address),
  });
}

export function companyTimelineQuery(id: string, range: string, interval: '1d' | '1m') {
  return queryOptions({
    queryKey: ['company-timeline', id, range, interval],
    queryFn: ({ signal }) => api.companyTimeline(id, range, interval, signal),
    enabled: Boolean(id),
    refetchInterval: companyMarketRefreshInterval,
    refetchIntervalInBackground: false,
  });
}

export function companyLivePriceQuery(id: string) {
  return queryOptions({
    queryKey: ['company-live-price', id],
    queryFn: ({ signal }) => api.companyLivePrice(id, signal),
    enabled: Boolean(id),
    refetchInterval: companyMarketRefreshInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function companyInformationQuery(id: string) {
  return queryOptions({
    queryKey: ['company-information', id],
    queryFn: ({ signal }) => api.companyInformation(id, signal),
    staleTime: 60_000,
  });
}
