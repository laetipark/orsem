import type { CompanyQuote } from '../types';

export interface WatchlistQuoteBatch {
  asOf: string;
  items: CompanyQuote[];
}

type DisplayPrice = CompanyQuote['displayPrice'];

function validDate(value: string | null): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function instant(value: string | null | undefined): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !validDate(value.slice(0, 10))
  ) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function currency(price: DisplayPrice | undefined) {
  return price?.currency === 'KRW' || price?.currency === 'USD' ? price.currency : undefined;
}

function usable(quote: CompanyQuote | undefined): quote is CompanyQuote {
  if (!quote) return false;
  const price = quote.displayPrice;
  if (
    !price ||
    typeof price !== 'object' ||
    typeof price.price !== 'string' ||
    !Number.isFinite(Number(price.price)) ||
    Number(price.price) <= 0 ||
    !currency(price) ||
    !validDate(price.sessionDate)
  ) {
    return false;
  }
  // Connector availability is separate from a valid completed-session close.
  if (price.basis === 'CLOSE') return true;
  return (
    (price.basis === 'LIVE' || price.basis === 'STALE') &&
    (price.status === 'LIVE' || price.status === 'STALE') &&
    Number.isFinite(instant(price.providerAt))
  );
}

/** Only compare validated observations for the same company and currency. */
function compare(next: DisplayPrice, previous: DisplayPrice): number {
  const session = next.sessionDate!.localeCompare(previous.sessionDate!);
  if (session !== 0) return session;
  if (next.basis === 'CLOSE') return previous.basis === 'CLOSE' ? 0 : 1;
  if (previous.basis === 'CLOSE') return -1;
  return instant(next.providerAt) - instant(previous.providerAt);
}

function retained(quote: CompanyQuote): CompanyQuote {
  const price = quote.displayPrice;
  if (price.status !== 'LIVE' && price.basis !== 'LIVE') return quote;
  return {
    ...quote,
    displayPrice: {
      ...price,
      status: price.status === 'LIVE' ? 'STALE' : price.status,
      basis: price.basis === 'LIVE' ? 'STALE' : price.basis,
    },
  };
}

export function mergeWatchlistQuotes(
  previous: WatchlistQuoteBatch | undefined,
  next: WatchlistQuoteBatch,
  fallbackItems: readonly CompanyQuote[] = [],
  companyIds?: readonly string[],
): WatchlistQuoteBatch {
  const previousTime = instant(previous?.asOf);
  const nextTime = instant(next.asOf);
  const asOf =
    Number.isFinite(nextTime) && (!Number.isFinite(previousTime) || nextTime >= previousTime)
      ? next.asOf
      : Number.isFinite(previousTime)
        ? previous!.asOf
        : undefined;
  if (!asOf) throw new TypeError('시세 확인 시각이 올바르지 않습니다.');

  const previousById = new Map(previous?.items.map((item) => [item.companyId, item]));
  const nextById = new Map(next.items.map((item) => [item.companyId, item]));
  const fallbackById = new Map(fallbackItems.map((item) => [item.companyId, item]));
  const ids = [
    ...new Set(companyIds ?? [...nextById.keys(), ...previousById.keys(), ...fallbackById.keys()]),
  ].slice(0, 200);
  const items: CompanyQuote[] = [];

  for (const id of ids) {
    const old = previousById.get(id);
    const fallback = fallbackById.get(id);
    const expectedCurrency = currency(old?.displayPrice) ?? currency(fallback?.displayPrice);
    const compatible = (quote: CompanyQuote) =>
      expectedCurrency === undefined || quote.displayPrice.currency === expectedCurrency;
    let baseline = usable(old) ? old : undefined;
    if (
      usable(fallback) &&
      compatible(fallback) &&
      (!baseline || compare(fallback.displayPrice, baseline.displayPrice) > 0)
    ) {
      baseline = fallback;
    }

    const candidate = nextById.get(id);
    if (
      usable(candidate) &&
      compatible(candidate) &&
      (!baseline || compare(candidate.displayPrice, baseline.displayPrice) >= 0)
    ) {
      items.push(candidate);
    } else if (baseline) {
      items.push(retained(baseline));
    }
  }

  return { asOf, items };
}
