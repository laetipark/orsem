import type { CompanyAliasEntity } from '@orsem/database';

/** Title-only matching never assumes that the search query identifies the company. */
export function matchNewsCompany(
  title: string,
  aliases: readonly Pick<CompanyAliasEntity, 'companyId' | 'alias' | 'aliasType'>[],
): string | null {
  const normalized = title.normalize('NFKC');
  const companies = new Set<string>();
  for (const item of aliases) {
    const alias = item.alias.normalize('NFKC').trim();
    if (alias.length < 2 || alias.length > 255) continue;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isSymbol = /TICKER|SYMBOL|STOCK_CODE/i.test(item.aliasType);
    const matches = isSymbol
      ? new RegExp(`(?:\\$|\\(|NASDAQ:|NYSE:|KRX:)${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(
          normalized,
        )
      : /[가-힣]/u.test(alias)
        ? normalized.includes(alias)
        : alias.length >= 3 &&
          new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(normalized);
    if (matches) companies.add(item.companyId);
  }
  return companies.size === 1 ? [...companies][0]! : null;
}
