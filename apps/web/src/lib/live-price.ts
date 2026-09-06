import type { CompanyLivePrice } from '../types';

const kstDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function domesticFallbackClose(
  data: Pick<CompanyLivePrice, 'quote' | 'fallbackClose'> | undefined,
  market: string,
  now = Date.now(),
) {
  const close = data?.fallbackClose;
  if (!close || !['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(market)) return null;
  const today = kstDate.format(now);
  if (
    close.currency !== 'KRW' ||
    close.source !== 'TOSS_KR' ||
    !Number.isFinite(Number(close.price)) ||
    Number(close.price) <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(close.sessionDate) ||
    close.sessionDate >= today
  ) {
    return null;
  }
  if (!data.quote) return close;
  const quoteAt = Date.parse(data.quote.providerAt);
  return data.quote.currency === 'KRW' &&
    Number.isFinite(quoteAt) &&
    kstDate.format(quoteAt) < today
    ? close
    : null;
}

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
