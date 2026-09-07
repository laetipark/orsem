import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalNewsUrl,
  ConnectorStatus,
  NEWS_EXTERNAL_API_POLICIES,
  NewsSourceKind,
  RightsMode,
  type NewsSourcePolicy,
} from '@orsem/contracts';
import type { WorkerConfig } from '../config/worker-config';
import type { FetchImplementation } from '../opendart/opendart.client';
import {
  ConnectorRequestError,
  fetchJson,
  type DiscoveryCandidate,
  type DiscoveryScope,
  type LinkDiscoveryAdapter,
} from './connector-adapters';
import type { DiscoveryBatch, RecoveryStore } from './discovery-recovery';
import {
  type FreeNewsProvider,
  type NewsApiBudgetStore,
  unavailableNewsApiBudgetStore,
} from './news-api-budget';

export interface ApprovedNewsPublisher {
  domain: string;
  sourceNames: readonly string[];
  sourceKind: NewsSourceKind;
  independentVerification: boolean;
  policy: NewsSourcePolicy;
}
export interface FreeNewsApiApproval {
  entitlementConfirmed: boolean;
  freeAccessVerifiedUntil: string;
  providerPolicy: NewsSourcePolicy;
  /** Finnhub must include its verified account rate; no advertised rate is assumed. */
  verifiedRequestsPerMinute: number | null;
  publisherPolicies: Readonly<Record<string, ApprovedNewsPublisher>>;
}
/** Account evidence and exact publisher rights are reviewed in code, never inferred from a key. */
export const APPROVED_FREE_NEWS_ACCESS: Readonly<
  Record<FreeNewsProvider, FreeNewsApiApproval | null>
> = Object.freeze({
  MARKETAUX: null,
  ALPHAVANTAGE: null,
  FINNHUB: null,
});
export interface FreeNewsApiOptions {
  enabled: boolean;
  key: string | null;
  fetchImpl: FetchImplementation;
  timeoutMs: number;
  dailyBudget: number;
  requestsPerRun: number;
  budgetStore?: NewsApiBudgetStore;
  approval?: FreeNewsApiApproval | null;
  clock?: () => Date;
}

const symbolSchema = z.string().min(1).max(64);
const timeSchema = z.string().datetime({ offset: true });
const numericMetadata = z.union([
  z.number().finite(),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .max(32),
]);
const marketauxPage = z.object({
  meta: z.object({
    found: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    page: z.number().int().positive(),
  }),
  data: z
    .array(
      z.object({
        uuid: z.string().min(1).max(128),
        title: z.string().min(1).max(4000),
        description: z.string().max(16000).nullable().optional(),
        url: z.string().url().max(4096),
        source: z.string().min(1).max(255),
        published_at: timeSchema,
        entities: z
          .array(
            z.object({
              symbol: symbolSchema,
              country: z.string().max(16).nullable().optional(),
              exchange: z.string().max(64).nullable().optional(),
            }),
          )
          .max(1000)
          .default([]),
      }),
    )
    .max(3),
});
const alphaPage = z.object({
  items: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(Number),
  feed: z
    .array(
      z.object({
        title: z.string().min(1).max(4000),
        url: z.string().url().max(4096),
        time_published: z.string().regex(/^\d{8}T\d{6}$/),
        summary: z.string().max(16000).nullable().optional(),
        source: z.string().min(1).max(255),
        ticker_sentiment: z
          .array(
            z.object({
              ticker: symbolSchema,
              relevance_score: numericMetadata.optional(),
              ticker_sentiment_score: numericMetadata.optional(),
              ticker_sentiment_label: z.string().max(128).optional(),
            }),
          )
          .max(1000)
          .default([]),
        topics: z
          .array(
            z.object({ topic: z.string().max(128), relevance_score: numericMetadata.optional() }),
          )
          .max(100)
          .optional(),
        overall_sentiment_score: numericMetadata.optional(),
        overall_sentiment_label: z.string().max(128).optional(),
      }),
    )
    .max(1000),
});
const finnhubPage = z
  .array(
    z.object({
      id: z
        .union([
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z.string().regex(/^\d+$/),
        ])
        .transform(String),
      headline: z.string().min(1).max(4000),
      url: z.string().url().max(4096),
      datetime: z.number().int().nonnegative().max(253402300799),
      source: z.string().min(1).max(255),
      summary: z.string().max(16000).nullable().optional(),
      category: z.string().max(128).optional(),
      related: z.string().max(8000).optional(),
    }),
  )
  .max(1000);

