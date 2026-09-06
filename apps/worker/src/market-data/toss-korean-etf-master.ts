import { Market } from '@orsem/contracts';
import type { CompanyEntity } from '@orsem/database';
import type { TossListedStock } from './toss-market.client';

export const KR_ETF_MARKETS = ['KOSPI', 'KOSDAQ', 'KR_ETC'] as const;
export type KoreanEtfMarket = (typeof KR_ETF_MARKETS)[number];
export interface KoreanEtfUniverse {
  readonly market: KoreanEtfMarket;
  readonly status: 'ACTIVE' | 'DELISTED';
  readonly rows: readonly TossListedStock[];
}
export interface KoreanEtfIdentity {
  readonly companyId: string;
  readonly symbol: string;
  readonly isinCode: string;
  readonly market: KoreanEtfMarket;
  readonly managedCompany: boolean;
  readonly appliedNameKo?: string | null;
}
export type EtfCompany = Pick<
  CompanyEntity,
  'id' | 'market' | 'stockCode' | 'corpCode' | 'cik' | 'ticker' | 'nameKo' | 'nameEn' | 'isListed'
>;
export interface KoreanEtfAction {
  readonly kind: 'CREATE' | 'REFRESH' | 'OBSERVE' | 'DELIST';
  readonly stock: TossListedStock;
  readonly market: KoreanEtfMarket;
  readonly company: EtfCompany | null;
  readonly patch: Partial<Pick<CompanyEntity, 'nameKo' | 'isListed'>>;
  readonly managedCompany: boolean;
}
export const etfCompanyMarket = (market: KoreanEtfMarket): Market =>
  market === 'KR_ETC' ? Market.KRX : market === 'KOSDAQ' ? Market.KOSDAQ : Market.KOSPI;

function stockIdentity(stock: Pick<TossListedStock, 'symbol' | 'isinCode'>): string {
  return `${stock.symbol}:${stock.isinCode}`;
}
function sameName(left: string, right: string): boolean {
  return left.normalize('NFKC').replace(/\s/gu, '') === right.normalize('NFKC').replace(/\s/gu, '');
}
export function koreanEtfDisplayName(name: string): string {
  return [...name.replace(/\p{Cc}/gu, '').trim()].slice(0, 255).join('');
}

/** The endpoint returns a complete market response without pagination. Validate every response
 * before any company changes; missing rows are never delisting evidence. */
export function validateKoreanEtfUniverse(
  snapshots: readonly KoreanEtfUniverse[],
  previousActiveCount = 0,
): { active: number; delisted: number } {
  if (!Number.isInteger(previousActiveCount) || previousActiveCount < 0)
    throw new Error('ETF_PREVIOUS_SNAPSHOT_INVALID');
  if (snapshots.length !== 6) throw new Error('ETF_MARKET_SNAPSHOT_INCOMPLETE');
  const streams = new Set<string>();
  const symbols = new Set<string>();
  const isinCodes = new Set<string>();
  let active = 0;
  let delisted = 0;
  for (const snapshot of snapshots) {
    const stream = `${snapshot.market}:${snapshot.status}`;
    if (
      !KR_ETF_MARKETS.includes(snapshot.market) ||
      !['ACTIVE', 'DELISTED'].includes(snapshot.status) ||
      streams.has(stream) ||
      snapshot.rows.length > 20_000
    )
      throw new Error('ETF_MARKET_SNAPSHOT_INVALID');
    streams.add(stream);
    for (const stock of snapshot.rows) {
      if (
        stock.securityType !== 'ETF' ||
        !/^[0-9A-Z]{6}$/u.test(stock.symbol) ||
        !/^KR[0-9A-Z]{9}[0-9]$/u.test(stock.isinCode) ||
        !koreanEtfDisplayName(stock.name) ||
        symbols.has(`${snapshot.status}:${stock.symbol}`) ||
        isinCodes.has(stock.isinCode)
      )
        throw new Error('ETF_STOCK_IDENTITY_INVALID');
      symbols.add(`${snapshot.status}:${stock.symbol}`);
      isinCodes.add(stock.isinCode);
      if (snapshot.status === 'ACTIVE') active++;
      else delisted++;
    }
  }
  if (!active || (previousActiveCount > 0 && active < previousActiveCount * 0.8))
    throw new Error('ETF_ACTIVE_SNAPSHOT_SHRANK');
  return { active, delisted };
}

