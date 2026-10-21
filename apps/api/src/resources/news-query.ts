import { marketsForRegion, type Region } from '@orsem/contracts';
import { newsAudienceSql, type NewsAudience } from './news-access';
import { literalSearchPattern, newsTranslationSearchCondition } from '../common/news-translation';

export interface NewsFilters {
  audience?: NewsAudience;
  scope?: unknown;
  asset?: unknown;
  personalActorKey?: string;
  q?: string;
  region?: Region;
  source?: unknown;
  sourceKind?: unknown;
  publisher?: unknown;
  companyId?: unknown;
  companyIds?: string[];
}

export function gdeltMetadataSql(alias: string): string {
  return `(${alias}.source IN ('GDELT','ALPACA_NEWS','MARKETAUX','ALPHAVANTAGE','FINNHUB') AND ${alias}.rights_mode = 'STORE_METADATA_ONLY'
    AND JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_metadata_json, '$.rightsContext')) = 'APPROVED_PUBLISHER_METADATA'
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.fullTextStorageAllowed') = false
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.aiAllowed') = false)`;
}

export function visibleNewsSql(contentAlias: string, sourceAlias: string): string {
  return metadataNewsSql(sourceAlias);
}

export function companyRelevanceSql(
  alias: string,
  companyId = false,
  region = false,
  audience: NewsAudience = 'MEMBER_UI',
): string {
  return `EXISTS (SELECT 1 FROM news_source_companies relevance JOIN source_items relevance_source ON relevance_source.id = relevance.source_item_id ${region ? 'JOIN companies relevance_company ON relevance_company.id = relevance.company_id' : ''} WHERE ${newsAudienceSql('relevance_source', audience)} AND ${metadataNewsSql('relevance_source')} AND (relevance.source_item_id = ${alias}.id OR (${alias}.news_article_id IS NOT NULL AND relevance_source.news_article_id = ${alias}.news_article_id))${companyId ? ' AND relevance.company_id = :newsCompanyId' : ''}${region ? ' AND relevance_company.market IN (:...newsMarkets)' : ''})`;
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
export function visibleEventSourceSql(alias: string, audience: NewsAudience = 'MEMBER_UI'): string {
  return `${alias}.source NOT LIKE 'NAVER%'
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true
    AND ${newsAudienceSql(alias, audience)}
    AND ${newsKindSql(alias)} IN ('OFFICIAL_DISCLOSURE', 'OFFICIAL_RELEASE', 'COMPANY_IR')`;
}

/** An event summary may contain facts from every member; hide mixed events before counting. */
export function eventAudienceSql(alias: string, audience: NewsAudience = 'MEMBER_UI'): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(alias)) throw new Error('Invalid event identifier.');
  const denied = `COALESCE((${newsAudienceSql('audience_source', audience)}), false) = false`;
  // Keep each membership path as a primary-key join. An OR between the direct
  // and news-item paths makes MySQL scan source_items for every candidate event.
  // Both anti-joins remain necessary: one restricted member hides the whole event.
  return `(NOT EXISTS (SELECT 1 FROM event_cluster_items audience_item
    JOIN source_items audience_source ON audience_source.id=audience_item.item_id
    WHERE audience_item.event_cluster_id=${alias}.id AND audience_item.item_type='SOURCE_ITEM'
      AND ${denied})
    AND NOT EXISTS (SELECT 1 FROM event_cluster_items audience_item
    JOIN news_items audience_news ON audience_news.id=audience_item.item_id
    JOIN source_items audience_source ON audience_source.id=audience_news.source_item_id
    WHERE audience_item.event_cluster_id=${alias}.id AND audience_item.item_type='NEWS_ITEM'
      AND ${denied}))`;
}
export function newsFiltersSql(alias: string, query: NewsFilters): string {
  const clauses = [
    newsAudienceSql(alias, query.audience),
    `JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true`,
    `JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true`,
    `((${newsKindSql(alias)} IN ('OFFICIAL_RELEASE', 'COMPANY_IR') AND ${newsPublisherSql(alias)} IN (${PUBLIC_NEWS_PUBLISHERS.map((value) => `'${value}'`).join(', ')})) OR ${gdeltMetadataSql(alias)} OR (JSON_EXTRACT(${alias}.source_policy_json, '$.policyVersion') = 2 AND ${newsKindSql(alias)} IN ('COMPANY_IR','PRESS_RELEASE','INDEPENDENT_MEDIA','AGGREGATOR')))`,
  ];
  if (query.personalActorKey)
    clauses.push(`EXISTS (
    SELECT 1 FROM news_source_companies personal_relevance
    JOIN source_items personal_source ON personal_source.id=personal_relevance.source_item_id
    JOIN watchlist_group_items personal_item ON personal_item.company_id=personal_relevance.company_id
    JOIN watchlist_groups personal_group ON personal_group.id=personal_item.group_id
    WHERE ${newsAudienceSql('personal_source', query.audience)} AND ${metadataNewsSql('personal_source')} AND personal_group.room_id IS NULL AND personal_group.owner_key=:personalActorKey
      AND (personal_relevance.source_item_id=${alias}.id OR (${alias}.news_article_id IS NOT NULL AND personal_source.news_article_id=${alias}.news_article_id)))`);
  if (query.companyId) clauses.push(companyRelevanceSql(alias, true, false, query.audience));
  if (query.companyIds !== undefined)
    clauses.push(
      query.companyIds.length
        ? `EXISTS (SELECT 1 FROM news_source_companies selected_relevance
          JOIN source_items selected_source ON selected_source.id=selected_relevance.source_item_id
          WHERE ${newsAudienceSql('selected_source', query.audience)} AND ${metadataNewsSql('selected_source')}
          AND selected_relevance.company_id IN (:...newsCompanyIds)
          AND (selected_relevance.source_item_id=${alias}.id OR (${alias}.news_article_id IS NOT NULL AND selected_source.news_article_id=${alias}.news_article_id)))`
        : '1 = 0',
    );
  if (query.asset)
    clauses.push(
      `JSON_CONTAINS(JSON_EXTRACT(${alias}.raw_metadata_json, '$.topicIds'), :newsAssetTopic)`,
    );
  if (query.scope === 'market')
    clauses.push(
      `(${newsPublisherSql(alias)} IN ('federal-reserve', 'bls') OR JSON_CONTAINS(JSON_EXTRACT(${alias}.raw_metadata_json, '$.topicKinds'), '"MARKET"'))`,
    );
  if (query.scope === 'company')
    clauses.push(companyRelevanceSql(alias, false, false, query.audience));
  if (query.source) clauses.push(`${alias}.source = :newsSource`);
  if (query.sourceKind) clauses.push(`${newsKindSql(alias)} = :newsKind`);
  if (query.publisher) clauses.push(`${newsPublisherSql(alias)} = :newsPublisher`);
  if (query.region && query.region !== 'all')
    clauses.push(
      `(${companyRelevanceSql(alias, false, true, query.audience)} OR (NOT (${companyRelevanceSql(alias, false, false, query.audience)}) AND (${alias}.source = :newsRegionSource OR JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_metadata_json, '$.marketRegion')) IN ('global', :newsRegion))))`,
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
    newsCompanyIds: query.companyIds,
    newsSource: query.source,
    newsAssetTopic: query.asset ? JSON.stringify(`topic:${String(query.asset)}`) : undefined,
    newsKind: query.sourceKind,
    newsPublisher: query.publisher,
    newsQuery: query.q ? literalSearchPattern(query.q) : undefined,
    newsMarkets: marketsForRegion(query.region ?? 'all'),
    newsRegion: query.region,
    newsRegionSource: query.region === 'kr' ? 'OPENDART' : 'SEC',
  };
}

export const NEWS_GROUP_SORT = 'COALESCE(source.published_at, source.first_observed_at)';
export const NEWS_GROUP_ID = 'source.id';

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
    AND ((duplicate.source IN ('GDELT','ALPACA_NEWS','MARKETAUX','ALPHAVANTAGE','FINNHUB','NAVER')) < (${sourceAlias}.source IN ('GDELT','ALPACA_NEWS','MARKETAUX','ALPHAVANTAGE','FINNHUB','NAVER'))
      OR ((duplicate.source IN ('GDELT','ALPACA_NEWS','MARKETAUX','ALPHAVANTAGE','FINNHUB','NAVER')) = (${sourceAlias}.source IN ('GDELT','ALPACA_NEWS','MARKETAUX','ALPHAVANTAGE','FINNHUB','NAVER')) AND
        (duplicate.first_observed_at < ${sourceAlias}.first_observed_at OR
         (duplicate.first_observed_at = ${sourceAlias}.first_observed_at AND duplicate.id < ${sourceAlias}.id)))))`;
}
