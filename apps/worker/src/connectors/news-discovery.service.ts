import { AlpacaNewsConnector } from './alpaca-news.connector';
import { ingestPendingSecOwnership } from '../sec/ownership-ingestion';
import { recoveryStore, type DiscoveryBatch } from './discovery-recovery';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  canonicalNewsUrl,
  ConnectorStatus,
  ProcessingStatus,
  RightsMode,
  WatchPriority,
  sourceKindForSource,
} from '@orsem/contracts';
import {
  CompanyEntity,
  CompanyAliasEntity,
  ConnectorHealthEntity,
  FilingEntity,
  IngestionRunEntity,
  IrSourceEntity,
  NewsArticleEntity,
  NewsItemEntity,
  NewsArticleContentEntity,
  SourceCheckpointEntity,
  SourceItemEntity,
  WatchlistItemEntity,
  attachNewsArticle,
} from '@orsem/database';
import { DataSource, In } from 'typeorm';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { HTTP_FETCH, type FetchImplementation } from '../opendart/opendart.client';
import type { DiscoverLinksJob } from '../queues/job-data';
import { PushFanoutService } from '../push/push-fanout.service';
import {
  createLinkDiscoveryAdapters,
  connectorFailureMessage,
  ConnectorRequestError,
  MAX_REGISTERED_IR_FEEDS,
  isApprovedContentIrFeed,
  RegisteredIrFeedConnector,
  PublisherNewsRssConnector,
  GdeltMetadataConnector,
  SecSubmissionsConnector,
  type ConnectorName,
  type DiscoveryCandidate,
  type DiscoveryScope,
  type FeedCheckpointStore,
  type FeedCheckpoint,
} from './connector-adapters';
import { createNewsCompanyMatcher, newsCompanyAliases } from './news-company-matching';
import { APPROVED_GROUP_COMPANIES_SQL, replaceNewsCompanyRelevance } from './news-relevance';
import { projectSecFilingEvents } from './sec-event-projection';
import { newsTranslationInputHash, translationInput } from '../ai/news-translation.service';

const MAX_DISCOVERY_SCOPE_COMPANIES = 25;
const COMPANY_LOOKUP_BATCH_SIZE = 500;
const MAX_CLASSIFICATION_VALUES = 100;
const MAX_CLASSIFICATION_LENGTH = 128;
const MAX_TEXT_COLUMN_CHARACTERS = 16_000;

function discoveryStream(job: DiscoverLinksJob): string {
  if (job.reason === 'DISCLOSURE_TRIGGER') return 'LINK_DISCOVERY:P3_TRIGGER';
  if (job.reason === 'BACKFILL') return 'LINK_DISCOVERY:BACKFILL';
  const scope = job.priorities.length > 0 ? job.priorities.join('_') : 'ALL';
  return `LINK_DISCOVERY:${scope}`;
}

function messageOf(error: unknown): string {
  return connectorFailureMessage(error).slice(0, 4000);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function rawHash(candidate: DiscoveryCandidate): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        stableValue({
          externalId: candidate.externalId,
          title: candidate.title,
          url: candidate.url,
          publishedAt: candidate.publishedAt,
          sourceName: candidate.sourceName,
          tickers: candidate.tickers,
          tags: candidate.tags,
          rightsMode: candidate.rightsMode,
          metadata: candidate.metadata,
        }),
      ),
    )
    .digest('hex');
}

function boundedValues(values: readonly string[]): string[] {
  return [...new Set(values)]
    .slice(0, MAX_CLASSIFICATION_VALUES)
    .map((value) => value.normalize('NFKC').slice(0, MAX_CLASSIFICATION_LENGTH));
}

function validInstant(value: string | null): Date | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value);
}

const SEC_NEWS_POLICY = Object.freeze({
  rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
  aiAllowed: false,
  fullTextStorageAllowed: false,
  metadataStorageAllowed: true,
  displayAllowed: true,
  publicRedistributionAllowed: true,
  notifyAllowed: true,
  policyUrl: 'https://www.sec.gov/privacy.htm',
  checkedAt: '2026-09-05',
});

@Injectable()
export class NewsDiscoveryService {
  public constructor(
    private readonly dataSource: DataSource,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: FetchImplementation,
    private readonly pushFanout: PushFanoutService,
  ) {}

