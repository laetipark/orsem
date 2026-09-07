export interface ProviderNewsSymbol {
  symbol: string;
  country?: string | null;
  exchange?: string | null;
}

export interface NewsEntityCompany {
  id: string;
  ticker: string | null;
  stockCode: string | null;
  market: string;
  isListed: boolean;
}

export type UnresolvedNewsEntityReason =
  'INVALID_SYMBOL' | 'UNSUPPORTED_MARKET' | 'CONFLICTING_MARKET' | 'NOT_FOUND' | 'AMBIGUOUS';

export interface ProviderNewsEntityResolution {
  companyIds: string[];
  resolved: Array<{ symbol: string; canonicalId: string; companyId: string }>;
  unresolved: Array<ProviderNewsSymbol & { reason: UnresolvedNewsEntityReason }>;
}

const US_MARKETS = new Set(['NASDAQ', 'NYSE', 'AMEX']);
const KR_MARKETS = new Set(['KOSPI', 'KOSDAQ', 'KRX']);
const EXCHANGES: Readonly<Record<string, string>> = {
  NASDAQ: 'NASDAQ',
  NASDAQGS: 'NASDAQ',
  NASDAQGM: 'NASDAQ',
  NASDAQCM: 'NASDAQ',
  XNAS: 'NASDAQ',
  NYSE: 'NYSE',
  XNYS: 'NYSE',
  AMEX: 'AMEX',
  XASE: 'AMEX',
  'NYSE AMERICAN': 'AMEX',
  KOSPI: 'KOSPI',
  KOSDAQ: 'KOSDAQ',
  KRX: 'KRX',
};

/** Resolve against the existing master only. This function cannot create or mutate companies. */
export function resolveProviderNewsEntities(
  symbols: readonly ProviderNewsSymbol[],
  companies: readonly NewsEntityCompany[],
): ProviderNewsEntityResolution {
  const result: ProviderNewsEntityResolution = { companyIds: [], resolved: [], unresolved: [] };
  const listed = companies.filter((company) => company.isListed);
  const seen = new Set<string>();
  for (const input of symbols) {
    const identity = JSON.stringify([input.symbol, input.country ?? null, input.exchange ?? null]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const unresolved = (reason: UnresolvedNewsEntityReason) =>
      result.unresolved.push({ ...input, reason });
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol || symbol.length > 64 || /\s/u.test(symbol)) {
      unresolved('INVALID_SYMBOL');
      continue;
    }
    const countryText = input.country?.trim().toUpperCase();
    const country = ['US', 'USA'].includes(countryText ?? '')
      ? 'US'
      : ['KR', 'KOR'].includes(countryText ?? '')
        ? 'KR'
        : null;
    const exchangeText = input.exchange?.trim().toUpperCase();
    const exchange = exchangeText ? EXCHANGES[exchangeText] : undefined;
    if ((countryText && !country) || (exchangeText && !exchange)) {
      unresolved('UNSUPPORTED_MARKET');
      continue;
    }
    const prefix = /^(US|KR):(.+)$/u.exec(symbol);
    const localSymbol = prefix?.[2] ?? symbol;
    const suffix = /^(\d{6})\.(KS|KQ)$/u.exec(localSymbol);
    const suffixMarket =
      suffix?.[2] === 'KS' ? 'KOSPI' : suffix?.[2] === 'KQ' ? 'KOSDAQ' : undefined;
    const exchangeCountry = exchange ? (US_MARKETS.has(exchange) ? 'US' : 'KR') : null;
    const countries = new Set(
      [country, exchangeCountry, prefix?.[1], suffix ? 'KR' : undefined].filter(Boolean),
    );
    if (
      countries.size > 1 ||
      (suffixMarket && exchange && exchange !== 'KRX' && exchange !== suffixMarket)
    ) {
      unresolved('CONFLICTING_MARKET');
      continue;
    }
    const region = [...countries][0] ?? 'US';
    let matches: NewsEntityCompany[];
    let canonicalId: string;
    if (region === 'KR') {
      const stockCode = suffix?.[1] ?? localSymbol;
      if (!/^\d{6}$/u.test(stockCode)) {
        unresolved('INVALID_SYMBOL');
        continue;
      }
      const market = suffixMarket ?? (exchange !== 'KRX' ? exchange : undefined);
      const candidates = listed.filter(
        (company) => KR_MARKETS.has(company.market) && company.stockCode === stockCode,
      );
      matches = market ? candidates.filter((company) => company.market === market) : candidates;
      // An unclassified KRX record is a compatibility fallback, never a second master.
      if (market && !matches.length && !candidates.some((company) => company.market !== 'KRX'))
        matches = candidates.filter((company) => company.market === 'KRX');
      canonicalId = `KR:${stockCode}`;
    } else {
      // A numeric code without explicit Korean metadata must not be assumed to be KRX.
      if (!/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/u.test(localSymbol) || localSymbol.length > 32) {
        unresolved('INVALID_SYMBOL');
        continue;
      }
      matches = listed.filter(
        (company) =>
          US_MARKETS.has(company.market) &&
          (!exchange || company.market === exchange) &&
          company.ticker?.toUpperCase() === localSymbol,
      );
      canonicalId = `US:${localSymbol}`;
    }
    const uniqueMatches = [...new Map(matches.map((company) => [company.id, company])).values()];
    if (uniqueMatches.length !== 1) {
      unresolved(uniqueMatches.length ? 'AMBIGUOUS' : 'NOT_FOUND');
      continue;
    }
    result.resolved.push({ symbol: input.symbol, canonicalId, companyId: uniqueMatches[0]!.id });
  }
  result.companyIds = [...new Set(result.resolved.map(({ companyId }) => companyId))].sort();
  return result;
}
