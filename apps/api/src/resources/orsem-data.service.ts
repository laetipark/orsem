import { adminNewsSourceViews } from './news-operations';
import { resolveNewsReview, type NewsReviewInput } from './news-review';
import { newsAudienceAllows, newsAudienceSql, type NewsAudience } from './news-access';
import { publicSourceUrl } from '../common/news-url';
import { publicDiscoveryStatus } from './connector-public-status';
import { verifyManualNewsSources } from './manual-news-translation';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AlertStatus,
  APPROVED_GDELT_SOURCE_POLICIES,
  classifyFilingDocumentKind,
  ClassificationReviewResult,
  ConnectorStatus,
  EffectiveFilingState,
  EventState,
  EvidenceGrade,
  FilingRelationType,
  ParseStatus,
  ProcessingStatus,
  RelationReviewDecision,
  RelationSource,
  ReviewTaskStatus,
  RightsMode,
  NEWS_IR_SOURCE_PROFILES,
  getNewsIrSourceProfile,
  newsPolicyApprovalReady,
  NEWS_RSS_FEEDS,
  newsCompanyIdsSchema,
  sourceKindForSource,
  candleSourceSchema,
  matchesRegion,
  marketsForRegion,
  hasParseTypeInvariant,
  largeHoldingSchema,
  isSupportedFilingType,
  type Region,
  type CandleSource,
  type Company,
  type CompanySummaryView,
  type CompanyTimeline,
  type ConnectorHealth,
  type Event,
  type EventSummaryView,
  type FilingDetail,
  type FilingSummary,
  type IrSource,
  type NewsDetail,
  type Review,
  type SourceItem,
  type WatchlistItem,
} from '@orsem/contracts';
import {
  CompanyEntity,
  AlertDeliveryEntity,
  PushDeliveryEntity,
  AlertEntity,
  ConnectorHealthEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  FilingRelationEntity,
  InsiderReportEntity,
  InsiderTransactionEntity,
  LargeHolderReportEntity,
  LargeHoldingChangeEntity,
  IrSourceEntity,
  JobOutboxEntity,
  NewsItemEntity,
  NewsArticleEntity,
  SourceCheckpointEntity,
  ParseRunEntity,
  PlanExecutionMatchEntity,
  PriceBarEntity,
  ReviewEntity,
  SourceItemEntity,
  isReadableOfficialNewsSource,
  TradePlanEntity,
  TradePlanItemEntity,
  WatchlistItemEntity,
  MarketLeaderScopeEntity,
  AlertOutboxEntity,
  BotDeliveryEntity,
  IngestionRunEntity,
  dateToIso,
  PARSE_INTEGRITY_METRICS_SQL,
  mapParseIntegrityMetrics,
  hasConfirmedSourceReview,
  type ParseIntegrityMetrics,
} from '@orsem/database';
import { createHash, randomUUID } from 'node:crypto';
import {
  In,
  type DataSource,
  type EntityManager,
  type EntityTarget,
  type ObjectLiteral,
  type FindOptionsWhere,
} from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { parseWith } from '../common/zod';
import { cursorInstant, decodeCursor } from '../common/cursor';
import {
  finishPage,
  pageRows,
  paginateFixture,
  type CursorPage,
  type PageQuery,
} from '../common/pagination';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { literalSearchPattern, newsTranslationSearchCondition } from '../common/news-translation';
import {
  metadataNewsSql,
  eventAudienceSql,
  newsFiltersSql,
  newsFilterParameters,
  representativeNewsSql,
  NEWS_GROUP_ID,
  NEWS_GROUP_SORT,
  visibleNewsSql,
  visibleEventSourceSql,
  PUBLIC_NEWS_PUBLISHERS,
} from './news-query';
import {
  mapCompany,
  mapFixtureEvent,
  mapFixtureSourceItem,
  mapIrSource,
  mapReview,
  mapSourceItem,
} from './resource-mappers';

import { readDisclosureFacts, candidateDisclosureEvidence } from './disclosure-facts';

function parsedSourceMatchesRun(
  run: Pick<ParseRunEntity, 'rawSha256'>,
  parsed: Record<string, unknown> | undefined,
): boolean {
  const source = parsed?.source;
  return Boolean(
    /^[a-f0-9]{64}$/u.test(run.rawSha256) &&
    source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    (source as Record<string, unknown>).archiveSha256 === run.rawSha256,
  );
}

function reviewedIrFeed(value: string) {
  const url = new URL(value).toString();
  const profile = getNewsIrSourceProfile(url);
  if (!profile) throw new BadRequestException('검토가 완료된 IR 피드만 등록할 수 있습니다.');
  return { url: profile.url, profile };
}

function isReviewedIrFeed(value: string): boolean {
  try {
    reviewedIrFeed(value);
    return true;
  } catch {
    return false;
  }
}

function resolvedSourceKind(row: SourceItemEntity): string {
  const feedId = row.rawMetadataJson?.feedId;
  const feed =
    typeof feedId === 'string' ? NEWS_RSS_FEEDS[feedId as keyof typeof NEWS_RSS_FEEDS] : undefined;
  return row.sourceKind ?? feed?.sourceKind ?? sourceKindForSource(row.source);
}

function sourcePolicyAllowsDisplay(
  row: SourceItemEntity,
  allowedKinds: readonly string[],
  allowedPublishers?: readonly string[],
  audience: NewsAudience = 'MEMBER_UI',
): boolean {
  const policy = row.sourcePolicyJson;
  const publisherId =
    typeof row.rawMetadataJson?.publisherId === 'string'
      ? row.rawMetadataJson.publisherId
      : (row.sourceName ?? row.source);
  return Boolean(
    !row.source.startsWith('NAVER') &&
    newsAudienceAllows(row, audience) &&
    policy &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.rightsMode === row.rightsMode &&
    allowedKinds.includes(resolvedSourceKind(row)) &&
    (!allowedPublishers || allowedPublishers.includes(publisherId)),
  );
}

function parsedDocumentKindMatchesFiling(
  filing: Pick<FilingEntity, 'reportName'>,
  parsed: Record<string, unknown> | undefined,
): boolean {
  return (
    parsed?.detailType !== 'D004' ||
    parsed.documentKind === classifyFilingDocumentKind(filing.reportName)
  );
}

function crosscheckReadyForProjection(
  resultType: string | null | undefined,
  crosscheck: Record<string, unknown> | undefined,
  rceptNo: string | null | undefined,
): boolean {
  if (resultType === 'D003' || resultType === 'D004') {
    return (
      crosscheck?.status === 'NOT_APPLICABLE' &&
      crosscheck.reason === `NO_SUMMARY_API_FOR_${resultType}`
    );
  }
  if (resultType === 'D005') return crosscheck?.status === 'NOT_APPLICABLE';
  if ((resultType !== 'D001' && resultType !== 'D002') || !rceptNo) return false;
  return (
    crosscheck?.status === 'OK' &&
    Array.isArray(crosscheck.exactReceiptMatches) &&
    crosscheck.exactReceiptMatches.some(
      (row: unknown) =>
        row && typeof row === 'object' && (row as Record<string, unknown>).rcept_no === rceptNo,
    )
  );
}

export type { CursorPage } from '../common/pagination';

export interface ListQuery extends PageQuery {
  audience?: NewsAudience;
  personalActorKey?: string;
  q?: string;
  region?: Region;
  companyIds?: string[];
  [key: string]: unknown;
}

const supportedEventFilingsSql = `NOT EXISTS (SELECT 1 FROM event_cluster_items integrity_item
  JOIN filings integrity_filing ON integrity_filing.id = integrity_item.item_id
  WHERE integrity_item.event_cluster_id = event.id AND integrity_item.item_type = 'FILING'
    AND integrity_filing.canonical_type IS NOT NULL
    AND integrity_filing.canonical_type NOT IN ('D001','D002','D003','D004','D005'))`;

type EventFilingFacts = FilingSummary & {
  transactions?: Array<
    Pick<FilingDetail['transactions'][number], 'nature' | 'direction' | 'eventDate'>
  >;
  largeHolding?: Pick<NonNullable<FilingDetail['largeHolding']>, 'changes'> | null;
  tradePlan?: Pick<NonNullable<FilingDetail['tradePlan']>, 'plannedStartDate'> | null;
};