function approvedPolicy(policy: NewsSourcePolicy | undefined): boolean {
  return Boolean(
    policy &&
    ['APPROVED', 'METADATA_ONLY'].includes(policy.rightsStatus ?? '') &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.rightsMode === RightsMode.STORE_METADATA_ONLY &&
    policy.policyId &&
    policy.checkedAt &&
    Number.isFinite(Date.parse(policy.checkedAt)) &&
    policy.policyUrl &&
    policy.allowedAudiences?.includes('ADMIN_UI'),
  );
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function nextNewsRunAt(provider: FreeNewsProvider, now: Date): string {
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);
  do {
    next.setUTCHours(next.getUTCHours() + 1);
  } while (provider === 'ALPHAVANTAGE' && ![3, 15].includes(next.getUTCHours()));
  return next.toISOString();
}
function utcCompact(value: string): string {
  return value.replace(/[-:]/g, '').slice(0, 13);
}
export function alphaPublishedAt(value: string): string {
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso)
    throw new Error('Invalid Alpha Vantage published time.');
  return iso;
}
export function newsApiSymbols(provider: FreeNewsProvider, scope: DiscoveryScope): string[] {
  return [
    ...new Set(
      scope.companies.flatMap((company) => {
        if (provider === 'MARKETAUX' && company.stockCode && /^\d{6}$/.test(company.stockCode)) {
          if (company.market === 'KOSPI') return [`${company.stockCode}.KS`];
          if (company.market === 'KOSDAQ') return [`${company.stockCode}.KQ`];
          return [];
        }
        if (company.stockCode) return [];
        if (!company.market || !['NASDAQ', 'NYSE', 'AMEX'].includes(company.market)) return [];
        const ticker = company.ticker?.toUpperCase();
        return ticker && /^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker) ? [ticker] : [];
      }),
    ),
  ];
}

interface ArticleMetadata {
  id: string | null;
  title: string;
  summary?: string | null;
  url: string;
  source: string;
  publishedAt: string;
  originalTimestamp: string | number;
  symbols: Array<{ symbol: string; country?: string | null; exchange?: string | null }>;
  providerFields?: Record<string, unknown>;
}
interface ParsedPage {
  articles: ArticleMetadata[];
  nextPage: number | null;
  incomplete: boolean;
}

