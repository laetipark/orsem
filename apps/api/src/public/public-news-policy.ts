import {
  NEWS_RSS_FEEDS,
  NewsSourceKind,
  RightsMode,
  isNewsSummaryStorageAllowed,
  isNewsTranslationAllowed,
  type NewsRssFeedDefinition,
  type NewsSourcePolicy,
  type PublicNewsItem,
} from '@orsem/contracts';
import type { SourceItemEntity } from '@orsem/database';
import { publicNewsTranslation } from '../common/news-translation';

export const PUBLIC_NEWS_FEED_IDS = [
  'fed-press',
  'fed-speeches',
  'bls-latest',
  'eia-today',
  'eia-press',
] as const;

function approved(policy: NewsSourcePolicy | null | undefined): boolean {
  return (
    policy?.rightsMode === RightsMode.OFFICIAL_PUBLIC_DATA &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.publicRedistributionAllowed === true
  );
}

export function publicNewsFeeds(): Array<[string, NewsRssFeedDefinition]> {
  return PUBLIC_NEWS_FEED_IDS.flatMap((id) => {
    const feed: NewsRssFeedDefinition = NEWS_RSS_FEEDS[id];
    return feed.enabled !== false && approved(feed.policy) ? [[id, feed]] : [];
  });
}

function unexpired(value: unknown, now: Date): boolean {
  return (
    value == null ||
    (typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value &&
      Date.parse(value) > now.getTime())
  );
}

export function publicNewsFeed(
  row: SourceItemEntity,
  now = new Date(),
  feeds = publicNewsFeeds(),
): NewsRssFeedDefinition | null {
  const metadata = row.rawMetadataJson;
  const feed = feeds.find(([id]) => id === metadata?.feedId)?.[1];
  const policy = row.sourcePolicyJson;
  if (
    !feed ||
    feed.enabled === false ||
    !approved(feed.policy) ||
    !approved(policy) ||
    row.source !== 'NEWS_RSS' ||
    row.sourceKind !== NewsSourceKind.OFFICIAL_RELEASE ||
    row.rightsMode !== policy?.rightsMode ||
    row.sourceName !== feed.publisher ||
    metadata?.publisher !== feed.publisher ||
    metadata.publisherId !== feed.publisherId ||
    metadata.feedUrl !== feed.url ||
    metadata.rightsContext !== feed.rightsContext ||
    metadata.rightsPolicyUrl !== feed.rightsPolicyUrl ||
    metadata.marketRegion !== feed.marketRegion ||
    policy.policyUrl !== feed.policy.policyUrl ||
    policy.policyVersion !== feed.policy.policyVersion ||
    !unexpired(metadata.expiresAt, now) ||
    !unexpired((policy as unknown as Record<string, unknown>).expiresAt, now)
  )
    return null;
  try {
    const url = new URL(row.url);
    const host = new URL(feed.url).hostname;
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hostname !== host
    )
      return null;
  } catch {
    return null;
  }
  return feed;
}