/** Preserve pre-existing issuers, market identities and manually maintained company names. */
export function planKoreanEtfMaster(
  snapshots: readonly KoreanEtfUniverse[],
  companies: readonly EtfCompany[],
  identities: readonly KoreanEtfIdentity[],
): { actions: KoreanEtfAction[]; conflicts: number; missingRetained: number } {
  const bySymbol = new Map<string, EtfCompany[]>();
  for (const company of companies) {
    if (!company.stockCode) continue;
    const rows = bySymbol.get(company.stockCode) ?? [];
    rows.push(company);
    bySymbol.set(company.stockCode, rows);
  }
  const identityByCompany = new Map(identities.map((identity) => [identity.companyId, identity]));
  const activeIdentities = new Set<string>();
  const delisted = new Map<string, { stock: TossListedStock; market: KoreanEtfMarket }>();
  const actions: KoreanEtfAction[] = [];
  let conflicts = 0;
  let missingRetained = 0;
  for (const snapshot of snapshots) {
    for (const stock of snapshot.rows) {
      if (snapshot.status === 'DELISTED') {
        delisted.set(stockIdentity(stock), { stock, market: snapshot.market });
        continue;
      }
      activeIdentities.add(stockIdentity(stock));
      const candidates = bySymbol.get(stock.symbol) ?? [];
      const company = candidates[0];
      const identity = company ? identityByCompany.get(company.id) : undefined;
      if (
        candidates.length > 1 ||
        (company &&
          (company.corpCode ||
            company.cik ||
            company.ticker ||
            (company.market !== etfCompanyMarket(snapshot.market) &&
              company.market !== Market.KRX) ||
            (identity &&
              (identity.isinCode !== stock.isinCode ||
                identity.symbol !== stock.symbol ||
                identity.market !== snapshot.market)) ||
            (!identity && !sameName(company.nameKo, stock.name))))
      ) {
        conflicts++;
        continue;
      }
      if (!company) {
        actions.push({
          kind: 'CREATE',
          stock,
          market: snapshot.market,
          company: null,
          patch: { nameKo: koreanEtfDisplayName(stock.name), isListed: true },
          managedCompany: true,
        });
      } else {
        const managed = identity?.managedCompany === true;
        actions.push({
          kind: managed ? 'REFRESH' : 'OBSERVE',
          stock,
          market: snapshot.market,
          company,
          managedCompany: managed,
          patch: managed
            ? {
                isListed: true,
                ...(company.nameKo === identity.appliedNameKo
                  ? { nameKo: koreanEtfDisplayName(stock.name) }
                  : {}),
              }
            : {},
        });
      }
    }
  }
  for (const identity of identities) {
    if (!identity.managedCompany || activeIdentities.has(stockIdentity(identity))) continue;
    const company = companies.find((row) => row.id === identity.companyId);
    if (!company?.isListed) continue;
    const confirmed = delisted.get(`${identity.symbol}:${identity.isinCode}`);
    if (
      !confirmed ||
      confirmed.market !== identity.market ||
      company.stockCode !== identity.symbol ||
      company.market !== etfCompanyMarket(identity.market) ||
      company.corpCode ||
      company.cik ||
      company.ticker
    ) {
      missingRetained++;
      continue;
    }
    actions.push({
      kind: 'DELIST',
      stock: confirmed.stock,
      market: confirmed.market,
      company,
      patch: { isListed: false },
      managedCompany: true,
    });
  }
  return { actions, conflicts, missingRetained };
}