export abstract class FreeNewsApiConnector implements LinkDiscoveryAdapter {
  abstract readonly name: FreeNewsProvider;
  readonly rightsMode = RightsMode.STORE_METADATA_ONLY;
  discoveryWasTruncated = false;
  discoveryMetadata: Record<string, unknown> = {};
  private requestsAttempted = 0;
  protected readonly clock: () => Date;
  protected readonly budget: NewsApiBudgetStore;
  constructor(protected readonly options: FreeNewsApiOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.budget = options.budgetStore ?? unavailableNewsApiBudgetStore;
  }
  protected get approval() {
    return this.options.approval === undefined
      ? APPROVED_FREE_NEWS_ACCESS[this.name]
      : this.options.approval;
  }
  private configured(now: Date): boolean {
    const approval = this.approval;
    return Boolean(
      this.options.enabled &&
      this.options.key &&
      approval?.entitlementConfirmed &&
      Date.parse(approval.freeAccessVerifiedUntil) > now.getTime() &&
      approvedPolicy(approval.providerPolicy) &&
      approval.providerPolicy.provider === this.name &&
      approval.providerPolicy.policyId === NEWS_EXTERNAL_API_POLICIES[this.name].policyId &&
      (this.options.approval !== undefined ||
        approvedPolicy(NEWS_EXTERNAL_API_POLICIES[this.name])) &&
      (this.name !== 'FINNHUB' ||
        (Number.isInteger(approval.verifiedRequestsPerMinute) &&
          approval.verifiedRequestsPerMinute! > 0)) &&
      Object.values(approval.publisherPolicies).some((publisher) =>
        approvedPolicy(publisher.policy),
      ),
    );
  }
  health(now = this.clock()) {
    const configured = this.configured(now);
    return {
      connector: this.name,
      rightsMode: this.rightsMode,
      checkedAt: now,
      status: configured ? ConnectorStatus.DEGRADED : ConnectorStatus.UNCONFIGURED,
      message: configured
        ? 'Awaiting approved metadata ingestion.'
        : 'News source disabled or credentials, free entitlement and storage rights require review.',
      metadata: {
        provider: this.name,
        healthSource: `${this.name}_INGESTION`,
        enabled: this.options.enabled,
        configured,
        capability:
          this.name === 'ALPHAVANTAGE' ? 'LOW_FREQUENCY_SUPPLEMENTAL' : 'SYMBOL_NEWS_METADATA',
        policyStatus: configured ? this.approval!.providerPolicy.rightsStatus : 'UNKNOWN',
        rightsStatus: configured ? this.approval!.providerPolicy.rightsStatus : 'UNKNOWN',
        sourcePolicy: configured
          ? this.approval!.providerPolicy
          : NEWS_EXTERNAL_API_POLICIES[this.name],
        entitlementStatus: configured ? 'CONFIRMED' : 'UNKNOWN',
        dailyRequestBudget: this.options.dailyBudget,
        rollingRequestBudget: this.options.dailyBudget,
        requestBudgetWindow: 'ROLLING_24_HOURS',
        nextRunAt: this.options.enabled ? nextNewsRunAt(this.name, now) : null,
        requestAttempted: false,
      },
    };
  }
  async check(now = this.clock()) {
    return this.health(now);
  }
  async discoverLinks(): Promise<readonly DiscoveryCandidate[]> {
    return [];
  }
  protected abstract request(
    symbols: string[],
    start: string,
    end: string,
    page: number,
  ): { url: URL; init: RequestInit };
  protected abstract parse(raw: unknown, page: number): ParsedPage;

