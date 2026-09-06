import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ConnectorStatus,
  NewsSourceKind,
  RightsMode,
  type NewsSourcePolicy,
} from '@orsem/contracts';
import type { FetchImplementation } from '../opendart/opendart.client';
import {
  fetchJson,
  ConnectorRequestError,
  type LinkDiscoveryAdapter,
  type DiscoveryCandidate,
  type DiscoveryScope,
} from './connector-adapters';
import type { DiscoveryBatch, RecoveryStore } from './discovery-recovery';

export interface AlpacaNewsApproval {
  entitlementConfirmed: boolean;
  freeAccessVerifiedUntil: string;
  publisherPolicies: Readonly<Record<string, { domain: string; policy: NewsSourcePolicy }>>;
}
/** Populate only after account entitlement, publisher rights and free access are verified. */
export const APPROVED_ALPACA_NEWS: AlpacaNewsApproval | null = null;
const articleSchema = z.object({
  id: z
    .union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d+$/)])
    .transform(String),
  headline: z.string().min(1).max(16000),
  url: z.string().url(),
  source: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  symbols: z.array(z.string()).max(1000),
});
const pageSchema = z.object({
  news: z.array(articleSchema).max(50),
  next_page_token: z.string().max(4096).nullable().optional(),
});

export class AlpacaNewsConnector implements LinkDiscoveryAdapter {
  readonly name = 'ALPACA_NEWS' as const;
  readonly rightsMode = RightsMode.STORE_METADATA_ONLY;
  discoveryWasTruncated = false;
  discoveryMetadata: Record<string, unknown> = {};
  private requestsAttempted = 0;
  constructor(
    private readonly enabled: boolean,
    private readonly key: string | null,
    private readonly secret: string | null,
    private readonly fetchImpl: FetchImplementation,
    private readonly timeoutMs: number,
    private readonly approval: AlpacaNewsApproval | null = APPROVED_ALPACA_NEWS,
  ) {}

  private configured(now = new Date()): boolean {
    return Boolean(
      this.enabled &&
      this.key &&
      this.secret &&
      this.approval?.entitlementConfirmed &&
      Date.parse(this.approval.freeAccessVerifiedUntil) > now.getTime() &&
      Object.values(this.approval.publisherPolicies).some(
        ({ policy }) =>
          policy.metadataStorageAllowed === true &&
          policy.displayAllowed === true &&
          policy.rightsMode === this.rightsMode &&
          policy.checkedAt &&
          policy.policyUrl,
      ),
    );
  }
  health(now = new Date()) {
    const configured = this.configured(now);
    return {
      connector: this.name,
      status: configured ? ConnectorStatus.DEGRADED : ConnectorStatus.UNCONFIGURED,
      message: configured
        ? 'Awaiting Alpaca News ingestion; account News entitlement is separate from assets.'
        : 'Alpaca News disabled, credentials missing, or entitlement/free access/publisher rights require review.',
      checkedAt: now,
      rightsMode: this.rightsMode,
      metadata: {
        configured,
        provider: 'ALPACA_NEWS',
        healthSource: 'ALPACA_NEWS_INGESTION',
        capability: 'SYMBOL_NEWS_METADATA',
        policyStatus: configured ? 'APPROVED' : 'REQUIRES_CONTRACT_REVIEW',
      },
    };
  }
  async check(now = new Date()) {
    return this.health(now);
  }
  async discoverLinks(): Promise<readonly DiscoveryCandidate[]> {
    return [];
  }