  public async discover(job: DiscoverLinksJob): Promise<
    readonly Readonly<{
      connector: ConnectorName;
      status: ConnectorStatus;
      seen: number;
      created: number;
      message: string | null;
    }>[]
  > {
    // Saved repeat/outbox jobs from before the isolated search rollout are inert.
    if (job.connectors.includes('NAVER')) return [];
    const stream = discoveryStream(job);
    const irSources = job.connectors.includes('IR')
      ? await this.dataSource.getRepository(IrSourceEntity).find({
          where: { isActive: true },
        })
      : [];
    const compatibleIrSources: IrSourceEntity[] = [];
    const incompatibleIrSources: IrSourceEntity[] = [];
    const feedUrls = new Set<string>(this.config.irFeedUrls.filter(isApprovedContentIrFeed));
    for (const source of irSources) {
      try {
        if (
          source.sourceType.toUpperCase() !== 'RSS' ||
          source.rightsMode !== RightsMode.PRIVATE_DISPLAY_ONLY ||
          !isApprovedContentIrFeed(source.url)
        ) {
          throw new Error('unsupported registered IR source contract');
        }
        // 생성 시 실제 어댑터와 동일하게 자격증명·스킴·호스트 주소 표기를
        // 검증합니다. 요청 시에는 DNS를 다시 검증하고 사용할 주소를
        // 고정합니다.
        new RegisteredIrFeedConnector([source.url], this.config.httpTimeoutMs);
        const normalizedUrl = new URL(source.url).toString();
        if (!feedUrls.has(normalizedUrl) && feedUrls.size >= MAX_REGISTERED_IR_FEEDS) {
          throw new Error('registered IR feed safety limit exceeded');
        }
        feedUrls.add(normalizedUrl);
        compatibleIrSources.push(source);
      } catch {
        incompatibleIrSources.push(source);
      }
    }
    const effectiveConfig: WorkerConfig = {
      ...this.config,
      irFeedUrls: Object.freeze([...feedUrls]),
    };
    const aliases = job.connectors.some((connector) =>
      ['NEWS_RSS', 'GDELT', 'IR', 'ALPACA_NEWS'].includes(connector),
    )
      ? newsCompanyAliases(
          await this.dataSource.getRepository(CompanyEntity).find({
            select: { id: true, nameKo: true, nameEn: true, ticker: true, stockCode: true },
          }),
          await this.dataSource.getRepository(CompanyAliasEntity).find(),
        )
      : [];
    const matchCompanies = createNewsCompanyMatcher(aliases);
    const scopedCompanies = await this.loadDiscoveryCompanies(job);
    const scopedCompanyValues = scopedCompanies.map((company) =>
      Object.freeze({
        ticker: company.ticker,
        stockCode: company.stockCode,
        cik: company.cik,
        nameKo: company.nameKo,
        nameEn: company.nameEn,
      }),
    );
    const discoveryScopes = Array.from(
      {
        length: Math.max(1, Math.ceil(scopedCompanyValues.length / MAX_DISCOVERY_SCOPE_COMPANIES)),
      },
      (_, index) =>
        Object.freeze({
          companies: Object.freeze(
            scopedCompanyValues.slice(
              index * MAX_DISCOVERY_SCOPE_COMPANIES,
              (index + 1) * MAX_DISCOVERY_SCOPE_COMPANIES,
            ),
          ),
        }),
    );
    const scopedUsCompanies = scopedCompanies.filter((company) =>
      ['NASDAQ', 'NYSE', 'AMEX'].includes(company.market),
    );
    const missingScopeCikCount = scopedUsCompanies.filter((company) => {
      const cik = company.cik?.padStart(10, '0');
      return !cik || !/^\d{10}$/.test(cik) || cik === '0000000000';
    }).length;
    const secScopes = job.connectors.includes('SEC')
      ? await this.loadSecScopes(scopedUsCompanies)
      : [];
    const secScopeMetadata = {
      scopedUsCompanyCount: scopedUsCompanies.length,
      missingScopeCikCount,
      eligibleIssuerCount: new Set(
        secScopes.flatMap((scope) =>
          scope.companies.map((company) => company.cik?.padStart(10, '0')),
        ),
      ).size,
      emptyScope: scopedUsCompanies.length === 0,
      requestsPlanned: secScopes.length > 0,
    };
    const secScopeWarning =
      scopedUsCompanies.length === 0
        ? 'No US companies in the requested discovery scope; no SEC requests were made.'
        : missingScopeCikCount > 0
          ? `${missingScopeCikCount} scoped US company/companies lack a valid SEC CIK.`
          : secScopes.length === 0
            ? 'No eligible SEC issuer remained in the discovery scope; no requests were made.'
            : null;
    const irCompanyIdsByUrl = new Map<string, string[]>();
    for (const source of compatibleIrSources) {
      const url = new URL(source.url).toString();
      const ids = irCompanyIdsByUrl.get(url) ?? [];
      ids.push(source.companyId);
      irCompanyIdsByUrl.set(url, ids);
    }
    const results: Array<{
      connector: ConnectorName;
      status: ConnectorStatus;
      seen: number;
      created: number;
      message: string | null;
    }> = [];
    const requestedConnectors = new Set<ConnectorName>(job.connectors);
    for (const adapter of createLinkDiscoveryAdapters(
      effectiveConfig,
      this.fetchImpl,
      this.feedCheckpointStore(),
    )) {
      if (!requestedConnectors.has(adapter.name)) continue;
      const configured = adapter.health();
      const discoveryMetadata = {
        ...configured.metadata,
        ...(adapter.name === 'SEC' ? secScopeMetadata : {}),
      };
      if (configured.status === ConnectorStatus.UNCONFIGURED) {
        const health = this.dataSource.getRepository(ConnectorHealthEntity);
        const row =
          (await health.findOne({ where: { connector: adapter.name.toLowerCase() } })) ??
          health.create({ connector: adapter.name.toLowerCase() });
        Object.assign(row, {
          status: configured.status,
          message: configured.message,
          checkedAt: new Date(),
          metadataJson: { ...row.metadataJson, ...configured.metadata, requestAttempted: false },
        });
        await health.save(row);
        results.push({
          connector: adapter.name,
          status: configured.status,
          seen: 0,
          created: 0,
          message: configured.message,
        });
        continue;
      }

      const startedAt = new Date();
      const runs = this.dataSource.getRepository(IngestionRunEntity);
      const run = runs.create({
        connector: adapter.name,
        stream,
        windowStart: null,
        windowEnd: null,
        status: ProcessingStatus.PROCESSING,
        itemsSeen: '0',
        itemsCreated: '0',
        startedAt,
        finishedAt: null,
        errorMessage: null,
      });
      await runs.save(run);
      try {
        let seen = 0;
        let created = 0;
        let truncated = false;
        const adapterScopes =
          adapter.name === 'SEC'
            ? secScopes
            : adapter.name === 'GDELT'
              ? [{ companies: scopedCompanyValues }]
              : ['IR', 'NEWS_RSS'].includes(adapter.name)
                ? discoveryScopes.slice(0, 1)
                : discoveryScopes;
        for (const rawScope of adapterScopes) {
          const scope =
            adapter.name === 'ALPACA_NEWS'
              ? {
                  companies: rawScope.companies.filter((company) =>
                    scopedUsCompanies.some((us) => us.ticker === company.ticker),
                  ),
                }
              : rawScope;
          const store = recoveryStore(this.dataSource);
          const batches: AsyncIterable<DiscoveryBatch> =
            adapter instanceof SecSubmissionsConnector
              ? adapter.discoverBatches(
                  scope,
                  store,
                  this.config.secBackfillMaxRequests,
                  job.reason === 'BACKFILL',
                )
              : adapter instanceof GdeltMetadataConnector
                ? adapter.discoverBatches(scope, store, {
                    overlapMinutes: this.config.gdeltOverlapMinutes,
                    maxDepth: this.config.gdeltMaxSplitDepth,
                    maxRequests: 12,
                  })
                : adapter instanceof AlpacaNewsConnector
                  ? adapter.discoverBatches(scope, store)
                  : (async function* () {
                      yield { candidates: await adapter.discoverLinks(scope) };
                    })();
          for await (const batch of batches) {
            seen += batch.candidates.length;
            run.itemsSeen = String(seen);
            let selected = batch.candidates;
            if (adapter instanceof SecSubmissionsConnector && batch.suppressAlerts !== true) {
              const known = new Set<string>();
              for (
                let offset = 0;
                offset < batch.candidates.length;
                offset += COMPANY_LOOKUP_BATCH_SIZE
              ) {
                const ids = batch.candidates
                  .slice(offset, offset + COMPANY_LOOKUP_BATCH_SIZE)
                  .flatMap((candidate) => (candidate.externalId ? [candidate.externalId] : []));
                if (!ids.length) continue;
                const existing = await this.dataSource.getRepository(SourceItemEntity).find({
                  select: { externalId: true },
                  where: { source: 'SEC', externalId: In(ids) },
                });
                for (const row of existing) if (row.externalId) known.add(row.externalId);
              }
              selected = batch.candidates.filter(
                (candidate) => !candidate.externalId || !known.has(candidate.externalId),
              );
            }
            for (const candidate of selected) {
              if (
                await this.persistCandidate(
                  candidate,
                  irCompanyIdsByUrl,
                  job,
                  job.suppressAlerts || job.reason === 'BACKFILL' || batch.suppressAlerts === true,
                  matchCompanies(candidate.title),
                )
              ) {
                created++;
                run.itemsCreated = String(created);
              }
            }
            // No checkpoint writes happen when an item, relationship, or projection failed.
            if (batch.checkpoint)
              await store.commit(
                adapter.name,
                batch.checkpoint.stream,
                batch.checkpoint.expected,
                batch.checkpoint.metadata,
              );
          }
        }

        let partialFailureCount =
          adapter instanceof RegisteredIrFeedConnector ||
          adapter instanceof PublisherNewsRssConnector
            ? adapter.discoveryFailureCount
            : 0;
        if (
          adapter instanceof PublisherNewsRssConnector ||
          adapter instanceof RegisteredIrFeedConnector
        ) {
          truncated ||= adapter.discoveryWasTruncated;
          await adapter.commitFeedCheckpoints();
        }
        if (
          adapter instanceof GdeltMetadataConnector ||
          adapter instanceof SecSubmissionsConnector ||
          adapter instanceof AlpacaNewsConnector
        )
          truncated ||= adapter.discoveryWasTruncated;
        const ownershipMetadata =
          adapter instanceof SecSubmissionsConnector &&
          this.config.secForm4Enabled &&
          this.config.secUserAgent
            ? await ingestPendingSecOwnership(
                this.dataSource,
                this.fetchImpl,
                this.config.secUserAgent,
                this.config.httpTimeoutMs,
              )
            : {};
        partialFailureCount += Number(ownershipMetadata.ownershipFailed ?? 0);
        const completedAt = new Date();
        run.status = ProcessingStatus.COMPLETED;
        run.itemsSeen = String(seen);
        run.itemsCreated = String(created);
        run.finishedAt = completedAt;
        const runWarnings = [
          adapter.name === 'SEC' ? secScopeWarning : null,
          truncated
            ? adapter.name === 'GDELT'
              ? 'GDELT window recovery is incomplete; inspect its checkpoint.'
              : 'Discovery recovery is incomplete; inspect the remaining cursor.'
            : null,
          partialFailureCount > 0
            ? adapter.name === 'NEWS_RSS'
              ? `${partialFailureCount} RSS feed/item failure(s); healthy items were retained.`
              : `${partialFailureCount} supplementary document/feed processing failure(s); saved receipts/items were retained.`
            : null,
        ].filter((message): message is string => Boolean(message));
        run.errorMessage = runWarnings.length > 0 ? runWarnings.join(' ') : null;
        await runs.save(run);
        await this.recordSuccess(
          adapter.name,
          adapter.rightsMode,
          completedAt,
          seen,
          created,
          truncated,
          partialFailureCount,
          stream,
          {
            ...discoveryMetadata,
            ...ownershipMetadata,
            ...(adapter instanceof SecSubmissionsConnector ||
            adapter instanceof GdeltMetadataConnector ||
            adapter instanceof AlpacaNewsConnector
              ? adapter.discoveryMetadata
              : {}),
            ...(adapter instanceof PublisherNewsRssConnector ||
            adapter instanceof RegisteredIrFeedConnector
              ? adapter.discoveryMetadata
              : {}),
          },
          adapter.name === 'SEC'
            ? {
                degradedMessage: secScopeWarning,
                recordSuccessInstant: secScopes.length > 0 && !truncated,
              }
            : {
                recordSuccessInstant:
                  !truncated &&
                  (!(adapter instanceof AlpacaNewsConnector) ||
                    Number(adapter.discoveryMetadata.requestsAttempted ?? 0) > 0),
              },
        );
        results.push({
          connector: adapter.name,
          status:
            partialFailureCount > 0 || truncated || (adapter.name === 'SEC' && secScopeWarning)
              ? ConnectorStatus.DEGRADED
              : ConnectorStatus.HEALTHY,
          seen,
          created,
          message: run.errorMessage,
        });
      } catch (error) {
        const failedAt = new Date();
        const message =
          ['SEC', 'GDELT', 'ALPACA_NEWS'].includes(adapter.name) &&
          !(error instanceof ConnectorRequestError)
            ? `${adapter.name} 수집 처리에 실패했습니다.`
            : messageOf(error);
        run.status = ProcessingStatus.FAILED;
        run.finishedAt = failedAt;
        run.errorMessage = message;
        await runs.save(run);
        await this.recordFailure(adapter.name, adapter.rightsMode, failedAt, message, stream, {
          ...discoveryMetadata,
          ...(adapter instanceof SecSubmissionsConnector ||
          adapter instanceof GdeltMetadataConnector ||
          adapter instanceof AlpacaNewsConnector
            ? adapter.discoveryMetadata
            : {}),
          ...(adapter instanceof PublisherNewsRssConnector ||
          adapter instanceof RegisteredIrFeedConnector
            ? adapter.discoveryMetadata
            : {}),
          ...(error instanceof ConnectorRequestError
            ? {
                httpStatus: error.httpStatus,
                requestOperation: error.operation,
                transportCategory: error.transportCategory,
                retryAt: error.retryAt?.toISOString() ?? null,
                providerCode: error.providerCode,
                requestAttempted: error.requestAttempted,
                skipped: !error.requestAttempted,
              }
            : {}),
        });
        results.push({
          connector: adapter.name,
          status: ConnectorStatus.DEGRADED,
          seen: Number(run.itemsSeen),
          created: Number(run.itemsCreated),
          message,
        });
      }
      if (adapter.name === 'IR' && compatibleIrSources.length > 0) {
        await this.dataSource
          .getRepository(IrSourceEntity)
          .update(
            { id: In(compatibleIrSources.map((source) => source.id)) },
            { lastCheckedAt: new Date() },
          );
      }
    }
    if (incompatibleIrSources.length > 0) {
      const checkedAt = new Date();
      await this.dataSource
        .getRepository(IrSourceEntity)
        .update(
          { id: In(incompatibleIrSources.map((source) => source.id)) },
          { lastCheckedAt: checkedAt },
        );
      // Retired/unreviewed IR sources stay inert. They are not connector failures because
      // the reviewed content registry intentionally excludes them.
    }
    return Object.freeze(results.map((result) => Object.freeze(result)));
  }