  private candidate(article: ArticleMetadata, observedAt: string): DiscoveryCandidate | null {
    const link = new URL(article.url);
    const publisher = this.approval!.publisherPolicies[link.hostname.toLowerCase()];
    if (
      !publisher ||
      link.protocol !== 'https:' ||
      link.hostname !== publisher.domain ||
      link.username ||
      link.password ||
      link.port ||
      !publisher.sourceNames.includes(article.source) ||
      !approvedPolicy(publisher.policy)
    )
      return null;
    const providerPolicy = this.approval!.providerPolicy;
    const summaryAllowed =
      providerPolicy.summaryStorageAllowed === true &&
      publisher.policy.summaryStorageAllowed === true;
    const policy: NewsSourcePolicy = {
      ...publisher.policy,
      provider: this.name,
      policyId: providerPolicy.policyId,
      policyVersion: 2,
      rightsStatus: 'METADATA_ONLY',
      allowedAudiences: ['ADMIN_UI'],
      metadataStorageAllowed: true,
      displayAllowed: true,
      summaryStorageAllowed: summaryAllowed,
      fullTextStorageAllowed: false,
      notifyAllowed: false,
      aiAllowed: providerPolicy.aiAllowed === true && publisher.policy.aiAllowed === true,
      translationAllowed:
        providerPolicy.translationAllowed === true && publisher.policy.translationAllowed === true,
      publicRedistributionAllowed: false,
    };
    return {
      connector: this.name,
      externalId: article.id ?? sha(canonicalNewsUrl(link.toString())),
      title: article.title,
      ...(summaryAllowed && article.summary ? { summary: article.summary } : {}),
      url: link.toString(),
      publishedAt: article.publishedAt,
      observedAt,
      sourceName: article.source,
      tickers: article.symbols.map(({ symbol }) => symbol),
      tags: [],
      rightsMode: this.rightsMode,
      sourceKind:
        publisher.sourceKind === NewsSourceKind.PRESS_RELEASE
          ? NewsSourceKind.PRESS_RELEASE
          : NewsSourceKind.AGGREGATOR,
      sourcePolicy: policy,
      metadata: {
        discoveryProvider: this.name,
        providerArticleId: article.id,
        externalIdentityKind: article.id ? 'PROVIDER_ARTICLE_ID' : 'CANONICAL_URL_HASH',
        providerPublishedAt: article.originalTimestamp,
        publishedTimestampMeaning: 'PROVIDER_PUBLISHED_AT',
        firstObservedAt: observedAt,
        collectedAt: observedAt,
        providerSymbols: article.symbols,
        sourceDomain: link.hostname,
        publisherPolicyId: publisher.policy.policyId,
        publisherPolicySnapshot: publisher.policy,
        publisherId: publisher.domain,
        originalPublisherId:
          publisher.independentVerification &&
          publisher.sourceKind === NewsSourceKind.INDEPENDENT_MEDIA
            ? publisher.domain
            : null,
        providerPolicySnapshot: providerPolicy,
        publisherSourceKind: publisher.sourceKind,
        independentVerification:
          publisher.independentVerification &&
          publisher.sourceKind === NewsSourceKind.INDEPENDENT_MEDIA,
        metadataOnly: true,
        allowedAudiences: ['ADMIN_UI'],
        rightsContext: 'APPROVED_PUBLISHER_METADATA',
        marketRegion: article.symbols.some(
          ({ country, symbol }) => country?.toLowerCase() === 'kr' || /\.(KS|KQ)$/.test(symbol),
        )
          ? 'kr'
          : 'us',
        attributionName: `${this.name} / ${article.source}`,
        providerFields: article.providerFields ?? {},
      },
    };
  }