@Injectable()
export class OrsemDataService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
    private readonly fixtures: FixtureStoreService,
  ) {}

  get fixtureMode(): boolean {
    return this.config.fixtureMode;
  }

  private source(): DataSource {
    const source = this.database.dataSource;
    if (!source)
      throw new ServiceUnavailableException(
        '데이터베이스를 사용할 수 없습니다. 운영 상태를 확인하세요.',
      );
    return source;
  }

  async listCompanies(query: ListQuery): Promise<CursorPage<Company>> {
    if (this.fixtureMode) {
      const q = query.q?.toLocaleLowerCase('ko-KR');
      const filtered = this.fixtures.companies
        .filter(
          (company) =>
            company.isListed &&
            matchesRegion(company.market, query.region) &&
            (!q ||
              [company.nameKo, company.nameEn, company.stockCode, company.ticker].some((v) =>
                v?.toLowerCase().includes(q),
              )),
        )
        .sort(
          (left, right) =>
            left.nameKo.localeCompare(right.nameKo, 'ko-KR') || left.id.localeCompare(right.id),
        );
      return paginateFixture(filtered, query, (item) => item.nameKo);
    }
    const cursor = decodeCursor(query.cursor);
    const qb = this.source().getRepository(CompanyEntity).createQueryBuilder('company');
    if (query.region && query.region !== 'all') {
      qb.andWhere('company.market IN (:...regionMarkets)', {
        regionMarkets: marketsForRegion(query.region),
      });
    }
    qb.andWhere('company.isListed = :isListed', { isListed: true }).andWhere(
      `(
        NOT EXISTS (
          SELECT 1 FROM alpaca_assets alpaca_history
          WHERE alpaca_history.company_id = company.id
        )
        OR EXISTS (
          SELECT 1 FROM alpaca_assets alpaca_current
          WHERE alpaca_current.company_id = company.id
            AND alpaca_current.is_current = :alpacaCurrent
        )
      )`,
      { alpacaCurrent: true },
    );
    if (query.q) {
      qb.andWhere(
        '(company.nameKo LIKE :q OR company.nameEn LIKE :q OR company.stockCode LIKE :q OR company.ticker LIKE :q)',
        {
          q: `%${query.q}%`,
        },
      );
    }
    if (cursor) {
      qb.andWhere(
        '(company.nameKo > :sort OR (company.nameKo = :sort AND company.id > :id))',
        cursor,
      );
    }
    const rows = await qb
      .orderBy('company.nameKo', 'ASC')
      .addOrderBy('company.id', 'ASC')
      .take(query.limit + 1)
      .getMany();
    return pageRows(rows, query.limit, mapCompany, (row) => row.nameKo);
  }

  async getCompany(id: string): Promise<Company> {
    if (this.fixtureMode) {
      const company = this.fixtures.companies.find((item) => item.id === id);
      if (!company) throw new NotFoundException('회사를 찾을 수 없습니다.');
      return company;
    }
    const row = await this.source().getRepository(CompanyEntity).findOneBy({ id });
    if (!row) throw new NotFoundException('회사를 찾을 수 없습니다.');
    return mapCompany(row);
  }

  async companiesByIds(ids: string[]): Promise<Company[]> {
    if (!ids.length) return [];
    const companies = this.fixtureMode
      ? this.fixtures.companies.filter((company) => ids.includes(company.id))
      : (
          await this.source()
            .getRepository(CompanyEntity)
            .findBy({ id: In(ids) })
        ).map(mapCompany);
    const byId = new Map(companies.map((company) => [company.id, company]));
    // A removed company in browser history does not suppress other companies' prices.
    return ids.flatMap((id) => {
      const company = byId.get(id);
      return company ? [company] : [];
    });
  }

  async findCompanies(query: string, limit = 10): Promise<Company[]> {
    return (await this.listCompanies({ q: query, limit })).items;
  }

  async findCompanyEvents(
    query: string,
    limit = 10,
  ): Promise<{ company: Company | null; events: Event[] }> {
    const company = (await this.findCompanies(query, 1))[0] ?? null;
    if (!company) return { company: null, events: [] };
    const events = await this.listEvents({ companyId: company.id, limit });
    return { company, events: events.items };
  }

  async listCompanyViews(query: ListQuery): Promise<CursorPage<CompanySummaryView>> {
    const page = await this.listCompanies(query);
    const items = await this.companySummaryViews(page.items);
    return { ...page, items };
  }

  async getCompanyView(id: string): Promise<Record<string, unknown>> {
    const company = await this.getCompany(id);
    const summary = await this.companySummaryView(company);
    const recentEvents = await this.listEventViews({ companyId: id, limit: 8 });
    const watch = await this.watchForCompany(id);
    const officialSource = company.corpCode
      ? {
          id: `identity-${company.id}`,
          source: 'OPENDART',
          sourceName: 'OpenDART 기업 고유번호',
          title: `${company.nameKo} corp_code 매핑`,
          url: 'https://opendart.fss.or.kr/',
          publishedAt: null,
          firstObservedAt: company.updatedAt,
          grade: EvidenceGrade.A,
          rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
          isOfficial: true,
        }
      : company.cik
        ? {
            id: `identity-${company.id}`,
            source: 'SEC',
            sourceName: 'SEC EDGAR',
            title: `${company.nameEn ?? company.nameKo} CIK 매핑`,
            url: 'https://www.sec.gov/edgar/search/',
            publishedAt: null,
            firstObservedAt: company.updatedAt,
            grade: EvidenceGrade.A,
            rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
            isOfficial: true,
          }
        : null;
    return {
      ...summary,
      corpCode: company.corpCode,
      cik: company.cik,
      thesis: watch?.notes ?? null,
      tags: watch ? [watch.priority] : [],
      recentEvents: recentEvents.items,
      provenance: officialSource ? [officialSource] : [],
    };
  }

  async listEventViews(query: ListQuery): Promise<CursorPage<EventSummaryView>> {
    const page = await this.listEvents(query);
    const items = await this.eventSummaryViews(page.items);
    return { ...page, items };
  }

  async getEventView(
    id: string,
    audience: NewsAudience = 'MEMBER_UI',
  ): Promise<Record<string, unknown>> {
    const event = await this.getEvent(id, audience);
    const summary = await this.eventSummaryView(event);
    const filing = event.filing ? await this.getFiling(event.filing.id) : null;
    const primarySource = event.sourceItems[0] ?? null;
    const evidence = [
      ...(filing
        ? [
            {
              id: `evidence-${filing.id}`,
              source: 'OPENDART',
              sourceName: 'OpenDART',
              title: filing.reportName,
              url: filing.officialUrl,
              publishedAt: null,
              firstObservedAt: filing.firstObservedAt,
              grade: event.evidenceGrade,
              rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
              isOfficial: true,
              excerpt: '공식 원문에서 추출한 구조화 데이터이며 원문 필드를 별도로 보존합니다.',
            },
          ]
        : []),
      ...event.sourceItems.map((source) => ({
        id: source.id,
        source: source.source,
        sourceName: source.sourceName ?? source.source,
        title: source.title,
        description: source.description ?? null,
        translation: source.translation ?? null,
        url: source.url,
        publishedAt: source.publishedAt,
        firstObservedAt: source.firstObservedAt,
        grade: event.evidenceGrade,
        rightsMode: source.rightsMode,
        isOfficial: source.rightsMode === RightsMode.OFFICIAL_PUBLIC_DATA,
        excerpt:
          source.rightsMode === RightsMode.STORE_METADATA_ONLY ||
          source.rightsMode === RightsMode.LINK_ONLY
            ? '제목·메타데이터·링크만 표시하며 기사 본문은 저장하거나 재배포하지 않습니다.'
            : undefined,
      })),
    ];
    const relatedLineage = filing
      ? (
          await Promise.all(
            filing.relations.map(async (relation) => {
              const related = await this.getFiling(relation.relatedRceptNo).catch(() => null);
              if (!related) return null;
              return {
                id: related.id,
                label: `${relation.relationType}${
                  relation.reviewDecision === RelationReviewDecision.PENDING &&
                  relation.reviewRequired
                    ? ' 후보 · 검토 필요'
                    : relation.reviewDecision === RelationReviewDecision.PENDING
                      ? ''
                      : relation.reviewDecision === RelationReviewDecision.CONFIRMED
                        ? ' · 확인됨'
                        : ` · ${relation.reviewDecision}`
                }`,
                submissionKind: related.submissionKind,
                effectiveState: related.effectiveState,
                rceptDate: related.rceptDate,
                publishedAt: null,
              };
            }),
          )
        ).filter((item) => item !== null)
      : [];
    const lineage = filing
      ? [
          {
            id: filing.id,
            label:
              filing.submissionKind === 'CORRECTION'
                ? '정정 공시'
                : filing.submissionKind === 'WITHDRAWAL'
                  ? '철회 공시'
                  : '최초 공시',
            submissionKind: filing.submissionKind,
            effectiveState: filing.effectiveState,
            rceptDate: filing.rceptDate,
            publishedAt: null,
          },
          ...relatedLineage,
        ]
      : [
          {
            id: event.id,
            label: primarySource?.sourceName ?? '소스 이벤트',
            submissionKind: summary.submissionKind,
            effectiveState: 'ACTIVE',
            rceptDate: summary.rceptDate,
            publishedAt: event.publishedAt,
          },
        ];
    return {
      ...summary,
      filerName: filing?.filerName ?? primarySource?.author ?? summary.companyName,
      reporterName: filing?.reporter?.name ?? null,
      relationship: filing?.reporter?.relationship ?? null,
      position: filing?.reporter?.position ?? null,
      ownershipBefore: filing?.reporter?.ownershipBefore ?? null,
      ownershipAfter: filing?.reporter?.ownershipAfter ?? null,
      ownershipChange: filing?.reporter?.ownershipChange ?? null,
      ownershipRateAfter: filing?.reporter?.ownershipRateAfter ?? null,
      parserVersion: filing?.parserVersion ?? null,
      transactions: filing?.transactions ?? [],
      tradePlan: filing?.tradePlan ?? null,
      largeHolding: filing?.largeHolding ?? null,
      proxySolicitation: filing?.proxySolicitation ?? null,
      tenderOffer: filing?.tenderOffer ?? null,
      evidence,
      lineage,
      limitations: [
        summary.detailType === 'SEC'
          ? 'SEC 공시의 접수 메타데이터입니다. Form 4 거래 행이나 8-K 본문을 분석한 결과가 아닙니다.'
          : filing?.detailType === 'D003'
            ? '의결권 위임 권유 내용이며 주식 거래·보유 변동으로 계산하지 않습니다.'
            : filing?.detailType === 'D004'
              ? '공개매수 조건과 결과를 구분합니다. 청약·예정 수량을 실제 취득으로 계산하지 않습니다.'
              : filing?.detailType === 'D005'
                ? '거래계획은 실제 체결을 의미하지 않으며 D002 등 후속 공시 확인이 필요합니다.'
                : '공시 제출일과 실제 사건 발생일은 다를 수 있습니다.',
        '이 정보는 소유·지배구조 관측 자료이며 자동 매수·매도 추천이 아닙니다.',
      ],
    };
  }

  async companyTimeline(
    companyId: string,
    range: '1M' | '3M' | '1Y',
    interval: '1d' | '1m' = '1d',
  ): Promise<CompanyTimeline> {
    const company = await this.getCompany(companyId);
    const isUs = ['NASDAQ', 'NYSE', 'AMEX'].includes(company.market);
    const selectedSource = isUs ? 'TOSS_US' : 'TOSS_KR';
    const configured = Boolean(this.config.tossClientId && this.config.tossClientSecret);
    const cutoffDays = range === '1M' ? 31 : range === '1Y' ? 366 : 93;
    let prices: CompanyTimeline['prices'] = [];
    let indicatorWarmupPrices: CompanyTimeline['prices'] = [];
    if (!this.fixtureMode && configured) {
      const cutoff = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000);
      const query = this.source()
        .getRepository(PriceBarEntity)
        .createQueryBuilder('bar')
        .where('bar.companyId = :companyId', { companyId })
        .andWhere('bar.interval = :interval', { interval })
        .andWhere('bar.source = :source', { source: selectedSource });
      if (interval === '1d') query.andWhere('bar.barAt >= :cutoff', { cutoff });
      // 분봉 화면에는 저장된 최신 1,000개 봉을 표시하며 기간 선택은 일봉에만 적용합니다.
      const rows = await query
        .orderBy('bar.barAt', 'DESC')
        .take(interval === '1m' ? 1000 : 366)
        .getMany();
      rows.reverse();
      const toPrice = (row: PriceBarEntity): CompanyTimeline['prices'][number] => ({
        time:
          interval === '1m'
            ? row.barAt.toISOString()
            : (row.sessionDate ?? kstDateFromInstant(row.barAt.toISOString())!),
        sessionDate: row.sessionDate ?? kstDateFromInstant(row.barAt.toISOString())!,
        observedAt: dateToIso(row.observedAt),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        source: candleSourceSchema.parse(row.source),
        rightsMode: row.rightsMode,
      });
      prices = rows.map(toPrice);
      // 최대 120봉 이동평균을 첫 표시 봉부터 계산할 수 있도록 이전 119봉만 보충합니다.
      // API 조회는 저장된 동일 공급자·동일 주기 데이터만 사용하며 외부 수집을 유발하지 않습니다.
      if (rows[0]) {
        const warmup = await this.source()
          .getRepository(PriceBarEntity)
          .createQueryBuilder('bar')
          .where('bar.companyId = :companyId', { companyId })
          .andWhere('bar.interval = :interval', { interval })
          .andWhere('bar.source = :source', { source: selectedSource })
          .andWhere('bar.barAt < :before', { before: rows[0].barAt })
          .orderBy('bar.barAt', 'DESC')
          .take(119)
          .getMany();
        indicatorWarmupPrices = warmup.reverse().map(toPrice);
      }
    }
    const priceSources = [
      ...new Map(
        prices.map((price) => [price.source, priceSourceMetadata(price.source, price.rightsMode)]),
      ).values(),
    ];
    const events =
      interval === '1d' ? (await this.listEvents({ companyId, limit: 100 })).items : [];
    const eventViews = await Promise.all(events.map((event) => this.eventSummaryView(event)));
    const markerSeeds: Array<{
      time: string;
      kind: 'TRADE' | 'FILING' | 'NEWS';
      eventId: string;
      label: string;
      detailType: EventSummaryView['detailType'];
    }> = [];
    for (const event of eventViews) {
      if (!event.rceptDate) {
        if (event.detailType === 'SEC') continue;
        const time = kstDateFromInstant(event.publishedAt);
        if (time) {
          markerSeeds.push({
            time,
            kind: 'NEWS',
            eventId: event.id,
            label: 'N · 뉴스·IR',
            detailType: event.detailType,
          });
        }
        continue;
      }
      // D005의 eventAt은 실제 거래일이 아닌 계획 시작일입니다.
      // D001/D002의 실제 변동일에만 사건·거래 마커를 표시합니다.
      if (event.eventAt && (event.detailType === 'D001' || event.detailType === 'D002')) {
        markerSeeds.push({
          time: event.eventAt,
          kind: 'TRADE',
          eventId: event.id,
          label: event.detailType === 'D002' ? 'T · 거래·변동일' : 'E · 지분변동일',
          detailType: event.detailType,
        });
      }
      markerSeeds.push({
        time: event.rceptDate,
        kind: 'FILING',
        eventId: event.id,
        label: `F · ${event.detailType} 공시`,
        detailType: event.detailType,
      });
    }
    const markers = markerSeeds
      .map((marker) => ({
        ...marker,
        returnWindows: timelineReturnWindows(prices, marker.time),
      }))
      .sort(
        (left, right) => left.time.localeCompare(right.time) || left.kind.localeCompare(right.kind),
      );
    // 수익률 계산에서 분봉을 거래일 단위로 취급하지 않습니다.
    const dailyPrices = interval === '1d' ? prices : [];
    const latest = dailyPrices.at(-1);
    const previous = dailyPrices.at(-2);
    const monthBase = dailyPrices.at(Math.max(0, dailyPrices.length - 22));
    const latestEventTime = markers.at(-1)?.time;
    const latestEventIndex = latestEventTime
      ? dailyPrices.findIndex((price) => price.time >= latestEventTime)
      : -1;
    return {
      companyId,
      currency: isUs ? 'USD' : 'KRW',
      provider: 'toss',
      interval,
      status: !configured ? 'NOT_CONFIGURED' : prices.length ? 'READY' : 'PENDING',
      prices,
      indicatorWarmupPrices,
      priceSources,
      markers,
      returns: {
        oneDay: percentageReturn(previous?.close, latest?.close),
        oneMonth: percentageReturn(monthBase?.close, latest?.close),
        sinceLatestEvent:
          latestEventIndex >= 0
            ? percentageReturn(dailyPrices[latestEventIndex]?.close, latest?.close)
            : null,
        benchmarkOneMonth: null,
      },
      latestCloseAt: prices.at(-1)?.time ?? null,
    };
  }

  async listFilings(query: ListQuery): Promise<CursorPage<FilingSummary>> {
    if (this.fixtureMode) {
      const q = query.q?.toLowerCase();
      const filtered = this.fixtures.filings
        .filter(() => !query.region || query.region === 'all' || query.region === 'kr')
        .filter(
          (item) =>
            !q ||
            item.reportName.toLowerCase().includes(q) ||
            item.company.nameKo.toLowerCase().includes(q),
        )
        .filter((item) => !query.detailType || item.detailType === query.detailType)
        .filter((item) => !query.submissionKind || item.submissionKind === query.submissionKind)
        .filter((item) => !query.effectiveState || item.effectiveState === query.effectiveState)
        .filter((item) => !query.parseStatus || item.parseStatus === query.parseStatus)
        .filter(
          (item) =>
            !query.nature ||
            item.transactions.some((transaction) => transaction.nature === query.nature),
        )
        .filter(
          (item) =>
            !query.direction ||
            item.transactions.some((transaction) => transaction.direction === query.direction),
        )
        .filter((item) => {
          if (!query.priority) return true;
          return this.fixtures.watchlist.some(
            (watch) => watch.company.id === item.company.id && watch.priority === query.priority,
          );
        })
        .sort(
          (left, right) =>
            right.rceptDate.localeCompare(left.rceptDate) || right.id.localeCompare(left.id),
        );
      return paginateFixture(filtered, query, (item) => item.rceptDate);
    }
    const cursor = decodeCursor(query.cursor);
    const qb = this.source().getRepository(FilingEntity).createQueryBuilder('filing');
    qb.andWhere(
      "(filing.canonical_type IS NULL OR filing.canonical_type IN ('D001','D002','D003','D004','D005'))",
    );
    if (query.region && query.region !== 'all') {
      qb.andWhere('filing.source = :regionFilingSource', {
        regionFilingSource: query.region === 'kr' ? 'OPENDART' : 'SEC',
      });
    }
    if (query.q)
      qb.andWhere('(filing.reportName LIKE :q OR filing.filerName LIKE :q)', { q: `%${query.q}%` });
    if (query.detailType)
      qb.andWhere('COALESCE(filing.canonical_type,filing.detail_type) = :detailType', {
        detailType: query.detailType,
      });
    for (const field of ['submissionKind', 'effectiveState'] as const) {
      if (query[field]) qb.andWhere(`filing.${field} = :${field}`, { [field]: query[field] });
    }
    if (query.parseStatus) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM parse_runs pr WHERE pr.id = filing.active_parse_run_id AND pr.status = :parseStatus)',
        { parseStatus: query.parseStatus },
      );
    }
    if (query.nature || query.direction) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM insider_reports ir
          JOIN insider_transactions it ON it.insider_report_id = ir.id
          WHERE ir.filing_id = filing.id
          ${query.nature ? 'AND it.nature = :nature' : ''}
          ${query.direction ? 'AND it.direction = :direction' : ''}
        )`,
        { nature: query.nature, direction: query.direction },
      );
    }
    if (query.priority) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM market_leader_company_links wi WHERE wi.company_id = filing.company_id AND wi.priority = :priority)',
        { priority: query.priority },
      );
    }
    if (query.from) qb.andWhere('filing.rceptDate >= :from', { from: query.from });
    if (query.to) qb.andWhere('filing.rceptDate <= :to', { to: query.to });
    if (cursor)
      qb.andWhere(
        '(filing.rceptDate < :sort OR (filing.rceptDate = :sort AND filing.id < :id))',
        cursor,
      );
    const rows = await qb
      .orderBy('filing.rceptDate', 'DESC')
      .addOrderBy('filing.id', 'DESC')
      .take(query.limit + 1)
      .getMany();
    const visible = rows.slice(0, query.limit);
    const items = await Promise.all(visible.map((row) => this.mapFilingSummary(row)));
    return finishPage(rows, query.limit, items, (row) => row.rceptDate);
  }

  async getFiling(idOrRceptNo: string): Promise<FilingDetail> {
    if (this.fixtureMode) {
      const filing = this.fixtures.filings.find(
        (item) => item.id === idOrRceptNo || item.rceptNo === idOrRceptNo,
      );
      if (!filing) throw new NotFoundException('공시를 찾을 수 없습니다.');
      return filing;
    }
    const source = this.source();
    const filing = await source
      .getRepository(FilingEntity)
      .createQueryBuilder('filing')
      .where('filing.id = :value OR filing.rceptNo = :value', { value: idOrRceptNo })
      .getOne();
    if (!filing) throw new NotFoundException('공시를 찾을 수 없습니다.');
    if (filing.canonicalType && !isSupportedFilingType(filing.canonicalType)) {
      throw new NotFoundException('현재 지원 범위에 포함되지 않는 공시입니다.');
    }
    const summary = await this.mapFilingSummary(filing);
    const parse = await this.activeParseRun(filing);
    const reporter =
      parse?.resultType === 'D002'
        ? await source
            .getRepository(InsiderReportEntity)
            .findOne({ where: { filingId: filing.id }, order: { createdAt: 'ASC' } })
        : null;
    const transactions = reporter
      ? await source
          .getRepository(InsiderTransactionEntity)
          .find({ where: { insiderReportId: reporter.id }, order: { eventDate: 'ASC' } })
      : [];
    const plan =
      parse?.resultType === 'D005'
        ? await source
            .getRepository(TradePlanEntity)
            .findOne({ where: { filingId: filing.id }, order: { createdAt: 'ASC' } })
        : null;
    const planItem = plan
      ? await source
          .getRepository(TradePlanItemEntity)
          .findOne({ where: { tradePlanId: plan.id }, order: { createdAt: 'ASC' } })
      : null;
    const domainFacts = await readDisclosureFacts(source, filing.id, parse);
    const relations = await source
      .getRepository(FilingRelationEntity)
      .createQueryBuilder('relation')
      .where('relation.fromFilingId = :id OR relation.toFilingId = :id', { id: filing.id })
      .getMany();
    const relationDtos = await Promise.all(
      relations.map(async (relation) => {
        const otherId =
          relation.fromFilingId === filing.id ? relation.toFilingId : relation.fromFilingId;
        const other = await source.getRepository(FilingEntity).findOneBy({ id: otherId });
        return {
          id: relation.id,
          relationType: relation.relationType,
          relatedRceptNo: other?.rceptNo ?? otherId,
          confidence: Number(relation.confidence),
          source: relation.source,
          reviewRequired: relation.reviewRequired,
          reviewDecision: relation.reviewDecision,
        };
      }),
    );
    return {
      ...summary,
      parserVersion: parse?.parserVersion ?? null,
      rm: filing.rm,
      reporter: reporter
        ? {
            name: reporter.reporterName,
            relationship: reporter.relationship,
            position: reporter.position,
            isRegisteredExecutive: reporter.isRegisteredExecutive,
            isMajorShareholder: reporter.isMajorShareholder,
            ownershipBefore: reporter.ownershipBefore,
            ownershipAfter: reporter.ownershipAfter,
            ownershipChange: reporter.ownershipChange,
            ownershipRateAfter: reporter.ownershipRateAfter,
          }
        : null,
      transactions: transactions.map((item) => ({
        id: item.id,
        eventDate: item.eventDate,
        securityTypeRaw: item.securityTypeRaw,
        methodRaw: item.methodRaw,
        nature: item.nature,
        direction: item.direction,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        currency: item.currency,
        sharesAfter: item.sharesAfter,
        parserConfidence: Number(item.parserConfidence),
      })),
      tradePlan: plan
        ? {
            plannedStartDate: plan.plannedStartDate,
            plannedEndDate: plan.plannedEndDate,
            plannedQuantity: planItem?.plannedQuantity ?? null,
            plannedAmount: planItem?.plannedAmount ?? null,
            methodRaw: planItem?.methodRaw ?? null,
            planStatus: plan.planStatus,
          }
        : null,
      ...domainFacts,
      parserWarnings: parse?.warningsJson ?? [],
      relations: relationDtos,
    };
  }

  async listEvents(query: ListQuery): Promise<CursorPage<Event>> {
    if (this.fixtureMode) {
      const filtered = this.fixtures.events
        .map((event) => mapFixtureEvent(event))
        .filter((event) => this.fixtureEventMatchesRegion(event, query.region))
        .filter(
          (item) =>
            !query.q ||
            [item.summary, item.company?.nameKo, item.company?.stockCode, item.filing?.reportName]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase().includes(String(query.q).toLowerCase())),
        )
        .filter((item) => !query.companyId || item.company?.id === query.companyId)
        .filter(
          (item) =>
            !query.detailType ||
            item.filing?.detailType === query.detailType ||
            (query.detailType === 'SEC' &&
              item.sourceItems.some((source) => source.source === 'SEC')) ||
            (query.detailType === 'NEWS' && item.canonicalEventType === 'NEWS'),
        )
        .filter(
          (item) =>
            !query.classificationStatus || item.classificationResult === query.classificationStatus,
        )
        .filter((item) => !query.type || item.canonicalEventType === query.type)
        .filter((item) => !query.state || item.state === query.state)
        .filter((item) => !query.evidenceGrade || item.evidenceGrade === query.evidenceGrade)
        .filter((item) => {
          if (!query.priority) return true;
          return this.fixtures.watchlist.some(
            (watch) => watch.company.id === item.company?.id && watch.priority === query.priority,
          );
        })
        .sort(
          (left, right) =>
            right.firstObservedAt.localeCompare(left.firstObservedAt) ||
            right.id.localeCompare(left.id),
        );
      return paginateFixture(filtered, query, (item) => item.firstObservedAt);
    }
    const cursor = decodeCursor(query.cursor);
    const qb = this.source().getRepository(EventClusterEntity).createQueryBuilder('event');
    qb.andWhere(supportedEventFilingsSql);
    qb.andWhere(eventAudienceSql('event', query.audience));
    if (query.region && query.region !== 'all') {
      qb.andWhere(
        `(
        EXISTS (SELECT 1 FROM companies regional_company WHERE regional_company.id = event.company_id AND regional_company.market IN (:...regionMarkets))
        OR EXISTS (SELECT 1 FROM event_cluster_items region_item JOIN filings region_filing ON region_filing.id = region_item.item_id WHERE region_item.event_cluster_id = event.id AND region_item.item_type = 'FILING' AND region_filing.source = :regionSource)
        OR EXISTS (SELECT 1 FROM event_cluster_items region_item JOIN source_items region_source ON region_source.id = region_item.item_id WHERE region_item.event_cluster_id = event.id AND region_item.item_type = 'SOURCE_ITEM' AND region_source.source = :regionSource)
      )`,
        {
          regionMarkets: marketsForRegion(query.region),
          regionSource: query.region === 'kr' ? 'OPENDART' : 'SEC',
        },
      );
    }
    if (query.q) {
      qb.andWhere(
        `(event.summary LIKE :q
          OR EXISTS (SELECT 1 FROM companies ec WHERE ec.id = event.company_id AND (ec.name_ko LIKE :q OR ec.stock_code LIKE :q))
          OR EXISTS (
            SELECT 1 FROM event_cluster_items eqi
            JOIN filings eqf ON eqf.id = eqi.item_id
            WHERE eqi.event_cluster_id = event.id AND eqi.item_type = 'FILING' AND eqf.report_name LIKE :q
          )
          OR EXISTS (
            SELECT 1 FROM event_cluster_items nqi
            JOIN source_items nqs ON nqs.id = nqi.item_id
            WHERE nqi.event_cluster_id = event.id AND nqi.item_type = 'SOURCE_ITEM'
              AND ${visibleEventSourceSql('nqs', query.audience)}
              AND (nqs.title LIKE :translationPattern ESCAPE '!' OR ${newsTranslationSearchCondition('nqs', 'translationPattern')})
          ))`,
        { q: `%${query.q}%`, translationPattern: literalSearchPattern(query.q) },
      );
    }
    if (query.personalActorKey)
      qb.andWhere(
        `EXISTS (
      SELECT 1 FROM watchlist_group_items personal_item
      JOIN watchlist_groups personal_group ON personal_group.id=personal_item.group_id
      WHERE (personal_item.company_id=event.company_id OR
          JSON_CONTAINS(JSON_EXTRACT(event.metadata_json, '$.relatedCompanyIds'), JSON_QUOTE(personal_item.company_id)))
        AND personal_group.room_id IS NULL
        AND personal_group.owner_key=:personalActorKey)`,
        { personalActorKey: query.personalActorKey },
      );
    if (query.companyId)
      qb.andWhere('event.companyId = :companyId', { companyId: query.companyId });
    if (query.detailType) {
      if (query.detailType === 'NEWS') {
        qb.andWhere('event.canonicalEventType = :newsType', { newsType: 'NEWS' });
      } else if (query.detailType === 'SEC') {
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM event_cluster_items esi
            JOIN source_items ess ON ess.id = esi.item_id
            WHERE esi.event_cluster_id = event.id AND esi.item_type = 'SOURCE_ITEM' AND ess.source = :secSource
          )`,
          { secSource: 'SEC' },
        );
      } else {
        qb.andWhere(
          `EXISTS (
            SELECT 1 FROM event_cluster_items edi
            JOIN filings edf ON edf.id = edi.item_id
            WHERE edi.event_cluster_id = event.id AND edi.item_type = 'FILING' AND COALESCE(edf.canonical_type, edf.detail_type) = :detailType
          )`,
          { detailType: query.detailType },
        );
      }
    }
    if (query.classificationStatus) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM event_cluster_items eci
          JOIN filings ecf ON ecf.id = eci.item_id
          JOIN parse_runs epr ON epr.id = ecf.active_parse_run_id
          WHERE eci.event_cluster_id = event.id AND eci.item_type = 'FILING'
            AND epr.classification_result = :classificationStatus
        )`,
        { classificationStatus: query.classificationStatus },
      );
    }
    if (query.type) qb.andWhere('event.canonicalEventType = :type', { type: query.type });
    if (query.state) qb.andWhere('event.state = :state', { state: query.state });
    if (query.evidenceGrade)
      qb.andWhere('event.evidenceGrade = :evidenceGrade', { evidenceGrade: query.evidenceGrade });
    if (query.priority) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM market_leader_company_links wi WHERE wi.company_id = event.company_id AND wi.priority = :priority)',
        { priority: query.priority },
      );
    }
    if (cursor) {
      qb.andWhere(
        '(event.firstObservedAt < :sort OR (event.firstObservedAt = :sort AND event.id < :id))',
        {
          sort: cursorInstant(cursor.sort),
          id: cursor.id,
        },
      );
    }
    const rows = await qb
      .orderBy('event.firstObservedAt', 'DESC')
      .addOrderBy('event.id', 'DESC')
      .take(query.limit + 1)
      .getMany();
    const visible = rows.slice(0, query.limit);
    const items = await this.mapEvents(visible, query.audience);
    return finishPage(rows, query.limit, items, (row) => row.firstObservedAt.toISOString());
  }

  async getEvent(id: string, audience: NewsAudience = 'MEMBER_UI'): Promise<Event> {
    if (this.fixtureMode) {
      const event = this.fixtures.events.find((item) => item.id === id);
      if (!event) throw new NotFoundException('이벤트를 찾을 수 없습니다.');
      return mapFixtureEvent(event);
    }
    const row = await this.source()
      .getRepository(EventClusterEntity)
      .createQueryBuilder('event')
      .where('event.id = :id', { id })
      .andWhere(eventAudienceSql('event', audience))
      .getOne();
    if (!row) throw new NotFoundException('이벤트를 찾을 수 없습니다.');
    const memberships = await this.source()
      .getRepository(EventClusterItemEntity)
      .findBy({ eventClusterId: id, itemType: 'FILING' });
    for (const membership of memberships) {
      const filing = await this.source()
        .getRepository(FilingEntity)
        .findOneBy({ id: membership.itemId });
      if (filing?.canonicalType && !isSupportedFilingType(filing.canonicalType)) {
        throw new NotFoundException('현재 지원 범위에 포함되지 않는 공시입니다.');
      }
    }
    return this.mapEvent(row, audience);
  }

  async listNews(query: ListQuery): Promise<CursorPage<SourceItem>> {
    if (query.companyIds !== undefined) {
      parseWith(newsCompanyIdsSchema, query.companyIds);
      if (!query.companyIds.length)
        return { items: [], nextCursor: null, pageInfo: { nextCursor: null, hasMore: false } };
    }
    if (query.asset)
      return { items: [], nextCursor: null, pageInfo: { nextCursor: null, hasMore: false } };
    if (this.fixtureMode) {
      const filtered = this.fixtures.sourceItems
        .map((item) => mapFixtureSourceItem(item))
        .filter((item) => !item.source.startsWith('NAVER'))
        .filter(
          (item) => item.sourceKind === 'OFFICIAL_RELEASE' || item.sourceKind === 'COMPANY_IR',
        )
        .filter((item) =>
          PUBLIC_NEWS_PUBLISHERS.includes(
            (item.publisherId ?? '') as (typeof PUBLIC_NEWS_PUBLISHERS)[number],
          ),
        )
        .filter(
          (item) =>
            !query.companyId ||
            this.fixtures.companies.some(
              (company) =>
                company.id === query.companyId &&
                [company.ticker, company.stockCode].some(
                  (ticker) => ticker && item.tickers.includes(ticker),
                ),
            ),
        )
        .filter(
          (item) =>
            query.companyIds === undefined ||
            this.fixtures.companies.some(
              (company) =>
                query.companyIds!.includes(company.id) &&
                [company.ticker, company.stockCode].some(
                  (ticker) => ticker && item.tickers.includes(ticker),
                ),
            ),
        )
        .filter((item) =>
          query.scope === 'market'
            ? ['federal-reserve', 'bls'].includes(item.publisherId ?? '')
            : query.scope === 'company'
              ? item.tickers.length > 0
              : true,
        )
        .filter((item) => !query.source || item.source === query.source)
        .filter((item) => !query.sourceKind || item.sourceKind === query.sourceKind)
        .filter(
          (item) => !query.publisher || (item.publisherId ?? item.sourceName) === query.publisher,
        )
        .filter((item) => this.fixtureSourceMatchesRegion(item, query.region))
        .filter(
          (item) => !query.q || item.title.toLowerCase().includes(String(query.q).toLowerCase()),
        )
        .sort((left, right) =>
          (right.publishedAt ?? right.firstObservedAt).localeCompare(
            left.publishedAt ?? left.firstObservedAt,
          ),
        );
      return paginateFixture(filtered, query, (item) => item.publishedAt ?? item.firstObservedAt);
    }
    const cursor = decodeCursor(query.cursor);
    const qb = this.source()
      .getRepository(SourceItemEntity)
      .createQueryBuilder('source')
      .leftJoinAndMapOne(
        'source.newsArticle',
        NewsArticleEntity,
        'article',
        'article.id = source.news_article_id',
      )
      .select([
        ...[
          'id',
          'companyId',
          'newsArticleId',
          'sourceKind',
          'sourcePolicyJson',
          'source',
          'externalId',
          'title',
          'url',
          'sourceName',
          'author',
          'publishedAt',
          'firstObservedAt',
          'processedAt',
          'rawHash',
          'manualTranslationJson',
          'rightsMode',
          'provenanceUrl',
          'rawMetadataJson',
          'translationJson',
        ].map((field) => `source.${field}`),
        'article.id',
        'article.sortAt',
      ])
      .where(newsFiltersSql('source', query), newsFilterParameters(query))
      .andWhere(visibleNewsSql('content', 'source'))
      .andWhere(representativeNewsSql(query));
    if (cursor)
      qb.andWhere(
        `(${NEWS_GROUP_SORT} < :sort OR (${NEWS_GROUP_SORT} = :sort AND ${NEWS_GROUP_ID} < :id))`,
        { sort: cursorInstant(cursor.sort), id: cursor.id },
      );
    const rows = await qb
      .orderBy(NEWS_GROUP_SORT, 'DESC')
      .addOrderBy(NEWS_GROUP_ID, 'DESC')
      .limit(query.limit + 1)
      .getMany();
    const visible = rows.slice(0, query.limit);
    await verifyManualNewsSources(this.source(), visible);
    const articleIds = [
      ...new Set(visible.flatMap((row) => (row.newsArticleId ? [row.newsArticleId] : []))),
    ];
    const provenance = articleIds.length
      ? await this.source()
          .getRepository(SourceItemEntity)
          .find({
            select: {
              id: true,
              newsArticleId: true,
              source: true,
              sourceKind: true,
              sourceName: true,
              url: true,
              sourcePolicyJson: true,
              rightsMode: true,
              rawMetadataJson: true,
            },
            where: { newsArticleId: In(articleIds) },
          })
      : [];
    const sourcesByArticle = new Map<string, SourceItemEntity[]>();
    for (const item of provenance) {
      if (
        !item.newsArticleId ||
        !newsAudienceAllows(item, query.audience) ||
        item.sourcePolicyJson?.rightsMode !== item.rightsMode ||
        !(
          sourcePolicyAllowsDisplay(
            item,
            ['OFFICIAL_RELEASE', 'COMPANY_IR'],
            PUBLIC_NEWS_PUBLISHERS,
            query.audience,
          ) ||
          (item.sourcePolicyJson?.policyVersion === 2 &&
            newsAudienceAllows(item, query.audience)) ||
          (['GDELT', 'ALPACA_NEWS'].includes(item.source) &&
            item.rawMetadataJson?.rightsContext === 'APPROVED_PUBLISHER_METADATA' &&
            item.sourcePolicyJson?.metadataStorageAllowed === true &&
            item.sourcePolicyJson?.displayAllowed === true &&
            item.sourcePolicyJson?.fullTextStorageAllowed === false &&
            item.sourcePolicyJson?.aiAllowed === false)
        )
      )
        continue;
      const sources = sourcesByArticle.get(item.newsArticleId) ?? [];
      sources.push(item);
      sourcesByArticle.set(item.newsArticleId, sources);
    }
    const relatedBySource = await this.newsRelatedCompanies(
      visible.map((row) => row.id),
      query.audience,
    );
    const items = await Promise.all(
      visible.map(async (row) => {
        const sources = row.newsArticleId ? (sourcesByArticle.get(row.newsArticleId) ?? []) : [];
        return {
          ...mapSourceItem(row),
          ...(await this.newsLinkageView(row, query.audience)),
          relatedCompanies: relatedBySource.get(row.id) ?? [],
          sourceCount: sources.length || 1,
          providerCount: new Set((sources.length ? sources : [row]).map((item) => item.source))
            .size,
          independentSourceCount: new Set(
            (sources.length ? sources : [row]).flatMap((item) =>
              (item.sourceKind === 'INDEPENDENT_MEDIA' ||
                (item.sourceKind === 'AGGREGATOR' &&
                  item.rawMetadataJson?.publisherSourceKind === 'INDEPENDENT_MEDIA')) &&
              item.rawMetadataJson?.independentVerification === true &&
              typeof item.rawMetadataJson?.originalPublisherId === 'string' &&
              item.rawMetadataJson.originalPublisherId.trim().length > 0
                ? [item.rawMetadataJson.originalPublisherId]
                : [],
            ),
          ).size,
          sources: (sources.length ? sources : [row]).map((item) => ({
            id: item.id,
            source: item.source,
            sourceName: item.sourceName,
            url: item.url,
          })),
        };
      }),
    );
    const positions = rows.map((row) => ({
      id: row.id,
      sort: (row.publishedAt ?? row.firstObservedAt).toISOString(),
    }));
    return finishPage(positions, query.limit, items, (row) => row.sort);
  }

  private async newsLinkageView(
    row: SourceItemEntity,
    audience: NewsAudience = 'MEMBER_UI',
  ): Promise<Pick<SourceItem, 'officialVerification' | 'officialReferences'>> {
    if (audience !== 'ADMIN_UI')
      return { officialVerification: 'UNVERIFIED', officialReferences: [] };
    const values = Array.isArray(row.rawMetadataJson?.officialReferences)
      ? row.rawMetadataJson.officialReferences
      : [];
    const officialReferences: NonNullable<SourceItem['officialReferences']> = [];
    for (const value of values.slice(0, 50)) {
      if (!value || typeof value !== 'object') continue;
      const ref = value as Record<string, unknown>;
      if (
        ref.sourceHash !== row.rawHash ||
        !['FILING', 'SOURCE_ITEM'].includes(String(ref.kind)) ||
        typeof ref.id !== 'string' ||
        !/^[a-f0-9-]{36}$/u.test(ref.id) ||
        !['EXPLICIT_ID', 'EXPLICIT_URL', 'COMPANY_TIME'].includes(String(ref.matchMethod)) ||
        !['RELATED', 'CONFIRMED', 'REJECTED'].includes(String(ref.status))
      )
        continue;
      let status = ref.status as 'RELATED' | 'CONFIRMED' | 'REJECTED';
      let title: string;
      let url: string;
      if (ref.kind === 'SOURCE_ITEM') {
        const target = await this.source()
          .getRepository(SourceItemEntity)
          .findOneBy({ id: ref.id });
        if (
          !target ||
          !newsAudienceAllows(target, audience) ||
          !isReadableOfficialNewsSource(target)
        )
          continue;
        const officialUrl = publicSourceUrl(target.url);
        if (!officialUrl) continue;
        title = target.title;
        url = officialUrl;
        if (status === 'CONFIRMED' && (!ref.targetHash || ref.targetHash !== target.rawHash))
          status = 'RELATED';
      } else {
        const target = await this.source().getRepository(FilingEntity).findOneBy({ id: ref.id });
        if (!target || target.source !== 'OPENDART') continue;
        title = target.reportName;
        url = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(target.rceptNo)}`;
      }
      officialReferences.push({
        kind: ref.kind as 'FILING' | 'SOURCE_ITEM',
        id: ref.id,
        matchMethod: ref.matchMethod as 'EXPLICIT_ID' | 'EXPLICIT_URL' | 'COMPANY_TIME',
        status,
        title,
        url,
      });
    }
    return {
      officialReferences,
      officialVerification: officialReferences.some((ref) => ref.status === 'CONFIRMED')
        ? 'CONFIRMED'
        : officialReferences.some((ref) => ref.status === 'RELATED')
          ? 'LINKED'
          : 'UNVERIFIED',
    };
  }

  private async newsRelatedCompanies(
    sourceIds: readonly string[],
    audience: NewsAudience = 'MEMBER_UI',
  ): Promise<Map<string, NonNullable<SourceItem['relatedCompanies']>>> {
    const result = new Map<string, NonNullable<SourceItem['relatedCompanies']>>();
    if (!sourceIds.length) return result;
    const rows: {
      sourceItemId: string;
      id: string;
      market: Company['market'];
      stockCode: string | null;
      ticker: string | null;
      nameKo: string;
      nameEn: string | null;
    }[] = await this.source().query(
      `SELECT DISTINCT displayed.id AS sourceItemId, c.id, c.market, c.stock_code AS stockCode, c.ticker, c.name_ko AS nameKo, c.name_en AS nameEn
       FROM source_items displayed JOIN source_items related ON (related.id = displayed.id OR (displayed.news_article_id IS NOT NULL AND related.news_article_id = displayed.news_article_id))
       JOIN news_source_companies r ON r.source_item_id = related.id JOIN companies c ON c.id = r.company_id
       WHERE ${newsAudienceSql('related', audience)} AND ${metadataNewsSql('related')} AND displayed.id IN (${sourceIds.map(() => '?').join(',')}) ORDER BY c.name_ko, c.id`,
      [...sourceIds],
    );
    for (const { sourceItemId, ...company } of rows) {
      const list = result.get(sourceItemId) ?? [];
      list.push(company);
      result.set(sourceItemId, list);
    }
    return result;
  }

  private fixtureSourceMatchesRegion(item: SourceItem, region: Region = 'all'): boolean {
    if (region === 'all') return true;
    if (item.source === 'NEWS_RSS')
      return (
        !item.marketRegion ||
        item.marketRegion === 'unknown' ||
        item.marketRegion === 'global' ||
        item.marketRegion === region
      );
    if (item.source === 'SEC') return region === 'us';
    if (item.source === 'OPENDART') return region === 'kr';
    return this.fixtures.companies.some(
      (company) =>
        matchesRegion(company.market, region) &&
        [company.ticker, company.stockCode].some(
          (symbol) => symbol && item.tickers.includes(symbol),
        ),
    );
  }

  private fixtureEventMatchesRegion(event: Event, region: Region = 'all'): boolean {
    if (region === 'all') return true;
    return Boolean(
      (event.company && matchesRegion(event.company.market, region)) ||
      (event.filing && region === 'kr') ||
      event.sourceItems.some((item) => item.source === (region === 'kr' ? 'OPENDART' : 'SEC')),
    );
  }

  async getNews(id: string, audience: NewsAudience = 'MEMBER_UI'): Promise<NewsDetail> {
    if (this.fixtureMode) {
      const row = this.fixtures.sourceItems.find(
        (item) =>
          !item.source.startsWith('NAVER') &&
          (item.id === id || item.articleId === id || item.externalId === id),
      );
      const item = row ? mapFixtureSourceItem(row) : null;
      if (
        !item ||
        !['OFFICIAL_RELEASE', 'COMPANY_IR'].includes(item.sourceKind ?? '') ||
        !PUBLIC_NEWS_PUBLISHERS.includes(
          (item.publisherId ?? '') as (typeof PUBLIC_NEWS_PUBLISHERS)[number],
        )
      )
        throw new NotFoundException('뉴스 항목을 찾을 수 없습니다.');
      return { ...item, content: null };
    }
    const source = this.source();
    const target = await source
      .getRepository(SourceItemEntity)
      .createQueryBuilder('item')
      .where('(item.id = :id OR item.externalId = :id OR item.news_article_id = :id)', { id })
      .andWhere(newsFiltersSql('item', { audience }))
      .getOne();
    if (!target) throw new NotFoundException('뉴스 항목을 찾을 수 없습니다.');

    const detailQuery = source
      .getRepository(SourceItemEntity)
      .createQueryBuilder('item')
      .where(newsFiltersSql('item', { audience }))
      .andWhere(visibleNewsSql('unused', 'item'))
      .andWhere(representativeNewsSql({ audience }, 'item'));
    if (target.newsArticleId) {
      detailQuery.andWhere('item.news_article_id = :articleId', {
        articleId: target.newsArticleId,
      });
    } else {
      detailQuery.andWhere('item.id = :sourceItemId', { sourceItemId: target.id });
    }
    const row = await detailQuery.getOne();
    if (
      !row ||
      !publicSourceUrl(row.url) ||
      row.sourcePolicyJson?.rightsMode !== row.rightsMode ||
      !(
        sourcePolicyAllowsDisplay(
          row,
          ['OFFICIAL_RELEASE', 'COMPANY_IR'],
          PUBLIC_NEWS_PUBLISHERS,
          audience,
        ) ||
        (row.sourcePolicyJson.policyVersion === 2 && newsAudienceAllows(row, audience)) ||
        (['GDELT', 'ALPACA_NEWS'].includes(row.source) &&
          row.rightsMode === RightsMode.STORE_METADATA_ONLY &&
          row.rawMetadataJson?.rightsContext === 'APPROVED_PUBLISHER_METADATA' &&
          row.sourcePolicyJson.metadataStorageAllowed === true &&
          row.sourcePolicyJson.displayAllowed === true &&
          row.sourcePolicyJson.fullTextStorageAllowed === false &&
          row.sourcePolicyJson.aiAllowed === false)
      )
    )
      throw new NotFoundException('뉴스 원문 링크를 찾을 수 없습니다.');
    await verifyManualNewsSources(source, [row]);
    const news = await source.getRepository(NewsItemEntity).findOneBy({ sourceItemId: row.id });
    return {
      ...mapSourceItem(row, news),
      ...(await this.newsLinkageView(row, audience)),
      relatedCompanies: (await this.newsRelatedCompanies([row.id], audience)).get(row.id) ?? [],
      content: null,
    };
  }

  async listIrSources(query: ListQuery): Promise<CursorPage<IrSource>> {
    if (this.fixtureMode) {
      const rows = this.fixtures.irSources
        .filter(
          (item) =>
            isReviewedIrFeed(item.url) &&
            item.sourceType === 'RSS' &&
            item.rightsMode === getNewsIrSourceProfile(item.url)?.policy.rightsMode,
        )
        .filter((item) => !query.companyId || item.companyId === query.companyId)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        );
      return paginateFixture(rows, query, (item) => item.createdAt);
    }
    const cursor = decodeCursor(query.cursor);
    const qb = this.source().getRepository(IrSourceEntity).createQueryBuilder('source');
    qb.andWhere('source.url IN (:...reviewedIrUrls) AND source.sourceType = :reviewedIrType', {
      reviewedIrUrls: Object.values(NEWS_IR_SOURCE_PROFILES).map((profile) => profile.url),
      reviewedIrType: 'RSS',
      reviewedIrRights: RightsMode.PRIVATE_DISPLAY_ONLY,
    });
    if (query.companyId)
      qb.andWhere('source.companyId = :companyId', { companyId: query.companyId });
    if (cursor) {
      qb.andWhere('(source.createdAt < :sort OR (source.createdAt = :sort AND source.id < :id))', {
        sort: cursorInstant(cursor.sort),
        id: cursor.id,
      });
    }
    const rows = await qb
      .orderBy('source.createdAt', 'DESC')
      .addOrderBy('source.id', 'DESC')
      .take(query.limit + 1)
      .getMany();
    return pageRows(rows, query.limit, mapIrSource, (row) => row.createdAt.toISOString());
  }

  async createIrSource(input: {
    companyId: string;
    url: string;
    sourceType: 'RSS';
    rightsMode: RightsMode;
    isActive: boolean;
  }): Promise<IrSource> {
    const company = await this.getCompany(input.companyId);
    const { url, profile } = reviewedIrFeed(input.url);
    this.assertIrRegistration(profile, company, input.isActive);
    const controlled = {
      ...input,
      url,
      sourceType: 'RSS' as const,
      rightsMode: profile.policy.rightsMode,
    };
    if (this.fixtureMode) {
      const existing = this.fixtures.irSources.find(
        (item) => item.companyId === input.companyId && item.url === url,
      );
      if (existing) return existing;
      const now = new Date().toISOString();
      const item: IrSource = {
        id: randomUUID(),
        ...controlled,
        lastCheckedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.fixtures.irSources.push(item);
      return item;
    }
    const repository = this.source().getRepository(IrSourceEntity);
    const urlHash = sha256(url);
    const existing = await repository.findOneBy({ companyId: input.companyId, urlHash });
    if (existing) return mapIrSource(existing);
    const row = repository.create({ ...controlled, urlHash, lastCheckedAt: null });
    return mapIrSource(await repository.save(row));
  }

  async updateIrSource(
    id: string,
    input: Partial<
      Omit<IrSource, 'id' | 'companyId' | 'createdAt' | 'updatedAt' | 'lastCheckedAt'>
    >,
  ): Promise<IrSource> {
    if (this.fixtureMode) {
      const item = this.fixtures.irSources.find((value) => value.id === id);
      if (!item) throw new NotFoundException('IR 소스를 찾을 수 없습니다.');
      const { url, profile } = reviewedIrFeed(input.url ?? item.url);
      this.assertIrRegistration(
        profile,
        await this.getCompany(item.companyId),
        input.isActive ?? item.isActive,
      );
      Object.assign(item, input, {
        url,
        sourceType: 'RSS',
        rightsMode: profile.policy.rightsMode,
        updatedAt: new Date().toISOString(),
      });
      return item;
    }
    const repository = this.source().getRepository(IrSourceEntity);
    const row = await repository.findOneBy({ id });
    if (!row) throw new NotFoundException('IR 소스를 찾을 수 없습니다.');
    const { url: approvedUrl, profile } = reviewedIrFeed(input.url ?? row.url);
    this.assertIrRegistration(
      profile,
      await this.getCompany(row.companyId),
      input.isActive ?? row.isActive,
    );
    if (input.url) {
      row.url = approvedUrl;
      row.urlHash = sha256(row.url);
    }
    row.sourceType = 'RSS';
    row.rightsMode = profile.policy.rightsMode;
    if (input.isActive !== undefined) row.isActive = input.isActive;
    return mapIrSource(await repository.save(row));
  }

  private assertIrRegistration(
    profile: NonNullable<ReturnType<typeof getNewsIrSourceProfile>>,
    company: Company,
    active: boolean,
  ): void {
    if (
      profile.companySymbols &&
      (!profile.companySymbols.includes(company.ticker ?? '') ||
        !['NASDAQ', 'NYSE', 'AMEX'].includes(company.market))
    )
      throw new BadRequestException('IR 프로필의 상장기업과 연결 대상이 일치하지 않습니다.');
    if (active && (!profile.enabled || !newsPolicyApprovalReady(profile.policy)))
      throw new BadRequestException(
        '권리 검토와 소스 승인이 완료되기 전에는 활성화할 수 없습니다.',
      );
  }

  async deleteIrSource(id: string): Promise<void> {
    if (this.fixtureMode) {
      const index = this.fixtures.irSources.findIndex((item) => item.id === id);
      if (index < 0) throw new NotFoundException('IR 소스를 찾을 수 없습니다.');
      this.fixtures.irSources.splice(index, 1);
      return;
    }
    const result = await this.source().getRepository(IrSourceEntity).delete({ id });
    if (!result.affected) throw new NotFoundException('IR 소스를 찾을 수 없습니다.');
  }

  async listWatchlist(query: ListQuery): Promise<CursorPage<WatchlistItem>> {
    if (this.fixtureMode) {
      const rows = this.fixtures.watchlist
        .filter((watch) => matchesRegion(watch.company.market, query.region))
        .sort(
          (left, right) =>
            left.priority.localeCompare(right.priority) ||
            left.createdAt.localeCompare(right.createdAt),
        );
      return paginateFixture(rows, query, (item) => `${item.priority}|${item.createdAt}`);
    }
    const cursor = decodeCursor(query.cursor);
    const qb = this.source().getRepository(WatchlistItemEntity).createQueryBuilder('watch');
    if (query.region && query.region !== 'all') {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM companies regional_company WHERE regional_company.id = watch.company_id AND regional_company.market IN (:...regionMarkets))',
        { regionMarkets: marketsForRegion(query.region) },
      );
    }
    if (cursor) {
      const [priority, createdAt] = cursor.sort.split('|', 2);
      qb.andWhere(
        '(watch.priority > :priority OR (watch.priority = :priority AND (watch.createdAt > :createdAt OR (watch.createdAt = :createdAt AND watch.id > :id))))',
        { priority, createdAt: cursorInstant(createdAt ?? ''), id: cursor.id },
      );
    }
    const rows = await qb
      .orderBy('watch.priority', 'ASC')
      .addOrderBy('watch.createdAt', 'ASC')
      .addOrderBy('watch.id', 'ASC')
      .take(query.limit + 1)
      .getMany();
    const visible = rows.slice(0, query.limit);
    const companies = new Map(
      (
        await this.findByIds(
          CompanyEntity,
          visible.map((row) => row.companyId),
        )
      ).map((company) => [company.id, mapCompany(company)]),
    );
    const items = await Promise.all(
      visible.map((row) => this.mapWatchlist(row, companies.get(row.companyId))),
    );
    return finishPage(
      rows,
      query.limit,
      items,
      (row) => `${row.priority}|${row.createdAt.toISOString()}`,
    );
  }

  async listWatchlistViews(query: ListQuery): Promise<CursorPage<Record<string, unknown>>> {
    const page = await this.listWatchlist(query);
    const summaries = await this.companySummaryViews(page.items.map((watch) => watch.company));
    const items = page.items.map((watch, index) => ({
      ...summaries[index]!,
      isWatchlisted: true,
      addedAt: watch.createdAt,
      note: watch.notes,
      realtimeAlerts: watch.realtimeAlerts,
      digestAlerts: watch.digestAlerts,
    }));
    return { ...page, items };
  }

  async watchedCompanies(companyIds: string[]): Promise<Company[]> {
    const uniqueIds = [...new Set(companyIds)];
    const companies = this.fixtureMode
      ? this.fixtures.watchlist
          .filter((item) => uniqueIds.includes(item.company.id))
          .map((item) => item.company)
      : (
          await this.source()
            .getRepository(CompanyEntity)
            .createQueryBuilder('company')
            .innerJoin(WatchlistItemEntity, 'watch', 'watch.companyId = company.id')
            .where('company.id IN (:...companyIds)', { companyIds: uniqueIds })
            .getMany()
        ).map((company) => mapCompany(company));
    const byId = new Map(companies.map((company) => [company.id, company]));
    if (uniqueIds.some((id) => !byId.has(id))) {
      throw new BadRequestException('관심기업에 등록된 회사만 시세를 조회할 수 있습니다.');
    }
    return uniqueIds.map((id) => byId.get(id)!);
  }

  async previousDailyCloses(
    requests: Array<{
      companyId: string;
      source: 'TOSS_KR' | 'TOSS_US';
      currency: 'KRW' | 'USD';
      beforeDate: string;
    }>,
  ): Promise<Map<string, { close: number; sessionDate: string }>> {
    if (this.fixtureMode || requests.length === 0) return new Map();
    const parameters: Record<string, unknown> = {
      closeRightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
    };
    const conditions = requests.map((request, index) => {
      parameters[`company${index}`] = request.companyId;
      parameters[`source${index}`] = request.source;
      parameters[`currency${index}`] = request.currency;
      parameters[`before${index}`] = request.beforeDate;
      return `(bar.companyId = :company${index} AND bar.source = :source${index} AND bar.currency = :currency${index}
        AND bar.sessionDate = (SELECT MAX(previous.session_date) FROM price_bars previous
          WHERE previous.company_id = bar.companyId AND previous.source = bar.source
            AND previous.currency = bar.currency AND previous.interval = '1d'
            AND previous.rights_mode = :closeRightsMode
            AND previous.session_date < :before${index}))`;
    });
    const rows = await this.source()
      .getRepository(PriceBarEntity)
      .createQueryBuilder('bar')
      .select(['bar.companyId', 'bar.sessionDate', 'bar.close', 'bar.barAt'])
      .where("bar.interval = '1d'")
      .andWhere('bar.rightsMode = :closeRightsMode', parameters)
      .andWhere(`(${conditions.join(' OR ')})`, parameters)
      .orderBy('bar.barAt', 'DESC')
      .getMany();
    const result = new Map<string, { close: number; sessionDate: string }>();
    for (const row of rows) {
      const close = Number(row.close);
      if (!result.has(row.companyId) && row.sessionDate && Number.isFinite(close) && close > 0) {
        result.set(row.companyId, { close, sessionDate: row.sessionDate });
      }
    }
    return result;
  }

  async connectorFreshness() {
    return {
      asOf: new Date().toISOString(),
      items: (await this.connectorSourceViews()).map((source) => ({
        id: source.id,
        name: source.name,
        category: source.category,
        status: source.status,
        lastSuccessAt: source.lastSuccessAt,
        lagSeconds: source.lagSeconds,
        rightsMode: source.rightsMode,
        checkedAt: source.checkedAt,
        message: ['sec', 'gdelt', 'alpaca_news'].includes(String(source.id))
          ? (source.message ?? null)
          : null,
        httpStatus: source.httpStatus ?? null,
        requestAttempted: source.requestAttempted ?? null,
        lastAttemptAt: source.lastAttemptAt ?? null,
        nextRetryAt: source.nextRetryAt ?? null,
      })),
    };
  }

  async listReviews(query: ListQuery): Promise<CursorPage<Review>> {
    if (this.fixtureMode) {
      const rows = this.fixtures.reviews
        .filter((item) => !query.status || item.status === query.status)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return paginateFixture(rows, query, (item) => item.createdAt);
    }
    const cursor = decodeCursor(query.cursor);
    const qb = this.source().getRepository(ReviewEntity).createQueryBuilder('review');
    if (query.status) qb.andWhere('review.status = :status', { status: query.status });
    if (cursor) {
      qb.andWhere('(review.createdAt < :sort OR (review.createdAt = :sort AND review.id < :id))', {
        sort: cursorInstant(cursor.sort),
        id: cursor.id,
      });
    }
    const rows = await qb
      .orderBy('review.createdAt', 'DESC')
      .addOrderBy('review.id', 'DESC')
      .take(query.limit + 1)
      .getMany();
    return pageRows(rows, query.limit, mapReview, (row) => row.createdAt.toISOString());
  }

  async listReviewViews(query: ListQuery): Promise<CursorPage<Record<string, unknown>>> {
    const page = await this.listReviews(query);
    const items = await Promise.all(
      page.items.map(async (review) => {
        if (review.subjectType === 'SOURCE_ITEM' && !this.fixtureMode) {
          const item = await this.source()
            .getRepository(SourceItemEntity)
            .findOneBy({ id: review.subjectId });
          const refs = Array.isArray(item?.rawMetadataJson?.officialReferences)
            ? item.rawMetadataJson.officialReferences
            : [];
          const officialReferences: Record<string, unknown>[] = [];
          for (const value of refs) {
            if (
              !value ||
              typeof value !== 'object' ||
              value.sourceHash !== item?.rawHash ||
              typeof value.id !== 'string'
            )
              continue;
            if (value.kind === 'FILING') {
              const filing = await this.source()
                .getRepository(FilingEntity)
                .findOneBy({ id: value.id });
              if (filing?.source === 'OPENDART')
                officialReferences.push({
                  ...value,
                  title: filing.reportName,
                  url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(filing.rceptNo)}`,
                });
            } else if (value.kind === 'SOURCE_ITEM') {
              const official = await this.source()
                .getRepository(SourceItemEntity)
                .findOneBy({ id: value.id });
              if (
                official &&
                newsAudienceAllows(official, 'ADMIN_UI') &&
                official.sourcePolicyJson?.displayAllowed === true &&
                publicSourceUrl(official.url)
              )
                officialReferences.push({ ...value, title: official.title, url: official.url });
            }
          }
          return {
            ...review,
            eventId: review.subjectId,
            sourceItemId: review.subjectId,
            sourceHash: item?.rawHash ?? null,
            companyName: item && newsAudienceAllows(item, 'ADMIN_UI') ? item.title : '뉴스 검토',
            detailType: 'NEWS',
            reason: review.reason,
            methodRaw: null,
            extractedText: null,
            proposedNature: 'UNKNOWN',
            parserConfidence: 0,
            officialReferences,
            manualCompanyIds: item?.rawMetadataJson?.manualCompanyIds ?? [],
          };
        }
        const event = await this.eventForReview(review);
        const storedFilingId =
          review.subjectType === 'FILING' ? review.subjectId : (event?.filing?.id ?? null);
        const storedFiling =
          !this.fixtureMode && storedFilingId
            ? await this.source().getRepository(FilingEntity).findOneBy({ id: storedFilingId })
            : null;
        const unsupported =
          storedFiling?.canonicalType && !isSupportedFilingType(storedFiling.canonicalType);
        const filing = storedFiling && !unsupported ? await this.getFiling(storedFiling.id) : null;
        const relation = await this.filingRelationReviewContext(review);
        const transaction = filing?.transactions[0] ?? null;
        const storedReview =
          !this.fixtureMode && review.subjectType === 'FILING'
            ? await this.source().getRepository(ReviewEntity).findOneBy({ id: review.id })
            : null;
        const runId =
          storedReview?.parseRunId ??
          /^parse:([a-f0-9-]{36})(?::failed)?$/u.exec(storedReview?.dedupeKey ?? '')?.[1];
        const candidate =
          !this.fixtureMode && runId && review.subjectType === 'FILING'
            ? await this.source()
                .getRepository(ParseRunEntity)
                .findOneBy({ id: runId, filingId: review.subjectId })
            : null;
        const candidateParsed = candidate?.resultJson?.parsed as
          Record<string, unknown> | undefined;
        const candidateRows =
          candidateParsed?.transactions ??
          candidateParsed?.changes ??
          candidateParsed?.planItems ??
          candidateParsed?.agendas ??
          candidateParsed?.securities;
        const candidateEvidence = Array.isArray(candidateRows)
          ? candidateRows.slice(0, 5).map((value: unknown) => {
              if (!value || typeof value !== 'object' || Array.isArray(value))
                return '행 형식 검증 필요';
              const row = value as Record<string, unknown>;
              const labels: Record<string, string> = {
                eventDate: '변동일',
                plannedStartDate: '계획 시작',
                plannedEndDate: '계획 종료',
                quantity: '수량',
                plannedQuantity: '계획 수량',
                unitPrice: '단가',
                amount: '금액',
                methodRaw: '원문 방법',
              };
              return [
                'eventDate',
                'plannedStartDate',
                'plannedEndDate',
                'quantity',
                'plannedQuantity',
                'unitPrice',
                'amount',
                'methodRaw',
              ]
                .filter((key) => row[key] !== null && row[key] !== undefined)
                .map((key) => `${labels[key]}: ${String(row[key]).slice(0, 300)}`)
                .join(' · ');
            })
          : [];
        const disclosureEvidence = candidateDisclosureEvidence(candidateParsed);
        const crosscheck = candidate?.resultJson?.crosscheck as Record<string, unknown> | undefined;
        const staged = candidate?.resultJson?.staging as Record<string, unknown> | undefined;
        const crosscheckReady = crosscheckReadyForProjection(
          candidate?.resultType,
          crosscheck,
          storedFiling?.rceptNo,
        );
        return {
          id: review.id,
          eventId: event?.id ?? review.subjectId,
          companyName: event?.company?.nameKo ?? filing?.company.nameKo ?? '회사 미확인',
          detailType: filing?.detailType ?? (event?.canonicalEventType === 'NEWS' ? 'NEWS' : 'SEC'),
          canonicalType: storedFiling?.canonicalType ?? filing?.detailType ?? null,
          classificationStatus: storedFiling?.classificationStatus ?? null,
          staged:
            staged?.mode === 'OFFLINE_INACTIVE' &&
            candidate?.resultJson?.projectionApplied === false,
          validationStatus: candidate?.validationStatus ?? null,
          crosscheckStatus: typeof crosscheck?.status === 'string' ? crosscheck.status : null,
          crosscheckReady,
          candidateRowCount: Array.isArray(candidateRows) ? candidateRows.length : 0,
          candidateEvidence: disclosureEvidence.length ? disclosureEvidence : candidateEvidence,
          sourceReviewRequired:
            candidate?.resultType === 'D003' || candidate?.resultType === 'D004',
          sourceReviewConfirmed: hasConfirmedSourceReview(candidate),
          sourceReviewConfirmedAt: hasConfirmedSourceReview(candidate)
            ? (candidate?.resultJson?.sourceReview as Record<string, unknown>).confirmedAt
            : null,
          candidateWarnings: candidate?.warningsJson ?? [],
          crosscheckEvidence: crosscheck?.exactReceiptMatches ?? null,
          officialUrl: storedFiling
            ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(storedFiling.rceptNo)}`
            : null,
          reason: review.reason,
          methodRaw: transaction?.methodRaw ?? filing?.tradePlan?.methodRaw ?? null,
          extractedText: transaction?.methodRaw ?? null,
          proposedNature: transaction?.nature ?? 'UNKNOWN',
          parserConfidence: candidate
            ? Number(candidate.confidence)
            : (transaction?.parserConfidence ?? filing?.parserConfidence ?? 0),
          createdAt: review.createdAt,
          status: review.status,
          relationType: relation?.relationType ?? null,
          fromRceptNo: relation?.fromRceptNo ?? null,
          toRceptNo: relation?.toRceptNo ?? null,
          planExecutionCandidates: relation?.planExecutionCandidates ?? [],
        };
      }),
    );
    return { ...page, items };
  }

  async updateReview(
    id: string,
    status: ReviewTaskStatus,
    resolution: string | null,
    adminId: string,
  ): Promise<Review> {
    const now = new Date();
    if (this.fixtureMode) {
      const item = this.fixtures.reviews.find((value) => value.id === id);
      if (!item) throw new NotFoundException('검토 작업을 찾을 수 없습니다.');
      item.status = status;
      item.resolution = resolution;
      item.resolvedAt = status === ReviewTaskStatus.OPEN ? null : now.toISOString();
      return item;
    }
    const repository = this.source().getRepository(ReviewEntity);
    const row = await repository.findOneBy({ id });
    if (!row) throw new NotFoundException('검토 작업을 찾을 수 없습니다.');
    if (
      row.subjectType === 'SOURCE_ITEM' ||
      row.subjectType === 'FILING_RELATION' ||
      row.dedupeKey.startsWith('parse:')
    ) {
      throw new BadRequestException(
        '공시 관계·재파싱 검토는 도메인 상태 전이가 필요하므로 /reviews/:id/resolve를 사용하세요.',
      );
    }
    row.status = status;
    row.resolution = resolution;
    row.resolvedByAdminId = status === ReviewTaskStatus.OPEN ? null : adminId;
    row.resolvedAt = status === ReviewTaskStatus.OPEN ? null : now;
    return mapReview(await repository.save(row));
  }

  async confirmReviewSource(
    id: string,
    input: { confirmed: true; note?: string },
    adminId: string,
  ): Promise<Record<string, unknown>> {
    if (this.fixtureMode)
      throw new BadRequestException('체험 데이터에는 원문 대조를 기록할 수 없습니다.');
    const source = this.source();
    const snapshot = await source.getRepository(ReviewEntity).findOneBy({ id });
    if (!snapshot || snapshot.subjectType !== 'FILING')
      throw new NotFoundException('공시 검토를 찾을 수 없습니다.');
    return source.transaction(async (manager) => {
      await this.lockReviewDomainDependencies(manager, snapshot);
      const repository = manager.getRepository(ReviewEntity);
      const review = await repository
        .createQueryBuilder('review')
        .setLock('pessimistic_write')
        .where('review.id = :id', { id })
        .getOne();
      if (
        !review ||
        review.status !== ReviewTaskStatus.OPEN ||
        review.subjectId !== snapshot.subjectId ||
        review.subjectType !== 'FILING'
      ) {
        throw new BadRequestException('검토가 변경되었거나 종료되었습니다. 다시 불러오세요.');
      }
      const runId =
        review.parseRunId ?? /^parse:([a-f0-9-]{36})(?::failed)?$/u.exec(review.dedupeKey)?.[1];
      const run = runId
        ? await manager
            .getRepository(ParseRunEntity)
            .findOneBy({ id: runId, filingId: review.subjectId })
        : null;
      const filing = await manager.getRepository(FilingEntity).findOneBy({ id: review.subjectId });
      const parsed = run?.resultJson?.parsed as Record<string, unknown> | undefined;
      const crosscheck = run?.resultJson?.crosscheck as Record<string, unknown> | undefined;
      const latest = await manager.getRepository(ParseRunEntity).findOne({
        where: { filingId: review.subjectId },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      if (
        !run ||
        !filing ||
        filing.effectiveState !== EffectiveFilingState.ACTIVE ||
        latest?.id !== run.id ||
        !['D003', 'D004'].includes(run.resultType ?? '') ||
        !['SUCCEEDED', 'PARTIAL'].includes(run.status) ||
        run.validationStatus === 'REJECTED' ||
        run.resultJson?.projectionApplied !== false ||
        run.resultType !== parsed?.detailType ||
        crosscheck?.status !== 'NOT_APPLICABLE' ||
        crosscheck?.reason !== `NO_SUMMARY_API_FOR_${run.resultType}` ||
        !run.rawSha256 ||
        !parsedSourceMatchesRun(run, parsed) ||
        !parsedDocumentKindMatchesFiling(filing, parsed) ||
        !hasParseTypeInvariant({
          canonicalType: filing.canonicalType,
          classificationStatus: filing.classificationStatus,
          inputType: run.inputType,
          extractorType: run.extractorType,
          resultType: run.resultType,
        })
      ) {
        throw new BadRequestException('최신의 유효한 원문 추출 결과만 대조할 수 있습니다.');
      }
      if (!hasConfirmedSourceReview(run)) {
        run.resultJson = {
          ...run.resultJson,
          sourceReview: {
            confirmedByAdminId: adminId,
            confirmedAt: new Date().toISOString(),
            parseRunId: run.id,
            rawSha256: run.rawSha256,
            note: input.note ?? null,
          },
        };
        await manager.getRepository(ParseRunEntity).save(run);
      }
      return {
        id,
        status: 'OPEN',
        sourceReviewConfirmed: true,
        sourceReviewConfirmedAt: (run.resultJson.sourceReview as Record<string, unknown>)
          .confirmedAt,
        queued: false,
      };
    });
  }

  async resolveReview(
    id: string,
    input: NewsReviewInput,
    adminId: string,
  ): Promise<Record<string, unknown>> {
    const resolvedAt = new Date();
    let projectionQueued = false;
    let serialized = JSON.stringify({
      resolution: input.resolution,
      note: input.note ?? null,
      planExecutionMatchId: input.planExecutionMatchId ?? null,
    });
    if (this.fixtureMode) {
      const item = this.fixtures.reviews.find((value) => value.id === id);
      if (!item) throw new NotFoundException('검토 작업을 찾을 수 없습니다.');
      item.status = ReviewTaskStatus.RESOLVED;
      item.resolution = serialized;
      item.resolvedAt = resolvedAt.toISOString();
    } else {
      const source = this.source();
      const reviewSnapshot = await source.getRepository(ReviewEntity).findOneBy({ id });
      if (!reviewSnapshot) throw new NotFoundException('검토 작업을 찾을 수 없습니다.');
      await source.transaction(async (manager) => {
        // 보강 worker의 잠금 순서는 Filing -> Relation/Match -> Review입니다.
        // 관리자 경로도 같은 순서를 지켜 재파싱과 수동 판단 사이의 교착을 방지합니다.
        // 최초 조회 결과는 연결 대상을 찾는 데만 사용하며, 아래에서 Review를
        // 직접 잠근 뒤 다시 검증합니다.
        await this.lockReviewDomainDependencies(manager, reviewSnapshot);
        const repository = manager.getRepository(ReviewEntity);
        const row = await repository
          .createQueryBuilder('review')
          .setLock('pessimistic_write')
          .where('review.id = :id', { id })
          .getOne();
        if (!row) throw new NotFoundException('검토 작업을 찾을 수 없습니다.');
        if (
          row.subjectType !== reviewSnapshot.subjectType ||
          row.subjectId !== reviewSnapshot.subjectId
        ) {
          throw new BadRequestException('검토 대상이 변경되어 다시 로드해야 합니다.');
        }
        if (row.status !== ReviewTaskStatus.OPEN) {
          throw new BadRequestException('이미 종료된 검토 작업입니다.');
        }
        if (row.subjectType === 'SOURCE_ITEM') {
          const audit = await resolveNewsReview(manager, row, input, adminId, resolvedAt);
          serialized = JSON.stringify({ ...input, newsReview: audit });
        } else if (input.resolution === 'CORRECTION_LINKED') {
          await this.confirmCorrectionLineage(manager, row, adminId, resolvedAt);
        } else if (input.resolution === 'CONFIRMED') {
          if (row.subjectType === 'FILING') {
            projectionQueued = await this.enqueueDeferredProjection(manager, row, adminId);
          } else {
            await this.confirmPlanExecutionCandidate(
              manager,
              row,
              adminId,
              resolvedAt,
              input.planExecutionMatchId,
            );
          }
        } else if (input.resolution === 'UNKNOWN' || input.resolution === 'DUPLICATE') {
          await this.rejectRelationCandidate(
            manager,
            row,
            adminId,
            resolvedAt,
            input.resolution,
            input.planExecutionMatchId,
          );
        }
        row.status = projectionQueued ? ReviewTaskStatus.OPEN : ReviewTaskStatus.RESOLVED;
        row.resolution = serialized;
        row.resolvedByAdminId = projectionQueued ? null : adminId;
        row.resolvedAt = projectionQueued ? null : resolvedAt;
        await repository.save(row);
      });
    }
    return {
      id,
      status: projectionQueued ? ReviewTaskStatus.OPEN : ReviewTaskStatus.RESOLVED,
      resolution: input.resolution,
      note: input.note ?? null,
      resolvedAt: projectionQueued ? null : resolvedAt.toISOString(),
      queued: projectionQueued,
    };
  }

  /**
   * Review 행을 잠그기 전에 검토 해결에 필요한 모든 도메인 잠금을 획득합니다.
   * ID를 찾기 위한 조회는 의도적으로 잠금 없이 수행합니다. 공시 잠금을 확보하면
   * 보강 worker가 이 트랜잭션 도중 해당 조회용 데이터를 교체할 수 없습니다.
   */
  private async lockReviewDomainDependencies(
    manager: EntityManager,
    review: ReviewEntity,
  ): Promise<void> {
    if (review.subjectType === 'SOURCE_ITEM') {
      await manager
        .getRepository(SourceItemEntity)
        .findOne({ where: { id: review.subjectId }, lock: { mode: 'pessimistic_write' } });
      return;
    }
    if (review.subjectType === 'FILING') {
      await manager
        .getRepository(FilingEntity)
        .createQueryBuilder('filing')
        .setLock('pessimistic_write')
        .where('filing.id = :filingId', { filingId: review.subjectId })
        .getOne();
      return;
    }
    if (review.subjectType !== 'FILING_RELATION') return;

    const relationRepository = manager.getRepository(FilingRelationEntity);
    const relationSnapshot = await relationRepository.findOneBy({ id: review.subjectId });
    if (!relationSnapshot) {
      throw new NotFoundException('검토할 공시 연결 후보를 찾을 수 없습니다.');
    }
    const filingIds = [
      ...new Set([relationSnapshot.fromFilingId, relationSnapshot.toFilingId]),
    ].sort();
    const filings = await manager
      .getRepository(FilingEntity)
      .createQueryBuilder('filing')
      .setLock('pessimistic_write')
      .where('filing.id IN (:...filingIds)', { filingIds })
      .orderBy('filing.id', 'ASC')
      .getMany();
    if (filings.length !== filingIds.length) {
      throw new NotFoundException('공시 연결 후보의 원본을 찾을 수 없습니다.');
    }

    // 정정 판단은 여러 D002/D005 후보 관계를 무효화할 수 있습니다.
    // 해당 공시에 연결된 모든 관계를 정해진 순서로 잠급니다.
    await relationRepository
      .createQueryBuilder('relation')
      .setLock('pessimistic_write')
      .where(
        '(relation.fromFilingId IN (:...filingIds) OR relation.toFilingId IN (:...filingIds))',
        { filingIds },
      )
      .orderBy('relation.id', 'ASC')
      .getMany();

    const reports = await manager.getRepository(InsiderReportEntity).findBy({
      filingId: In(filingIds),
    });
    const plans = await manager.getRepository(TradePlanEntity).findBy({
      filingId: In(filingIds),
    });
    const transactions = reports.length
      ? await manager.getRepository(InsiderTransactionEntity).findBy({
          insiderReportId: In(reports.map((report) => report.id)),
        })
      : [];
    const planItems = plans.length
      ? await manager.getRepository(TradePlanItemEntity).findBy({
          tradePlanId: In(plans.map((plan) => plan.id)),
        })
      : [];
    const matchConditions: string[] = [];
    const matchParameters: Record<string, string[]> = {};
    if (transactions.length) {
      matchConditions.push('candidate.insiderTransactionId IN (:...transactionIds)');
      matchParameters.transactionIds = transactions.map((transaction) => transaction.id);
    }
    if (planItems.length) {
      matchConditions.push('candidate.tradePlanItemId IN (:...planItemIds)');
      matchParameters.planItemIds = planItems.map((item) => item.id);
    }
    if (matchConditions.length) {
      await manager
        .getRepository(PlanExecutionMatchEntity)
        .createQueryBuilder('candidate')
        .setLock('pessimistic_write')
        .where(`(${matchConditions.join(' OR ')})`, matchParameters)
        .orderBy('candidate.id', 'ASC')
        .getMany();
    }
  }

  async connectors(): Promise<
    Array<
      ConnectorHealth &
        Partial<
          Pick<
            ReturnType<typeof publicDiscoveryStatus>,
            'incomplete' | 'lastWindowStart' | 'lastWindowEnd' | 'latestObservedAt'
          >
        >
    >
  > {
    if (this.fixtureMode) return this.fixtures.connectors;
    if (!this.database.dataSource) return [];
    const rows = await this.source()
      .getRepository(ConnectorHealthEntity)
      .find({ order: { connector: 'ASC' } });
    return rows.map((row) => ({
      connector: row.connector,
      status: row.status,
      message: row.message,
      ...(['sec', 'gdelt', 'alpaca_news'].includes(row.connector.toLowerCase())
        ? publicDiscoveryStatus(row)
        : {}),
      lastSuccessAt: dateToIso(row.lastSuccessAt),
      lastFailureAt: dateToIso(row.lastFailureAt),
      checkedAt: row.checkedAt.toISOString(),
    }));
  }

  async hasCompatibleIrSources(): Promise<boolean> {
    const configuredFeeds = (this.config.irFeedUrls ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      configuredFeeds.some((value) => {
        const profile = getNewsIrSourceProfile(value);
        return profile?.enabled && newsPolicyApprovalReady(profile.policy);
      })
    ) {
      return true;
    }
    if (this.fixtureMode) {
      return this.fixtures.irSources.some(
        (source) =>
          source.isActive &&
          source.sourceType === 'RSS' &&
          source.rightsMode === getNewsIrSourceProfile(source.url)?.policy.rightsMode &&
          getNewsIrSourceProfile(source.url)?.enabled === true &&
          newsPolicyApprovalReady(getNewsIrSourceProfile(source.url)?.policy),
      );
    }
    if (!this.database.dataSource) return false;
    const persisted = await this.database.dataSource.getRepository(IrSourceEntity).findBy({
      isActive: true,
      sourceType: 'RSS',
    });
    return persisted.some((source) => {
      const profile = getNewsIrSourceProfile(source.url);
      return (
        profile?.enabled &&
        profile.policy.rightsMode === source.rightsMode &&
        newsPolicyApprovalReady(profile.policy)
      );
    });
  }

  async privateNewsSourceViews() {
    return adminNewsSourceViews(this.database.dataSource ?? undefined);
  }

  async connectorSourceViews(): Promise<Array<Record<string, unknown>>> {
    const persisted = await this.connectors();
    const byName = new Map(persisted.map((item) => [item.connector.toLowerCase(), item]));
    const now = new Date().toISOString();
    const irConfigured = await this.hasCompatibleIrSources();
    const definitions = [
      {
        id: 'opendart',
        name: 'OpenDART',
        category: 'OFFICIAL',
        configured: Boolean(this.config.opendartApiKey),
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        missing: 'OPENDART_API_KEY가 없습니다.',
      },
      {
        id: 'toss',
        name: '토스증권 Open API',
        category: 'MARKET',
        configured: Boolean(this.config.tossClientId && this.config.tossClientSecret),
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        missing: '토스증권 API 자격 증명이 설정되지 않았습니다.',
      },
      {
        id: 'sec',
        name: 'SEC EDGAR',
        category: 'OFFICIAL',
        configured: Boolean(this.config.secUserAgent),
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        missing: 'SEC_USER_AGENT가 없습니다.',
      },
      {
        id: 'alpaca_news',
        name: 'Alpaca News',
        category: 'NEWS',
        configured: Boolean(
          byName.get('alpaca_news') &&
          !['UNCONFIGURED', 'DISABLED'].includes(String(byName.get('alpaca_news')?.status)),
        ),
        rightsMode: RightsMode.STORE_METADATA_ONLY,
        missing: 'Alpaca News의 설정·무료 이용·publisher 권리 확인이 필요합니다.',
      },
      {
        id: 'gdelt',
        name: 'GDELT 뉴스 링크',
        category: 'NEWS',
        configured:
          this.config.gdeltEnabled &&
          this.config.gdeltNewsDomains.length > 0 &&
          this.config.gdeltNewsDomains.every((domain) => {
            const policy = APPROVED_GDELT_SOURCE_POLICIES[domain];
            return policy?.metadataStorageAllowed === true && policy.displayAllowed === true;
          }),
        rightsMode: RightsMode.STORE_METADATA_ONLY,
        missing: 'GDELT 수집 설정 또는 publisher 저장·표시 승인이 필요합니다.',
      },
      {
        id: 'ir',
        name: 'Samsung Global Newsroom',
        category: 'OFFICIAL',
        configured: irConfigured,
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        missing: '검토된 Samsung Global Newsroom 피드가 등록되지 않았습니다.',
      },
      {
        id: 'naver',
        name: this.config.naverApiProvider === 'ncloud' ? 'NAVER Cloud 뉴스검색' : 'NAVER 뉴스검색',
        category: 'NEWS',
        configured: Boolean(this.config.naverClientId && this.config.naverClientSecret),
        rightsMode: RightsMode.STORE_METADATA_ONLY,
        missing: 'NAVER 자격 증명이 없습니다.',
      },
      {
        id: 'news_rss',
        name: 'Federal Reserve · BLS 공식 RSS',
        category: 'NEWS',
        configured: this.config.newsRssFeeds.length > 0,
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        missing: 'Federal Reserve · BLS 공식 RSS가 설정되지 않았습니다.',
      },
      {
        id: 'ai',
        name: 'AI 분류기',
        category: 'OFFICIAL',
        configured: Boolean(this.config.aiEnabled && this.config.aiBaseUrl && this.config.aiModel),
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        missing: 'AI 분류기가 비활성화되었습니다.',
      },
    ] as const;
    const feedViews = await this.newsFeedSourceViews();
    return [
      ...definitions.map((definition) => {
        const health =
          definition.id === 'naver' ||
          (['toss', 'gdelt'].includes(definition.id) && !definition.configured)
            ? undefined
            : byName.get(definition.id);
        const lastSuccessAt = health?.lastSuccessAt ?? null;
        return {
          id: definition.id,
          name: definition.name,
          category: definition.category,
          status:
            health?.status ??
            (definition.id === 'naver' || (definition.id === 'gdelt' && !definition.configured)
              ? ConnectorStatus.DISABLED
              : definition.configured
                ? ConnectorStatus.DEGRADED
                : ConnectorStatus.UNCONFIGURED),
          lastSuccessAt,
          lagSeconds: lastSuccessAt
            ? Math.max(0, Math.floor((Date.now() - Date.parse(lastSuccessAt)) / 1000))
            : null,
          rightsMode: definition.rightsMode,
          message:
            definition.id === 'naver' && definition.configured
              ? '별도 화면에서 수동 검색합니다. 정기 수집과 상태 점검은 사용하지 않습니다.'
              : health
                ? health.message
                : definition.configured
                  ? '설정됨; 아직 성공 상태가 기록되지 않았습니다.'
                  : definition.missing,
          checkedAt: health?.checkedAt ?? now,
          ...(['sec', 'gdelt', 'alpaca_news'].includes(definition.id) && health
            ? {
                httpStatus: health.httpStatus ?? null,
                requestAttempted: health.requestAttempted ?? null,
                lastAttemptAt: health.lastAttemptAt ?? null,
                nextRetryAt: health.nextRetryAt ?? null,
                incomplete: health.incomplete === true,
                lastWindowStart: health.lastWindowStart ?? null,
                lastWindowEnd: health.lastWindowEnd ?? null,
                latestObservedAt: health.latestObservedAt ?? null,
              }
            : {}),
        };
      }),
      ...feedViews,
    ];
  }

  private async newsFeedSourceViews(): Promise<Array<Record<string, unknown>>> {
    const ids = this.config.newsRssFeeds;
    if (!ids.length) return [];
    const checkpoints =
      this.database.dataSource && !this.fixtureMode
        ? await this.source()
            .getRepository(SourceCheckpointEntity)
            .findBy({ connector: 'NEWS_RSS' })
        : [];
    const now = Date.now();
    return ids.map((id) => {
      const feed = NEWS_RSS_FEEDS[id];
      const stream = `RSS_HTTP:${createHash('sha256').update(feed.url).digest('hex')}`;
      const row = checkpoints.find((checkpoint) => checkpoint.stream === stream);
      const lastSuccessAt = dateToIso(row?.lastSuccessAt);
      const lagSeconds = lastSuccessAt
        ? Math.max(0, Math.floor((now - Date.parse(lastSuccessAt)) / 1000))
        : null;
      const failed = row?.metadataJson?.status === ConnectorStatus.DEGRADED;
      return {
        id: `news_rss:${id}`,
        name: `${feed.publisher} · ${feed.categories.join(' / ')}`,
        category: feed.sourceKind === 'OFFICIAL_RELEASE' ? 'OFFICIAL' : 'NEWS',
        status:
          failed || !lastSuccessAt || (lagSeconds ?? 0) > 45 * 60
            ? ConnectorStatus.DEGRADED
            : ConnectorStatus.HEALTHY,
        lastSuccessAt,
        lagSeconds,
        rightsMode: feed.policy.rightsMode,
        checkedAt:
          typeof row?.metadataJson?.lastFailureAt === 'string' && failed
            ? row.metadataJson.lastFailureAt
            : (lastSuccessAt ?? new Date(now).toISOString()),
        message: failed
          ? '최근 피드 수집에 실패했습니다. 다음 주기에 재시도합니다.'
          : lastSuccessAt
            ? '15분마다 수집합니다.'
            : '첫 수집을 기다리고 있습니다.',
      };
    });
  }

  private async dashboardCounts(asOf = new Date().toISOString()) {
    const today = kstDateFromInstant(asOf)!;
    const todayCounts = { D001: 0, D002: 0, D003: 0, D004: 0, D005: 0 };
    const totalCounts = { ...todayCounts };
    let reviewRequired: number;
    let failedJobs: number;
    let watchedCompanies: number;
    if (this.fixtureMode) {
      for (const filing of this.fixtures.filings) {
        if (!isSupportedFilingType(filing.detailType)) continue;
        totalCounts[filing.detailType] += 1;
        if (filing.rceptDate === today) todayCounts[filing.detailType] += 1;
      }
      reviewRequired = this.fixtures.reviews.filter(
        (item) => item.status === ReviewTaskStatus.OPEN,
      ).length;
      failedJobs = 0;
      watchedCompanies = this.fixtures.watchlist.length;
    } else {
      const source = this.source();
      const effectiveType = 'COALESCE(filing.canonicalType, filing.detailType)';
      const [groups, reviews, failures, watches] = await Promise.all([
        source
          .getRepository(FilingEntity)
          .createQueryBuilder('filing')
          .select(effectiveType, 'detailType')
          .addSelect('COUNT(*)', 'countTotal')
          .addSelect('SUM(CASE WHEN filing.rceptDate = :today THEN 1 ELSE 0 END)', 'countToday')
          .where('filing.source = :source', { source: 'OPENDART' })
          .andWhere(`${effectiveType} IN (:...supportedTypes)`, {
            supportedTypes: Object.keys(todayCounts),
          })
          .setParameter('today', today)
          .groupBy(effectiveType)
          .getRawMany<{ detailType: string; countTotal: string; countToday: string }>(),
        source.getRepository(ReviewEntity).countBy({ status: ReviewTaskStatus.OPEN }),
        source.getRepository(JobOutboxEntity).countBy({ status: ProcessingStatus.FAILED }),
        source.getRepository(WatchlistItemEntity).count(),
      ]);
      for (const group of groups) {
        if (!isSupportedFilingType(group.detailType)) continue;
        totalCounts[group.detailType] = Number(group.countTotal);
        todayCounts[group.detailType] = Number(group.countToday);
      }
      reviewRequired = reviews;
      failedJobs = failures;
      watchedCompanies = watches;
    }
    return {
      counts: {
        filingsToday: Object.values(todayCounts).reduce((sum, count) => sum + count, 0),
        d001Today: todayCounts.D001,
        d002Today: todayCounts.D002,
        d003Today: todayCounts.D003,
        d004Today: todayCounts.D004,
        d005Today: todayCounts.D005,
        reviewRequired,
        failedJobs,
        watchedCompanies,
      },
      totalCounts,
    };
  }

  async dashboard(): Promise<Record<string, unknown>> {
    const [{ counts }, events, connectors] = await Promise.all([
      this.dashboardCounts(),
      this.fixtureMode
        ? Promise.resolve({ items: this.fixtures.events.map(mapFixtureEvent) })
        : this.listEvents({ limit: 8 }),
      this.fixtureMode ? Promise.resolve(this.fixtures.connectors) : this.connectors(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      counts,
      recentEvents: events.items,
      connectors,
    };
  }

  async personalFilings(personalActorKey: string) {
    const asOf = new Date().toISOString();
    if (this.fixtureMode) return { asOf, companyCount: 0, items: [] };
    const companies = await this.source().query(
      `SELECT DISTINCT c.id, c.name_ko nameKo, c.name_en nameEn,
      c.stock_code stockCode, c.ticker, c.market FROM companies c JOIN watchlist_group_items i ON i.company_id=c.id
      JOIN watchlist_groups g ON g.id=i.group_id WHERE g.room_id IS NULL AND g.owner_key=?`,
      [personalActorKey],
    );
    return this.filingsForCompanies(companies);
  }

  async filingsForCompanies(
    companies: Array<Pick<Company, 'id' | 'nameKo' | 'nameEn' | 'stockCode' | 'ticker' | 'market'>>,
  ) {
    const asOf = new Date().toISOString();
    // These companies were resolved from an authorized server-side scope. A personal
    // union can span several 200-stock groups, so it has no single-group size cap.
    const ids = companies.map((company) => company.id);
    if (this.fixtureMode) return { asOf, companyCount: companies.length, items: [] };
    if (!companies.length) return { asOf, companyCount: 0, items: [] };
    const mine = ids.map(() => '?').join(',');
    const [dart, sec] = await Promise.all([
      this.source().query(
        `SELECT f.id, f.company_id companyId, f.rcept_no externalId, f.report_name title,
        f.rcept_date filingDate, f.first_observed_at firstObservedAt FROM filings f
        WHERE f.source='OPENDART' AND f.company_id IN (${mine}) ORDER BY f.rcept_date DESC, f.id DESC LIMIT 12`,
        ids,
      ),
      this.source().query(
        `SELECT s.id, s.company_id companyId, s.external_id externalId, s.title, s.url,
        JSON_UNQUOTE(JSON_EXTRACT(s.raw_metadata_json, '$.filingDate')) filingDate,
        s.published_at publishedAt, s.first_observed_at firstObservedAt FROM source_items s
        WHERE s.source='SEC' AND s.rights_mode='OFFICIAL_PUBLIC_DATA' AND (s.company_id IN (${mine}) OR EXISTS
          (SELECT 1 FROM news_source_companies r WHERE r.source_item_id=s.id AND r.company_id IN (${mine})))
        ORDER BY COALESCE(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(s.raw_metadata_json, '$.filingDate')) REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN JSON_UNQUOTE(JSON_EXTRACT(s.raw_metadata_json, '$.filingDate')) END,s.published_at,s.first_observed_at) DESC, s.id DESC LIMIT 12`,
        [...ids, ...ids],
      ),
    ]);
    const relations = sec.length
      ? await this.source().query(
          `SELECT source_item_id sourceId, company_id companyId FROM news_source_companies WHERE source_item_id IN (${sec.map(() => '?').join(',')})`,
          sec.map((r: { id: string }) => r.id),
        )
      : [];
    const instant = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
    const dateOnly = (value: unknown) =>
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
        ? value
        : null;
    const rows = [
      ...dart.map((row: Record<string, unknown>) => ({
        ...row,
        source: 'OPENDART',
        url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.externalId}`,
      })),
      ...sec.map((row: Record<string, unknown>) => ({ ...row, source: 'SEC' })),
    ] as Array<{
      id: string;
      source: 'OPENDART' | 'SEC';
      externalId: string;
      companyId: string | null;
      title: string;
      url: string;
      filingDate: string | null;
      publishedAt?: string | Date | null;
      firstObservedAt: string | Date;
    }>;
    const unique = new Map<string, (typeof rows)[number]>();
    for (const row of rows)
      if (
        (row.source === 'OPENDART' && /^\d{14}$/u.test(row.externalId)) ||
        (row.source === 'SEC' && /^https:\/\/(?:www\.)?sec\.gov\//iu.test(row.url))
      )
        unique.set(`${row.source}:${row.externalId}`, row);
    const items = [...unique.values()]
      .map((row) => ({
        id: `${row.source}:${row.id}`,
        source: row.source,
        externalId: row.externalId,
        title: row.title,
        filingDate: dateOnly(row.filingDate),
        publishedAt: instant(row.publishedAt ?? null),
        firstObservedAt: instant(row.firstObservedAt),
        url: row.url,
        relatedCompanies: companies.filter(
          (c: { id: string }) =>
            c.id === row.companyId ||
            relations.some(
              (r: { sourceId: string; companyId: string }) =>
                r.sourceId === row.id && r.companyId === c.id,
            ),
        ),
      }))
      .sort(
        (a, b) =>
          (b.filingDate ?? b.publishedAt ?? b.firstObservedAt ?? '').localeCompare(
            a.filingDate ?? a.publishedAt ?? a.firstObservedAt ?? '',
          ) || b.id.localeCompare(a.id),
      )
      .slice(0, 8);
    return { asOf, companyCount: companies.length, items };
  }

  async personalNews(personalActorKey: string, audience: NewsAudience = 'MEMBER_UI') {
    const asOf = new Date().toISOString();
    // Personal groups only: never substitute the shared operational P2 list.
    if (this.fixtureMode) return { asOf, companyCount: 0, events: [], news: [] };
    const [count] = await this.source().query(
      `SELECT COUNT(DISTINCT i.company_id) companyCount FROM watchlist_group_items i
       JOIN watchlist_groups g ON g.id=i.group_id WHERE g.room_id IS NULL AND g.owner_key=?`,
      [personalActorKey],
    );
    const companyCount = Number(count?.companyCount ?? 0);
    if (!companyCount) return { asOf, companyCount, events: [], news: [] };
    const [events, news] = await Promise.all([
      this.listEventViews({ personalActorKey, audience, limit: 3 }),
      this.listNews({ personalActorKey, audience, scope: 'company', limit: 3 }),
    ]);
    return { asOf, companyCount, events: events.items, news: news.items };
  }

  async dashboardView(): Promise<Record<string, unknown>> {
    const asOf = new Date().toISOString();
    const { counts, totalCounts } = await this.dashboardCounts(asOf);
    const [p1, p2, verified, sources] = await Promise.all([
      this.listEventViews({ priority: 'P1', limit: 3 }),
      this.listEventViews({ priority: 'P2', limit: 3 }),
      this.listEventViews({ evidenceGrade: EvidenceGrade.A, limit: 4 }),
      this.connectorSourceViews(),
    ]);
    const integrity = await this.parseIntegrityMetrics();
    const [parserFailures, alertOutboxFailures, alertDeliveryFailures] = this.fixtureMode
      ? [0, 0, 0]
      : await Promise.all([
          this.source().getRepository(ParseRunEntity).countBy({ status: ParseStatus.FAILED }),
          this.source().getRepository(AlertOutboxEntity).countBy({ status: AlertStatus.FAILED }),
          this.source().getRepository(AlertDeliveryEntity).countBy({ status: AlertStatus.FAILED }),
        ]);
    return {
      asOf,
      todayCounts: {
        D001: counts.d001Today,
        D002: counts.d002Today,
        D003: counts.d003Today,
        D004: counts.d004Today,
        D005: counts.d005Today,
      },
      totalCounts,
      priorities: { P1: p1.items, P2: p2.items },
      reviewPending: counts.reviewRequired,
      parserFailures,
      integrity,
      alertFailures: alertOutboxFailures + alertDeliveryFailures,
      sources,
      recentlyVerified: verified.items,
    };
  }

  async parseIntegrityMetrics(): Promise<ParseIntegrityMetrics> {
    if (this.fixtureMode) {
      const open = this.fixtures.reviews.filter(
        (review) => review.status === ReviewTaskStatus.OPEN,
      );
      return {
        asOf: new Date().toISOString(),
        totalParseRuns: 0,
        failedParseRuns: 0,
        openReviewRows: open.length,
        currentReviewSubjects: new Set(
          open.map((review) => `${review.subjectType}:${review.subjectId}`),
        ).size,
        currentUnrecoveredFilings: open.filter((review) => review.subjectType === 'FILING').length,
        currentFailedFilings: 0,
        staleOpenParseReviews: 0,
        supersededReviews: 0,
        documentUnavailableReviews: 0,
        relationReviews: open.filter((review) => review.subjectType === 'FILING_RELATION').length,
        currentTypeMismatches: 0,
        futureCreatedRows: 0,
      };
    }
    const runner = this.source().createQueryRunner();
    await runner.connect();
    try {
      await runner.query('SET TRANSACTION READ ONLY');
      await runner.startTransaction('REPEATABLE READ');
      // Establish the MVCC snapshot before taking its presentation timestamp.
      await runner.query('SELECT id FROM parse_runs LIMIT 1');
      const [clock] = (await runner.query('SELECT UTC_TIMESTAMP(3) AS snapshot_at')) as Array<{
        snapshot_at: Date;
      }>;
      const asOf = clock!.snapshot_at;
      const [row] = (await runner.query(PARSE_INTEGRITY_METRICS_SQL, [asOf, asOf])) as Array<
        Record<string, unknown>
      >;
      const result = mapParseIntegrityMetrics(row!, asOf);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async listOperationRuns(query: ListQuery): Promise<CursorPage<Record<string, unknown>>> {
    if (this.fixtureMode) {
      const now = new Date().toISOString();
      return paginateFixture(
        [
          {
            id: 'fixture-opendart-run',
            source: 'OpenDART',
            job: 'poll-dart:D002',
            status: 'SUCCEEDED',
            startedAt: now,
            finishedAt: now,
            processed: this.fixtures.filings.length,
            failed: 0,
            message: 'fixture mode: 외부 요청 없이 예제 데이터를 사용했습니다.',
          },
        ],
        query,
        (item) => String(item.startedAt),
      );
    }
    const cursor = decodeCursor(query.cursor);
    const qb = this.source().getRepository(IngestionRunEntity).createQueryBuilder('run');
    if (cursor) {
      qb.andWhere('(run.startedAt < :sort OR (run.startedAt = :sort AND run.id < :id))', {
        sort: cursorInstant(cursor.sort),
        id: cursor.id,
      });
    }
    const rows = await qb
      .orderBy('run.startedAt', 'DESC')
      .addOrderBy('run.id', 'DESC')
      .take(query.limit + 1)
      .getMany();
    return pageRows(
      rows,
      query.limit,
      (row) => ({
        id: row.id,
        source: row.connector,
        job: row.stream,
        status:
          row.status === ProcessingStatus.PROCESSING
            ? 'RUNNING'
            : row.status === ProcessingStatus.COMPLETED
              ? 'SUCCEEDED'
              : row.status,
        startedAt: row.startedAt.toISOString(),
        finishedAt: dateToIso(row.finishedAt),
        processed: Number(row.itemsSeen),
        failed: row.status === ProcessingStatus.FAILED ? 1 : 0,
        message: row.errorMessage,
      }),
      (row) => row.startedAt.toISOString(),
    );
  }

  async listQueueMetrics(): Promise<CursorPage<Record<string, unknown>>> {
    if (this.fixtureMode) {
      const items = [
        {
          id: 'processing',
          name: 'processing-outbox',
          waiting: 0,
          active: 0,
          delayed: 0,
          failed: 0,
          oldestWaitingAt: null,
        },
        {
          id: 'alerts',
          name: 'alert-outbox',
          waiting: 0,
          active: 0,
          delayed: 0,
          failed: 0,
          oldestWaitingAt: null,
        },
        {
          id: 'bots',
          name: 'bot-deliveries',
          waiting: 0,
          active: 0,
          delayed: 0,
          failed: 0,
          oldestWaitingAt: null,
        },
      ];
      return { items, nextCursor: null, pageInfo: { nextCursor: null, hasMore: false } };
    }
    const source = this.source();
    const now = new Date();
    const metrics = await Promise.all([
      queueMetric(source, JobOutboxEntity, 'processing-outbox', now),
      queueMetric(source, AlertOutboxEntity, 'alert-outbox', now),
      queueMetric(source, BotDeliveryEntity, 'bot-deliveries', now),
    ]);
    return { items: metrics, nextCursor: null, pageInfo: { nextCursor: null, hasMore: false } };
  }

  async enqueueReprocess(filingId: string): Promise<{ jobId: string; status: string }> {
    await this.getFiling(filingId);
    if (this.fixtureMode) return { jobId: randomUUID(), status: ProcessingStatus.PENDING };
    const repository = this.source().getRepository(JobOutboxEntity);
    const dedupeKey = `manual-reparse:${filingId}:${Date.now()}`;
    const row = repository.create({
      kind: 'ENRICH_FILING',
      dedupeKey,
      payloadJson: { filingId, requestedBy: 'api' },
      status: ProcessingStatus.PENDING,
      availableAt: new Date(),
      attempts: 0,
      lockedAt: null,
      lastError: null,
    });
    await repository.save(row);
    return { jobId: row.id, status: row.status };
  }

  databaseHealth(): { ready: boolean; message: string | null } {
    return this.database.status;
  }

  private async watchForCompany(companyId: string): Promise<WatchlistItem | null> {
    if (this.fixtureMode)
      return this.fixtures.watchlist.find((item) => item.company.id === companyId) ?? null;
    const row = await this.source().getRepository(MarketLeaderScopeEntity).findOneBy({ companyId });
    return row ? this.mapWatchlist(row) : null;
  }

  private async eventForReview(review: Review): Promise<Event | null> {
    if (this.fixtureMode) {
      const row = this.fixtures.events.find(
        (event) =>
          (review.subjectType === 'EVENT_CLUSTER' && event.id === review.subjectId) ||
          (review.subjectType === 'FILING' && event.filing?.id === review.subjectId) ||
          (review.subjectType === 'SOURCE_ITEM' &&
            event.sourceItems.some((item) => item.id === review.subjectId)),
      );
      return row ?? null;
    }
    if (review.subjectType === 'EVENT_CLUSTER') {
      const row = await this.source()
        .getRepository(EventClusterEntity)
        .findOneBy({ id: review.subjectId });
      return row ? this.mapEvent(row) : null;
    }
    if (review.subjectType === 'FILING_RELATION') {
      const source = this.source();
      const relation = await source
        .getRepository(FilingRelationEntity)
        .findOneBy({ id: review.subjectId });
      if (!relation) return null;
      const filingIds = [relation.fromFilingId, relation.toFilingId];
      const memberships = await source.getRepository(EventClusterItemEntity).find({
        where: { itemType: 'FILING', itemId: In(filingIds) },
      });
      const preferred =
        memberships.find((item) => item.itemId === relation.fromFilingId) ??
        memberships.find((item) => item.itemId === relation.toFilingId);
      if (!preferred) return null;
      const row = await source
        .getRepository(EventClusterEntity)
        .findOneBy({ id: preferred.eventClusterId });
      return row ? this.mapEvent(row) : null;
    }
    const itemType = review.subjectType === 'FILING' ? 'FILING' : 'SOURCE_ITEM';
    const membership = await this.source()
      .getRepository(EventClusterItemEntity)
      .findOne({ where: { itemType, itemId: review.subjectId }, order: { createdAt: 'DESC' } });
    if (!membership) return null;
    const row = await this.source()
      .getRepository(EventClusterEntity)
      .findOneBy({ id: membership.eventClusterId });
    return row ? this.mapEvent(row) : null;
  }

  private async filingRelationReviewContext(review: Review): Promise<{
    relationType: string;
    fromRceptNo: string | null;
    toRceptNo: string | null;
    planExecutionCandidates: Array<Record<string, unknown>>;
  } | null> {
    if (this.fixtureMode || review.subjectType !== 'FILING_RELATION') return null;
    const source = this.source();
    const relation = await source
      .getRepository(FilingRelationEntity)
      .findOneBy({ id: review.subjectId });
    if (!relation) return null;
    const filings = await source.getRepository(FilingEntity).findBy({
      id: In([relation.fromFilingId, relation.toFilingId]),
    });
    const context = {
      relationType: relation.relationType,
      fromRceptNo: filings.find((filing) => filing.id === relation.fromFilingId)?.rceptNo ?? null,
      toRceptNo: filings.find((filing) => filing.id === relation.toFilingId)?.rceptNo ?? null,
      planExecutionCandidates: [] as Array<Record<string, unknown>>,
    };
    if (
      relation.relationType !== FilingRelationType.EXECUTION_CANDIDATE &&
      relation.relationType !== FilingRelationType.FULFILLS_PLAN
    ) {
      return context;
    }
    const reports = await source
      .getRepository(InsiderReportEntity)
      .findBy({ filingId: relation.fromFilingId });
    const plans = await source
      .getRepository(TradePlanEntity)
      .findBy({ filingId: relation.toFilingId });
    if (reports.length === 0 || plans.length === 0) return context;
    const [transactions, planItems] = await Promise.all([
      source.getRepository(InsiderTransactionEntity).findBy({
        insiderReportId: In(reports.map((report) => report.id)),
      }),
      source
        .getRepository(TradePlanItemEntity)
        .findBy({ tradePlanId: In(plans.map((plan) => plan.id)) }),
    ]);
    if (transactions.length === 0 || planItems.length === 0) return context;
    const matches = await source.getRepository(PlanExecutionMatchEntity).find({
      where: {
        insiderTransactionId: In(transactions.map((transaction) => transaction.id)),
        tradePlanItemId: In(planItems.map((item) => item.id)),
        reviewDecision: RelationReviewDecision.PENDING,
      },
    });
    const transactionsById = new Map(
      transactions.map((transaction) => [transaction.id, transaction]),
    );
    const planItemsById = new Map(planItems.map((item) => [item.id, item]));
    context.planExecutionCandidates = matches.map((match) => {
      const transaction = transactionsById.get(match.insiderTransactionId);
      const item = planItemsById.get(match.tradePlanItemId);
      return {
        matchId: match.id,
        transactionId: match.insiderTransactionId,
        planItemId: match.tradePlanItemId,
        eventDate: transaction?.eventDate ?? null,
        actualQuantity: transaction?.quantity ?? null,
        plannedQuantity: item?.plannedQuantity ?? null,
        actualMethodRaw: transaction?.methodRaw ?? '방법 확인 필요',
        plannedMethodRaw: item?.methodRaw ?? null,
        confidence: Number(match.confidence),
        matchedFields: match.matchedFieldsJson ?? [],
      };
    });
    return context;
  }

  private async confirmCorrectionLineage(
    manager: EntityManager,
    review: ReviewEntity,
    adminId: string,
    reviewedAt: Date,
  ): Promise<void> {
    if (review.subjectType !== 'FILING_RELATION') {
      throw new BadRequestException(
        'CORRECTION_LINKED 처리는 공시 정정 계보 검토에만 사용할 수 있습니다.',
      );
    }
    const relationRepository = manager.getRepository(FilingRelationEntity);
    const relation = await relationRepository
      .createQueryBuilder('relation')
      .setLock('pessimistic_write')
      .where('relation.id = :id', { id: review.subjectId })
      .getOne();
    if (!relation) throw new NotFoundException('검토할 공시 연결 후보를 찾을 수 없습니다.');
    const supportedRelations = new Set<string>([
      FilingRelationType.CORRECTS,
      FilingRelationType.SUPERSEDES,
      FilingRelationType.CANCELS,
      FilingRelationType.WITHDRAWS,
    ]);
    if (!supportedRelations.has(relation.relationType)) {
      throw new BadRequestException('이 연결 유형은 정정 계보로 승인할 수 없습니다.');
    }

    const filingRepository = manager.getRepository(FilingEntity);
    const filingIds = [relation.fromFilingId, relation.toFilingId].sort();
    const lockedFilings = await filingRepository
      .createQueryBuilder('filing')
      .setLock('pessimistic_write')
      .where('filing.id IN (:...filingIds)', { filingIds })
      .orderBy('filing.id', 'ASC')
      .getMany();
    const successor = lockedFilings.find((filing) => filing.id === relation.fromFilingId) ?? null;
    const original = lockedFilings.find((filing) => filing.id === relation.toFilingId) ?? null;
    if (!successor || !original)
      throw new NotFoundException('연결 후보의 공시 원본을 찾을 수 없습니다.');
    if (
      successor.companyId !== original.companyId ||
      successor.detailType !== original.detailType
    ) {
      throw new BadRequestException(
        '회사 또는 공시 유형이 다른 항목은 정정 계보로 승인할 수 없습니다.',
      );
    }

    const eventState =
      relation.relationType === FilingRelationType.CANCELS ||
      relation.relationType === FilingRelationType.WITHDRAWS
        ? EventState.CANCELLED
        : EventState.SUPERSEDED;
    original.effectiveState =
      relation.relationType === FilingRelationType.CANCELS
        ? EffectiveFilingState.CANCELLED
        : relation.relationType === FilingRelationType.WITHDRAWS
          ? EffectiveFilingState.WITHDRAWN
          : EffectiveFilingState.SUPERSEDED;
    await filingRepository.save(original);

    await this.invalidatePlanExecutionLinks(manager, original, adminId, reviewedAt);

    relation.reviewRequired = false;
    relation.reviewDecision = RelationReviewDecision.CONFIRMED;
    relation.reviewedByAdminId = adminId;
    relation.reviewedAt = reviewedAt;
    relation.source = RelationSource.MANUAL;
    relation.confidence = '1.000000';
    await relationRepository.save(relation);

    const memberships = await manager.getRepository(EventClusterItemEntity).find({
      where: { itemType: 'FILING', itemId: original.id },
    });
    const eventIds = memberships.map((item) => item.eventClusterId);
    if (eventIds.length === 0) return;
    await manager
      .getRepository(EventClusterEntity)
      .update({ id: In(eventIds) }, { state: eventState });

    const relatedAlerts = await manager.getRepository(AlertEntity).find({
      where: { eventClusterId: In(eventIds) },
    });
    if (relatedAlerts.length === 0) return;
    const alertIds = relatedAlerts.map((alert) => alert.id);
    await manager
      .getRepository(AlertEntity)
      .update(
        { id: In(alertIds), status: In([AlertStatus.PENDING, AlertStatus.SENDING]) },
        { status: AlertStatus.CANCELLED },
      );
    await manager.getRepository(AlertDeliveryEntity).update(
      {
        alertId: In(alertIds),
        status: In([AlertStatus.PENDING, AlertStatus.SENDING]),
      },
      {
        status: AlertStatus.CANCELLED,
        errorMessage: '정정·취소 계보 승인으로 이전 공시 알림을 취소했습니다.',
      },
    );
    await manager.getRepository(AlertOutboxEntity).update(
      {
        alertId: In(alertIds),
        status: In([AlertStatus.PENDING, AlertStatus.SENDING]),
      },
      {
        status: AlertStatus.CANCELLED,
        lastError: '정정·취소 계보 승인으로 이전 공시 알림을 취소했습니다.',
      },
    );
    await manager.getRepository(PushDeliveryEntity).update(
      {
        alertId: In(alertIds),
        status: In([AlertStatus.PENDING, AlertStatus.SENDING]),
      },
      {
        status: AlertStatus.CANCELLED,
        leaseUntil: null,
        lastError: '정정·취소 계보 승인으로 이전 공시 알림을 취소했습니다.',
      },
    );
    await manager.getRepository(BotDeliveryEntity).update(
      {
        alertId: In(alertIds),
        status: In([AlertStatus.PENDING, AlertStatus.SENDING]),
      },
      {
        status: AlertStatus.CANCELLED,
        leaseUntil: null,
        lastError: '정정·취소 계보 승인으로 이전 공시 알림을 취소했습니다.',
      },
    );
  }

  /**
   * 대체·철회·취소된 D002나 D005는 이후 수동 실행 확인의 대상으로 남아서는 안 됩니다.
   * 감사 이력을 위해 대기 중인 행과 과거 확인된 행 모두 보존하되, 유효한 판단을
   * 취소해 계획 수량을 예약하거나 차감하지 않도록 합니다. 이후 worker가 정정 공시를
   * 기준으로 다시 연결할 수 있습니다.
   */
  private async invalidatePlanExecutionLinks(
    manager: EntityManager,
    filing: FilingEntity,
    adminId: string,
    reviewedAt: Date,
  ): Promise<void> {
    if (filing.detailType !== 'D002' && filing.detailType !== 'D005') return;

    if (filing.detailType === 'D005') {
      const planStatus =
        filing.effectiveState === EffectiveFilingState.CANCELLED
          ? 'CANCELLED'
          : filing.effectiveState === EffectiveFilingState.WITHDRAWN
            ? 'WITHDRAWN'
            : 'SUPERSEDED';
      await manager.getRepository(TradePlanEntity).update({ filingId: filing.id }, { planStatus });
    }

    const relationRepository = manager.getRepository(FilingRelationEntity);
    const relations = await relationRepository
      .createQueryBuilder('relation')
      .setLock('pessimistic_write')
      .where('(relation.fromFilingId = :filingId OR relation.toFilingId = :filingId)', {
        filingId: filing.id,
      })
      .andWhere('relation.relationType IN (:...relationTypes)', {
        relationTypes: [FilingRelationType.EXECUTION_CANDIDATE, FilingRelationType.FULFILLS_PLAN],
      })
      .andWhere('relation.reviewDecision IN (:...reviewDecisions)', {
        reviewDecisions: [RelationReviewDecision.PENDING, RelationReviewDecision.CONFIRMED],
      })
      .getMany();

    let matches: PlanExecutionMatchEntity[] = [];
    if (filing.detailType === 'D005') {
      const plans = await manager.getRepository(TradePlanEntity).findBy({ filingId: filing.id });
      const items = plans.length
        ? await manager.getRepository(TradePlanItemEntity).findBy({
            tradePlanId: In(plans.map((plan) => plan.id)),
          })
        : [];
      if (items.length) {
        matches = await manager
          .getRepository(PlanExecutionMatchEntity)
          .createQueryBuilder('candidate')
          .setLock('pessimistic_write')
          .where('candidate.tradePlanItemId IN (:...itemIds)', {
            itemIds: items.map((item) => item.id),
          })
          .andWhere('candidate.relationType IN (:...relationTypes)', {
            relationTypes: [
              FilingRelationType.EXECUTION_CANDIDATE,
              FilingRelationType.FULFILLS_PLAN,
            ],
          })
          .andWhere('candidate.reviewDecision IN (:...reviewDecisions)', {
            reviewDecisions: [RelationReviewDecision.PENDING, RelationReviewDecision.CONFIRMED],
          })
          .getMany();
      }
    } else {
      const reports = await manager
        .getRepository(InsiderReportEntity)
        .findBy({ filingId: filing.id });
      const transactions = reports.length
        ? await manager.getRepository(InsiderTransactionEntity).findBy({
            insiderReportId: In(reports.map((report) => report.id)),
          })
        : [];
      if (transactions.length) {
        matches = await manager
          .getRepository(PlanExecutionMatchEntity)
          .createQueryBuilder('candidate')
          .setLock('pessimistic_write')
          .where('candidate.insiderTransactionId IN (:...transactionIds)', {
            transactionIds: transactions.map((transaction) => transaction.id),
          })
          .andWhere('candidate.relationType IN (:...relationTypes)', {
            relationTypes: [
              FilingRelationType.EXECUTION_CANDIDATE,
              FilingRelationType.FULFILLS_PLAN,
            ],
          })
          .andWhere('candidate.reviewDecision IN (:...reviewDecisions)', {
            reviewDecisions: [RelationReviewDecision.PENDING, RelationReviewDecision.CONFIRMED],
          })
          .getMany();
      }
    }

    for (const match of matches) {
      match.reviewDecision = RelationReviewDecision.REJECTED;
      match.reviewedByAdminId = adminId;
      match.reviewedAt = reviewedAt;
    }
    if (matches.length) await manager.getRepository(PlanExecutionMatchEntity).save(matches);

    for (const candidateRelation of relations) {
      candidateRelation.reviewRequired = false;
      candidateRelation.reviewDecision = RelationReviewDecision.REJECTED;
      candidateRelation.reviewedByAdminId = adminId;
      candidateRelation.reviewedAt = reviewedAt;
    }
    if (relations.length) await relationRepository.save(relations);

    if (relations.length) {
      await manager.getRepository(ReviewEntity).update(
        {
          subjectType: 'FILING_RELATION',
          subjectId: In(relations.map((candidateRelation) => candidateRelation.id)),
          status: ReviewTaskStatus.OPEN,
        },
        {
          status: ReviewTaskStatus.DISMISSED,
          resolution: JSON.stringify({
            resolution: 'INVALIDATED_BY_FILING_LINEAGE',
            filingId: filing.id,
          }),
          resolvedByAdminId: adminId,
          resolvedAt: reviewedAt,
        },
      );
    }
  }

  private async enqueueDeferredProjection(
    manager: EntityManager,
    review: ReviewEntity,
    adminId: string,
  ): Promise<boolean> {
    const parseRunId =
      review.parseRunId ??
      (review.dedupeKey.startsWith('parse:')
        ? review.dedupeKey.slice(6).replace(/:failed$/u, '')
        : null);
    if (!parseRunId) return false;
    const parseRun = await manager.getRepository(ParseRunEntity).findOneBy({
      id: parseRunId,
      filingId: review.subjectId,
    });
    if (!parseRun || parseRun.resultJson?.projectionApplied !== false) return false;
    const filing = await manager.getRepository(FilingEntity).findOneBy({ id: review.subjectId });
    const parsed = parseRun.resultJson?.parsed as { detailType?: string } | undefined;
    const sourceReviewRequired = parseRun.resultType === 'D003' || parseRun.resultType === 'D004';
    if (
      !filing ||
      (parseRun.status !== 'SUCCEEDED' && parseRun.status !== 'PARTIAL') ||
      parseRun.resultType !== parsed?.detailType ||
      (sourceReviewRequired &&
        (!parsedSourceMatchesRun(parseRun, parsed as Record<string, unknown> | undefined) ||
          !parsedDocumentKindMatchesFiling(
            filing,
            parsed as Record<string, unknown> | undefined,
          ))) ||
      !hasParseTypeInvariant({
        canonicalType: filing.canonicalType,
        classificationStatus: filing.classificationStatus,
        inputType: parseRun.inputType,
        extractorType: parseRun.extractorType,
        resultType: parsed?.detailType,
      }) ||
      parseRun.validationStatus === 'REJECTED'
    ) {
      throw new BadRequestException(
        '공시 유형 또는 파싱 검증이 일치하지 않아 결과를 활성화할 수 없습니다.',
      );
    }
    if (sourceReviewRequired && !hasConfirmedSourceReview(parseRun)) {
      throw new BadRequestException('공식 원문 대조를 먼저 기록한 뒤 별도로 활성화를 확정하세요.');
    }
    const staging = parseRun.resultJson?.staging as Record<string, unknown> | undefined;
    const crosscheck = parseRun.resultJson?.crosscheck as Record<string, unknown> | undefined;
    const crosscheckReady = crosscheckReadyForProjection(
      parseRun.resultType,
      crosscheck,
      filing.rceptNo,
    );
    if (sourceReviewRequired && !crosscheckReady) {
      throw new BadRequestException(
        '원문 대조에 결합된 공시 유형별 검증 근거가 변경되어 다시 대조해야 합니다.',
      );
    }
    const repository = manager.getRepository(JobOutboxEntity);
    const dedupeKey = `manual-apply-projection:${parseRun.id}`;
    const payloadJson = {
      filingId: review.subjectId,
      parseRunId: parseRun.id,
      requestedByAdminId: adminId,
      crosscheckOnly:
        !sourceReviewRequired && staging?.mode === 'OFFLINE_INACTIVE' && !crosscheckReady,
    };
    const existing = await repository
      .createQueryBuilder('outbox')
      .setLock('pessimistic_write')
      .where('outbox.kind = :kind', { kind: 'APPLY_PARSE_PROJECTION' })
      .andWhere('outbox.dedupeKey = :dedupeKey', { dedupeKey })
      .getOne();
    if (existing) {
      if (
        existing.status === ProcessingStatus.COMPLETED ||
        existing.status === ProcessingStatus.FAILED
      ) {
        // COMPLETED는 저장된 작업 행을 BullMQ에 전달했다는 뜻이며 후속 조회용
        // 데이터 생성 작업의 성공을 뜻하지는 않습니다. 관리자가 재시도하면 같은
        // 저장 행을 다시 활성화하고, 전송기가 시도 횟수를 증가시켜 새로운
        // BullMQ 세대 번호와 작업 ID를 발급합니다.
        existing.status = ProcessingStatus.PENDING;
        existing.availableAt = new Date();
        existing.lockedAt = null;
        existing.lastError = null;
        existing.payloadJson = payloadJson;
        await repository.save(existing);
      }
      return true;
    }
    await repository.save(
      repository.create({
        kind: 'APPLY_PARSE_PROJECTION',
        dedupeKey,
        payloadJson,
        status: ProcessingStatus.PENDING,
        availableAt: new Date(),
        attempts: 0,
        lockedAt: null,
        lastError: null,
      }),
    );
    return true;
  }

  private async confirmPlanExecutionCandidate(
    manager: EntityManager,
    review: ReviewEntity,
    adminId: string,
    confirmedAt: Date,
    selectedMatchId?: string,
  ): Promise<void> {
    if (review.subjectType !== 'FILING_RELATION') return;
    const relationRepository = manager.getRepository(FilingRelationEntity);
    const relation = await relationRepository
      .createQueryBuilder('relation')
      .setLock('pessimistic_write')
      .where('relation.id = :id', { id: review.subjectId })
      .getOne();
    if (!relation) throw new NotFoundException('검토할 계획 실행 후보를 찾을 수 없습니다.');
    if (
      relation.relationType === FilingRelationType.FULFILLS_PLAN &&
      relation.reviewDecision === RelationReviewDecision.CONFIRMED
    ) {
      return;
    }
    if (relation.relationType !== FilingRelationType.EXECUTION_CANDIDATE) {
      throw new BadRequestException('CONFIRMED 처리는 D005-D002 실행 후보에만 사용할 수 있습니다.');
    }

    const filingIds = [relation.fromFilingId, relation.toFilingId].sort();
    const filings = await manager
      .getRepository(FilingEntity)
      .createQueryBuilder('filing')
      .setLock('pessimistic_write')
      .where('filing.id IN (:...filingIds)', { filingIds })
      .orderBy('filing.id', 'ASC')
      .getMany();
    const execution = filings.find((filing) => filing.id === relation.fromFilingId);
    const planFiling = filings.find((filing) => filing.id === relation.toFilingId);
    if (
      !execution ||
      !planFiling ||
      execution.detailType !== 'D002' ||
      planFiling.detailType !== 'D005'
    ) {
      throw new BadRequestException('D002 실행 공시와 D005 계획 공시의 방향이 올바르지 않습니다.');
    }
    if (
      execution.effectiveState !== EffectiveFilingState.ACTIVE ||
      planFiling.effectiveState !== EffectiveFilingState.ACTIVE
    ) {
      throw new BadRequestException('비활성·정정·취소된 공시는 계획 실행으로 확정할 수 없습니다.');
    }

    const reports = await manager
      .getRepository(InsiderReportEntity)
      .findBy({ filingId: execution.id });
    const plans = await manager.getRepository(TradePlanEntity).findBy({ filingId: planFiling.id });
    const transactions = reports.length
      ? await manager.getRepository(InsiderTransactionEntity).findBy({
          insiderReportId: In(reports.map((report) => report.id)),
        })
      : [];
    const planItems = plans.length
      ? await manager
          .getRepository(TradePlanItemEntity)
          .findBy({ tradePlanId: In(plans.map((plan) => plan.id)) })
      : [];
    const matches =
      transactions.length && planItems.length
        ? await manager.getRepository(PlanExecutionMatchEntity).find({
            where: {
              insiderTransactionId: In(transactions.map((transaction) => transaction.id)),
              tradePlanItemId: In(planItems.map((item) => item.id)),
              relationType: FilingRelationType.EXECUTION_CANDIDATE,
              reviewDecision: RelationReviewDecision.PENDING,
            },
          })
        : [];
    if (matches.length === 0) {
      throw new BadRequestException(
        '현재 파싱 결과에서 승인할 거래계획 실행 항목을 찾을 수 없습니다.',
      );
    }
    const selected = selectedMatchId
      ? matches.find((match) => match.id === selectedMatchId)
      : matches.length === 1
        ? matches[0]
        : null;
    if (!selected) {
      throw new BadRequestException(
        '여러 실행 후보가 있어 자동으로 하나를 고를 수 없습니다. planExecutionMatchId를 지정하세요.',
      );
    }
    const lockedMatch = await manager
      .getRepository(PlanExecutionMatchEntity)
      .createQueryBuilder('candidate')
      .setLock('pessimistic_write')
      .where('candidate.id = :id', { id: selected.id })
      .andWhere('candidate.relationType = :relationType', {
        relationType: FilingRelationType.EXECUTION_CANDIDATE,
      })
      .andWhere('candidate.reviewDecision = :reviewDecision', {
        reviewDecision: RelationReviewDecision.PENDING,
      })
      .getOne();
    if (!lockedMatch)
      throw new BadRequestException('선택한 실행 후보가 더 이상 승인 가능한 상태가 아닙니다.');
    const lockedPlanItem = await manager
      .getRepository(TradePlanItemEntity)
      .createQueryBuilder('item')
      .setLock('pessimistic_write')
      .where('item.id = :id', { id: lockedMatch.tradePlanItemId })
      .getOne();
    const lockedTransaction = await manager
      .getRepository(InsiderTransactionEntity)
      .createQueryBuilder('transaction')
      .setLock('pessimistic_write')
      .where('transaction.id = :id', { id: lockedMatch.insiderTransactionId })
      .getOne();
    if (!lockedPlanItem?.plannedQuantity || !lockedTransaction?.quantity) {
      throw new BadRequestException(
        '계획수량과 실제수량이 모두 확인되어야 실행을 확정할 수 있습니다.',
      );
    }
    const lockedPlan = await manager
      .getRepository(TradePlanEntity)
      .createQueryBuilder('plan')
      .setLock('pessimistic_write')
      .where('plan.id = :id', { id: lockedPlanItem.tradePlanId })
      .getOne();
    if (
      !lockedPlan ||
      lockedPlan.filingId !== planFiling.id ||
      lockedPlan.planStatus !== 'PLANNED'
    ) {
      throw new BadRequestException('활성 PLANNED 상태의 거래계획만 실행으로 확정할 수 있습니다.');
    }
    const conflictingConfirmation = await manager.getRepository(PlanExecutionMatchEntity).findOne({
      where: {
        insiderTransactionId: lockedMatch.insiderTransactionId,
        relationType: FilingRelationType.FULFILLS_PLAN,
        reviewDecision: RelationReviewDecision.CONFIRMED,
      },
    });
    if (conflictingConfirmation && conflictingConfirmation.id !== lockedMatch.id) {
      throw new BadRequestException(
        '이 실제 거래는 이미 다른 계획 항목의 실행으로 확정되었습니다.',
      );
    }
    const priorMatches = await manager.getRepository(PlanExecutionMatchEntity).find({
      where: {
        tradePlanItemId: lockedMatch.tradePlanItemId,
        relationType: FilingRelationType.FULFILLS_PLAN,
        reviewDecision: RelationReviewDecision.CONFIRMED,
      },
    });
    const priorTransactions = priorMatches.length
      ? await manager.getRepository(InsiderTransactionEntity).findBy({
          id: In(priorMatches.map((match) => match.insiderTransactionId)),
        })
      : [];
    const confirmedQuantity = priorTransactions.reduce(
      (sum, transaction) => sum + decimalMagnitudeToScaledBigInt(transaction.quantity),
      0n,
    );
    const selectedQuantity = decimalMagnitudeToScaledBigInt(lockedTransaction.quantity);
    const plannedQuantity = decimalMagnitudeToScaledBigInt(lockedPlanItem.plannedQuantity);
    if (selectedQuantity <= 0n || plannedQuantity <= 0n) {
      throw new BadRequestException('0 이하 수량은 거래계획 실행으로 확정할 수 없습니다.');
    }
    if (confirmedQuantity + selectedQuantity > plannedQuantity) {
      throw new BadRequestException('확정 실행수량 합계가 해당 계획 항목의 계획수량을 초과합니다.');
    }
    lockedMatch.relationType = FilingRelationType.FULFILLS_PLAN;
    lockedMatch.source = RelationSource.MANUAL;
    lockedMatch.confidence = '1.000000';
    lockedMatch.confirmedByAdminId = adminId;
    lockedMatch.confirmedAt = confirmedAt;
    lockedMatch.reviewDecision = RelationReviewDecision.CONFIRMED;
    lockedMatch.reviewedByAdminId = adminId;
    lockedMatch.reviewedAt = confirmedAt;
    await manager.getRepository(PlanExecutionMatchEntity).save(lockedMatch);
    const sameTransactionAlternatives = matches.filter(
      (match) =>
        match.id !== lockedMatch.id &&
        match.insiderTransactionId === lockedMatch.insiderTransactionId,
    );
    for (const alternative of sameTransactionAlternatives) {
      alternative.reviewDecision = RelationReviewDecision.REJECTED;
      alternative.reviewedByAdminId = adminId;
      alternative.reviewedAt = confirmedAt;
    }
    if (sameTransactionAlternatives.length) {
      await manager.getRepository(PlanExecutionMatchEntity).save(sameTransactionAlternatives);
    }
    const remaining = matches.filter(
      (match) =>
        match.id !== lockedMatch.id &&
        match.insiderTransactionId !== lockedMatch.insiderTransactionId,
    );
    if (remaining.length === 0) {
      relation.relationType = FilingRelationType.FULFILLS_PLAN;
      relation.source = RelationSource.MANUAL;
      relation.confidence = '1.000000';
      relation.reviewRequired = false;
      relation.reviewDecision = RelationReviewDecision.CONFIRMED;
      relation.reviewedByAdminId = adminId;
      relation.reviewedAt = confirmedAt;
    } else {
      relation.reviewRequired = true;
      relation.reviewDecision = RelationReviewDecision.PENDING;
      await this.createRemainingPlanExecutionReview(
        manager,
        relation,
        remaining.map((match) => match.id),
      );
    }
    await relationRepository.save(relation);
  }

  private async createRemainingPlanExecutionReview(
    manager: EntityManager,
    relation: FilingRelationEntity,
    remainingMatchIds: string[],
  ): Promise<void> {
    const candidateSet = [...remainingMatchIds].sort().join(',');
    const dedupeKey = `plan-execution:${relation.id}:remaining:${sha256(candidateSet).slice(0, 24)}`;
    const repository = manager.getRepository(ReviewEntity);
    if (
      await repository.findOneBy({
        subjectType: 'FILING_RELATION',
        subjectId: relation.id,
        dedupeKey,
      })
    )
      return;
    await repository.save(
      repository.create({
        subjectType: 'FILING_RELATION',
        subjectId: relation.id,
        dedupeKey,
        reason:
          '일부 실행 후보를 확정했지만 서로 다른 실제 거래 후보가 남아 추가 검토가 필요합니다.',
        status: ReviewTaskStatus.OPEN,
        classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
        resolution: null,
        resolvedByAdminId: null,
        resolvedAt: null,
      }),
    );
  }

  private async rejectRelationCandidate(
    manager: EntityManager,
    review: ReviewEntity,
    adminId: string,
    reviewedAt: Date,
    resolution: 'UNKNOWN' | 'DUPLICATE',
    selectedMatchId?: string,
  ): Promise<void> {
    if (review.subjectType !== 'FILING_RELATION') return;
    const relationRepository = manager.getRepository(FilingRelationEntity);
    const relation = await relationRepository
      .createQueryBuilder('relation')
      .setLock('pessimistic_write')
      .where('relation.id = :id', { id: review.subjectId })
      .getOne();
    if (!relation) throw new NotFoundException('검토할 공시 연결 후보를 찾을 수 없습니다.');
    const decision =
      resolution === 'DUPLICATE' ? RelationReviewDecision.REJECTED : RelationReviewDecision.UNKNOWN;

    if (relation.relationType === FilingRelationType.EXECUTION_CANDIDATE) {
      const filings = await manager.getRepository(FilingEntity).findBy({
        id: In([relation.fromFilingId, relation.toFilingId]),
      });
      const execution = filings.find(
        (filing) => filing.id === relation.fromFilingId && filing.detailType === 'D002',
      );
      const planFiling = filings.find(
        (filing) => filing.id === relation.toFilingId && filing.detailType === 'D005',
      );
      if (!execution || !planFiling) {
        throw new BadRequestException('실행 후보 공시의 D002-D005 방향이 올바르지 않습니다.');
      }
      const reports = await manager
        .getRepository(InsiderReportEntity)
        .findBy({ filingId: execution.id });
      const plans = await manager
        .getRepository(TradePlanEntity)
        .findBy({ filingId: planFiling.id });
      const transactions = reports.length
        ? await manager.getRepository(InsiderTransactionEntity).findBy({
            insiderReportId: In(reports.map((report) => report.id)),
          })
        : [];
      const planItems = plans.length
        ? await manager.getRepository(TradePlanItemEntity).findBy({
            tradePlanId: In(plans.map((plan) => plan.id)),
          })
        : [];
      const pendingMatches =
        transactions.length && planItems.length
          ? await manager.getRepository(PlanExecutionMatchEntity).find({
              where: {
                insiderTransactionId: In(transactions.map((transaction) => transaction.id)),
                tradePlanItemId: In(planItems.map((item) => item.id)),
                relationType: FilingRelationType.EXECUTION_CANDIDATE,
                reviewDecision: RelationReviewDecision.PENDING,
              },
            })
          : [];
      const targets = selectedMatchId
        ? pendingMatches.filter((match) => match.id === selectedMatchId)
        : pendingMatches;
      if (selectedMatchId && targets.length === 0) {
        throw new BadRequestException('선택한 실행 후보가 현재 검토 대상에 포함되지 않습니다.');
      }
      for (const target of targets) {
        target.reviewDecision = decision;
        target.reviewedByAdminId = adminId;
        target.reviewedAt = reviewedAt;
      }
      if (targets.length) await manager.getRepository(PlanExecutionMatchEntity).save(targets);
      const rejectedIds = new Set(targets.map((target) => target.id));
      const remaining = pendingMatches.filter((match) => !rejectedIds.has(match.id));
      if (remaining.length) {
        relation.reviewRequired = true;
        relation.reviewDecision = RelationReviewDecision.PENDING;
        await this.createRemainingPlanExecutionReview(
          manager,
          relation,
          remaining.map((match) => match.id),
        );
      } else {
        relation.reviewRequired = false;
        const confirmedCount = await manager.getRepository(PlanExecutionMatchEntity).count({
          where: {
            insiderTransactionId: In(transactions.map((transaction) => transaction.id)),
            tradePlanItemId: In(planItems.map((item) => item.id)),
            relationType: FilingRelationType.FULFILLS_PLAN,
            reviewDecision: RelationReviewDecision.CONFIRMED,
          },
        });
        if (confirmedCount > 0) {
          relation.relationType = FilingRelationType.FULFILLS_PLAN;
          relation.reviewDecision = RelationReviewDecision.CONFIRMED;
          relation.source = RelationSource.MANUAL;
        } else {
          relation.reviewDecision = decision;
        }
        relation.reviewedByAdminId = adminId;
        relation.reviewedAt = reviewedAt;
      }
      await relationRepository.save(relation);
      return;
    }

    relation.reviewRequired = false;
    relation.reviewDecision = decision;
    relation.reviewedByAdminId = adminId;
    relation.reviewedAt = reviewedAt;
    await relationRepository.save(relation);
  }

  private async findByIds<T extends ObjectLiteral & { id: string }>(
    entity: EntityTarget<T>,
    ids: string[],
  ): Promise<T[]> {
    const unique = [...new Set(ids)];
    return unique.length
      ? this.source()
          .getRepository(entity)
          .findBy({ id: In(unique) } as unknown as FindOptionsWhere<T>)
      : [];
  }

  private async activeParseRuns(filings: FilingEntity[]): Promise<Map<string, ParseRunEntity>> {
    const rows = await this.findByIds(
      ParseRunEntity,
      filings.flatMap((filing) => (filing.activeParseRunId ? [filing.activeParseRunId] : [])),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const active = new Map<string, ParseRunEntity>();
    for (const filing of filings) {
      const parse = filing.activeParseRunId ? byId.get(filing.activeParseRunId) : undefined;
      if (parse?.filingId === filing.id && this.isValidActiveParse(filing, parse))
        active.set(filing.id, parse);
    }
    return active;
  }

  private async mapEvents(
    rows: EventClusterEntity[],
    audience: NewsAudience = 'MEMBER_UI',
  ): Promise<Event[]> {
    if (!rows.length) return [];
    const memberships = await this.source()
      .getRepository(EventClusterItemEntity)
      .findBy({ eventClusterId: In(rows.map((row) => row.id)) });
    const byEvent = groupRows(memberships, (item) => item.eventClusterId);
    const filings = await this.findByIds(
      FilingEntity,
      rows.flatMap((row) => {
        const membership = byEvent.get(row.id)?.find((item) => item.itemType === 'FILING');
        return membership ? [membership.itemId] : [];
      }),
    );
    const [companies, sources, active] = await Promise.all([
      this.findByIds(CompanyEntity, [
        ...rows.flatMap((row) => (row.companyId ? [row.companyId] : [])),
        ...filings.map((filing) => filing.companyId),
      ]),
      this.findByIds(
        SourceItemEntity,
        memberships.filter((item) => item.itemType === 'SOURCE_ITEM').map((item) => item.itemId),
      ),
      this.activeParseRuns(filings),
    ]);
    await verifyManualNewsSources(this.source(), sources);
    const companyById = new Map(companies.map((row) => [row.id, row]));
    const filingById = new Map(filings.map((row) => [row.id, row]));
    const sourceById = new Map(sources.map((row) => [row.id, row]));
    return rows.map((row) => {
      const links = byEvent.get(row.id) ?? [];
      const filingLink = links.find((item) => item.itemType === 'FILING');
      const filingRow = filingLink ? (filingById.get(filingLink.itemId) ?? null) : null;
      const parse = filingRow ? (active.get(filingRow.id) ?? null) : null;
      const filingCompany = filingRow ? companyById.get(filingRow.companyId) : undefined;
      if (filingRow && !filingCompany)
        throw new Error(`Company ${filingRow.companyId} is missing for filing ${filingRow.id}`);
      const sourceItems: SourceItem[] = [];
      for (const link of links) {
        if (link.itemType !== 'SOURCE_ITEM') continue;
        const source = sourceById.get(link.itemId);
        if (
          source &&
          sourcePolicyAllowsDisplay(
            source,
            ['OFFICIAL_DISCLOSURE', 'OFFICIAL_RELEASE', 'COMPANY_IR'],
            undefined,
            audience,
          )
        ) {
          sourceItems.push(mapSourceItem(source));
        }
      }
      return this.eventFromRelations(
        row,
        row.companyId ? (companyById.get(row.companyId) ?? null) : null,
        filingRow,
        filingRow && filingCompany ? this.filingSummary(filingRow, filingCompany, parse) : null,
        parse,
        sourceItems,
      );
    });
  }

  private async companySummaryViews(companies: Company[]): Promise<CompanySummaryView[]> {
    if (!companies.length) return [];
    const ids = companies.map((company) => company.id);
    if (this.fixtureMode) {
      const priorities = new Map(
        this.fixtures.watchlist.map((watch) => [watch.company.id, watch.priority]),
      );
      const latest = new Map<string, string>();
      for (const event of this.fixtures.events) {
        if (!event.company) continue;
        if (
          !latest.has(event.company.id) ||
          latest.get(event.company.id)! < event.firstObservedAt
        ) {
          latest.set(event.company.id, event.firstObservedAt);
        }
      }
      return companies.map((company) =>
        this.companySummary(company, priorities.get(company.id), latest.get(company.id) ?? null),
      );
    }
    const [watches, latest] = await Promise.all([
      this.source()
        .getRepository(MarketLeaderScopeEntity)
        .find({
          select: { companyId: true, priority: true },
          where: { companyId: In(ids) },
        }),
      this.source()
        .getRepository(EventClusterEntity)
        .createQueryBuilder('event')
        .select('event.companyId', 'companyId')
        .addSelect(
          "DATE_FORMAT(MAX(event.firstObservedAt), '%Y-%m-%dT%H:%i:%s.%fZ')",
          'lastEventAt',
        )
        .where('event.companyId IN (:...companyIds)', { companyIds: ids })
        .andWhere(supportedEventFilingsSql)
        .andWhere(eventAudienceSql('event'))
        .groupBy('event.companyId')
        .getRawMany<{ companyId: string; lastEventAt: string }>(),
    ]);
    const priorities = new Map(watches.map((row) => [row.companyId, row.priority]));
    const latestById = new Map(
      latest.map((row) => [row.companyId, new Date(row.lastEventAt).toISOString()]),
    );
    return companies.map((company) =>
      this.companySummary(company, priorities.get(company.id), latestById.get(company.id) ?? null),
    );
  }

  private async eventSummaryViews(events: Event[]): Promise<EventSummaryView[]> {
    if (!events.length) return [];
    if (this.fixtureMode) return Promise.all(events.map((event) => this.eventSummaryView(event)));
    const companyIds = [
      ...new Set(
        events.flatMap((event) => {
          const company = event.company ?? event.filing?.company;
          return company ? [company.id] : [];
        }),
      ),
    ];
    const [filings, watches, sources] = await Promise.all([
      this.findByIds(
        FilingEntity,
        events.flatMap((event) => (event.filing ? [event.filing.id] : [])),
      ),
      companyIds.length
        ? this.source()
            .getRepository(MarketLeaderScopeEntity)
            .find({
              select: { companyId: true, priority: true },
              where: { companyId: In(companyIds) },
            })
        : [],
      this.findByIds(
        SourceItemEntity,
        events.flatMap((event) => {
          const sec = event.sourceItems.find((source) => source.source === 'SEC');
          return sec ? [sec.id] : [];
        }),
      ),
    ]);
    const active = await this.activeParseRuns(filings);
    const filingIds = (type: string) =>
      filings
        .filter((filing) => active.get(filing.id)?.resultType === type)
        .map((filing) => filing.id);
    const insiderIds = filingIds('D002');
    const holderIds = filingIds('D001');
    const planIds = filingIds('D005');
    const [reporters, holders, plans] = await Promise.all([
      insiderIds.length
        ? this.source()
            .getRepository(InsiderReportEntity)
            .find({ where: { filingId: In(insiderIds) }, order: { createdAt: 'ASC' } })
        : [],
      holderIds.length
        ? this.source()
            .getRepository(LargeHolderReportEntity)
            .find({ where: { filingId: In(holderIds) }, order: { createdAt: 'ASC' } })
        : [],
      planIds.length
        ? this.source()
            .getRepository(TradePlanEntity)
            .find({ where: { filingId: In(planIds) }, order: { createdAt: 'ASC' } })
        : [],
    ]);
    const firstReporters = firstRows(reporters, (row) => row.filingId);
    const firstHolders = firstRows(holders, (row) => row.filingId);
    const firstPlans = firstRows(plans, (row) => row.filingId);
    const [transactions, changes] = await Promise.all([
      firstReporters.size
        ? this.source()
            .getRepository(InsiderTransactionEntity)
            .find({
              select: { insiderReportId: true, nature: true, direction: true, eventDate: true },
              where: { insiderReportId: In([...firstReporters.values()].map((row) => row.id)) },
              order: { eventDate: 'ASC' },
            })
        : [],
      firstHolders.size
        ? this.source()
            .getRepository(LargeHoldingChangeEntity)
            .find({
              where: { largeHolderReportId: In([...firstHolders.values()].map((row) => row.id)) },
              order: { eventDate: 'ASC', id: 'ASC' },
            })
        : [],
    ]);
    const firstTransactions = firstRows(transactions, (row) => row.insiderReportId);
    const changesByHolder = groupRows(changes, (row) => row.largeHolderReportId);
    const filingById = new Map(filings.map((row) => [row.id, row]));
    const priorities = new Map(watches.map((row) => [row.companyId, row.priority]));
    const sourcesById = new Map(sources.map((row) => [row.id, row]));
    return events.map((event) => {
      let facts: EventFilingFacts | null = null;
      if (event.filing) {
        if (!filingById.has(event.filing.id))
          throw new NotFoundException('공시를 찾을 수 없습니다.');
        facts = { ...event.filing };
        const reporter = firstReporters.get(event.filing.id);
        const transaction = reporter ? firstTransactions.get(reporter.id) : undefined;
        facts.transactions = transaction ? [transaction] : [];
        facts.tradePlan = firstPlans.get(event.filing.id) ?? null;
        const holder = firstHolders.get(event.filing.id);
        if (holder) {
          const reason = holder.rawJson?.reportReasonKind;
          facts.largeHolding = largeHoldingSchema.parse({
            ...holder,
            reportReasonKind:
              typeof reason === 'string' &&
              ['HOLDINGS_CHANGE', 'CONTRACT_CHANGE', 'REPORTING_STATUS_CHANGE'].includes(reason)
                ? reason
                : 'UNKNOWN',
            changes: changesByHolder.get(holder.id) ?? [],
          });
        }
      }
      const company = event.company ?? facts?.company;
      const sec = event.sourceItems.find((source) => source.source === 'SEC');
      return this.eventSummary(
        event,
        facts,
        company ? priorities.get(company.id) : undefined,
        sec ? (sourcesById.get(sec.id) ?? null) : null,
      );
    });
  }

  private async companySummaryView(company: Company): Promise<CompanySummaryView> {
    const watch = await this.watchForCompany(company.id);
    const latest = (await this.listEvents({ companyId: company.id, limit: 1 })).items[0] ?? null;
    return this.companySummary(company, watch?.priority, latest?.firstObservedAt ?? null);
  }

  private companySummary(
    company: Company,
    priority: WatchlistItem['priority'] | undefined,
    lastEventAt: string | null,
  ): CompanySummaryView {
    return {
      id: company.id,
      nameKo: company.nameKo,
      nameEn: company.nameEn,
      stockCode: company.stockCode,
      ticker: company.ticker,
      market: company.market,
      sector: '미분류',
      priority: priority ?? null,
      isListed: company.isListed,
      isWatchlisted: priority !== undefined,
      lastEventAt,
    };
  }

  private async eventSummaryView(event: Event): Promise<EventSummaryView> {
    const filing = event.filing ? await this.getFiling(event.filing.id) : null;
    const company = event.company ?? filing?.company ?? null;
    const watch = company ? await this.watchForCompany(company.id) : null;
    const secSource = event.sourceItems.find((item) => item.source === 'SEC');
    const secRow =
      secSource && !this.fixtureMode
        ? await this.source().getRepository(SourceItemEntity).findOneBy({ id: secSource.id })
        : null;
    return this.eventSummary(event, filing, watch?.priority, secRow);
  }

  private eventSummary(
    event: Event,
    filing: EventFilingFacts | null,
    priority: WatchlistItem['priority'] | undefined,
    secRow: SourceItemEntity | null,
  ): EventSummaryView {
    const transaction = filing?.transactions?.[0] ?? null;
    const holdingChange = filing?.largeHolding?.changes[0] ?? null;
    const company = event.company ?? filing?.company ?? null;
    const secSource = event.sourceItems.find((item) => item.source === 'SEC');
    const source = secSource ?? event.sourceItems[0] ?? null;
    const secFilingDate = secRow?.rawMetadataJson?.filingDate;
    const secForm = secRow?.rawMetadataJson?.form;
    const detailType: EventSummaryView['detailType'] =
      filing?.detailType ?? (secSource ? 'SEC' : 'NEWS');
    return {
      id: event.id,
      companyId: company?.id ?? 'unresolved',
      companyName: company?.nameKo ?? '회사 미확인',
      stockCode: company?.stockCode ?? null,
      ticker: company?.ticker ?? null,
      market: company?.market ?? 'OTHER',
      priority: priority ?? (filing || secSource ? 'P3' : 'P4'),
      detailType,
      title: filing?.reportName ?? source?.title ?? event.canonicalEventType,
      translation: !filing && detailType === 'NEWS' ? (source?.translation ?? null) : null,
      summary: event.summary,
      nature: transaction?.nature ?? (filing?.detailType === 'D005' ? 'UNKNOWN' : null),
      direction: transaction?.direction ?? holdingChange?.direction ?? 'UNKNOWN',
      eventAt: secSource
        ? null
        : (transaction?.eventDate ??
          holdingChange?.eventDate ??
          filing?.tradePlan?.plannedStartDate ??
          kstDateFromInstant(event.occurredAt) ??
          null),
      rceptDate:
        filing?.rceptDate ??
        (typeof secFilingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(secFilingDate)
          ? secFilingDate
          : null),
      publishedAt: event.publishedAt,
      firstObservedAt: event.firstObservedAt,
      processedAt: event.processedAt,
      submissionKind:
        filing?.submissionKind ??
        (typeof secForm === 'string' && secForm.endsWith('/A') ? 'CORRECTION' : 'INITIAL'),
      effectiveState: filing?.effectiveState ?? 'ACTIVE',
      evidenceGrade: event.evidenceGrade,
      classificationStatus: event.classificationResult ?? 'REVIEW_REQUIRED',
      sourceName: filing
        ? 'OpenDART'
        : (source?.sourceName ?? source?.source ?? '공식 소스 확인 대기'),
      rightsMode: filing
        ? RightsMode.OFFICIAL_PUBLIC_DATA
        : (source?.rightsMode ?? RightsMode.LINK_ONLY),
      officialUrl: filing?.officialUrl ?? source?.url ?? 'https://opendart.fss.or.kr/',
    };
  }

  private async mapFilingSummary(row: FilingEntity): Promise<FilingSummary> {
    const source = this.source();
    const company = await source.getRepository(CompanyEntity).findOneBy({ id: row.companyId });
    if (!company) throw new Error(`Company ${row.companyId} is missing for filing ${row.id}`);
    const parse = await this.activeParseRun(row);
    return this.filingSummary(row, company, parse);
  }

  private filingSummary(
    row: FilingEntity,
    company: CompanyEntity,
    parse: ParseRunEntity | null,
  ): FilingSummary {
    return {
      id: row.id,
      rceptNo: row.rceptNo,
      detailType: isSupportedFilingType(row.canonicalType) ? row.canonicalType : row.detailType,
      reportName: row.reportName,
      filerName: row.filerName,
      rceptDate: row.rceptDate,
      submissionKind: row.submissionKind,
      effectiveState: row.effectiveState,
      firstObservedAt: row.firstObservedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      processedAt: dateToIso(parse?.finishedAt),
      parseStatus: parse?.status ?? null,
      parserConfidence: parse?.confidence ? Number(parse.confidence) : null,
      company: mapCompany(company),
      officialUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(row.rceptNo)}`,
    };
  }

  private async mapEvent(
    row: EventClusterEntity,
    audience: NewsAudience = 'MEMBER_UI',
  ): Promise<Event> {
    const source = this.source();
    const company = row.companyId
      ? await source.getRepository(CompanyEntity).findOneBy({ id: row.companyId })
      : null;
    const memberships = await source
      .getRepository(EventClusterItemEntity)
      .findBy({ eventClusterId: row.id });
    const filingMembership = memberships.find((item) => item.itemType === 'FILING');
    const sourceMemberships = memberships.filter((item) => item.itemType === 'SOURCE_ITEM');
    const filingRow = filingMembership
      ? await source.getRepository(FilingEntity).findOneBy({ id: filingMembership.itemId })
      : null;
    const filing = filingRow ? await this.mapFilingSummary(filingRow) : null;
    const parse = filingRow ? await this.activeParseRun(filingRow) : null;
    const sourceRows = sourceMemberships.length
      ? await source
          .getRepository(SourceItemEntity)
          .findBy({ id: In(sourceMemberships.map((item) => item.itemId)) })
      : [];
    await verifyManualNewsSources(source, sourceRows);
    const sourcesById = new Map(sourceRows.map((item) => [item.id, item]));
    const sourceItems = sourceMemberships.map((item) => {
      const sourceRow = sourcesById.get(item.itemId);
      return sourceRow &&
        sourcePolicyAllowsDisplay(
          sourceRow,
          ['OFFICIAL_DISCLOSURE', 'OFFICIAL_RELEASE', 'COMPANY_IR'],
          undefined,
          audience,
        )
        ? mapSourceItem(sourceRow)
        : null;
    });
    return this.eventFromRelations(
      row,
      company,
      filingRow,
      filing,
      parse,
      sourceItems.filter((item): item is SourceItem => item !== null),
    );
  }

  private eventFromRelations(
    row: EventClusterEntity,
    company: CompanyEntity | null,
    filingRow: FilingEntity | null,
    filing: FilingSummary | null,
    parse: ParseRunEntity | null,
    sourceItems: SourceItem[],
  ): Event {
    const canonicalEventTypes = {
      D001: 'LARGE_HOLDER',
      D002: 'INSIDER_OWNERSHIP',
      D003: 'PROXY_SOLICITATION',
      D004: 'TENDER_OFFER',
      D005: 'TRADE_PLAN',
    } as const;
    const requiresParseReview = Boolean(filingRow && !parse);
    return {
      id: row.id,
      canonicalEventType: filingRow
        ? isSupportedFilingType(filingRow.canonicalType)
          ? canonicalEventTypes[filingRow.canonicalType]
          : 'OTHER'
        : row.canonicalEventType,
      occurredAt: dateToIso(row.occurredAt),
      publishedAt: dateToIso(row.publishedAt),
      firstObservedAt: row.firstObservedAt.toISOString(),
      processedAt: dateToIso(row.processedAt),
      state:
        requiresParseReview &&
        row.state !== EventState.CANCELLED &&
        row.state !== EventState.SUPERSEDED
          ? EventState.REVIEW_REQUIRED
          : row.state,
      evidenceGrade: row.evidenceGrade,
      classificationResult: parse?.classificationResult ?? null,
      summary: requiresParseReview ? `원문 검증 대기 — ${filingRow!.reportName}` : row.summary,
      company: company ? mapCompany(company) : null,
      filing,
      sourceItems,
    };
  }

  private async activeParseRun(filing: FilingEntity): Promise<ParseRunEntity | null> {
    const repository = this.source().getRepository(ParseRunEntity);
    if (filing.activeParseRunId) {
      const active = await repository.findOneBy({
        id: filing.activeParseRunId,
        filingId: filing.id,
      });
      if (active) return this.isValidActiveParse(filing, active) ? active : null;
    }
    // A newer shadow or failed run must never become active merely by being latest.
    return null;
  }

  private isValidActiveParse(filing: FilingEntity, parse: ParseRunEntity): boolean {
    const parsed = parse.resultJson?.parsed as Record<string, unknown> | undefined;
    const parsedType = typeof parsed?.detailType === 'string' ? parsed.detailType : null;
    return (
      (parse.status === ParseStatus.SUCCEEDED || parse.status === ParseStatus.PARTIAL) &&
      parse.resultJson?.projectionApplied === true &&
      parse.validationStatus === 'PASSED' &&
      parse.resultType === parsedType &&
      (!['D003', 'D004'].includes(parse.resultType ?? '') ||
        (hasConfirmedSourceReview(parse) &&
          parsedSourceMatchesRun(parse, parsed) &&
          parsedDocumentKindMatchesFiling(filing, parsed))) &&
      hasParseTypeInvariant({
        canonicalType: filing.canonicalType,
        classificationStatus: filing.classificationStatus,
        inputType: parse.inputType,
        extractorType: parse.extractorType,
        resultType: parsedType,
      })
    );
  }

  private async mapWatchlist(row: WatchlistItemEntity, company?: Company): Promise<WatchlistItem> {
    return {
      id: row.id,
      company: company ?? (await this.getCompany(row.companyId)),
      priority: row.priority,
      realtimeAlerts: row.realtimeAlerts,
      digestAlerts: row.digestAlerts,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function groupRows<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const items = grouped.get(id) ?? [];
    items.push(row);
    grouped.set(id, items);
  }
  return grouped;
}

function firstRows<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const first = new Map<string, T>();
  for (const row of rows) if (!first.has(key(row))) first.set(key(row), row);
  return first;
}

function kstDateFromInstant(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);
}

function percentageReturn(before: number | undefined, after: number | undefined): number | null {
  if (before === undefined || after === undefined || before === 0) return null;
  return ((after - before) / before) * 100;
}

function timelineReturnWindows(
  prices: readonly { time: string; close: number }[],
  markerDate: string,
): { pre1d: number | null; post1d: number | null; post5d: number | null; post20d: number | null } {
  const index = prices.findIndex((price) => price.time >= markerDate);
  if (index < 0) return { pre1d: null, post1d: null, post5d: null, post20d: null };
  const base = prices[index]?.close;
  return {
    pre1d: percentageReturn(prices[index - 1]?.close, base),
    post1d: percentageReturn(base, prices[index + 1]?.close),
    post5d: percentageReturn(base, prices[index + 5]?.close),
    post20d: percentageReturn(base, prices[index + 20]?.close),
  };
}

function priceSourceMetadata(source: CandleSource, rightsMode: RightsMode) {
  return {
    source,
    sourceName: '토스증권 Open API',
    rightsMode,
    feed: 'REST 캔들',
    adjustment: 'RAW',
    attribution: '출처: 토스증권 Open API',
    limitation:
      '비조정 가격입니다. 개인 화면에만 표시하며, 실시간 체결과 캔들의 집계 범위는 다를 수 있습니다.',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decimalMagnitudeToScaledBigInt(value: string | null): bigint {
  if (!value) throw new BadRequestException('수량 값이 없어 계획 실행을 확정할 수 없습니다.');
  const match = /^([+-]?)(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new BadRequestException('수량 값의 정밀도가 올바르지 않습니다.');
  const whole = BigInt(match[2]!);
  const fraction = BigInt((match[3] ?? '').padEnd(6, '0'));
  return whole * 1_000_000n + fraction;
}

interface QueueRow extends ObjectLiteral {
  id: string;
  status: string;
  availableAt: Date;
}

async function queueMetric(
  source: DataSource,
  entity: EntityTarget<QueueRow>,
  name: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const activeStatus =
    entity === JobOutboxEntity ? ProcessingStatus.PROCESSING : AlertStatus.SENDING;
  const result = await source
    .getRepository(entity)
    .createQueryBuilder('item')
    .select(
      'SUM(CASE WHEN item.status = :pending AND item.availableAt <= :now THEN 1 ELSE 0 END)',
      'waiting',
    )
    .addSelect('SUM(CASE WHEN item.status = :active THEN 1 ELSE 0 END)', 'active')
    .addSelect(
      'SUM(CASE WHEN item.status = :pending AND item.availableAt > :now THEN 1 ELSE 0 END)',
      'delayed',
    )
    .addSelect('SUM(CASE WHEN item.status = :failed THEN 1 ELSE 0 END)', 'failed')
    .addSelect(
      'MIN(CASE WHEN item.status = :pending AND item.availableAt <= :now THEN item.availableAt ELSE NULL END)',
      'oldestWaitingAt',
    )
    .setParameters({ pending: 'PENDING', active: activeStatus, failed: 'FAILED', now })
    .getRawOne<{
      waiting: string | null;
      active: string | null;
      delayed: string | null;
      failed: string | null;
      oldestWaitingAt: Date | string | null;
    }>();
  const oldest = result?.oldestWaitingAt;
  return {
    id: name,
    name,
    waiting: Number(result?.waiting ?? 0),
    active: Number(result?.active ?? 0),
    delayed: Number(result?.delayed ?? 0),
    failed: Number(result?.failed ?? 0),
    oldestWaitingAt:
      oldest instanceof Date
        ? oldest.toISOString()
        : oldest
          ? new Date(oldest).toISOString()
          : null,
  };
}
