import { publicSourceUrl } from '../common/news-url';
import { createHash } from 'node:crypto';
import {
  type SourceItem,
  RightsMode,
  NewsContentState,
  matchesRegion,
  createNewsCompanyMatcher,
  newsBadgeCompanyAliases,
} from '@orsem/contracts';
import { activeActorSql } from '../watchlist-groups/watchlist-access.service';
import { MARKET_LEADER_COMPANIES_SQL } from '@orsem/database';
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { NaverNewsSearchService, type NaverNewsSearchResult } from './naver-news-search.service';

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
};
export const NAVER_NEWS_TOPICS = [
  { id: 'topic:equities', name: '증시' },
  { id: 'topic:rates', name: '금리' },
  { id: 'topic:fx', name: '환율' },
  { id: 'topic:gold', name: '국제 금값' },
  { id: 'topic:silver', name: '국제 은값' },
  { id: 'topic:wti', name: 'WTI 유가' },
  { id: 'topic:btc', name: '비트코인' },
  { id: 'topic:eth', name: '이더리움' },
] as const;
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
type Snapshot = { result: NaverNewsSearchResult; fetchedAt: string; expiresAt: number };

/** Provider results stay unmodified in short-lived memory, never in DB, logs or AI. */
@Injectable()
export class NaverFocusNewsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly nextAttempt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;
  private stopped = false;
  private cursor = 0;
  private failure: string | null = null;
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
    await this.running;
    await Promise.allSettled(this.inFlight.values());
    this.snapshots.clear();
    this.nextAttempt.clear();
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
    const companies: FocusCompany[] = [...(await this.companies()), ...NAVER_NEWS_TOPICS];
    this.failure = null;

    // Round-robin cap leaves the existing shared free budget in control.
    const count = Math.min(
      companies.length,
      10,
      status.remainingToday ?? 0,
      status.remainingMonth ?? 0,
      'remainingWindow' in status ? (status.remainingWindow ?? 0) : 10,
    );
    for (let index = 0; index < count && !this.stopped; index++) {
      const company = companies[this.cursor++ % companies.length]!;
      await this.ensure(
        company,
        Math.min(
          24 * 60 * 60_000,
          Math.max(1, Math.ceil(companies.length / 10)) * NAVER_FOCUS_INTERVAL_MS,
        ),
        true,
      );
      if (this.failure) break;
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
      this.nextAttempt.set(company.id, Date.now() + NAVER_FOCUS_INTERVAL_MS);
      const status = await this.search.status();
      if (!status.automaticAllowed || this.stopped) return;
      this.nextAttempt.set(company.id, Date.now() + NAVER_FOCUS_INTERVAL_MS);
      try {
        const result = await this.search.search({ q: company.name, start: 1, sort: 'date' }, () =>
          this.snapshots.delete(company.id),
        );
        const fetched = Date.now();
        this.snapshots.set(company.id, {
          result,
          fetchedAt: new Date(fetched).toISOString(),
          expiresAt: fetched + ttl,
        });
        this.failure = null;
      } catch {
        this.failure = '네이버 뉴스를 잠시 불러오지 못했습니다.';
      }
      for (const [id, time] of this.nextAttempt) if (time < Date.now()) this.nextAttempt.delete(id);
      for (const [id, entry] of this.snapshots)
        if (entry.expiresAt <= Date.now()) this.snapshots.delete(id);
      while (this.snapshots.size > 1000) this.snapshots.delete(this.snapshots.keys().next().value!);
    })()
      .catch(() => {
        this.failure = '네이버 연결 상태를 확인하지 못했습니다.';
      })
      .finally(() => this.inFlight.delete(company.id));
    this.inFlight.set(company.id, task);
    return task;
  }

  async feed(
    input: {
      companyId?: string;
      scope?: string;
      asset?: 'gold' | 'silver' | 'wti' | 'btc' | 'eth';
      region?: 'all' | 'kr' | 'us';
    },
    actorKey: string,
  ) {
    if (this.config.fixtureMode)
      return {
        groups: [] as SourceItem[][],
        fetchedAt: null,
        status: 'UNCONFIGURED',
        nextRequestAt: null,
      };
    const db = this.database.requireDataSource();
    const base =
      'SELECT DISTINCT c.id,c.name_ko name,c.name_ko nameKo,c.name_en nameEn,c.market,c.stock_code stockCode,c.ticker FROM companies c WHERE ';
    const companies: FocusCompany[] =
      input.asset || input.scope === 'market'
        ? []
        : input.companyId
          ? await db.query(base + 'c.id=?', [input.companyId])
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
    const targets: FocusCompany[] = input.asset
      ? NAVER_NEWS_TOPICS.filter((topic) => topic.id === `topic:${input.asset}`)
      : input.scope === 'market'
        ? NAVER_NEWS_TOPICS.slice(0, 3)
        : input.companyId || input.scope === 'personal' || input.scope === 'company'
          ? selected
          : [...selected, ...NAVER_NEWS_TOPICS];
    // Only opening a specific company can initiate an on-demand provider request.
    if (input.companyId && selected[0]) await this.ensure(selected[0]);
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
            (input.companyId || input.scope === 'personal' || input.scope === 'company') &&
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
              marketRegion: company.id.startsWith('topic:')
                ? 'global'
                : ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(company.market ?? '')
                  ? 'kr'
                  : 'us',
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
    const providerStatus = await this.search.status();
    const budgetNext = 'nextRequestAt' in providerStatus ? providerStatus.nextRequestAt : null;
    const nextAt = Math.max(next ?? 0, budgetNext ? Date.parse(budgetNext) : 0);
    return {
      groups,
      fetchedAt,
      status: fetchedAt
        ? 'AVAILABLE'
        : !providerStatus.configured
          ? 'UNCONFIGURED'
          : !providerStatus.automaticAllowed
            ? 'LIMIT_REACHED'
            : this.failure
              ? 'UNAVAILABLE'
              : 'PENDING',
      nextRequestAt: nextAt ? new Date(nextAt).toISOString() : null,
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
      intervalMinutes:
        Math.max(1, Math.ceil((companies.length + NAVER_NEWS_TOPICS.length) / 10)) * 15,
      fetchedAt: available?.fetchedAt ?? null,
      expiresAt: available ? new Date(available.expiresAt).toISOString() : null,
      result: available?.result ?? null,
      reason:
        status.reason ??
        (focus && !available
          ? (this.failure ?? '대상 종목 순서대로 다음 정기 검색을 기다리고 있습니다.')
          : null),
    };
  }
}