  async *discoverBatches(
    scope: DiscoveryScope,
    store: RecoveryStore,
  ): AsyncGenerator<DiscoveryBatch> {
    if (!this.configured(this.clock())) return;
    const allSymbols = newsApiSymbols(this.name, scope);
    if (!allSymbols.length) return;
    this.requestsAttempted = 0;
    const rotation = await store.load(this.name, 'NEWS_ROTATION');
    let rotationRevision = rotation.revision;
    const nextSymbol =
      typeof rotation.metadata.nextSymbol === 'string' ? rotation.metadata.nextSymbol : '';
    let index = Math.max(0, allSymbols.indexOf(nextSymbol));
    let processed = 0;
    let unresolvedTruncation = false;
    while (this.requestsAttempted < this.options.requestsPerRun && processed < allSymbols.length) {
      const symbols =
        this.name === 'MARKETAUX' ? allSymbols.slice(index, index + 25) : [allSymbols[index]!];
      const stream = `NEWS:${sha(symbols.join(','))}`;
      const prior = await store.load(this.name, stream);
      let revision = prior.revision;
      const pending =
        prior.metadata.incomplete === true && typeof prior.metadata.nextPage === 'number';
      const now = this.clock();
      const priorCursor =
        typeof prior.metadata.cursor === 'string' ? Date.parse(prior.metadata.cursor) : NaN;
      const start =
        pending && typeof prior.metadata.lastWindowStart === 'string'
          ? prior.metadata.lastWindowStart
          : new Date(
              Number.isFinite(priorCursor) ? priorCursor - 10 * 60_000 : now.getTime() - 86400_000,
            ).toISOString();
      const end =
        pending && typeof prior.metadata.lastWindowEnd === 'string'
          ? prior.metadata.lastWindowEnd
          : now.toISOString();
      let pageNumber = pending ? Number(prior.metadata.nextPage) : 1;
      const pageHashes =
        pending && Array.isArray(prior.metadata.pageHashes)
          ? prior.metadata.pageHashes.filter((value): value is string => typeof value === 'string')
          : [];
      let more = true;
      while (more && this.requestsAttempted < this.options.requestsPerRun) {
        if (!this.configured(this.clock()))
          throw new Error(`${this.name} approval expired during ingestion.`);
        if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 100)
          throw new Error(`${this.name} pagination recovery requires review.`);
        await this.budget.reserve(this.name, {
          daily: this.options.dailyBudget,
          perMinute: this.approval!.verifiedRequestsPerMinute,
        });
        if (!this.configured(this.clock()))
          throw new Error(`${this.name} approval expired before its reserved request.`);
        this.requestsAttempted++;
        this.discoveryMetadata = {
          ...this.discoveryMetadata,
          requestsAttempted: this.requestsAttempted,
          dailyRequestBudget: this.options.dailyBudget,
          rollingRequestBudget: this.options.dailyBudget,
          nextRunAt: nextNewsRunAt(this.name, this.clock()),
        };
        let parsed: ParsedPage;
        try {
          const { url, init } = this.request(symbols, start, end, pageNumber);
          const raw = await fetchJson(
            this.name,
            'news',
            this.options.fetchImpl,
            url,
            init,
            this.options.timeoutMs,
          );
          try {
            parsed = this.parse(raw, pageNumber);
          } catch (error) {
            if (error instanceof ConnectorRequestError) throw error;
            throw new Error(`${this.name} returned malformed news metadata.`);
          }
          if (this.name === 'FINNHUB')
            for (const article of parsed.articles) {
              if (!article.symbols.length)
                article.symbols = [{ symbol: symbols[0]!, country: 'us' }];
              article.providerFields = { ...article.providerFields, requestedSymbol: symbols[0]! };
            }
          const pageHash = sha(
            parsed.articles.map((article) => article.id ?? article.url).join('\n'),
          );
          if (parsed.articles.length && pageHashes.includes(pageHash))
            throw new Error(`${this.name} repeated a news result page.`);
          pageHashes.push(pageHash);
        } catch (error) {
          const status = error instanceof ConnectorRequestError ? error.httpStatus : null;
          const category =
            status === 401
              ? 'AUTHENTICATION'
              : status === 403
                ? 'ENTITLEMENT'
                : status === 402
                  ? 'DAILY_LIMIT'
                  : status === 429
                    ? 'RATE_LIMIT'
                    : status && status >= 500
                      ? 'PROVIDER_FAILURE'
                      : error instanceof ConnectorRequestError &&
                          error.transportCategory === 'timeout'
                        ? 'TIMEOUT'
                        : 'MALFORMED_OR_TRANSPORT';
          const delay =
            status === 402 || status === 401 || status === 403
              ? 86400_000
              : status === 429
                ? 60_000
                : 5 * 60_000;
          const retryAt =
            error instanceof ConnectorRequestError && error.retryAt
              ? new Date(Math.max(error.retryAt.getTime(), this.clock().getTime() + 60_000))
              : new Date(this.clock().getTime() + delay);
          await this.budget.defer(this.name, retryAt, category);
          this.discoveryMetadata = {
            ...this.discoveryMetadata,
            lastError: category,
            retryAt: retryAt.toISOString(),
            incomplete: true,
          };
          throw error;
        }
        const observedAt = this.clock().toISOString();
        const candidates = parsed.articles
          .map((article) => this.candidate(article, observedAt))
          .filter((candidate): candidate is DiscoveryCandidate => candidate !== null);
        unresolvedTruncation ||= parsed.incomplete && parsed.nextPage === null;
        this.discoveryWasTruncated = unresolvedTruncation || parsed.incomplete;
        this.discoveryMetadata = {
          ...this.discoveryMetadata,
          provider: this.name,
          checkpoint: stream,
          lastFetchedAt: observedAt,
          lastWindowStart: start,
          lastWindowEnd: end,
          nextPage: parsed.nextPage,
          pageHashes: parsed.nextPage ? pageHashes : [],
          incomplete: parsed.incomplete,
          truncated: parsed.incomplete && parsed.nextPage === null,
          lastItemCount: parsed.articles.length,
          rejectedByPolicyCount: parsed.articles.length - candidates.length,
          cursor: parsed.incomplete ? (prior.metadata.cursor ?? null) : end,
        };
        yield {
          candidates,
          suppressAlerts: true,
          checkpoint: { stream, expected: revision++, metadata: this.discoveryMetadata },
        };
        more = parsed.nextPage !== null;
        if (more) pageNumber = parsed.nextPage!;
      }
      if (more) break;
      processed += symbols.length;
      index = (index + symbols.length) % allSymbols.length;
      // The prior batch has been stored when the consumer advances the generator.
      await store.commit(this.name, 'NEWS_ROTATION', rotationRevision++, {
        nextSymbol: allSymbols[index]!,
        cursor: allSymbols[index]!,
        incomplete: false,
      });
    }
  }
}

