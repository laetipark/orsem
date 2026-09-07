import { createHash } from 'node:crypto';
import {
  currentNewsSourcePolicy,
  isNewsSummaryStorageAllowed,
  type NewsSourcePolicy,
} from '@orsem/contracts';
import type { DiscoveryCandidate } from './connector-adapters';

const V2_METADATA_FIELDS = new Set([
  'discoveryProvider',
  'providerArticleId',
  'externalIdentityKind',
  'providerPublishedAt',
  'publishedTimestampMeaning',
  'firstObservedAt',
  'collectedAt',
  'providerSymbols',
  'sourceDomain',
  'publisherPolicyId',
  'publisherPolicySnapshot',
  'publisherId',
  'originalPublisherId',
  'providerPolicySnapshot',
  'publisherSourceKind',
  'independentVerification',
  'metadataOnly',
  'allowedAudiences',
  'rightsContext',
  'marketRegion',
  'attributionName',
  'providerFields',
  'feedUrl',
  'feedId',
  'originalGuid',
  'originalPublishedAt',
  'originalUpdatedAt',
  'providerUpdatedAt',
  'originalAuthor',
  'sourceProfileId',
  'categories',
  'contentPolicy',
  'rightsPolicyId',
  'originalTitle',
  'originalLink',
  'originalCategories',
  'publisher',
  'rightsPolicyUrl',
]);

function withoutArticleContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutArticleContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !/^(?:body|content|html|full[_-]?text|article[_-]?body|images?|banner_image|highlights)$/i.test(
            key,
          ),
      )
      .map(([key, nested]) => [key, withoutArticleContent(nested)]),
  );
}

/** Defense at persistence, in addition to the adapter's field allowlist. Never retain a raw body. */
export function newsCandidateMetadata(
  candidate: DiscoveryCandidate,
  policy: NewsSourcePolicy,
): Record<string, unknown> {
  if (policy.policyVersion !== 2) return { ...candidate.metadata };
  return Object.fromEntries(
    Object.entries(candidate.metadata)
      .filter(([key]) => V2_METADATA_FIELDS.has(key))
      .map(([key, value]) => [key, withoutArticleContent(value)]),
  );
}

export function newsCandidateSummary(
  candidate: DiscoveryCandidate,
  policy: NewsSourcePolicy,
): string | null {
  const current = currentNewsSourcePolicy(policy);
  if (!isNewsSummaryStorageAllowed(policy) || !current || !isNewsSummaryStorageAllowed(current))
    return null;
  const text = candidate.summary ?? candidate.metadata.description;
  return typeof text === 'string' ? text.slice(0, 16_000) : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) => !['firstObservedAt', 'observedAt', 'collectedAt', 'checkedAt'].includes(key),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function newsCandidateHash(
  candidate: DiscoveryCandidate,
  metadata: Record<string, unknown>,
  summary: string | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        stableValue({
          externalId: candidate.externalId,
          title: candidate.title,
          url: candidate.url,
          publishedAt: candidate.publishedAt,
          updatedAt: candidate.updatedAt ?? null,
          sourceName: candidate.sourceName,
          tickers: candidate.tickers,
          tags: candidate.tags,
          rightsMode: candidate.rightsMode,
          metadata,
          summary,
        }),
      ),
    )
    .digest('hex');
}
