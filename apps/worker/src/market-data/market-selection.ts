export interface FscStock {
  basDt: string;
  srtnCd: string;
  isinCd: string;
  itmsNm: string;
  mrktCtg: string;
  mrktTotAmt: string;
  clpr: string;
  lstgStCnt: string;
}
export interface SelectionCompany {
  id: string;
  stockCode: string;
  corpCode: string | null;
}
export interface StockClassification {
  isinCode: string;
  securityType: string;
  isCommonShare: boolean;
}

export function selectMarketLeaders(
  rows: FscStock[],
  companies: SelectionCompany[],
  types: StockClassification[],
) {
  const byCode = new Map(companies.map((c) => [c.stockCode, c]));
  const byIsin = new Map(types.map((t) => [t.isinCode, t]));
  const sorted = [...rows].sort((a, b) =>
    BigInt(a.mrktTotAmt) === BigInt(b.mrktTotAmt)
      ? a.isinCd.localeCompare(b.isinCd)
      : BigInt(a.mrktTotAmt) > BigInt(b.mrktTotAmt)
        ? -1
        : 1,
  );
  const seen = new Set<string>();
  const selected: Array<{ companyId: string; stockCode: string; marketCap: string; rank: number }> =
    [];
  for (const row of sorted) {
    const type = byIsin.get(row.isinCd);
    if (!type) throw new Error('상위 종목의 주식 유형 검증 대기');
    if (
      !type.isCommonShare ||
      ['ETF', 'FOREIGN_ETF', 'ETN', 'STOCK_WARRANTS', 'INFRASTRUCTURE_FUND', 'REIT'].includes(
        type.securityType,
      )
    )
      continue;
    if (!['STOCK'].includes(type.securityType)) throw new Error('주식 유형 확인 대기');
    const company = byCode.get(row.srtnCd);
    if (!company?.corpCode) throw new Error('상위 종목의 기업 식별 확인 대기');
    if (seen.has(company.corpCode)) continue;
    seen.add(company.corpCode);
    selected.push({
      companyId: company.id,
      stockCode: row.srtnCd,
      marketCap: row.mrktTotAmt,
      rank: selected.length + 1,
    });
    if (selected.length === 20) return selected;
  }
  throw new Error('검증된 기업 20개 미충족');
}

export function validateFscRows(rows: FscStock[], basisDate: string, totalCount: number) {
  if (
    !totalCount ||
    rows.length !== totalCount ||
    new Set(rows.map((row) => row.isinCd)).size !== totalCount
  )
    throw new Error('전체 시세 자료 검증 실패');
  for (const row of rows) {
    if (
      row.basDt !== basisDate ||
      !/^[0-9A-Z]{6}$/u.test(row.srtnCd) ||
      !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/u.test(row.isinCd) ||
      !/^\d{1,30}$/u.test(row.mrktTotAmt) ||
      !/^\d+$/u.test(row.clpr) ||
      !/^\d+$/u.test(row.lstgStCnt) ||
      BigInt(row.clpr) * BigInt(row.lstgStCnt) !== BigInt(row.mrktTotAmt)
    )
      throw new Error('시세 기준일 또는 시가총액 검증 실패');
  }
}

export type SelectionRegion = 'kr' | 'us';
export interface MonthlySelectionCompany {
  id: string;
  stockCode: string | null;
  ticker: string | null;
  corpCode: string | null;
  cik: string | null;
  market: string;
}
export interface SelectionListing extends StockClassification {
  name: string;
  symbol: string;
  requestedMarket: string;
}
export interface SelectionStock extends StockClassification {
  symbol: string;
  market: string;
  status: string;
  currency: string;
  sharesOutstanding: unknown;
}
export interface SelectionPrice {
  symbol: string;
  lastPrice: string;
  currency: string;
  timestamp?: string | null;
}
export const SELECTION_MARKETS = {
  kr: ['KOSPI', 'KOSDAQ', 'KR_ETC'],
  us: ['NASDAQ', 'NYSE', 'AMEX'],
} as const;
export const MONTHLY_SELECTION_METHOD =
  '월간 조회 시점 · 발행주식수 × 제공자 최종 거래가 · 상장 보통주 기준';