/** Apply this predicate in SQL before sorting, limiting, counting, or selecting a detail. */
export function publicNewsSql(alias: string): { sql: string; parameters: Record<string, unknown> } {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(alias)) throw new Error('Invalid public news alias');
  const parameters: Record<string, unknown> = {};
  const value = (column: string, field: string) =>
    `JSON_UNQUOTE(JSON_EXTRACT(${alias}.${column}, '$.${field}'))`;
  const equal = (column: string, field: string, parameter: string, expected: unknown) => {
    parameters[parameter] = expected;
    return `BINARY ${value(column, field)} = BINARY :${parameter}`;
  };
  const feedClauses = publicNewsFeeds().map(([id, feed], index) => {
    const prefix = `publicFeed${index}`;
    parameters[`${prefix}Publisher`] = feed.publisher;
    // The path separator prevents a lookalike host (e.g. federalreserve.gov.attacker.invalid).
    parameters[`${prefix}Url`] = `https://${new URL(feed.url).hostname}/%`;
    return `(${[
      equal('raw_metadata_json', 'feedId', `${prefix}Id`, id),
      equal('raw_metadata_json', 'feedUrl', `${prefix}FeedUrl`, feed.url),
      equal('raw_metadata_json', 'publisher', `${prefix}Publisher`, feed.publisher),
      equal('raw_metadata_json', 'publisherId', `${prefix}PublisherId`, feed.publisherId),
      equal('raw_metadata_json', 'rightsContext', `${prefix}Context`, feed.rightsContext),
      equal('raw_metadata_json', 'rightsPolicyUrl', `${prefix}RightsUrl`, feed.rightsPolicyUrl),
      equal('raw_metadata_json', 'marketRegion', `${prefix}Region`, feed.marketRegion),
      equal('source_policy_json', 'policyUrl', `${prefix}PolicyUrl`, feed.policy.policyUrl),
      feed.policy.policyVersion === undefined
        ? `JSON_EXTRACT(${alias}.source_policy_json, '$.policyVersion') IS NULL`
        : `JSON_TYPE(JSON_EXTRACT(${alias}.source_policy_json, '$.policyVersion')) = 'INTEGER' AND JSON_EXTRACT(${alias}.source_policy_json, '$.policyVersion') = ${feed.policy.policyVersion}`,
      `BINARY ${alias}.source_name = BINARY :${prefix}Publisher`,
      `BINARY ${alias}.url LIKE BINARY :${prefix}Url`,
    ].join(' AND ')})`;
  });
  const permissions = [
    'metadataStorageAllowed',
    'displayAllowed',
    'publicRedistributionAllowed',
  ].map(
    (field) => `(JSON_TYPE(JSON_EXTRACT(${alias}.source_policy_json, '$.${field}')) = 'BOOLEAN'
      AND JSON_EXTRACT(${alias}.source_policy_json, '$.${field}') = true)`,
  );
  const expiration = ['raw_metadata_json', 'source_policy_json'].map((column) => {
    const expiry = value(column, 'expiresAt');
    return `(JSON_EXTRACT(${alias}.${column}, '$.expiresAt') IS NULL OR
      JSON_TYPE(JSON_EXTRACT(${alias}.${column}, '$.expiresAt')) = 'NULL' OR
      (JSON_TYPE(JSON_EXTRACT(${alias}.${column}, '$.expiresAt')) = 'STRING' AND
      ${expiry} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND
      STR_TO_DATE(${expiry}, '%Y-%m-%dT%H:%i:%s.%fZ') > UTC_TIMESTAMP(3)))`;
  });
  return {
    sql: [
      `BINARY ${alias}.source = BINARY 'NEWS_RSS'`,
      `BINARY ${alias}.source_kind = BINARY 'OFFICIAL_RELEASE'`,
      `BINARY ${alias}.rights_mode = BINARY 'OFFICIAL_PUBLIC_DATA'`,
      `BINARY ${value('source_policy_json', 'rightsMode')} = BINARY 'OFFICIAL_PUBLIC_DATA'`,
      ...permissions,
      ...expiration,
      `(${feedClauses.join(' OR ') || '1 = 0'})`,
    ].join(' AND '),
    parameters,
  };
}

export function mapPublicNews(row: SourceItemEntity, now = new Date()): PublicNewsItem | null {
  const feed = publicNewsFeed(row, now);
  if (!feed) return null;
  const summaryAllowed =
    isNewsSummaryStorageAllowed(row.sourcePolicyJson) &&
    isNewsSummaryStorageAllowed(feed.policy) &&
    (row.sourcePolicyJson?.summaryStorageAllowed === undefined ||
      row.sourcePolicyJson.summaryStorageAllowed === true) &&
    (feed.policy.summaryStorageAllowed === undefined || feed.policy.summaryStorageAllowed === true);
  const description = row.rawMetadataJson?.description;
  const translation =
    isNewsTranslationAllowed(row.sourcePolicyJson) &&
    isNewsTranslationAllowed(feed.policy) &&
    (row.sourcePolicyJson?.translationAllowed === undefined ||
      row.sourcePolicyJson.translationAllowed === true) &&
    (feed.policy.translationAllowed === undefined || feed.policy.translationAllowed === true)
      ? publicNewsTranslation(row)
      : null;
  return {
    id: row.id,
    title: row.title,
    summary: summaryAllowed && typeof description === 'string' ? description : null,
    url: row.url,
    publisher: feed.publisher,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    firstObservedAt: row.firstObservedAt.toISOString(),
    rightsMode: row.rightsMode,
    sourceUrl: feed.url,
    ...(translation
      ? {
          translation: {
            title: translation.title,
            summary: summaryAllowed ? translation.description : null,
          },
        }
      : {}),
  };
}
