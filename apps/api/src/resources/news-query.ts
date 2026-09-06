import { manualNewsTranslationSql } from './manual-news-translation';
import { marketsForRegion, type Region } from '@orsem/contracts';
import {
  completedAutomaticNewsTranslationCondition,
  literalSearchPattern,
  newsTranslationSearchCondition,
} from '../common/news-translation';

export interface NewsFilters {
  scope?: unknown;
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
  return `((${availableNewsContentSql(contentAlias, sourceAlias)}) OR ${gdeltMetadataSql(sourceAlias)})`;
}

export function companyRelevanceSql(alias: string, companyId = false, region = false): string {
  return `EXISTS (SELECT 1 FROM news_source_companies relevance JOIN source_items relevance_source ON relevance_source.id = relevance.source_item_id ${region ? 'JOIN companies relevance_company ON relevance_company.id = relevance.company_id' : ''} WHERE (relevance.source_item_id = ${alias}.id OR (${alias}.news_article_id IS NOT NULL AND relevance_source.news_article_id = ${alias}.news_article_id))${companyId ? ' AND relevance.company_id = :newsCompanyId' : ''}${region ? ' AND relevance_company.market IN (:...newsMarkets)' : ''})`;
}

export const PUBLIC_NEWS_PUBLISHERS = [
  'samsung-global-newsroom',
  'federal-reserve',
  'bls',
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
  if (query.companyId) clauses.push(companyRelevanceSql(alias, true));
  if (query.scope === 'market') clauses.push(`NOT (${companyRelevanceSql(alias)})`);
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

export function availableNewsContentSql(contentAlias: string, sourceAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(contentAlias) || !/^[a-z_][a-z0-9_]*$/iu.test(sourceAlias))
    throw new Error('Invalid news content identifier.');
  const translation = `${contentAlias}.translation_json`;
  const contentPolicy = `${contentAlias}.rights_policy_json`;
  const sourcePolicy = `${sourceAlias}.source_policy_json`;
  return `${sourceAlias}.rights_mode IN ('OFFICIAL_PUBLIC_DATA', 'PRIVATE_DISPLAY_ONLY')
    AND JSON_UNQUOTE(JSON_EXTRACT(${sourcePolicy}, '$.rightsMode')) = ${sourceAlias}.rights_mode
    AND JSON_EXTRACT(${sourcePolicy}, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${sourcePolicy}, '$.displayAllowed') = true
    AND JSON_EXTRACT(${sourcePolicy}, '$.fullTextStorageAllowed') = true
    AND JSON_UNQUOTE(JSON_EXTRACT(${contentPolicy}, '$.rightsMode')) = ${sourceAlias}.rights_mode
    AND JSON_EXTRACT(${contentPolicy}, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${contentPolicy}, '$.displayAllowed') = true
    AND JSON_EXTRACT(${contentPolicy}, '$.fullTextStorageAllowed') = true
    AND ${contentAlias}.status = 'AVAILABLE'
    AND JSON_TYPE(${contentAlias}.blocks_json) = 'ARRAY'
    AND JSON_LENGTH(${contentAlias}.blocks_json) BETWEEN 1 AND 2000
    AND (${contentAlias}.language = 'ko' OR (${manualNewsTranslationSql(sourceAlias)}) OR (${contentAlias}.language = 'en'
      AND ${sourceAlias}.manual_translation_json IS NULL AND ${contentAlias}.manual_translation_json IS NULL
      AND JSON_EXTRACT(${sourcePolicy}, '$.aiAllowed') = true
      AND JSON_EXTRACT(${contentPolicy}, '$.aiAllowed') = true
      AND ${contentAlias}.content_hash IS NOT NULL
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(${translation}, '$.status')) = BINARY 'COMPLETED'
      AND JSON_TYPE(JSON_EXTRACT(${translation}, '$.version')) = 'INTEGER'
      AND JSON_EXTRACT(${translation}, '$.version') = 1
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(${translation}, '$.inputHash')) = BINARY ${contentAlias}.content_hash
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(${translation}, '$.sourceLanguage')) = BINARY 'en'
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(${translation}, '$.targetLanguage')) = BINARY 'ko'
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(${translation}, '$.provider')) IN (BINARY 'LOCAL', BINARY 'AZURE')
      AND JSON_TYPE(JSON_EXTRACT(${translation}, '$.model')) = 'STRING'
      AND CHAR_LENGTH(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${translation}, '$.model')))) > 0
      AND JSON_TYPE(JSON_EXTRACT(${translation}, '$.blocks')) = 'ARRAY'
      AND JSON_LENGTH(JSON_EXTRACT(${translation}, '$.blocks')) BETWEEN 1 AND 2000
      AND JSON_LENGTH(JSON_EXTRACT(${translation}, '$.blocks')) = JSON_LENGTH(${contentAlias}.blocks_json)
      AND JSON_TYPE(JSON_EXTRACT(${translation}, '$.translatedAt')) = 'STRING'
      AND JSON_TYPE(JSON_EXTRACT(${translation}, '$.attemptedAt')) = 'STRING'
      AND JSON_TYPE(JSON_EXTRACT(${translation}, '$.attempts')) = 'INTEGER'
      AND JSON_EXTRACT(${translation}, '$.attempts') > 0
      AND JSON_TYPE(JSON_EXTRACT(${translation}, '$.nextAttemptAt')) IN ('STRING', 'NULL')
      AND ${completedAutomaticNewsTranslationCondition(sourceAlias)}))`;
}

export function representativeNewsSql(query: NewsFilters, sourceAlias = 'source'): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(sourceAlias))
    throw new Error('Invalid representative news alias.');
  // Only another displayable source with usable content can displace the current source.
  // This prevents the list metadata and detail body from coming from different providers.
  return `NOT EXISTS (SELECT 1 FROM source_items duplicate WHERE ${sourceAlias}.news_article_id IS NOT NULL
    AND duplicate.news_article_id = ${sourceAlias}.news_article_id AND ${newsFiltersSql('duplicate', query)}
    AND (${gdeltMetadataSql('duplicate')} OR EXISTS (SELECT 1 FROM news_article_contents duplicate_content
      WHERE duplicate_content.source_item_id = duplicate.id
        AND ${availableNewsContentSql('duplicate_content', 'duplicate')}))
    AND ((duplicate.source IN ('GDELT','ALPACA_NEWS')) < (${sourceAlias}.source IN ('GDELT','ALPACA_NEWS'))
      OR ((duplicate.source IN ('GDELT','ALPACA_NEWS')) = (${sourceAlias}.source IN ('GDELT','ALPACA_NEWS')) AND
        (duplicate.first_observed_at < ${sourceAlias}.first_observed_at OR
         (duplicate.first_observed_at = ${sourceAlias}.first_observed_at AND duplicate.id < ${sourceAlias}.id)))))`;
}