  async *discoverBatches(
    scope: DiscoveryScope,
    store: RecoveryStore,
  ): AsyncGenerator<DiscoveryBatch> {
    if (!this.configured()) return;
    const access = await store.load(this.name, 'ACCESS_COOLDOWN');
    const retryAt =
      typeof access.metadata.retryAt === 'string' ? new Date(access.metadata.retryAt) : null;
    if (retryAt && retryAt.getTime() > Date.now())
      throw new ConnectorRequestError(this.name, 'news', 429, null, retryAt, null, null, false);
    const symbols = [
      ...new Set(scope.companies.flatMap((company) => (company.ticker ? [company.ticker] : []))),
    ].sort();
    if (!symbols.length) return;
    const stream = `NEWS:${createHash('sha256').update(symbols.join(',')).digest('hex')}`;
    const previous = await store.load(this.name, stream);
    let revision = previous.revision;
    // Conservative delayed feed horizon, even when an account may have real-time access.
    const now = Date.now() - 16 * 60_000;
    const pending = previous.metadata.incomplete === true;
    const start =
      pending && typeof previous.metadata.lastWindowStart === 'string'
        ? previous.metadata.lastWindowStart
        : typeof previous.metadata.cursor === 'string'
          ? new Date(Date.parse(previous.metadata.cursor) - 10 * 60_000).toISOString()
          : new Date(now - 86400_000).toISOString();
    const end =
      pending && typeof previous.metadata.lastWindowEnd === 'string'
        ? previous.metadata.lastWindowEnd
        : new Date(now).toISOString();
    let token =
      pending && typeof previous.metadata.pageToken === 'string'
        ? previous.metadata.pageToken
        : null;
    const visited = new Set<string>();
    for (let pages = 0; pages < 4; pages++) {
      if (!this.configured()) throw new Error('Alpaca News approval expired during ingestion.');
      if (token && visited.has(token)) throw new Error('Alpaca News repeated pagination token.');
      if (token) visited.add(token);
      const url = new URL('https://data.alpaca.markets/v1beta1/news');
      for (const [key, value] of Object.entries({
        symbols: symbols.join(','),
        start,
        end,
        sort: 'asc',
        limit: '50',
        include_content: 'false',
      }))
        url.searchParams.set(key, value);
      if (token) url.searchParams.set('page_token', token);
      this.requestsAttempted++;
      this.discoveryMetadata = {
        ...this.discoveryMetadata,
        requestsAttempted: this.requestsAttempted,
      };
      let page: z.infer<typeof pageSchema>;
      try {
        page = pageSchema.parse(
          await fetchJson(
            this.name,
            'news',
            this.fetchImpl,
            url,
            { headers: { 'APCA-API-KEY-ID': this.key!, 'APCA-API-SECRET-KEY': this.secret! } },
            this.timeoutMs,
          ),
        );
      } catch (error) {
        if (error instanceof ConnectorRequestError && error.httpStatus === 429) {
          await store.commit(this.name, 'ACCESS_COOLDOWN', access.revision, {
            retryAt: (error.retryAt ?? new Date(Date.now() + 60000)).toISOString(),
            providerStatus: 429,
            incomplete: true,
          });
        }
        throw error;
      }
      const candidates: DiscoveryCandidate[] = [];
      for (const item of page.news) {
        const publisher = this.approval!.publisherPolicies[item.source];
        const link = new URL(item.url);
        if (
          !publisher ||
          link.protocol !== 'https:' ||
          link.hostname !== publisher.domain ||
          link.username ||
          link.password ||
          link.port ||
          publisher.policy.metadataStorageAllowed !== true ||
          publisher.policy.displayAllowed !== true ||
          !publisher.policy.checkedAt ||
          !publisher.policy.policyUrl ||
          publisher.policy.rightsMode !== this.rightsMode
        )
          continue;
        candidates.push({
          connector: this.name,
          externalId: item.id,
          title: item.headline,
          url: link.toString(),
          publishedAt: item.created_at,
          sourceName: item.source,
          tickers: item.symbols,
          tags: [],
          rightsMode: this.rightsMode,
          sourceKind: NewsSourceKind.INDEPENDENT_MEDIA,
          sourcePolicy: {
            ...publisher.policy,
            aiAllowed: false,
            fullTextStorageAllowed: false,
            notifyAllowed: false,
          },
          metadata: {
            rightsContext: 'APPROVED_PUBLISHER_METADATA',
            discoveryProvider: this.name,
            providerArticleId: item.id,
            providerCreatedAt: item.created_at,
            providerUpdatedAt: item.updated_at,
            publishedTimestampMeaning: 'PROVIDER_CREATED_AT',
            metadataOnly: true,
            language: 'en',
            marketRegion: 'us',
            attributionName: `Alpaca News / ${item.source}`,
          },
        });
      }
      token = page.next_page_token ?? null;
      this.discoveryWasTruncated = token !== null;
      this.discoveryMetadata = {
        provider: this.name,
        requestsAttempted: this.requestsAttempted,
        checkpoint: stream,
        lastFetchedAt: new Date().toISOString(),
        lastWindowStart: start,
        lastWindowEnd: end,
        pageToken: token,
        incomplete: token !== null,
        truncated: false,
        lastItemCount: page.news.length,
        rejectedByPolicyCount: page.news.length - candidates.length,
        cursor: token ? (previous.metadata.cursor ?? null) : end,
      };
      yield {
        candidates,
        suppressAlerts: true,
        checkpoint: { stream, expected: revision++, metadata: this.discoveryMetadata },
      };
      if (!token) break;
    }
  }
}
