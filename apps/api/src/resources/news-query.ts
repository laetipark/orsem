import { marketsForRegion, type Region } from '@orsem/contracts';
import { literalSearchPattern, newsTranslationSearchCondition } from '../common/news-translation';

export interface NewsFilters {
  q?: string;
  region?: Region;
  source?: unknown;
  sourceKind?: unknown;
  publisher?: unknown;
  companyId?: unknown;
}
export function newsKindSql(alias: string): string {
  return `COALESCE(${alias}.source_kind, CASE WHEN ${alias}.source IN ('OPENDART','SEC') THEN 'OFFICIAL_DISCLOSURE' WHEN ${alias}.source = 'IR' THEN 'COMPANY_IR' WHEN ${alias}.source = 'NEWS_RSS' THEN 'INDEPENDENT_MEDIA' ELSE 'UNKNOWN' END)`;
}
export function newsFiltersSql(alias: string, query: NewsFilters): string {
  const clauses = [
    `${alias}.source <> 'NAVER'`,
    `(${alias}.source_policy_json IS NULL OR JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true)`,
  ];
  if (query.companyId) clauses.push(`${alias}.company_id = :newsCompanyId`);
  if (query.source) clauses.push(`${alias}.source = :newsSource`);
  if (query.sourceKind) clauses.push(`${newsKindSql(alias)} = :newsKind`);
  if (query.publisher)
    clauses.push(
      `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_metadata_json, '$.publisherId')), ${alias}.source_name, ${alias}.source) = :newsPublisher`,
    );
  if (query.region && query.region !== 'all')
    clauses.push(
      `(EXISTS (SELECT 1 FROM companies nc WHERE nc.id = ${alias}.company_id AND nc.market IN (:...newsMarkets)) OR ${alias}.source = :newsRegionSource OR JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_metadata_json, '$.marketRegion')) IN ('global', :newsRegion))`,
    );
  if (query.q)
    clauses.push(
      `(${alias}.title LIKE :newsQuery ESCAPE '!' OR ${newsTranslationSearchCondition(alias, 'newsQuery')})`,
    );
  return clauses.join(' AND ');
}
export function newsFilterParameters(query: NewsFilters): Record<string, unknown> {
  return {
    newsCompanyId: query.companyId,
    newsSource: query.source,
    newsKind: query.sourceKind,
    newsPublisher: query.publisher,
    newsQuery: query.q ? literalSearchPattern(query.q) : undefined,
    newsMarkets: marketsForRegion(query.region ?? 'all'),
    newsRegion: query.region,
    newsRegionSource: query.region === 'kr' ? 'OPENDART' : 'SEC',
  };
}

export const NEWS_GROUP_SORT =
  'COALESCE(article.sort_at, source.published_at, source.first_observed_at)';
export const NEWS_GROUP_ID = 'COALESCE(source.news_article_id, source.id)';
export function representativeNewsSql(query: NewsFilters): string {
  // Prefer a direct source over an aggregator; preserve a stable tie breaker.
  return `NOT EXISTS (SELECT 1 FROM source_items duplicate WHERE source.news_article_id IS NOT NULL
    AND duplicate.news_article_id = source.news_article_id AND ${newsFiltersSql('duplicate', query)}
    AND ((duplicate.source = 'GDELT') < (source.source = 'GDELT')
      OR ((duplicate.source = 'GDELT') = (source.source = 'GDELT') AND
        (duplicate.first_observed_at < source.first_observed_at OR
         (duplicate.first_observed_at = source.first_observed_at AND duplicate.id < source.id)))))`;
}
