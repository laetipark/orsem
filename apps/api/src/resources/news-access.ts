import {
  newsPolicyAllowsAudience,
  registeredNewsSourcePolicies,
  type NewsSourcePolicy,
  type NewsAudience,
} from '@orsem/contracts';
export type { NewsAudience } from '@orsem/contracts';
import type { GroupActor } from '../watchlist-groups/watchlist-access.service';

/** Created from an authenticated session, never from a public query parameter. */
export const newsAudienceForActor = (actor: GroupActor): NewsAudience =>
  actor.kind === 'ADMIN' ? 'ADMIN_UI' : 'MEMBER_UI';

export const PRIVATE_NEWS_PROVIDERS = ['MARKETAUX', 'ALPHAVANTAGE', 'FINNHUB', 'NAVER'] as const;
export const PRIVATE_NEWS_PROFILES = [
  'nvidia-ir-press',
  'broadcom-ir-news',
  'palo-alto-networks-ir-news',
  'hankyung-finance-rss',
] as const;

export function newsAudienceAllows(
  row: {
    source: string;
    sourcePolicyJson?: NewsSourcePolicy | null;
    rawMetadataJson?: Record<string, unknown> | null;
  },
  audience: NewsAudience = 'MEMBER_UI',
): boolean {
  const policy = row.sourcePolicyJson;
  const restricted =
    policy?.policyVersion === 2 ||
    (PRIVATE_NEWS_PROVIDERS as readonly string[]).includes(row.source) ||
    (PRIVATE_NEWS_PROFILES as readonly unknown[]).includes(row.rawMetadataJson?.feedId);
  return restricted
    ? policy?.policyVersion === 2 && newsPolicyAllowsAudience(policy, audience)
    : true;
}

export function newsAudienceSql(alias: string, audience: NewsAudience = 'MEMBER_UI'): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(alias)) throw new Error('Invalid news source identifier.');
  const sourceNames = PRIVATE_NEWS_PROVIDERS.map((value) => `'${value}'`).join(',');
  const profiles = PRIVATE_NEWS_PROFILES.map((value) => `'${value}'`).join(',');
  const version = `JSON_EXTRACT(${alias}.source_policy_json, '$.policyVersion')`;
  const approvedIds = registeredNewsSourcePolicies()
    .filter((policy) => policy.policyVersion === 2 && newsPolicyAllowsAudience(policy, audience))
    .flatMap((policy) =>
      policy.policyId && /^[a-z0-9-]+$/u.test(policy.policyId) ? [policy.policyId] : [],
    );
  const currentApproval = approvedIds.length
    ? `JSON_UNQUOTE(JSON_EXTRACT(${alias}.source_policy_json, '$.policyId')) IN (${approvedIds.map((id) => `'${id}'`).join(',')})`
    : '1 = 0';
  return `((COALESCE(${version}, 0) <> 2 AND ${alias}.source NOT IN (${sourceNames})
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_metadata_json, '$.feedId')), '') NOT IN (${profiles}))
    OR (${currentApproval} AND ${version} = 2 AND JSON_UNQUOTE(JSON_EXTRACT(${alias}.source_policy_json, '$.rightsStatus')) IN ('APPROVED','METADATA_ONLY')
    AND JSON_CONTAINS(JSON_EXTRACT(${alias}.source_policy_json, '$.allowedAudiences'), '"${audience}"')
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.metadataStorageAllowed') = true
    AND JSON_EXTRACT(${alias}.source_policy_json, '$.displayAllowed') = true))`;
}
