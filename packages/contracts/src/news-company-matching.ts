import { companyRegion } from './region';

export const NEWS_MATCHER_VERSION = 1;
export interface NewsCompanyAlias {
  companyId: string;
  alias: string;
  aliasType: string;
}
export interface CompanyNames {
  id: string;
  nameKo: string;
  nameEn: string | null;
  ticker: string | null;
  stockCode: string | null;
}

export interface NewsBadgeCompanyNames extends CompanyNames {
  market: string | undefined;
  isListed: unknown;
}

/** Automatic badges use current listed securities and their registry names/symbols only.
 * Free-form alias rows have no review status and must not become evidence on their own.
 * This does not alter existing persisted relevance or the discovery/backfill matcher.
 */
export function newsBadgeCompanyAliases(
  companies: readonly NewsBadgeCompanyNames[],
): NewsCompanyAlias[] {
  const listed = companies.filter((company) => {
    if (![true, 1, '1'].includes(company.isListed as boolean | number | string)) return false;
    const region = companyRegion(company.market);
    return region === 'kr'
      ? /^[0-9A-Z]{6}$/u.test(company.stockCode ?? '')
      : region === 'us' && /^[A-Z][A-Z0-9.-]{0,14}$/u.test(company.ticker ?? '');
  });
  const domesticCodes = new Map(
    listed
      .filter((company) => companyRegion(company.market) === 'kr')
      .map((company) => [company.id, company.stockCode]),
  );
  return newsCompanyAliases(listed).map((alias) =>
    alias.aliasType === 'SYMBOL' && domesticCodes.get(alias.companyId) !== alias.alias
      ? { ...alias, aliasType: 'EXPLICIT_SYMBOL' }
      : alias,
  );
}
const AMBIGUOUS_NAMES = new Set([
  'apple',
  'meta',
  'target',
  'gap',
  'on',
  'arm',
  'block',
  'shell',
  'visa',
  'oracle',
  'amazon',
  '삼성',
  '현대',
  '기아',
]);

export function newsCompanyAliases(
  companies: readonly CompanyNames[],
  extras: readonly NewsCompanyAlias[] = [],
): NewsCompanyAlias[] {
  return companies
    .flatMap((company) => [
      ...[company.nameKo, company.nameEn].flatMap((name) => {
        if (!name) return [];
        const short = name
          .normalize('NFKC')
          .replace(/^(?:\(주\)|주식회사)\s*/u, '')
          .replace(
            /(?:,?\s+(?:incorporated|corporation|limited|company|corp|inc|ltd|plc|co)\.?)+$/iu,
            '',
          )
          .trim();
        return [...new Set([name, short])]
          .filter((alias) => alias.length >= 2)
          .map((alias) => ({ companyId: company.id, alias, aliasType: 'COMPANY_NAME' }));
      }),
      ...[company.ticker, company.stockCode].flatMap((alias) =>
        alias ? [{ companyId: company.id, alias, aliasType: 'SYMBOL' }] : [],
      ),
    ])
    .concat(extras);
}

