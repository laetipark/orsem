import {
  companyRegion,
  livePriceSnapshotSchema,
  type Company,
  type GroupDisplayPrice,
} from '@orsem/contracts';

export interface StoredGroupClose {
  sessionDate: string;
  close: number;
}
export function marketDate(now: Date, region: 'kr' | 'us' = 'kr'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: region === 'kr' ? 'Asia/Seoul' : 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function recentKstWindow(now: Date): {
  start: string;
  end: string;
  startInstant: string;
  endInstant: string;
} {
  const end = marketDate(now);
  const midnight = Date.parse(`${end}T00:00:00+09:00`);
  return {
    start: marketDate(new Date(midnight - 6 * 86400000)),
    end,
    startInstant: new Date(midnight - 6 * 86400000).toISOString(),
    endInstant: new Date(midnight + 86400000).toISOString(),
  };
}

/** Every percentage compares the displayed observation to its preceding completed session. */
export function groupDisplayPrice(
  company: Company,
  cached: { available: boolean; value: string | null },
  closes: StoredGroupClose[],
  configured: boolean,
  now: Date,
): GroupDisplayPrice {
  const region = companyRegion(company.market);
  if (!region)
    return {
      price: null,
      currency: null,
      status: 'UNAVAILABLE',
      basis: 'NONE',
      source: null,
      sessionDate: null,
      providerAt: null,
      referenceClose: null,
      referenceDate: null,
      change: null,
      changePercent: null,
    };
  const currency = region === 'us' ? 'USD' : 'KRW';
  const source = region === 'us' ? 'TOSS_US' : 'TOSS_KR';
  const today = marketDate(now, region);
  const completed = closes
    .filter((bar) => bar.sessionDate < today && Number.isFinite(bar.close) && bar.close > 0)
    .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));
  let result: GroupDisplayPrice = {
    price: null,
    currency,
    status: !configured ? 'NOT_CONFIGURED' : !cached.available ? 'UNAVAILABLE' : 'WAITING',
    basis: 'NONE',
    source: null,
    sessionDate: null,
    providerAt: null,
    referenceClose: null,
    referenceDate: null,
    change: null,
    changePercent: null,
  };
  if (configured && cached.available && cached.value) {
    try {
      const parsed = livePriceSnapshotSchema.safeParse(JSON.parse(cached.value));
      if (
        !parsed.success ||
        parsed.data.companyId !== company.id ||
        parsed.data.currency !== currency ||
        (parsed.data.source === 'TOSS_US') !== (region === 'us') ||
        parsed.data.rightsMode !== 'PRIVATE_DISPLAY_ONLY' ||
        Number(parsed.data.price) <= 0
      ) {
        result.status = 'UNAVAILABLE';
      } else {
        const quote = parsed.data;
        const age = Math.max(
          now.getTime() - Date.parse(quote.providerAt),
          now.getTime() - Date.parse(quote.observedAt),
        );
        const future =
          Math.min(
            now.getTime() - Date.parse(quote.providerAt),
            now.getTime() - Date.parse(quote.observedAt),
          ) < -5000;
        if (future) result.status = 'UNAVAILABLE';
        else {
          const status = age > 15000 ? 'STALE' : 'LIVE';
          result = {
            ...result,
            price: quote.price,
            status,
            basis: status,
            source: quote.source,
            sessionDate: marketDate(new Date(quote.providerAt), region),
            providerAt: quote.providerAt,
          };
        }
      }
    } catch {
      result.status = 'UNAVAILABLE';
    }
  }
  const close = completed[0];
  if (
    region === 'kr' &&
    close &&
    (result.price === null ||
      (result.sessionDate! < today && close.sessionDate >= result.sessionDate!))
  ) {
    result = {
      ...result,
      price: String(close.close),
      basis: 'CLOSE',
      source,
      sessionDate: close.sessionDate,
      providerAt: null,
    };
  }
  if (result.price === null || !result.sessionDate) return result;
  const reference = completed.find((bar) => bar.sessionDate < result.sessionDate!);
  if (!reference) return result;
  const change = Number(result.price) - reference.close;
  const percent = (change / reference.close) * 100;
  return {
    ...result,
    referenceClose: reference.close,
    referenceDate: reference.sessionDate,
    change: Number.isFinite(change) ? change : null,
    changePercent: Number.isFinite(percent) ? percent : null,
  };
}
