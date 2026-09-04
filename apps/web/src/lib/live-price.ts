import type { CompanyLivePrice } from '../types';

export function effectiveLiveStatus(
  data: CompanyLivePrice | undefined,
  unavailable: boolean,
  elapsedSinceFetchMs: number,
): CompanyLivePrice['status'] {
  if (unavailable) return 'UNAVAILABLE';
  if (!data) return 'WAITING';
  if (data.status !== 'LIVE') return data.status;
  if (!data.quote) return 'WAITING';
  const age =
    Math.max(
      Date.parse(data.asOf) - Date.parse(data.quote.observedAt),
      Date.parse(data.asOf) - Date.parse(data.quote.providerAt),
    ) + Math.max(0, elapsedSinceFetchMs);
  return Number.isFinite(age) && age <= 15_000 ? 'LIVE' : 'STALE';
}