export function selectionMonth(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
}
export function shouldRefreshMonthlySelection(
  state: { selectionMonth?: string | null; last_attempt_at?: Date | string | null } | undefined,
  now: Date,
): boolean {
  if (state?.selectionMonth === selectionMonth(now)) return false;
  if (!state?.last_attempt_at) return true;
  return now.getTime() - new Date(state.last_attempt_at).getTime() >= 6 * 3600_000;
}
export function eligibleSelectionListings(listings: readonly SelectionListing[]) {
  return listings.filter(
    (row) =>
      row.isCommonShare &&
      row.securityType === 'STOCK' &&
      !/우선주|채권|워런트|\b(?:preferred|pfd|warrants?|notes?|nts|bonds?)\b/iu.test(row.name),
  );
}
const SCALE = 10n ** 12n;
function scaledPrice(value: string): bigint {
  if (!/^\d{1,18}(?:\.\d{1,12})?$/u.test(value)) throw new Error('시세 숫자 검증 실패');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0'));
}
function uniqueSymbols<T extends { symbol: string }>(items: readonly T[]) {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.symbol)) throw new Error('전체 종목 응답 중복');
    result.set(item.symbol, item);
  }
  return result;
}
/** Provider common-share universe only: ADR units are not documented and are never inferred. */
export function selectMonthlyMarketLeaders(input: {
  region: SelectionRegion;
  listings: readonly SelectionListing[];
  stocks: readonly SelectionStock[];
  prices: readonly SelectionPrice[];
  companies: readonly MonthlySelectionCompany[];
  observedAt: Date;
}) {
  const { region, listings, stocks, prices, companies, observedAt } = input;
  const markets: readonly string[] = SELECTION_MARKETS[region];
  const currency = region === 'kr' ? 'KRW' : 'USD';
  const listingMap = uniqueSymbols(listings);
  if (listings.length < 20 || listings.length > 30_000) throw new Error('전체 종목 수 검증 실패');
  const knownTypes = new Set([
    'STOCK',
    'FOREIGN_STOCK',
    'DEPOSITARY_RECEIPT',
    'INFRASTRUCTURE_FUND',
    'REIT',
    'ETF',
    'FOREIGN_ETF',
    'ETN',
    'STOCK_WARRANTS',
  ]);
  for (const listing of listingMap.values()) {
    if (
      !markets.includes(listing.requestedMarket) ||
      !knownTypes.has(listing.securityType) ||
      !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/u.test(listing.isinCode)
    )
      throw new Error('전체 종목 유형 또는 시장 검증 실패');
  }
  const eligible = eligibleSelectionListings(listings);
  const stockMap = uniqueSymbols(stocks),
    priceMap = uniqueSymbols(prices);
  if (
    stockMap.size !== eligible.length ||
    priceMap.size !== eligible.length ||
    new Set(eligible.map((row) => row.isinCode)).size !== eligible.length
  )
    throw new Error('전체 주식 또는 시세 응답 누락');
  const companiesBySymbol = new Map<string, MonthlySelectionCompany[]>();
  for (const company of companies) {
    if (
      !(region === 'kr' ? ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX', 'KR_ETC'] : markets).includes(
        company.market,
      )
    )
      continue;
    const symbol = region === 'kr' ? company.stockCode : company.ticker;
    if (symbol) companiesBySymbol.set(symbol, [...(companiesBySymbol.get(symbol) ?? []), company]);
  }
  // US/CA ISIN embeds CUSIP: the first six CUSIP characters identify its issuer.
  // A stored CIK joins classes across issuer codes, but never mutates company identity.
  const cikByCusip = new Map<string, string>();
  for (const listing of eligible) {
    const owners = companiesBySymbol.get(listing.symbol) ?? [];
    const cik = owners.length === 1 ? owners[0]?.cik : null;
    if (region === 'us' && cik && /^(US|CA)/u.test(listing.isinCode)) {
      const cusip = listing.isinCode.slice(2, 8),
        normalized = cik.padStart(10, '0');
      if (cikByCusip.has(cusip) && cikByCusip.get(cusip) !== normalized)
        throw new Error('발행자 식별 정보 충돌');
      cikByCusip.set(cusip, normalized);
    }
  }
  const excluded: Array<{
    symbol: string;
    reason: string;
    marketCapScaled: string;
    issuer: string;
  }> = [];
  const groups = new Map<
    string,
    Array<{
      symbol: string;
      company: MonthlySelectionCompany | null;
      cap: bigint;
      priceAt: string;
    }>
  >();
  for (const listing of eligible) {
    const stock = stockMap.get(listing.symbol),
      price = priceMap.get(listing.symbol);
    if (
      !stock ||
      !price ||
      stock.isinCode !== listing.isinCode ||
      stock.market !== listing.requestedMarket ||
      stock.securityType !== 'STOCK' ||
      !stock.isCommonShare ||
      stock.status !== 'ACTIVE' ||
      stock.currency !== currency ||
      price.currency !== currency ||
      typeof stock.sharesOutstanding !== 'string' ||
      !/^\d{1,30}$/u.test(stock.sharesOutstanding)
    )
      throw new Error('주식·시세 식별 또는 발행주식수 검증 실패');
    const shares = BigInt(stock.sharesOutstanding),
      cap = shares * scaledPrice(price.lastPrice);
    if (!shares || !cap) throw new Error('발행주식수 또는 가격 미제공 · 시총 상한 확인 불가');
    if (cap >= 10n ** 30n * SCALE) throw new Error('시가총액 범위 초과');
    const owners = companiesBySymbol.get(listing.symbol) ?? [];
    const company = owners.length === 1 ? owners[0]! : null;
    let issuer: string;
    if (region === 'kr')
      issuer = company?.corpCode ? `DART:${company.corpCode}` : `ISIN:${listing.isinCode}`;
    else {
      const cusip = /^(US|CA)/u.test(listing.isinCode) ? listing.isinCode.slice(2, 8) : null;
      const cik = cusip ? cikByCusip.get(cusip) : company?.cik?.padStart(10, '0');
      issuer = cik ? `SEC:${cik}` : cusip ? `CUSIP6:${cusip}` : `ISIN:${listing.isinCode}`;
    }
    const instant = price.timestamp ? Date.parse(price.timestamp) : NaN;
    if (Number.isFinite(instant) && instant > observedAt.getTime() + 5 * 60_000)
      throw new Error('미래 가격 시각 검증 실패');
    if (!Number.isFinite(instant) || observedAt.getTime() - instant > 14 * 86400_000) {
      excluded.push({
        symbol: listing.symbol,
        issuer,
        marketCapScaled: cap.toString(),
        reason: !Number.isFinite(instant) ? 'NO_PRICE_TIME' : 'STALE_PRICE',
      });
      continue;
    }
    groups.set(issuer, [
      ...(groups.get(issuer) ?? []),
      { symbol: listing.symbol, company, cap, priceAt: price.timestamp! },
    ]);
  }
  const ranked = [...groups.entries()]
    .map(([issuer, members]) => {
      members.sort((a, b) =>
        a.cap === b.cap ? a.symbol.localeCompare(b.symbol) : a.cap > b.cap ? -1 : 1,
      );
      return { issuer, members, cap: members.reduce((sum, member) => sum + member.cap, 0n) };
    })
    .sort((a, b) => (a.cap === b.cap ? a.issuer.localeCompare(b.issuer) : a.cap > b.cap ? -1 : 1));
  if (ranked.length < 20) throw new Error('검증된 기업 20개 미충족');
  const unverifiedTotals = new Map<string, bigint>();
  for (const row of excluded)
    unverifiedTotals.set(
      row.issuer,
      (unverifiedTotals.get(row.issuer) ?? 0n) + BigInt(row.marketCapScaled),
    );
  for (const [issuer, cap] of unverifiedTotals) {
    const verified = ranked.find((group) => group.issuer === issuer);
    if (cap + (verified?.cap ?? 0n) >= ranked[19]!.cap)
      throw new Error('확인 불가 종목의 시총이 선정 경계 이상');
  }
  const leaders = ranked.slice(0, 20).map((group, index) => {
    const representative = group.members[0]!;
    if (!representative.company || (region === 'kr' && !representative.company.corpCode))
      throw new Error('상위 기업 식별 확인 대기');
    return {
      companyId: representative.company.id,
      stockCode: representative.symbol,
      marketCap: (group.cap / SCALE).toString(),
      rank: index + 1,
      issuer: group.issuer,
      components: group.members.map((member) => ({
        companyId: member.company?.id ?? null,
        symbol: member.symbol,
        priceAt: member.priceAt,
        marketCapScaled: member.cap.toString(),
        scale: 12,
      })),
    };
  });
  if (new Set(leaders.map((row) => row.companyId)).size !== 20) throw new Error('대표 기업 중복');
  return {
    leaders,
    currency,
    eligibleCount: eligible.length,
    classificationExcluded: listings
      .filter((row) => !eligible.includes(row))
      .map((row) => ({
        symbol: row.symbol,
        name: row.name,
        securityType: row.securityType,
        isCommonShare: row.isCommonShare,
      })),
    excluded,
    issuerCount: ranked.length,
    reviewCandidates: ranked.slice(0, 40).map((group) => ({
      issuer: group.issuer,
      marketCap: (group.cap / SCALE).toString(),
      symbols: group.members.map((member) => member.symbol),
    })),
    quality: {
      excludedMaximumMarketCap: (
        excluded.reduce(
          (max, row) => (BigInt(row.marketCapScaled) > max ? BigInt(row.marketCapScaled) : max),
          0n,
        ) / SCALE
      ).toString(),
      cutoffMarketCap: (ranked[19]!.cap / SCALE).toString(),
      unknownShareCount: 0,
      pricedIssuerCount: ranked.length,
    },
  };
}