export class MarketauxNewsConnector extends FreeNewsApiConnector {
  readonly name = 'MARKETAUX' as const;
  protected request(symbols: string[], start: string, end: string, page: number) {
    const url = new URL('https://api.marketaux.com/v1/news/all');
    for (const [key, value] of Object.entries({
      api_token: this.options.key!,
      symbols: symbols.join(','),
      filter_entities: 'true',
      limit: '3',
      page: String(page),
      published_after: start.slice(0, 19),
      published_before: end.slice(0, 19),
      domains: Object.values(this.approval!.publisherPolicies)
        .filter((publisher) => approvedPolicy(publisher.policy))
        .map((publisher) => publisher.domain)
        .join(','),
      group_similar: 'false',
    }))
      url.searchParams.set(key, value);
    return { url, init: {} };
  }
  protected parse(raw: unknown, requestedPage: number): ParsedPage {
    const page = marketauxPage.parse(raw);
    if (
      page.meta.page !== requestedPage ||
      page.meta.returned !== page.data.length ||
      page.meta.limit !== 3 ||
      page.meta.found < page.data.length
    )
      throw new Error('Invalid Marketaux pagination.');
    const next =
      page.meta.returned === page.meta.limit && page.meta.page * page.meta.limit < page.meta.found;
    if (next && !page.data.length) throw new Error('Empty Marketaux continuation.');
    return {
      articles: page.data.map((item) => ({
        id: item.uuid,
        title: item.title,
        summary: item.description,
        url: item.url,
        source: item.source,
        publishedAt: new Date(item.published_at).toISOString(),
        originalTimestamp: item.published_at,
        symbols: item.entities,
      })),
      nextPage: next ? requestedPage + 1 : null,
      incomplete: next,
    };
  }
}