  private feedCheckpointStore(): FeedCheckpointStore {
    const repository = this.dataSource.getRepository(SourceCheckpointEntity);
    const streamFor = (url: string): string =>
      `RSS_HTTP:${createHash('sha256').update(url).digest('hex')}`;
    return {
      load: async (connector, url) => {
        const row = await repository.findOne({ where: { connector, stream: streamFor(url) } });
        const metadata = row?.metadataJson;
        if (!metadata || typeof metadata.checkedAt !== 'string') return null;
        const safe = (value: unknown): string | null =>
          typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value) ? value : null;
        return {
          etag: safe(metadata.etag),
          lastModified: safe(metadata.lastModified),
          checkedAt: metadata.checkedAt,
          httpStatus: Number(metadata.httpStatus),
        } satisfies FeedCheckpoint;
      },
      save: async (connector, url, state) => {
        const stream = streamFor(url);
        const row =
          (await repository.findOne({ where: { connector, stream } })) ??
          repository.create({ connector, stream, lastSuccessDate: null, cursor: null });
        row.lastSuccessAt = new Date(state.checkedAt);
        row.metadataJson = {
          ...row.metadataJson,
          ...state,
          feedUrl: url,
          status: ConnectorStatus.HEALTHY,
          errorMessage: null,
        };
        await repository.save(row);
      },
      recordFailure: async (connector, url, message, at) => {
        const stream = streamFor(url);
        const row =
          (await repository.findOne({ where: { connector, stream } })) ??
          repository.create({
            connector,
            stream,
            lastSuccessDate: null,
            cursor: null,
            lastSuccessAt: null,
          });
        row.metadataJson = {
          ...row.metadataJson,
          // A content/parser failure must force a full feed response on the next poll.
          // Retaining an earlier validator can produce a 304 and strand FAILED content.
          etag: null,
          lastModified: null,
          feedUrl: url,
          status: ConnectorStatus.DEGRADED,
          lastFailureAt: at.toISOString(),
          errorMessage: message,
        };
        await repository.save(row);
      },
    };
  }

  private async loadDiscoveryCompanies(job: DiscoverLinksJob): Promise<readonly CompanyEntity[]> {
    const companyIds: string[] = [];
    const watchlistRepository = this.dataSource.getRepository(WatchlistItemEntity);
    if (job.reason === 'BACKFILL') {
      companyIds.push(...job.companyIds);
    } else if (job.reason === 'DISCLOSURE_TRIGGER') {
      const companyId = job.companyIds[0];
      if (!companyId || !job.triggerFilingId) return Object.freeze([]);
      const filing = await this.dataSource.getRepository(FilingEntity).findOne({
        where: { id: job.triggerFilingId, companyId },
      });
      if (!filing) return Object.freeze([]);
      const watch = await watchlistRepository.findOne({ where: { companyId } });
      // 관심 목록에 없는 기업의 공시 이벤트는 기본적으로 P3입니다. 저장된 작업이 실행되기 전에
      // 기업의 등급이 올라가거나 다른 등급으로 명시적으로 지정되었다면, P3 실행 조건은
      // 더 이상 유효하지 않으므로 현재 등급의 정기 수집 주기를 따릅니다.
      if (watch && watch.priority !== WatchPriority.P3) return Object.freeze([]);
      companyIds.push(companyId);
    } else {
      for (const priority of job.priorities) {
        const watchlist = await watchlistRepository.find({
          where: { priority },
          order: { createdAt: 'ASC', id: 'ASC' },
        });
        companyIds.push(...watchlist.map((item) => item.companyId));
      }
    }
    if (
      job.reason === 'SCHEDULED' &&
      job.connectors.some((connector) => ['SEC', 'GDELT', 'ALPACA_NEWS'].includes(connector))
    ) {
      const groupRows: { companyId: string }[] = await this.dataSource.query(
        APPROVED_GROUP_COMPANIES_SQL,
      );
      companyIds.push(...groupRows.map((row) => row.companyId));
      if (job.connectors.some((connector) => ['GDELT', 'ALPACA_NEWS'].includes(connector))) {
        const global = await watchlistRepository.find({ select: { companyId: true } });
        companyIds.push(...global.map((row) => row.companyId));
      }
    }
    const uniqueIds = [...new Set(companyIds)];
    if (uniqueIds.length === 0) return Object.freeze([]);
    const companies: CompanyEntity[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += COMPANY_LOOKUP_BATCH_SIZE) {
      companies.push(
        ...(await this.dataSource.getRepository(CompanyEntity).find({
          where: { id: In(uniqueIds.slice(offset, offset + COMPANY_LOOKUP_BATCH_SIZE)) },
        })),
      );
    }
    const companyById = new Map(companies.map((company) => [company.id, company]));
    return Object.freeze(
      uniqueIds.flatMap((id) => {
        const company = companyById.get(id);
        return company ? [company] : [];
      }),
    );
  }

  private async loadSecScopes(
    scopedCompanies: readonly CompanyEntity[],
  ): Promise<readonly DiscoveryScope[]> {
    const ciks = [
      ...new Set(
        scopedCompanies.flatMap((company) => {
          const cik = company.cik?.padStart(10, '0');
          return cik && /^\d{10}$/.test(cik) && cik !== '0000000000' ? [cik] : [];
        }),
      ),
    ];
    const groups = new Map<string, CompanyEntity[]>(ciks.map((cik) => [cik, []]));
    for (let offset = 0; offset < ciks.length; offset += COMPANY_LOOKUP_BATCH_SIZE) {
      const batch = ciks.slice(offset, offset + COMPANY_LOOKUP_BATCH_SIZE);
      const related = await this.dataSource.getRepository(CompanyEntity).find({
        where: { cik: In([...batch, ...batch.map((cik) => cik.replace(/^0+/, ''))]) },
        order: { id: 'ASC' },
      });
      for (const company of related) {
        const group = groups.get(company.cik?.padStart(10, '0') ?? '');
        if (group && !group.some((existing) => existing.id === company.id)) group.push(company);
      }
    }
    const issuers = [...groups.values()].filter((group) => group.length > 0);
    const scopes: DiscoveryScope[] = [];
    // Keep each issuer and all its share classes together; persist before requesting the next issuer.
    for (let offset = 0; offset < issuers.length; offset += 1) {
      scopes.push({
        companies: issuers
          .slice(offset, offset + 1)
          .flat()
          .map((company) => ({
            ticker: company.ticker,
            stockCode: company.stockCode,
            cik: company.cik,
            nameKo: company.nameKo,
            nameEn: company.nameEn,
          })),
      });
    }
    return scopes;
  }

  private async persistCandidate(
    candidate: DiscoveryCandidate,
    irCompanyIdsByUrl: ReadonlyMap<string, readonly string[]>,
    job: DiscoverLinksJob,
    suppressAlerts = false,
    matchedCompanyIds: readonly string[] = [],
  ): Promise<boolean> {
    const sourcePolicy =
      candidate.sourcePolicy ?? (candidate.connector === 'SEC' ? SEC_NEWS_POLICY : null);
    if (
      candidate.connector === 'NAVER' ||
      sourcePolicy?.metadataStorageAllowed !== true ||
      sourcePolicy.displayAllowed !== true ||
      sourcePolicy.rightsMode !== candidate.rightsMode
    )
      return false;
    const content = candidate.content;
    const contentPolicyValid =
      !content ||
      (sourcePolicy.fullTextStorageAllowed === true &&
        content.rightsPolicy.metadataStorageAllowed === true &&
        content.rightsPolicy.displayAllowed === true &&
        content.rightsPolicy.fullTextStorageAllowed === true &&
        content.rightsPolicy.rightsMode === sourcePolicy.rightsMode &&
        candidate.rightsMode === sourcePolicy.rightsMode &&
        (content.language !== 'en' ||
          (sourcePolicy.aiAllowed === true && content.rightsPolicy.aiAllowed === true)));
    if (['IR', 'NEWS_RSS'].includes(candidate.connector) && (!content || !contentPolicyValid))
      return false;
    const candidateHash = rawHash(candidate);
    const externalId =
      candidate.externalId && candidate.externalId.length <= 255 ? candidate.externalId : null;
    let tickers = boundedValues(candidate.tickers);
    const tags = boundedValues(candidate.tags);
    const publishedAt = validInstant(candidate.publishedAt);
    const description =
      typeof candidate.metadata['description'] === 'string'
        ? candidate.metadata['description'].slice(0, MAX_TEXT_COLUMN_CHARACTERS)
        : null;
    const title = candidate.title.slice(0, MAX_TEXT_COLUMN_CHARACTERS);

    return this.dataSource.transaction(async (manager) => {
      const secCik =
        candidate.connector === 'SEC' && typeof candidate.metadata.cik === 'string'
          ? candidate.metadata.cik
          : null;
      const companies = secCik
        ? await manager.getRepository(CompanyEntity).find({
            where: [{ cik: secCik }, { cik: secCik.replace(/^0+/, '') }],
            order: { id: 'ASC' },
          })
        : matchedCompanyIds.length > 0
          ? await manager
              .getRepository(CompanyEntity)
              .find({ where: { id: In([...matchedCompanyIds]) } })
          : tickers.length === 0
            ? []
            : await manager.getRepository(CompanyEntity).find({
                where: [{ ticker: In(tickers) }, { stockCode: In(tickers) }],
                take: 2,
              });
      if (secCik || matchedCompanyIds.length > 0)
        tickers = boundedValues(
          companies.flatMap((company) => (company.ticker ? [company.ticker] : [])),
        ).sort();
      const feedUrl =
        typeof candidate.metadata['feedUrl'] === 'string' ? candidate.metadata['feedUrl'] : null;
      const registeredCompanyIds = feedUrl ? (irCompanyIdsByUrl.get(feedUrl) ?? []) : [];
      const companyId =
        registeredCompanyIds.length === 1
          ? registeredCompanyIds[0]!
          : companies.length === 1
            ? companies[0]!.id
            : null;
      const sourceRepository = manager.getRepository(SourceItemEntity);
      let sourceItem = externalId
        ? await sourceRepository.findOne({
            where: { source: candidate.connector, externalId },
            lock: { mode: 'pessimistic_write' },
          })
        : await sourceRepository.findOne({
            where: { source: candidate.connector, rawHash: candidateHash },
            lock: { mode: 'pessimistic_write' },
          });
      if (
        !sourceItem &&
        candidate.connector === 'IR' &&
        feedUrl &&
        isApprovedContentIrFeed(feedUrl)
      ) {
        const canonicalUrlHash = createHash('sha256')
          .update(canonicalNewsUrl(candidate.url))
          .digest('hex');
        const article = await manager.getRepository(NewsArticleEntity).findOne({
          where: { urlHash: canonicalUrlHash },
        });
        if (article) {
          const sameArticleSources = await sourceRepository.find({
            where: { source: 'IR', newsArticleId: article.id },
            order: { firstObservedAt: 'ASC', id: 'ASC' },
          });
          sourceItem =
            sameArticleSources.find((source) => {
              const storedFeedUrl = source.rawMetadataJson?.['feedUrl'];
              return typeof storedFeedUrl === 'string' && isApprovedContentIrFeed(storedFeedUrl);
            }) ?? null;
          if (sourceItem) {
            sourceItem = await sourceRepository.findOne({
              where: { id: sourceItem.id },
              lock: { mode: 'pessimistic_write' },
            });
            if (sourceItem) sourceItem.externalId = externalId;
          }
        }
      }
      const created = !sourceItem;
      const newsRepository = manager.getRepository(NewsItemEntity);
      let newsItem = sourceItem
        ? await newsRepository.findOne({ where: { sourceItemId: sourceItem.id } })
        : null;
      const contentRepository = manager.getRepository(NewsArticleContentEntity);
      const storedContent =
        sourceItem && content
          ? await contentRepository.findOne({
              where: { sourceItemId: sourceItem.id },
              lock: { mode: 'pessimistic_write' },
            })
          : null;
      const previousInput = sourceItem && newsItem ? translationInput(sourceItem, newsItem) : null;
      const previousTranslation = sourceItem?.translationJson;
      const previousRawHash = sourceItem?.rawHash;
      sourceItem ??= sourceRepository.create({
        source: candidate.connector,
        externalId,
        firstObservedAt: new Date(),
      });
      sourceItem.companyId = companyId;
      sourceItem.url = candidate.url;
      sourceItem.title = title;
      sourceItem.sourceName = candidate.sourceName?.slice(0, 255) ?? null;
      sourceItem.author =
        typeof candidate.metadata.originalAuthor === 'string'
          ? candidate.metadata.originalAuthor.slice(0, 255)
          : null;
      sourceItem.publishedAt = publishedAt;
      sourceItem.processedAt = new Date();
      sourceItem.rawHash = candidateHash;
      sourceItem.rawObjectUri = null;
      sourceItem.rightsMode = candidate.rightsMode;
      sourceItem.sourceKind = candidate.sourceKind ?? sourceKindForSource(candidate.connector);
      sourceItem.sourcePolicyJson = sourcePolicy;
      sourceItem.provenanceUrl = candidate.url;
      sourceItem.rawMetadataJson = {
        ...(candidate.connector === 'SEC' ? sourceItem.rawMetadataJson : {}),
        ...candidate.metadata,
        ...(secCik ? { companyIds: companies.map((company) => company.id).sort() } : {}),
        tickers,
        tags,
        matchedCompanyIds,
        companyMatchMethod: matchedCompanyIds.length > 0 ? 'UNAMBIGUOUS_TITLE_ALIAS_V1' : null,
        discoveryReason: job.reason,
        discoveryPriorities: job.priorities,
        triggerFilingId: job.triggerFilingId ?? null,
        externalIdTruncatedToHash: candidate.externalId !== null && externalId === null,
      };
      // Feed metadata can change without changing the text sent to the translator.
      // Rebind a valid completed result, including legacy results without a text fingerprint.
      const nextInput = translationInput(
        sourceItem,
        newsRepository.create({
          title,
          description,
          tickersJson: tickers.length > 0 ? tickers : null,
        }),
      );
      if (
        !sourceItem.manualTranslationJson &&
        !storedContent?.manualTranslationJson &&
        previousInput &&
        nextInput &&
        previousTranslation?.version === 1 &&
        previousTranslation.status === 'COMPLETED' &&
        previousTranslation.inputHash === previousRawHash &&
        newsTranslationInputHash(previousInput) === newsTranslationInputHash(nextInput)
      ) {
        sourceItem.translationJson = {
          ...previousTranslation,
          inputHash: candidateHash,
          sourceTextHash: newsTranslationInputHash(nextInput),
        };
      }
      sourceItem = await sourceRepository.save(sourceItem);
      await attachNewsArticle(manager, sourceItem);
      await replaceNewsCompanyRelevance(manager, sourceItem.id, title, [
        ...companies.map((company) => ({
          companyId: company.id,
          matchMethod: secCik ? 'SEC_CIK' : 'TITLE_ALIAS',
        })),
        ...registeredCompanyIds.map((id) => ({ companyId: id, matchMethod: 'REGISTERED_IR' })),
      ]);
      if (content && contentPolicyValid) {
        let content = storedContent;
        if (!(content?.status === 'AVAILABLE' && candidate.content.status === 'FAILED')) {
          const previousHash = content?.contentHash ?? null;
          content ??= contentRepository.create({ sourceItemId: sourceItem.id });
          content.status = candidate.content.status;
          content.language = candidate.content.language;
          content.blocksJson = candidate.content.blocks
            ? candidate.content.blocks.map((block) =>
                block.type === 'LIST' ? { ...block, items: [...block.items] } : { ...block },
              )
            : null;
          content.contentHash = candidate.content.contentHash;
          content.extractorVersion = 1;
          content.fetchedAt = new Date(candidate.content.fetchedAt);
          content.attemptedAt = new Date(candidate.content.fetchedAt);
          content.attempts = Math.min((content.attempts ?? 0) + 1, 1_000_000);
          content.nextAttemptAt =
            candidate.content.status === 'FAILED' ? new Date(Date.now() + 15 * 60_000) : null;
          content.failureCode = candidate.content.failureCode;
          content.rightsPolicyJson = candidate.content.rightsPolicy;
          if (
            previousHash !== candidate.content.contentHash &&
            !sourceItem.manualTranslationJson &&
            !content.manualTranslationJson
          ) {
            content.translationJson =
              candidate.content.status === 'AVAILABLE' &&
              candidate.content.language === 'en' &&
              candidate.content.contentHash &&
              candidate.content.rightsPolicy.aiAllowed === true
                ? {
                    version: 1,
                    status: 'PENDING',
                    inputHash: candidate.content.contentHash,
                    provider: 'LOCAL',
                    model: this.config.newsTranslationModel,
                    sourceLanguage: 'en',
                    targetLanguage: 'ko',
                    blocks: null,
                    attemptedAt: candidate.content.fetchedAt,
                    translatedAt: null,
                    attempts: 0,
                    nextAttemptAt: candidate.content.fetchedAt,
                  }
                : null;
          }
          await contentRepository.save(content);
        }
      }
      if (candidate.connector === 'SEC')
        await projectSecFilingEvents(manager, sourceItem, companies);

      newsItem ??= newsRepository.create({ sourceItemId: sourceItem.id });
      newsItem.companyId = companyId;
      newsItem.title = title;
      newsItem.description = description;
      newsItem.publishedAt = publishedAt;
      newsItem.tickersJson = tickers.length > 0 ? tickers : null;
      newsItem.tagsJson = tags.length > 0 ? tags : null;
      newsItem.engagementJson = null;
      newsItem = await newsRepository.save(newsItem);
      // Publisher RSS is authorized for collection only, without outgoing notifications.
      if (
        created &&
        candidate.connector === 'SEC' &&
        !suppressAlerts &&
        !job.suppressAlerts &&
        job.reason !== 'BACKFILL'
      ) {
        await this.pushFanout.enqueueNews(manager, newsItem, sourceItem);
      }
      return created;
    });
  }

  private async recordSuccess(
    connector: ConnectorName,
    rightsMode: DiscoveryCandidate['rightsMode'],
    now: Date,
    seen: number,
    created: number,
    truncated: boolean,
    partialFailureCount: number,
    stream: string,
    metadata: Readonly<Record<string, unknown>> = {},
    completion: { degradedMessage?: string | null; recordSuccessInstant?: boolean } = {},
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const checkpoints = manager.getRepository(SourceCheckpointEntity);
      const checkpoint =
        (await checkpoints.findOne({
          where: { connector, stream },
        })) ??
        checkpoints.create({
          connector,
          stream,
          lastSuccessDate: null,
          cursor: null,
        });
      if (completion.recordSuccessInstant !== false) checkpoint.lastSuccessAt = now;
      else checkpoint.lastSuccessAt ??= null;
      checkpoint.metadataJson = {
        ...metadata,
        seen,
        created,
        truncated,
        partialFailureCount,
        rightsMode,
      };
      await checkpoints.save(checkpoint);

      const health = manager.getRepository(ConnectorHealthEntity);
      const row =
        (await health.findOne({ where: { connector: connector.toLowerCase() } })) ??
        health.create({ connector: connector.toLowerCase() });
      row.status =
        partialFailureCount > 0 || truncated || completion.degradedMessage
          ? ConnectorStatus.DEGRADED
          : ConnectorStatus.HEALTHY;
      row.message =
        [
          completion.degradedMessage,
          truncated
            ? connector === 'GDELT'
              ? 'GDELT window recovery is incomplete; inspect its checkpoint.'
              : 'Discovery recovery is incomplete; inspect the remaining cursor.'
            : null,
          partialFailureCount > 0
            ? connector === 'NEWS_RSS'
              ? `${partialFailureCount} RSS feed/item failure(s).`
              : `${partialFailureCount} registered IR feed(s) failed.`
            : null,
        ]
          .filter((message): message is string => Boolean(message))
          .join(' ') || null;
      row.checkedAt = now;
      if (completion.recordSuccessInstant !== false) row.lastSuccessAt = now;
      else row.lastSuccessAt ??= null;
      if (row.status === ConnectorStatus.DEGRADED) row.lastFailureAt = now;
      else row.lastFailureAt ??= null;
      row.metadataJson = {
        ...metadata,
        requestAttempted: ['SEC', 'GDELT', 'ALPACA_NEWS'].includes(connector)
          ? Number(metadata.requestsAttempted ?? metadata.requestsInRun ?? 0) > 0
          : true,
        httpStatus:
          !['SEC', 'GDELT', 'ALPACA_NEWS'].includes(connector) ||
          Number(
            metadata.requestsCompleted ?? metadata.requestsInRun ?? metadata.requestsAttempted ?? 0,
          ) > 0
            ? 200
            : null,
        lastAttemptAt:
          connector !== 'SEC' || Number(metadata.requestsAttempted ?? 0) > 0
            ? now.toISOString()
            : (row.metadataJson?.lastAttemptAt ?? null),
        rightsMode,
        discoverySeen: seen,
        discoveryCreated: created,
        truncated,
        partialFailureCount,
      };
      await health.save(row);
    });
  }

  private async recordFailure(
    connector: ConnectorName,
    rightsMode: DiscoveryCandidate['rightsMode'],
    now: Date,
    message: string,
    stream: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const health = this.dataSource.getRepository(ConnectorHealthEntity);
    const row =
      (await health.findOne({ where: { connector: connector.toLowerCase() } })) ??
      health.create({ connector: connector.toLowerCase() });
    row.status = ConnectorStatus.DEGRADED;
    row.message = message;
    row.checkedAt = now;
    row.lastSuccessAt ??= null;
    row.lastFailureAt = now;
    row.metadataJson = {
      rightsMode,
      operation: stream,
      ...metadata,
      lastAttemptAt:
        metadata.requestAttempted === false
          ? (row.metadataJson?.lastAttemptAt ?? null)
          : now.toISOString(),
    };
    await health.save(row);
  }
}
