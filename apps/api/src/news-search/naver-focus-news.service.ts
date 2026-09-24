import { publicSourceUrl } from '../common/news-url';
import { createHash } from 'node:crypto';
import {
  type SourceItem,
  RightsMode,
  NewsContentState,
  matchesRegion,
  createNewsCompanyMatcher,
  newsBadgeCompanyAliases,
  newsCompanyIdsSchema,
  isAmbiguousNewsCompanyName,
} from '@orsem/contracts';
import { activeActorSql } from '../watchlist-groups/watchlist-access.service';
import { MARKET_LEADER_COMPANIES_SQL } from '@orsem/database';
import {
  HttpException,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { NaverNewsSearchService, type NaverNewsSearchResult } from './naver-news-search.service';
import { parseWith } from '../common/zod';

export const NAVER_FOCUS_INTERVAL_MS = 15 * 60_000;
type FocusCompany = {
  id: string;
  name: string;
  nameKo?: string;
  nameEn?: string | null;
  market?: string;
  stockCode?: string | null;
  ticker?: string | null;
  isListed?: boolean | number | string;
  region?: 'kr' | 'us' | 'global';
  kind?: 'MARKET' | 'ASSET';
};
export const NAVER_NEWS_TOPICS = [
  { id: 'topic:kr-equities', name: '국내 증시', region: 'kr', kind: 'MARKET' },
  { id: 'topic:kr-rates', name: '한국은행 기준금리', region: 'kr', kind: 'MARKET' },
  { id: 'topic:kr-fx', name: '원달러 환율', region: 'kr', kind: 'MARKET' },
  { id: 'topic:us-equities', name: '미국 증시', region: 'us', kind: 'MARKET' },
  { id: 'topic:us-rates', name: '미국 연준 금리', region: 'us', kind: 'MARKET' },
  { id: 'topic:us-economy', name: '미국 경제', region: 'us', kind: 'MARKET' },
  { id: 'topic:gold', name: '국제 금값', region: 'global', kind: 'ASSET' },
  { id: 'topic:silver', name: '국제 은값', region: 'global', kind: 'ASSET' },
  { id: 'topic:wti', name: 'WTI 유가', region: 'global', kind: 'ASSET' },
  { id: 'topic:btc', name: '비트코인', region: 'global', kind: 'ASSET' },
  { id: 'topic:eth', name: '이더리움', region: 'global', kind: 'ASSET' },
] as const;
export interface NaverProviderResultSet {
  queryId: string;
  queryLabel: string;
  region: 'kr' | 'us' | 'global';
  kind: 'COMPANY' | 'MARKET' | 'ASSET';
  fetchedAt: string | null;
  expiresAt: string | null;
  status: 'AVAILABLE' | 'UNCONFIGURED' | 'LIMIT_REACHED' | 'PAUSED' | 'UNAVAILABLE' | 'PENDING';
  reason: string | null;
  items: NaverNewsSearchResult['items'];
  total: number | null;
  start: number | null;
  display: number | null;
  lastBuildDate: string | null;
}
const targetRegion = (company: FocusCompany): NaverProviderResultSet['region'] =>
  company.region ??
  (['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(company.market ?? '') ? 'kr' : 'us');
export function naverCompanySearchTerm(company: FocusCompany): string | null {
  const names = [company.nameKo ?? company.name, company.nameEn];
  for (const name of names) {
    const value = name?.normalize('NFKC').trim();
    if (value && value.length <= 120 && !isAmbiguousNewsCompanyName(value)) return value;
  }
  if (
    ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(company.market ?? '') &&
    /^[0-9A-Z]{6}$/u.test(company.stockCode ?? '')
  )
    return `KRX:${company.stockCode}`;
  if (
    ['NASDAQ', 'NYSE', 'AMEX'].includes(company.market ?? '') &&
    /^[A-Z][A-Z0-9.-]{0,14}$/u.test(company.ticker ?? '')
  )
    return `${company.market}:${company.ticker}`;
  return null;
}
const plainEvidence = (value: string) =>
  value
    .replace(/<[^>]*>/gu, '')
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/giu, (entity) => {
      const named: Record<string, string> = {
        '&amp;': '&',
        '&quot;': '"',
        '&apos;': "'",
        '&lt;': '<',
        '&gt;': '>',
        '&nbsp;': ' ',
      };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
      const number =
        entity[2]?.toLowerCase() === 'x'
          ? parseInt(entity.slice(3, -1), 16)
          : parseInt(entity.slice(2, -1), 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
    });
type Snapshot = {
  result: NaverNewsSearchResult;
  queryLabel: string;
  fetchedAt: string;
  expiresAt: number;
};

/** Short-lived provider diagnostics; searchable metadata is persisted by the search service. */
@Injectable()
export class NaverFocusNewsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly nextAttempt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | null = null;
  private stopped = false;
  private companyCursor = 0;
  private topicCursor = 0;
  private companyTurn = true;
  private failure: string | null = null;
  private sharedFailure: string | null = null;
  private readonly targetFailures = new Map<string, string>();
  private readonly targetIds = new Set<string>(NAVER_NEWS_TOPICS.map((topic) => topic.id));
  private lastSuccessAt: string | null = null;
  private lastAttemptAt: string | null = null;
  private companyIndex: {
    expiresAt: number;
    companies: FocusCompany[];
    match: (text: string) => string[];
  } | null = null;
  private async relevanceIndex() {
    if (this.companyIndex && this.companyIndex.expiresAt > Date.now()) return this.companyIndex;
    const db = this.database.requireDataSource();
    const companies: FocusCompany[] = await db.query(
      `SELECT id,name_ko name,name_ko nameKo,name_en nameEn,market,stock_code stockCode,ticker,is_listed isListed
       FROM companies WHERE is_listed=1 AND market IN ('KRX','KOSPI','KOSDAQ','KONEX','NASDAQ','NYSE','AMEX')`,
    );
    this.companyIndex = {
      companies,
      expiresAt: Date.now() + NAVER_FOCUS_INTERVAL_MS,
      match: createNewsCompanyMatcher(
        newsBadgeCompanyAliases(
          companies.map((c) => ({
            id: c.id,
            nameKo: c.nameKo ?? c.name,
            nameEn: c.nameEn ?? null,
            ticker: c.ticker ?? null,
            stockCode: c.stockCode ?? null,
            market: c.market,
            isListed: c.isListed,
          })),
        ),
      ),
    };
    return this.companyIndex;
  }
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
    private readonly search: NaverNewsSearchService,
  ) {}
  onApplicationBootstrap() {
    if (this.config.fixtureMode || !this.config.naverClientId || !this.config.naverClientSecret)
      return;
    this.timer = setInterval(() => void this.refresh(), NAVER_FOCUS_INTERVAL_MS);
    this.timer.unref();
    void this.refresh();
  }
  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    await this.running;
    await Promise.allSettled(this.inFlight.values());
    this.snapshots.clear();
    this.nextAttempt.clear();
    this.targetFailures.clear();
    this.companyIndex = null;
  }
  private scheduleExpiry() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.stopped || !this.snapshots.size) return;
    const next = Math.min(...[...this.snapshots.values()].map((snapshot) => snapshot.expiresAt));
    this.expiryTimer = setTimeout(
      () => {
        for (const [id, snapshot] of this.snapshots)
          if (snapshot.expiresAt <= Date.now()) this.snapshots.delete(id);
        this.scheduleExpiry();
      },
      Math.max(0, next - Date.now()),
    );
    this.expiryTimer.unref();
  }
  collectionStatus() {
    const available = [...this.snapshots].filter(([, snapshot]) => snapshot.expiresAt > Date.now());
    const availableIds = new Set(available.map(([id]) => id));
    const failedTargets = [...this.targetFailures.keys()].filter(
      (id) => this.targetIds.has(id) && !availableIds.has(id),
    ).length;
    return {
      lastSuccessAt: this.lastSuccessAt,
      lastAttemptAt: this.lastAttemptAt,
      availableTargets: available.length,
      pendingTargets: Math.max(0, this.targetIds.size - available.length - failedTargets),
      failedTargets,
      reason:
        this.sharedFailure ??
        this.failure ??
        (failedTargets
          ? '일부 검색 결과를 불러오지 못했습니다. 다음 주기에 다시 확인합니다.'
          : null),
    };
  }
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.collect()
      .catch(() => {
        // Do not expose provider content, search terms or credentials in logs.
        this.failure =
          '관심 종목 뉴스 정기 검색을 완료하지 못했습니다. 다음 주기에 다시 확인합니다.';
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async companies(): Promise<FocusCompany[]> {
    if (this.config.fixtureMode) return [];
    return this.database.requireDataSource().query(
      `SELECT DISTINCT c.id,c.name_ko name,c.name_ko nameKo,c.name_en nameEn,c.market,c.stock_code stockCode,c.ticker FROM companies c WHERE
        c.id IN (${MARKET_LEADER_COMPANIES_SQL})
        OR EXISTS (SELECT 1 FROM watchlist_group_items i JOIN watchlist_groups g ON g.id=i.group_id
          WHERE i.company_id=c.id AND g.room_id IS NULL AND ${activeActorSql('g.owner_key')}) ORDER BY c.id`,
    );
  }
  private async collect() {
    const now = Date.now();
    for (const [id, value] of this.snapshots) if (value.expiresAt <= now) this.snapshots.delete(id);
    if (this.stopped || this.config.fixtureMode) return;
    const status = await this.search.status();
    if (!status.automaticAllowed) return;
    const companies = await this.companies();
    this.targetIds.clear();
    for (const target of [...companies, ...NAVER_NEWS_TOPICS]) this.targetIds.add(target.id);
    this.failure = null;
    this.sharedFailure = null;

    // Round-robin cap leaves the existing shared free budget in control.
    const count = Math.min(
      companies.length + NAVER_NEWS_TOPICS.length,
      10,
      status.remainingToday ?? 0,
      status.remainingMonth ?? 0,
      'remainingWindow' in status ? (status.remainingWindow ?? 0) : 10,
    );
    const visited = new Set<string>();
    for (let index = 0; index < count && !this.stopped; index++) {
      // Alternate the two lanes, so a large watchlist cannot starve market/asset topics.
      const companyAvailable = companies.some((item) => !visited.has(item.id));
      const topicAvailable = NAVER_NEWS_TOPICS.some((item) => !visited.has(item.id));
      const useCompany = companyAvailable && (this.companyTurn || !topicAvailable);
      const lane: readonly FocusCompany[] = useCompany ? companies : NAVER_NEWS_TOPICS;
      let company: FocusCompany;
      do {
        company = lane[(useCompany ? this.companyCursor++ : this.topicCursor++) % lane.length]!;
      } while (visited.has(company.id));
      visited.add(company.id);
      this.companyTurn = !useCompany;
      await this.ensure(
        company,
        Math.min(
          24 * 60 * 60_000,
          Math.max(1, Math.ceil(lane.length / (companies.length ? 5 : 10))) *
            NAVER_FOCUS_INTERVAL_MS,
        ),
        true,
      );
      if (this.sharedFailure) break;
    }
  }
  private ensure(
    company: FocusCompany,
    ttl = NAVER_FOCUS_INTERVAL_MS,
    scheduled = false,
  ): Promise<void> {
    const pending = this.inFlight.get(company.id);
    if (pending) return pending;
    const now = Date.now();
    if (
      this.stopped ||
      (!scheduled && (this.snapshots.get(company.id)?.expiresAt ?? 0) > now) ||
      (this.nextAttempt.get(company.id) ?? 0) > now + (scheduled ? 5_000 : 0)
    )
      return Promise.resolve();
    const task = (async () => {
      const status = await this.search.status();
      if (!status.automaticAllowed || this.stopped) {
        this.sharedFailure = status.reason;
        return;
      }
      this.nextAttempt.set(company.id, Date.now() + NAVER_FOCUS_INTERVAL_MS);
      this.targetIds.add(company.id);
      const query = company.kind ? company.name : naverCompanySearchTerm(company);
      if (!query) {
        this.targetFailures.set(
          company.id,
          '명확한 회사명이나 종목코드를 확인하지 못해 검색을 보류했습니다.',
        );
        return;
      }
      try {
        const result = await this.search.search(
          { q: query, start: 1, sort: 'date' },
          () => {
            this.lastAttemptAt = new Date(Date.now()).toISOString();
            // The next request supersedes every cached occurrence of this query, even when
            // multiple share classes use the same registry name.
            for (const [id, snapshot] of this.snapshots)
              if (id === company.id || snapshot.queryLabel === query) this.snapshots.delete(id);
            this.scheduleExpiry();
          },
          {
            topicId: company.kind ? company.id : undefined,
            kind: company.kind,
            region: targetRegion(company),
          },
        );
        const fetched = Date.now();
        this.lastSuccessAt = new Date(fetched).toISOString();
        this.snapshots.set(company.id, {
          result,
          queryLabel: query,
          fetchedAt: new Date(fetched).toISOString(),
          expiresAt: fetched + ttl,
        });
        this.targetFailures.delete(company.id);
        this.sharedFailure = null;
      } catch (error) {
        const response = error instanceof HttpException ? error.getResponse() : null;
        const code =
          response && typeof response === 'object' && 'code' in response ? response.code : null;
        const shared =
          error instanceof HttpException &&
          (error.getStatus() === 429 ||
            ['NAVER_AUTH_INVALID', 'NAVER_ACCESS_DENIED', 'USAGE_UNAVAILABLE'].includes(
              String(code),
            ) ||
            String(code).startsWith('FREE_'));
        const reason =
          code === 'NAVER_AUTH_INVALID'
            ? '네이버 뉴스 검색 인증 키를 확인해 주세요.'
            : code === 'NAVER_ACCESS_DENIED'
              ? '네이버 뉴스 검색 API의 이용 권한을 확인해 주세요.'
              : shared
                ? '네이버 뉴스 검색의 사용량 또는 무료 이용 조건을 확인해 주세요.'
                : '네이버 뉴스를 잠시 불러오지 못했습니다.';
        this.targetFailures.set(company.id, reason);
        if (shared) this.sharedFailure = reason;
      }
      for (const [id, time] of this.nextAttempt) if (time < Date.now()) this.nextAttempt.delete(id);
      for (const [id, entry] of this.snapshots)
        if (entry.expiresAt <= Date.now()) this.snapshots.delete(id);
      while (this.snapshots.size > 1000) this.snapshots.delete(this.snapshots.keys().next().value!);
      while (this.targetFailures.size > 1000)
        this.targetFailures.delete(this.targetFailures.keys().next().value!);
      this.scheduleExpiry();
    })()
      .catch(() => {
        this.targetFailures.set(company.id, '네이버 연결 상태를 확인하지 못했습니다.');
      })
      .finally(() => this.inFlight.delete(company.id));
    this.inFlight.set(company.id, task);
    return task;
  }

  async feed(
    input: {
      companyId?: string;
      companyIds?: string[];
      scope?: string;
      asset?: 'gold' | 'silver' | 'wti' | 'btc' | 'eth';
      region?: 'all' | 'kr' | 'us';
    },
    actorKey: string,
  ) {
    if (input.companyIds !== undefined) parseWith(newsCompanyIdsSchema, input.companyIds);
    if (this.config.fixtureMode)
      return {
        groups: [] as SourceItem[][],
        resultSets: [] as NaverProviderResultSet[],
        providerStatus: null,
        fetchedAt: null,
        status: 'UNCONFIGURED',
        nextRequestAt: null,
        reason: null,
      };
    const db = this.database.requireDataSource();
    const base =
      'SELECT DISTINCT c.id,c.name_ko name,c.name_ko nameKo,c.name_en nameEn,c.market,c.stock_code stockCode,c.ticker FROM companies c WHERE ';
    const companies: FocusCompany[] =
      input.asset || input.scope === 'market'
        ? []
        : input.companyId
          ? await db.query(base + 'c.id=?', [input.companyId])
          : input.companyIds !== undefined
            ? input.companyIds.length
              ? await db.query(
                  base + `c.id IN (${input.companyIds.map(() => '?').join(',')})`,
                  input.companyIds,
                )
              : []
            : input.scope === 'personal'
              ? await db.query(
                  base +
                    'EXISTS (SELECT 1 FROM watchlist_group_items i JOIN watchlist_groups g ON g.id=i.group_id WHERE i.company_id=c.id AND g.room_id IS NULL AND g.owner_key=?)',
                  [actorKey],
                )
              : await db.query(base + `c.id IN (${MARKET_LEADER_COMPANIES_SQL})`);
    const selected = companies.filter(
      (c) =>
        !input.region ||
        input.region === 'all' ||
        matchesRegion(c.market as Parameters<typeof matchesRegion>[0], input.region),
    );
    const topics = NAVER_NEWS_TOPICS.filter(
      (topic) =>
        !input.region ||
        input.region === 'all' ||
        topic.region === 'global' ||
        topic.region === input.region,
    );
    const targets: FocusCompany[] = input.asset
      ? NAVER_NEWS_TOPICS.filter((topic) => topic.id === `topic:${input.asset}`)
      : input.scope === 'market'
        ? topics.filter((topic) => topic.kind === 'MARKET')
        : input.companyId ||
            input.companyIds !== undefined ||
            input.scope === 'personal' ||
            input.scope === 'company'
          ? selected
          : [...selected, ...topics];
    // Only opening a specific company can initiate an on-demand provider request.
    if (input.companyId && selected[0]) await this.ensure(selected[0]);
    const providerStatus = await this.search.status();
    if (!providerStatus.configured) this.snapshots.clear();
    const limitReached =
      providerStatus.remainingToday === 0 ||
      providerStatus.remainingMonth === 0 ||
      providerStatus.remainingWindow === 0;
    const resultSets: NaverProviderResultSet[] = targets.map((target) => {
      const cached = this.snapshots.get(target.id);
      const snapshot = cached && cached.expiresAt > Date.now() ? cached : undefined;
      const targetFailure = this.targetFailures.get(target.id);
      return {
        queryId: target.id,
        queryLabel:
          snapshot?.queryLabel ??
          (target.kind ? target.name : naverCompanySearchTerm(target)) ??
          target.name,
        region: targetRegion(target),
        kind: target.kind ?? 'COMPANY',
        fetchedAt: snapshot?.fetchedAt ?? null,
        expiresAt: snapshot ? new Date(snapshot.expiresAt).toISOString() : null,
        status: snapshot
          ? 'AVAILABLE'
          : !providerStatus.configured
            ? 'UNCONFIGURED'
            : !providerStatus.automaticAllowed
              ? limitReached
                ? 'LIMIT_REACHED'
                : 'PAUSED'
              : targetFailure || this.sharedFailure || this.failure
                ? 'UNAVAILABLE'
                : 'PENDING',
        reason: providerStatus.reason ?? targetFailure ?? this.sharedFailure ?? this.failure,
        // Provider sequence and exact strings are independent of optional relevance badges.
        items: snapshot?.result.items.map((item) => ({ ...item })) ?? [],
        total: snapshot?.result.total ?? null,
        start: snapshot?.result.start ?? null,
        display: snapshot?.result.display ?? null,
        lastBuildDate: snapshot?.result.lastBuildDate ?? null,
      };
    });
    const groups: SourceItem[][] = [];
    let fetchedAt: string | null = null;
    const relevance = await this.relevanceIndex();
    const selectedIds = new Set(selected.map((company) => company.id));
    for (const company of targets) {
      const snapshot = this.snapshots.get(company.id);
      if (!snapshot || snapshot.expiresAt <= Date.now()) continue;
      if (!fetchedAt || snapshot.fetchedAt > fetchedAt) fetchedAt = snapshot.fetchedAt;
      groups.push(
        snapshot.result.items.flatMap((item): SourceItem[] => {
          const original = publicSourceUrl(item.originallink) ?? publicSourceUrl(item.link);
          if (!original) return [];
          const url = new URL(original);
          const ids = relevance.match(
            `${plainEvidence(item.title)} ${plainEvidence(item.description)}`,
          );
          const related = relevance.companies.filter((candidate) => ids.includes(candidate.id));
          if (
            (input.companyId ||
              input.companyIds !== undefined ||
              input.scope === 'personal' ||
              input.scope === 'company') &&
            !related.some((candidate) => selectedIds.has(candidate.id))
          )
            return [];
          const hash = createHash('sha256').update(url.href).digest('hex');
          const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          return [
            {
              id,
              expiresAt: new Date(snapshot.expiresAt).toISOString(),
              collectedAt: snapshot.fetchedAt,
              providerOriginal: { ...item },
              source: 'NAVER',
              sourceName: '네이버 뉴스',
              externalId: item.link,
              url: url.href,
              title: item.title,
              description: item.description,
              author: null,
              publishedAt: Number.isFinite(Date.parse(item.pubDate))
                ? new Date(item.pubDate).toISOString()
                : null,
              firstObservedAt: snapshot.fetchedAt,
              processedAt: null,
              rightsMode: RightsMode.LINK_ONLY,
              provenanceUrl: publicSourceUrl(item.link),
              tickers: related.flatMap((c) =>
                [c.stockCode || c.ticker].filter((value): value is string => Boolean(value)),
              ),
              tags: [],
              contentState: NewsContentState.UNAVAILABLE,
              contentSourceId: null,
              contentLanguage: 'ko',
              translated: false,
              translationStatus: 'UNAVAILABLE',
              displayMode: 'EXTERNAL_LINK',
              marketRegion: targetRegion(company),
              relatedCompanies: related.map((c) => ({
                id: c.id,
                nameKo: c.nameKo ?? c.name,
                nameEn: c.nameEn ?? null,
                market: c.market as NonNullable<SourceItem['relatedCompanies']>[number]['market'],
                stockCode: c.stockCode ?? null,
                ticker: c.ticker ?? null,
              })),
            },
          ];
        }),
      );
    }
    const next = input.companyId ? this.nextAttempt.get(input.companyId) : null;
    const budgetNext = 'nextRequestAt' in providerStatus ? providerStatus.nextRequestAt : null;
    // A local retry delay cannot reopen an expired allowance or repair a usage-check failure.
    const nextAt =
      providerStatus.automaticAllowed || limitReached
        ? Math.max(next ?? 0, budgetNext ? Date.parse(budgetNext) : 0)
        : 0;
    return {
      groups,
      resultSets,
      providerStatus,
      fetchedAt,
      status: fetchedAt
        ? resultSets.some((set) => set.status !== 'AVAILABLE')
          ? 'PARTIAL'
          : 'AVAILABLE'
        : !providerStatus.configured
          ? 'UNCONFIGURED'
          : !providerStatus.automaticAllowed
            ? limitReached
              ? 'LIMIT_REACHED'
              : 'PAUSED'
            : resultSets.some((set) => set.status === 'UNAVAILABLE')
              ? 'UNAVAILABLE'
              : 'PENDING',
      nextRequestAt: nextAt ? new Date(nextAt).toISOString() : null,
      reason:
        providerStatus.reason ??
        this.sharedFailure ??
        this.failure ??
        resultSets.find((set) => set.status === 'UNAVAILABLE')?.reason ??
        null,
    };
  }
  async company(companyId: string, actorKey?: string) {
    const companies = await this.companies();
    const eligible = this.config.fixtureMode
      ? []
      : await this.database.requireDataSource().query(
          `SELECT c.id FROM companies c WHERE c.id=? AND (
      EXISTS (SELECT 1 FROM market_cap_memberships m JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id WHERE m.company_id=c.id)
      OR EXISTS (SELECT 1 FROM watchlist_group_items i JOIN watchlist_groups g ON g.id=i.group_id WHERE i.company_id=c.id AND g.room_id IS NULL AND g.owner_key=?))`,
          [companyId, actorKey ?? ''],
        );
    const focus = eligible.length > 0;
    const snapshot = this.snapshots.get(companyId);
    const status = await this.search.status();
    if (!status.configured || (snapshot && snapshot.expiresAt <= Date.now()))
      this.snapshots.delete(companyId);
    const available = focus ? this.snapshots.get(companyId) : undefined;
    return {
      focus,
      intervalMinutes: Math.max(1, Math.ceil(companies.length / 5)) * 15,
      fetchedAt: available?.fetchedAt ?? null,
      expiresAt: available ? new Date(available.expiresAt).toISOString() : null,
      result: available?.result ?? null,
      reason:
        status.reason ??
        (focus && !available
          ? (this.targetFailures.get(companyId) ??
            this.sharedFailure ??
            this.failure ??
            '대상 종목 순서대로 다음 정기 검색을 기다리고 있습니다.')
          : null),
    };
  }
}
