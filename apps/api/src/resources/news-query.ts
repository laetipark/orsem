import { marketsForRegion, type Region } from '@orsem/contracts';
import { literalSearchPattern, newsTranslationSearchCondition } from '../common/news-translation';

export interface NewsFilters {
  scope?: unknown;
  asset?: unknown;
  personalActorKey?: string;
  q?: string;
  region?: Region;
  source?: unknown;
  sourceKind?: unknown;
  publisher?: unknown;
  companyId?: unknown;
}

export function gdeltMetadataSql(alias: string): string {
  return `(${alias}.source IN ('GDELT','ALPACA_NEWS') AND ${alias}.rights_mode = 'STORE_METADATA_ONLY'
    AND JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_metadata_json, '$.rightsContext')) = 'APPROVED_PUBLISHER_METADATA'
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.fullTextStorageAllowed') = false
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.aiAllowed') = false)`;
}

export function visibleNewsSql(contentAlias: string, sourceAlias: string): string {
  return metadataNewsSql(sourceAlias);
}

export function companyRelevanceSql(alias: string, companyId = false, region = false): string {
  return `EXISTS (SELECT 1 FROM news_source_companies relevance JOIN source_items relevance_source ON relevance_source.id = relevance.source_item_id ${region ? 'JOIN companies relevance_company ON relevance_company.id = relevance.company_id' : ''} WHERE (relevance.source_item_id = ${alias}.id OR (${alias}.news_article_id IS NOT NULL AND relevance_source.news_article_id = ${alias}.news_article_id))${companyId ? ' AND relevance.company_id = :newsCompanyId' : ''}${region ? ' AND relevance_company.market IN (:...newsMarkets)' : ''})`;
}

export const PUBLIC_NEWS_PUBLISHERS = [
  'samsung-global-newsroom',
  'federal-reserve',
  'bls',
  'eia',
] as const;

function newsPublisherSql(alias: string): string {
  return `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_metadata_json, '$.publisherId')), ${alias}.source_name, ${alias}.source)`;
}

export function newsKindSql(alias: string): string {
  return `COALESCE(${alias}.source_kind, CASE WHEN ${alias}.source IN ('OPENDART','SEC') THEN 'OFFICIAL_DISCLOSURE' WHEN ${alias}.source = 'IR' THEN 'COMPANY_IR' WHEN ${alias}.source = 'NEWS_RSS' THEN 'INDEPENDENT_MEDIA' ELSE 'UNKNOWN' END)`;
}
export function visibleEventSourceSql(alias: string): string {
  return `${alias}.source NOT LIKE 'NAVER%'
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true
    AND ${newsKindSql(alias)} IN ('OFFICIAL_DISCLOSURE', 'OFFICIAL_RELEASE', 'COMPANY_IR')`;
}
export function newsFiltersSql(alias: string, query: NewsFilters): string {
  const clauses = [
    `${alias}.source NOT LIKE 'NAVER%'`,
    `JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true`,
    `JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true`,
    `((${newsKindSql(alias)} IN ('OFFICIAL_RELEASE', 'COMPANY_IR') AND ${newsPublisherSql(alias)} IN (${PUBLIC_NEWS_PUBLISHERS.map((value) => `'${value}'`).join(', ')})) OR ${gdeltMetadataSql(alias)})`,
  ];
  if (query.personalActorKey)
    clauses.push(`EXISTS (
    SELECT 1 FROM news_source_companies personal_relevance
    JOIN source_items personal_source ON personal_source.id=personal_relevance.source_item_id
    JOIN watchlist_group_items personal_item ON personal_item.company_id=personal_relevance.company_id
    JOIN watchlist_groups personal_group ON personal_group.id=personal_item.group_id
    WHERE personal_group.room_id IS NULL AND personal_group.owner_key=:personalActorKey
      AND (personal_relevance.source_item_id=${alias}.id OR (${alias}.news_article_id IS NOT NULL AND personal_source.news_article_id=${alias}.news_article_id)))`);
  if (query.companyId) clauses.push(companyRelevanceSql(alias, true));
  if (query.asset) clauses.push('1 = 0'); // Asset feeds are transient Naver snapshots only.
  if (query.scope === 'market')
    clauses.push(`${newsPublisherSql(alias)} IN ('federal-reserve', 'bls')`);
  if (query.scope === 'company') clauses.push(companyRelevanceSql(alias));
  if (query.source) clauses.push(`${alias}.source = :newsSource`);
  if (query.sourceKind) clauses.push(`${newsKindSql(alias)} = :newsKind`);
  if (query.publisher) clauses.push(`${newsPublisherSql(alias)} = :newsPublisher`);
  if (query.region && query.region !== 'all')
    clauses.push(
      `(${companyRelevanceSql(alias, false, true)} OR (NOT (${companyRelevanceSql(alias)}) AND (${alias}.source = :newsRegionSource OR JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_metadata_json, '$.marketRegion')) IN ('global', :newsRegion))))`,
    );
  if (query.q)
    clauses.push(
      `(${alias}.title LIKE :newsQuery ESCAPE '!' OR ${newsTranslationSearchCondition(alias, 'newsQuery')})`,
    );
  return clauses.join(' AND ');
}
export function newsFilterParameters(query: NewsFilters): Record<string, unknown> {
  return {
    personalActorKey: query.personalActorKey,
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

export function metadataNewsSql(sourceAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(sourceAlias)) throw new Error('Invalid news source identifier.');
  return `JSON_UNQUOTE(JSON_EXTRACT(${sourceAlias}.source_policy_json, '$.rightsMode')) = ${sourceAlias}.rights_mode
    AND JSON_EXTRACT(${sourceAlias}.source_policy_json, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${sourceAlias}.source_policy_json, '$.displayAllowed') = true`;
}

/** Compatibility alias: body availability no longer determines metadata visibility. */
export function availableNewsContentSql(_contentAlias: string, sourceAlias: string): string {
  return metadataNewsSql(sourceAlias);
}

export function representativeNewsSql(query: NewsFilters, sourceAlias = 'source'): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(sourceAlias))
    throw new Error('Invalid representative news alias.');
  return `NOT EXISTS (SELECT 1 FROM source_items duplicate WHERE ${sourceAlias}.news_article_id IS NOT NULL
    AND duplicate.news_article_id = ${sourceAlias}.news_article_id AND ${newsFiltersSql('duplicate', query)}
    AND ${metadataNewsSql('duplicate')}
    AND ((duplicate.source IN ('GDELT','ALPACA_NEWS')) < (${sourceAlias}.source IN ('GDELT','ALPACA_NEWS'))
      OR ((duplicate.source IN ('GDELT','ALPACA_NEWS')) = (${sourceAlias}.source IN ('GDELT','ALPACA_NEWS')) AND
        (duplicate.first_observed_at < ${sourceAlias}.first_observed_at OR
         (duplicate.first_observed_at = ${sourceAlias}.first_observed_at AND duplicate.id < ${sourceAlias}.id)))))`;
}
