import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
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
  NewsItemEntity,
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
  RegisteredIrFeedConnector,
  PublisherNewsRssConnector,
  type ConnectorName,
  type DiscoveryCandidate,
  type DiscoveryScope,
  type FeedCheckpointStore,
  type FeedCheckpoint,
} from './connector-adapters';
import { matchNewsCompany } from './news-company-matching';
import { projectSecFilingEvents } from './sec-event-projection';

const MAX_CANDIDATES_PER_DISCOVERY_BATCH = 500;
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
    const feedUrls = new Set<string>(this.config.irFeedUrls);
    for (const source of irSources) {
      try {
        if (
          !['RSS', 'ATOM'].includes(source.sourceType.toUpperCase()) ||
          source.rightsMode !== RightsMode.OFFICIAL_PUBLIC_DATA
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
    const aliases = job.connectors.some((connector) => ['NEWS_RSS', 'GDELT'].includes(connector))
      ? await this.dataSource.getRepository(CompanyAliasEntity).find()
      : [];
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
            : ['IR', 'NEWS_RSS', 'GDELT'].includes(adapter.name)
              ? discoveryScopes.slice(0, 1)
              : discoveryScopes;
        for (const scope of adapterScopes) {
          const issuerCiks =
            adapter.name === 'SEC'
              ? [
                  ...new Set(
                    scope.companies.flatMap((company) =>
                      company.cik ? [company.cik.padStart(10, '0')] : [],
                    ),
                  ),
                ]
              : [];
          const initialIssuers = await this.initialSecIssuers(issuerCiks);
          const candidates = await adapter.discoverLinks(scope);
          seen += candidates.length;
          // RSS/IR parsers already bound each feed. Persist every returned feed item before
          // saving HTTP validators, otherwise a 304 could hide unpersisted articles forever.
          const selected = ['NEWS_RSS', 'IR'].includes(adapter.name)
            ? candidates
            : candidates.slice(0, MAX_CANDIDATES_PER_DISCOVERY_BATCH);
          truncated ||= candidates.length > selected.length;
          for (const candidate of selected) {
            const suppressAlerts =
              job.suppressAlerts ||
              job.reason === 'BACKFILL' ||
              (candidate.connector === 'SEC' && initialIssuers.has(String(candidate.metadata.cik)));
            if (
              await this.persistCandidate(
                candidate,
                irCompanyIdsByUrl,
                job,
                suppressAlerts,
                matchNewsCompany(candidate.title, aliases),
              )
            ) {
              created += 1;
            }
          }
          if (selected.length === candidates.length)
            await this.completeSecBaselines(issuerCiks, job);
        }
        const partialFailureCount =
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
        const completedAt = new Date();
        run.status = ProcessingStatus.COMPLETED;
        run.itemsSeen = String(seen);
        run.itemsCreated = String(created);
        run.finishedAt = completedAt;
        const runWarnings = [
          adapter.name === 'SEC' ? secScopeWarning : null,
          truncated
            ? `A discovery batch was capped at ${MAX_CANDIDATES_PER_DISCOVERY_BATCH} candidates.`
            : null,
          partialFailureCount > 0
            ? adapter.name === 'NEWS_RSS'
              ? `${partialFailureCount} RSS feed/item failure(s); healthy items were retained.`
              : `${partialFailureCount} registered IR feed(s) failed; healthy feeds were retained.`
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
            ...(adapter instanceof PublisherNewsRssConnector ||
            adapter instanceof RegisteredIrFeedConnector
              ? adapter.discoveryMetadata
              : {}),
          },
          adapter.name === 'SEC'
            ? { degradedMessage: secScopeWarning, recordSuccessInstant: secScopes.length > 0 }
            : {},
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
        const message = messageOf(error);
        run.status = ProcessingStatus.FAILED;
        run.finishedAt = failedAt;
        run.errorMessage = message;
        await runs.save(run);
        await this.recordFailure(adapter.name, adapter.rightsMode, failedAt, message, stream, {
          ...discoveryMetadata,
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
      const warning = `${incompatibleIrSources.length} active IR source(s) were skipped: only credential-free public HTTPS RSS/Atom sources with OFFICIAL_PUBLIC_DATA rights are supported.`;
      await this.recordFailure('IR', RightsMode.OFFICIAL_PUBLIC_DATA, checkedAt, warning, stream);
      const existingIr = results.findIndex((result) => result.connector === 'IR');
      const degraded = {
        connector: 'IR' as const,
        status: ConnectorStatus.DEGRADED,
        seen: existingIr >= 0 ? results[existingIr]!.seen : 0,
        created: existingIr >= 0 ? results[existingIr]!.created : 0,
        message: warning,
      };
      if (existingIr >= 0) results[existingIr] = degraded;
      else results.push(degraded);
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
    // Keep every share class of an issuer in the same batch: at most 25 issuers × 20 filings.
    for (let offset = 0; offset < issuers.length; offset += MAX_DISCOVERY_SCOPE_COMPANIES) {
      scopes.push({
        companies: issuers
          .slice(offset, offset + MAX_DISCOVERY_SCOPE_COMPANIES)
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

  private async initialSecIssuers(ciks: readonly string[]): Promise<ReadonlySet<string>> {
    const checkpoints = this.dataSource.getRepository(SourceCheckpointEntity);
    const initial = new Set<string>();
    for (const cik of ciks) {
      const row = await checkpoints.findOne({
        where: { connector: 'SEC', stream: `SUBMISSIONS:CIK:${cik}` },
      });
      if (!row?.lastSuccessAt || row.metadataJson?.baselineComplete !== true) initial.add(cik);
    }
    return initial;
  }

  private async completeSecBaselines(
    ciks: readonly string[],
    job: DiscoverLinksJob,
  ): Promise<void> {
    if (ciks.length === 0) return;
    await this.dataSource.transaction(async (manager) => {
      const checkpoints = manager.getRepository(SourceCheckpointEntity);
      const now = new Date();
      for (const cik of ciks) {
        const stream = `SUBMISSIONS:CIK:${cik}`;
        const row =
          (await checkpoints.findOne({ where: { connector: 'SEC', stream } })) ??
          checkpoints.create({ connector: 'SEC', stream, lastSuccessDate: null, cursor: null });
        row.lastSuccessAt = now;
        row.metadataJson = {
          ...row.metadataJson,
          cik,
          baselineComplete: true,
          baselineCompletedAt: row.metadataJson?.baselineCompletedAt ?? now.toISOString(),
          lastDiscoveryReason: job.reason,
        };
        await checkpoints.save(row);
      }
    });
  }

  private async persistCandidate(
    candidate: DiscoveryCandidate,
    irCompanyIdsByUrl: ReadonlyMap<string, readonly string[]>,
    job: DiscoverLinksJob,
    suppressAlerts = false,
    matchedCompanyId: string | null = null,
  ): Promise<boolean> {
    if (
      candidate.connector === 'NAVER' ||
      candidate.sourcePolicy?.metadataStorageAllowed === false ||
      (candidate.connector === 'GDELT' && candidate.sourcePolicy?.metadataStorageAllowed !== true)
    )
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
        : matchedCompanyId
          ? await manager.getRepository(CompanyEntity).find({ where: { id: matchedCompanyId } })
          : tickers.length === 0
            ? []
            : await manager.getRepository(CompanyEntity).find({
                where: [{ ticker: In(tickers) }, { stockCode: In(tickers) }],
                take: 2,
              });
      if (secCik || matchedCompanyId)
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
          })
        : await sourceRepository.findOne({
            where: { source: candidate.connector, rawHash: candidateHash },
          });
      const created = !sourceItem;
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
      sourceItem.sourcePolicyJson = candidate.sourcePolicy ?? {
        rightsMode: candidate.rightsMode,
        aiAllowed: 'UNKNOWN',
        fullTextStorageAllowed: false,
        metadataStorageAllowed: true,
        displayAllowed: true,
        publicRedistributionAllowed: 'UNKNOWN',
        notifyAllowed: candidate.connector === 'SEC',
        policyUrl: candidate.url,
        checkedAt: '2026-09-05',
      };
      sourceItem.provenanceUrl = candidate.url;
      sourceItem.rawMetadataJson = {
        ...candidate.metadata,
        ...(secCik ? { companyIds: companies.map((company) => company.id).sort() } : {}),
        tickers,
        tags,
        matchedCompanyId,
        companyMatchMethod: matchedCompanyId ? 'UNAMBIGUOUS_TITLE_ALIAS' : null,
        discoveryReason: job.reason,
        discoveryPriorities: job.priorities,
        triggerFilingId: job.triggerFilingId ?? null,
        externalIdTruncatedToHash: candidate.externalId !== null && externalId === null,
      };
      sourceItem = await sourceRepository.save(sourceItem);
      await attachNewsArticle(manager, sourceItem);
      if (candidate.connector === 'SEC')
        await projectSecFilingEvents(manager, sourceItem, companies);

      const newsRepository = manager.getRepository(NewsItemEntity);
      let newsItem = await newsRepository.findOne({
        where: { sourceItemId: sourceItem.id },
      });
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
            ? `A discovery batch was capped at ${MAX_CANDIDATES_PER_DISCOVERY_BATCH}.`
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
        rightsMode,
        discoverySeen: seen,
        discoveryCreated: created,
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
    row.metadataJson = { rightsMode, operation: stream, ...metadata };
    await health.save(row);
  }
}