export class AlphaVantageNewsConnector extends FreeNewsApiConnector {
  readonly name = 'ALPHAVANTAGE' as const;
  protected request(symbols: string[], start: string, end: string) {
    const url = new URL('https://www.alphavantage.co/query');
    for (const [key, value] of Object.entries({
      function: 'NEWS_SENTIMENT',
      apikey: this.options.key!,
      tickers: symbols[0]!,
      time_from: utcCompact(start),
      time_to: utcCompact(end),
      sort: 'LATEST',
      limit: '1000',
    }))
      url.searchParams.set(key, value);
    return { url, init: {} };
  }
  protected parse(raw: unknown): ParsedPage {
    if (raw && typeof raw === 'object') {
      const envelope = raw as Record<string, unknown>;
      if ('Information' in envelope || 'Note' in envelope)
        throw new ConnectorRequestError(
          this.name,
          'news',
          429,
          null,
          new Date(this.clock().getTime() + 86400_000),
        );
      if ('Error Message' in envelope) throw new ConnectorRequestError(this.name, 'news', 403);
    }
    const page = alphaPage.parse(raw);
    if (page.items !== page.feed.length) throw new Error('Invalid Alpha Vantage item count.');
    return {
      articles: page.feed.map((item) => ({
        id: null,
        title: item.title,
        summary: item.summary,
        url: item.url,
        source: item.source,
        publishedAt: alphaPublishedAt(item.time_published),
        originalTimestamp: item.time_published,
        symbols: item.ticker_sentiment.map(({ ticker }) => ({ symbol: ticker, country: 'us' })),
        providerFields: {
          topics: item.topics ?? [],
          overall_sentiment_score: item.overall_sentiment_score ?? null,
          overall_sentiment_label: item.overall_sentiment_label ?? null,
          ticker_sentiment: item.ticker_sentiment,
          sentimentMeaning: 'UNVERIFIED_PROVIDER_METADATA',
        },
      })),
      nextPage: null,
      incomplete: page.feed.length === 1000,
    };
  }
}

export class FinnhubNewsConnector extends FreeNewsApiConnector {
  readonly name = 'FINNHUB' as const;
  protected request(symbols: string[], start: string, end: string) {
    const url = new URL('https://finnhub.io/api/v1/company-news');
    for (const [key, value] of Object.entries({
      symbol: symbols[0]!,
      from: start.slice(0, 10),
      to: end.slice(0, 10),
    }))
      url.searchParams.set(key, value);
    return { url, init: { headers: { 'X-Finnhub-Token': this.options.key! } } };
  }
  protected parse(raw: unknown): ParsedPage {
    const page = finnhubPage.parse(raw);
    return {
      articles: page.map((item) => ({
        id: item.id,
        title: item.headline,
        summary: item.summary,
        url: item.url,
        source: item.source,
        publishedAt: new Date(item.datetime * 1000).toISOString(),
        originalTimestamp: item.datetime,
        symbols: (item.related ?? '')
          .split(',')
          .map((symbol) => symbol.trim())
          .filter(Boolean)
          .map((symbol) => ({ symbol, country: 'us' })),
        providerFields: { category: item.category ?? null, related: item.related ?? null },
      })),
      nextPage: null,
      incomplete: page.length === 1000,
    };
  }
}

export function createFreeNewsApiAdapters(
  config: WorkerConfig,
  fetchImpl: FetchImplementation,
  budgetStore?: NewsApiBudgetStore,
): readonly FreeNewsApiConnector[] {
  return [
    new MarketauxNewsConnector({
      enabled: config.marketauxNewsEnabled,
      key: config.marketauxApiToken,
      fetchImpl,
      timeoutMs: config.httpTimeoutMs,
      dailyBudget: config.marketauxNewsDailyBudget,
      requestsPerRun: config.marketauxNewsRequestsPerRun,
      budgetStore,
    }),
    new AlphaVantageNewsConnector({
      enabled: config.alphaVantageNewsEnabled,
      key: config.alphaVantageApiKey,
      fetchImpl,
      timeoutMs: config.httpTimeoutMs,
      dailyBudget: config.alphaVantageNewsDailyBudget,
      requestsPerRun: config.alphaVantageNewsRequestsPerRun,
      budgetStore,
    }),
    new FinnhubNewsConnector({
      enabled: config.finnhubNewsEnabled,
      key: config.finnhubApiKey,
      fetchImpl,
      timeoutMs: config.httpTimeoutMs,
      dailyBudget: config.finnhubNewsDailyBudget,
      requestsPerRun: config.finnhubNewsRequestsPerRun,
      budgetStore,
    }),
  ];
}