/** Exact title evidence only. Query terms, article language and publishers do not imply relevance. */
export function createNewsCompanyMatcher(
  aliases: readonly NewsCompanyAlias[],
): (title: string) => string[] {
  const aliasOwners = new Map<string, Set<string>>();
  for (const item of aliases) {
    const key = `${/TICKER|SYMBOL|STOCK_CODE/i.test(item.aliasType) ? 'symbol' : 'name'}:${item.alias.normalize('NFKC').trim().toLowerCase()}`;
    const owners = aliasOwners.get(key) ?? new Set<string>();
    owners.add(item.companyId);
    aliasOwners.set(key, owners);
  }
  interface PreparedAlias {
    companyId: string;
    alias: string;
    folded: string;
    symbol: boolean;
    explicitSymbol: boolean;
    expression?: RegExp;
  }
  // Prefix buckets avoid compiling/executing every company's Unicode regex for every title.
  // The original boundary expressions still decide every match after this cheap candidate pass.
  const index = new Map<string, PreparedAlias[]>();
  const widths = new Set<number>();
  const seen = new Set<string>();
  const fold = (value: string): string => value.toLowerCase().replace(/ς/gu, 'σ');
  for (const item of aliases) {
    const alias = item.alias.normalize('NFKC').trim();
    const symbol = /TICKER|SYMBOL|STOCK_CODE/i.test(item.aliasType);
    if (alias.length < (symbol ? 1 : 2) || alias.length > 255) continue;
    const ownerKey = `${symbol ? 'symbol' : 'name'}:${alias.toLowerCase()}`;
    // Symbols and Korean mixed-script names retain their original case-sensitive expressions.
    const exactKey = `${symbol ? 'symbol' : 'name'}:${alias}`;
    if ((aliasOwners.get(ownerKey)?.size ?? 0) > 1 || seen.has(exactKey)) continue;
    seen.add(exactKey);
    if (
      !symbol &&
      (AMBIGUOUS_NAMES.has(alias.toLowerCase()) || (!/[가-힣]/u.test(alias) && alias.length < 3))
    )
      continue;
    const folded = fold(alias);
    const width = Math.min(6, folded.length);
    const key = folded.slice(0, width);
    const bucket = index.get(key) ?? [];
    bucket.push({
      companyId: item.companyId,
      alias,
      folded,
      symbol,
      explicitSymbol: item.aliasType === 'EXPLICIT_SYMBOL',
    });
    index.set(key, bucket);
    widths.add(width);
  }
  const prefixWidths = [...widths];
  const expressionFor = (item: PreparedAlias): RegExp => {
    if (item.expression) return item.expression;
    const escaped = item.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    item.expression = item.symbol
      ? new RegExp(
          // Badge-only symbols need a cashtag/exchange; parentheses often contain acronyms (DX).
          `(?:\\$|${item.explicitSymbol ? '' : '\\(|'}(?:NASDAQ|NYSE|AMEX|KRX)\\s*:\\s*)${escaped}(?=$|[^\\p{L}\\p{N}])`,
          'gu',
        )
      : /[가-힣]/u.test(item.alias)
        ? new RegExp(
            `(?<![\\p{L}\\p{N}])${escaped}(?![가-힣A-Za-z0-9])|(?<![\\p{L}\\p{N}])${escaped}(?=(?:은|는|이|가|의|와|과|도|를|에|에서|으로)(?:\\s|[,.:!?]|$))`,
            'gu',
          )
        : new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    return item.expression;
  };
  return (title: string): string[] => {
    const normalized = title.normalize('NFKC');
    const folded = fold(normalized);
    const candidates = new Set<PreparedAlias>();
    for (let offset = 0; offset < folded.length; offset++) {
      for (const width of prefixWidths) {
        if (offset + width > folded.length) continue;
        const bucket = index.get(folded.slice(offset, offset + width));
        if (!bucket) continue;
        for (const item of bucket) if (folded.startsWith(item.folded, offset)) candidates.add(item);
      }
    }
    const hits: { companyId: string; start: number; end: number; symbol: boolean }[] = [];
    for (const item of candidates) {
      for (const match of normalized.matchAll(expressionFor(item)))
        hits.push({
          companyId: item.companyId,
          start: match.index!,
          end: match.index! + match[0].length,
          symbol: item.symbol,
        });
    }
    // A shorter alias contained in another company's longer name is not separate evidence.
    return [
      ...new Set(
        hits
          .filter(
            (hit) =>
              !hits.some(
                (other) =>
                  other.companyId !== hit.companyId &&
                  !hit.symbol &&
                  !other.symbol &&
                  other.start <= hit.start &&
                  other.end >= hit.end &&
                  other.end - other.start > hit.end - hit.start,
              ),
          )
          .map((hit) => hit.companyId),
      ),
    ].sort();
  };
}

export function matchNewsCompanies(title: string, aliases: readonly NewsCompanyAlias[]): string[] {
  return createNewsCompanyMatcher(aliases)(title);
}

export function matchNewsCompany(
  title: string,
  aliases: readonly NewsCompanyAlias[],
): string | null {
  const ids = matchNewsCompanies(title, aliases);
  return ids.length === 1 ? ids[0]! : null;
}
