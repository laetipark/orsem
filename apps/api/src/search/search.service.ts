import { newsAudienceSql, newsAudienceAllows, type NewsAudience } from '../resources/news-access';
import { publicSourceUrl } from '../common/news-url';
import { manualNewsTranslationSql } from '../resources/manual-news-translation';
import { Inject, Injectable } from '@nestjs/common';
import {
  RightsMode,
  matchesRegion,
  marketsForRegion,
  type Region,
  type Company,
  type NewsTranslation,
  type SourceItem,
} from '@orsem/contracts';
import { CompanyEntity, FilingEntity, SourceItemEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import {
  literalSearchPattern as searchPattern,
  newsTranslationSearchCondition,
  publicNewsTranslation,
  publicNewsDescription,
  publicNewsTranslationStatus,
} from '../common/news-translation';
import {
  visibleNewsSql,
  metadataNewsSql,
  newsFiltersSql,
  newsFilterParameters,
  PUBLIC_NEWS_PUBLISHERS,
  representativeNewsSql,
} from '../resources/news-query';

export { searchPattern };

export interface SearchItem {
  id: string;
  type: 'COMPANY' | 'NEWS' | 'FILING';
  title: string;
  description?: string | null;
  translationStatus?: SourceItem['translationStatus'];
  relatedCompanies?: SourceItem['relatedCompanies'];
  company?: CompanyRow;
  translation?: NewsTranslation | null;
  subtitle: string;
  url: string;
  external: boolean;
  companyId: string | null;
  source: string | null;
  rightsMode: RightsMode | null;
  publishedAt: string | null;
  rceptDate: string | null;
  firstObservedAt: string | null;
}

export interface SearchResults {
  query: string;
  companies: SearchItem[];
  news: SearchItem[];
  filings: SearchItem[];
  hasMore: { companies: boolean; news: boolean; filings: boolean };
}

interface CompanyRow {
  id: string;
  nameKo: string;
  nameEn: string | null;
  market: string;
  stockCode: string | null;
  ticker: string | null;
}
interface SourceRow {
  id: string;
  articleId?: string | null;
  title: string;
  description?: string | null;
  relatedCompanies?: SourceItem['relatedCompanies'];
  url: string;
  companyId: string | null;
  companyName: string | null;
  source: string;
  sourceName: string | null;
  rightsMode: RightsMode;
  publishedAt: Date | string | null;
  firstObservedAt: Date | string;
  rceptDate: string | null;
  rawHash?: string | null;
  translationJson?: unknown;
  manualTranslationJson?: unknown;
  manualRevisionVerified?: number | string;
  sourcePolicyJson?: unknown;
  sourceKind?: string | null;
  publisherId?: string | null;
  metadataRightsContext?: string | null;
  contentState?: string | null;
  contentLanguage?: string | null;
}
interface FilingRow {
  id: string;
  companyId: string;
  companyName: string;
  reportName: string;
  source: string;
  rceptNo: string;
  rceptDate: string;
  detailType: string;
  firstObservedAt: Date | string;
}

const metadataRights: RightsMode[] = [
  RightsMode.OFFICIAL_PUBLIC_DATA,
  RightsMode.PRIVATE_DISPLAY_ONLY,
  RightsMode.STORE_METADATA_ONLY,
  RightsMode.LINK_ONLY,
];

export { publicSourceUrl } from '../common/news-url';

function instant(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function companyCondition(): string {
  // DB 컬럼의 collation과 관계없이 검색과 추천 순위에서 대소문자를 무시합니다.
  return `(LOWER(company.nameKo) LIKE LOWER(:pattern) ESCAPE '!' OR LOWER(company.nameEn) LIKE LOWER(:pattern) ESCAPE '!'
    OR LOWER(company.stockCode) LIKE LOWER(:pattern) ESCAPE '!' OR LOWER(company.ticker) LIKE LOWER(:pattern) ESCAPE '!'
    OR LOWER(company.corpCode) LIKE LOWER(:pattern) ESCAPE '!' OR LOWER(company.cik) LIKE LOWER(:pattern) ESCAPE '!'
    OR EXISTS (SELECT 1 FROM company_aliases alias WHERE alias.company_id = company.id
      AND LOWER(alias.alias) LIKE LOWER(:pattern) ESCAPE '!'))`;
}

function companyItem(row: CompanyRow): SearchItem {
  return {
    id: row.id,
    type: 'COMPANY',
    company: row,
    title: row.nameKo,
    subtitle: [row.market, row.stockCode ?? row.ticker, row.nameEn].filter(Boolean).join(' · '),
    url: `/companies/${row.id}`,
    external: false,
    companyId: row.id,
    source: null,
    rightsMode: null,
    publishedAt: null,
    rceptDate: null,
    firstObservedAt: null,
  };
}

function sourceItem(row: SourceRow, audience: NewsAudience = 'MEMBER_UI'): SearchItem | null {
  const url = publicSourceUrl(row.url);
  if (row.source.startsWith('NAVER') || !url || !metadataRights.includes(row.rightsMode))
    return null;
  const filing = row.source === 'SEC';
  let policy: any = row.sourcePolicyJson;
  if (typeof policy === 'string') {
    try {
      policy = JSON.parse(policy);
    } catch {
      policy = null;
    }
  }
  const privateCard =
    policy?.policyVersion === 2 &&
    newsAudienceAllows({ source: row.source, sourcePolicyJson: policy }, audience);
  if (!newsAudienceAllows({ source: row.source, sourcePolicyJson: policy }, audience)) return null;
  const metadataCard =
    ['GDELT', 'ALPACA_NEWS'].includes(row.source) &&
    row.metadataRightsContext === 'APPROVED_PUBLISHER_METADATA' &&
    policy?.metadataStorageAllowed === true &&
    policy?.displayAllowed === true &&
    policy?.fullTextStorageAllowed === false &&
    policy?.aiAllowed === false;
  const translation = metadataCard ? null : publicNewsTranslation(row);
  if (
    !filing &&
    !metadataCard &&
    !privateCard &&
    (policy?.metadataStorageAllowed !== true ||
      policy?.displayAllowed !== true ||
      policy?.rightsMode !== row.rightsMode ||
      !['OFFICIAL_RELEASE', 'COMPANY_IR'].includes(row.sourceKind ?? '') ||
      !PUBLIC_NEWS_PUBLISHERS.includes(
        (row.publisherId ?? '') as (typeof PUBLIC_NEWS_PUBLISHERS)[number],
      ))
  )
    return null;
  return {
    id: row.id,
    type: filing ? 'FILING' : 'NEWS',
    title: row.title,
    description: metadataCard
      ? null
      : publicNewsDescription(row.rightsMode, row.description, policy),
    relatedCompanies: row.relatedCompanies ?? [],
    translation,
    translationStatus: filing ? 'UNAVAILABLE' : publicNewsTranslationStatus(row),
    subtitle: [row.companyName, row.sourceName ?? row.source].filter(Boolean).join(' · '),
    url: filing ? `/events/${encodeURIComponent(row.id)}` : url,
    external: !filing,
    companyId: row.companyId,
    source: row.source,
    rightsMode: row.rightsMode,
    publishedAt: instant(row.publishedAt),
    rceptDate: row.rceptDate && /^\d{4}-\d{2}-\d{2}$/u.test(row.rceptDate) ? row.rceptDate : null,
    firstObservedAt: instant(row.firstObservedAt),
  };
}

function filingItem(row: FilingRow): SearchItem | null {
  if (row.source !== 'OPENDART' || !/^\d{14}$/u.test(row.rceptNo)) return null;
  return {
    id: row.id,
    type: 'FILING',
    title: row.reportName,
    subtitle: [row.companyName, row.detailType, row.rceptNo].join(' · '),
    url: `/events/${encodeURIComponent(row.id)}`,
    external: false,
    companyId: row.companyId,
    source: row.source,
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    publishedAt: null,
    rceptDate: row.rceptDate,
    firstObservedAt: instant(row.firstObservedAt),
  };
}

function newest(left: SearchItem, right: SearchItem): number {
  const leftTime = left.rceptDate ?? left.publishedAt ?? left.firstObservedAt ?? '';
  const rightTime = right.rceptDate ?? right.publishedAt ?? right.firstObservedAt ?? '';
  return rightTime.localeCompare(leftTime) || right.id.localeCompare(left.id);
}

@Injectable()
export class SearchService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
    private readonly fixtures: FixtureStoreService,
  ) {}

  async search(
    input: { q: string; limit: number; region?: Region },
    audience: NewsAudience = 'MEMBER_UI',
  ): Promise<SearchResults> {
    const groups = this.config.fixtureMode
      ? this.fixtureGroups(input.q, input.region ?? 'all')
      : await this.databaseGroups(input.q, input.limit, input.region ?? 'all', 'search', {
          audience,
        });
    return {
      query: input.q,
      companies: groups.companies.slice(0, input.limit),
      news: groups.news.slice(0, input.limit),
      filings: groups.filings.slice(0, input.limit),
      hasMore: {
        companies: groups.companies.length > input.limit,
        news: groups.news.length > input.limit,
        filings: groups.filings.length > input.limit,
      },
    };
  }

  async suggestions(
    input: {
      q: string;
      limit: number;
      region?: Region;
      kind: 'all' | 'companies' | 'news' | 'events';
      scope?: 'all' | 'market' | 'company';
      sourceKind?: string;
      publisher?: string;
      companyId?: string;
    },
    audience: NewsAudience = 'MEMBER_UI',
  ) {
    const groups = this.config.fixtureMode
      ? this.fixtureGroups(input.q, input.region ?? 'all')
      : await this.databaseGroups(input.q, input.limit, input.region ?? 'all', input.kind, {
          ...input,
          audience,
        });
    return {
      query: input.q,
      companies: input.kind === 'news' ? [] : groups.companies.slice(0, input.limit),
      news: ['all', 'news'].includes(input.kind) ? groups.news.slice(0, input.limit) : [],
      filings: [],
      hasMore: { companies: false, news: false, filings: false },
    };
  }

  private async databaseGroups(
    term: string,
    limit: number,
    region: Region,
    kind: 'search' | 'all' | 'companies' | 'news' | 'events' = 'search',
    filters: import('../resources/news-query').NewsFilters = {},
  ) {
    const source = this.database.requireDataSource();
    const parameters = {
      term,
      pattern: searchPattern(term),
      prefix: searchPattern(term).slice(1),
      rights: metadataRights,
    };
    const companyQuery = source
      .getRepository(CompanyEntity)
      .createQueryBuilder('company')
      .select([
        'company.id AS id',
        'company.nameKo AS nameKo',
        'company.nameEn AS nameEn',
        'company.market AS market',
        'company.stockCode AS stockCode',
        'company.ticker AS ticker',
      ])
      .where(companyCondition(), parameters)
      .orderBy(
        "CASE WHEN LOWER(company.stockCode) = LOWER(:term) OR LOWER(company.ticker) = LOWER(:term) OR LOWER(company.nameKo) = LOWER(:term) OR LOWER(company.nameEn) = LOWER(:term) THEN 0 WHEN LOWER(company.nameKo) LIKE LOWER(:prefix) ESCAPE '!' OR LOWER(company.ticker) LIKE LOWER(:prefix) ESCAPE '!' OR LOWER(company.stockCode) LIKE LOWER(:prefix) ESCAPE '!' THEN 1 ELSE 2 END",
        'ASC',
      )
      .addOrderBy('company.isListed', 'DESC')
      .addOrderBy('company.nameKo', 'ASC')
      .addOrderBy('company.id', 'ASC')
      .limit(limit + 1);
    if (region !== 'all')
      companyQuery.andWhere('company.market IN (:...regionMarkets)', {
        regionMarkets: marketsForRegion(region),
      });
    const filingQuery = source
      .getRepository(FilingEntity)
      .createQueryBuilder('filing')
      .innerJoin(CompanyEntity, 'company', 'company.id = filing.companyId')
      .select([
        'filing.id AS id',
        'filing.companyId AS companyId',
        'company.nameKo AS companyName',
        'filing.reportName AS reportName',
        'filing.source AS source',
        'filing.rceptNo AS rceptNo',
        'filing.rceptDate AS rceptDate',
        'COALESCE(filing.canonical_type, filing.detail_type) AS detailType',
        'filing.firstObservedAt AS firstObservedAt',
      ])
      .where("filing.source = 'OPENDART'")
      .andWhere(
        "(filing.canonical_type IS NULL OR filing.canonical_type IN ('D001','D002','D003','D004','D005'))",
      )
      .andWhere(
        `(LOWER(filing.reportName) LIKE LOWER(:pattern) ESCAPE '!' OR LOWER(filing.filerName) LIKE LOWER(:pattern) ESCAPE '!' OR LOWER(filing.rceptNo) LIKE LOWER(:pattern) ESCAPE '!' OR ${companyCondition()})`,
        parameters,
      )
      .orderBy('filing.rceptDate', 'DESC')
      .addOrderBy('filing.id', 'DESC')
      .limit(limit + 1);
    if (region === 'us') filingQuery.andWhere('1 = 0');

    // 네 조회는 저장된 메타데이터만 읽으며 수집 작업이나 외부 API를 호출하지 않습니다.
    const [companies, news, dart, sec] = await Promise.all([
      kind === 'news' ? Promise.resolve([]) : companyQuery.getRawMany<CompanyRow>(),
      ['search', 'all', 'news'].includes(kind)
        ? this.sourceQuery(
            source,
            false,
            parameters,
            limit,
            region,
            filters,
          ).getRawMany<SourceRow>()
        : Promise.resolve([]),
      kind === 'search' ? filingQuery.getRawMany<FilingRow>() : Promise.resolve([]),
      kind === 'search'
        ? this.sourceQuery(source, true, parameters, limit, region).getRawMany<SourceRow>()
        : Promise.resolve([]),
    ]);
    if (news.length) {
      const relations = (await source.query(
        `SELECT DISTINCT displayed.id sourceItemId,c.id,c.name_ko nameKo,c.name_en nameEn,c.market,c.stock_code stockCode,c.ticker
        FROM source_items displayed JOIN source_items linked ON linked.id=displayed.id OR (displayed.news_article_id IS NOT NULL AND linked.news_article_id=displayed.news_article_id)
        JOIN news_source_companies relevance ON relevance.source_item_id=linked.id JOIN companies c ON c.id=relevance.company_id
        WHERE ${newsAudienceSql('linked', filters.audience)} AND ${metadataNewsSql('linked')} AND displayed.id IN (${news.map(() => '?').join(',')}) ORDER BY c.name_ko,c.id`,
        news.map((row) => row.id),
      )) as (NonNullable<SourceItem['relatedCompanies']>[number] & { sourceItemId: string })[];
      for (const row of news)
        row.relatedCompanies = relations
          .filter((company) => company.sourceItemId === row.id)
          .map(({ id, nameKo, nameEn, market, stockCode, ticker }) => ({
            id,
            nameKo,
            nameEn,
            market,
            stockCode,
            ticker,
          }));
    }
    return {
      companies: companies.map(companyItem),
      news: news
        .map((row) => sourceItem(row, filters.audience))
        .filter((row): row is SearchItem => row !== null),
      filings: [...dart.map(filingItem), ...sec.map((row) => sourceItem(row, filters.audience))]
        .filter((row): row is SearchItem => row !== null)
        .sort(newest),
    };
  }

  private sourceQuery(
    source: DataSource,
    secOnly: boolean,
    parameters: Record<string, unknown>,
    limit: number,
    region: Region,
    filters: import('../resources/news-query').NewsFilters = {},
  ) {
    const query = source
      .getRepository(SourceItemEntity)
      .createQueryBuilder('item')
      .leftJoin(CompanyEntity, 'company', 'company.id = item.companyId')
      .select([
        'item.id AS id',
        'item.newsArticleId AS articleId',
        'item.title AS title',
        "JSON_UNQUOTE(JSON_EXTRACT(item.rawMetadataJson, '$.description')) AS description",
        'item.url AS url',
        'item.companyId AS companyId',
        'company.nameKo AS companyName',
        'item.source AS source',
        'item.sourceName AS sourceName',
        'item.rightsMode AS rightsMode',
        'item.publishedAt AS publishedAt',
        'item.firstObservedAt AS firstObservedAt',
        'item.rawHash AS rawHash',
        'item.translationJson AS translationJson',
        'item.manualTranslationJson AS manualTranslationJson',
        'item.sourcePolicyJson AS sourcePolicyJson',
        'item.sourceKind AS sourceKind',
        "JSON_UNQUOTE(JSON_EXTRACT(item.rawMetadataJson, '$.rightsContext')) AS metadataRightsContext",
      ])
      .addSelect(secOnly ? '0' : manualNewsTranslationSql('item'), 'manualRevisionVerified')
      .addSelect(
        "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(item.rawMetadataJson, '$.publisherId')), item.sourceName, item.source)",
        'publisherId',
      )
      // SEC의 날짜 필드만 추출하고 원본 메타데이터 객체는 조회 결과에 포함하지 않습니다.
      .addSelect(
        secOnly ? "JSON_UNQUOTE(JSON_EXTRACT(item.rawMetadataJson, '$.filingDate'))" : 'NULL',
        'rceptDate',
      )
      .where(secOnly ? "item.source = 'SEC'" : "item.source NOT IN ('SEC', 'NAVER')")
      .andWhere('item.rightsMode IN (:...rights)', parameters)
      .andWhere(
        `(LOWER(item.title) LIKE LOWER(:pattern) ESCAPE '!' OR LOWER(item.externalId) LIKE LOWER(:pattern) ESCAPE '!' OR ${companyCondition()} OR ${newsTranslationSearchCondition('item', 'pattern')})`,
        parameters,
      )
      .orderBy(
        secOnly
          ? "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(item.rawMetadataJson, '$.filingDate')), DATE(item.firstObservedAt))"
          : 'COALESCE(item.publishedAt, item.firstObservedAt)',
        'DESC',
      )
      .addOrderBy('item.id', 'DESC')
      .limit(limit + 1);
    if (!secOnly) {
      query
        .andWhere(newsFiltersSql('item', filters), newsFilterParameters(filters))
        .andWhere(visibleNewsSql('content', 'item'))
        .andWhere(representativeNewsSql(filters, 'item'));
    }
    if (region !== 'all') {
      if (secOnly) {
        if (region === 'kr') query.andWhere('1 = 0');
      } else {
        query.andWhere(
          newsFiltersSql('item', { ...filters, region }),
          newsFilterParameters({ ...filters, region }),
        );
      }
    }
    return query;
  }

  private fixtureGroups(term: string, region: Region) {
    const normalized = term.toLocaleLowerCase();
    const matches = (...values: Array<string | null | undefined>) =>
      values.some((value) => value?.toLocaleLowerCase().includes(normalized));
    const companyMatches = (company: Company) =>
      matches(
        company.nameKo,
        company.nameEn,
        company.stockCode,
        company.ticker,
        company.corpCode,
        company.cik,
      );
    const companies = this.fixtures.companies
      .filter((company) => matchesRegion(company.market, region) && companyMatches(company))
      .sort((left, right) => {
        const exact = (company: Company) =>
          [company.stockCode, company.ticker, company.nameKo, company.nameEn].some(
            (value) => value?.toLocaleLowerCase() === normalized,
          );
        return (
          Number(exact(right)) - Number(exact(left)) ||
          Number(right.isListed) - Number(left.isListed) ||
          left.nameKo.localeCompare(right.nameKo) ||
          left.id.localeCompare(right.id)
        );
      });
    const linkedCompany = (item: SourceItem) =>
      this.fixtures.companies.find((company) =>
        [company.stockCode, company.ticker].some(
          (symbol) => symbol && item.tickers.includes(symbol),
        ),
      );
    const sourceItems = this.fixtures.sourceItems
      .filter(
        (item) =>
          item.source === 'SEC' ||
          (['OFFICIAL_RELEASE', 'COMPANY_IR'].includes(item.sourceKind ?? '') &&
            PUBLIC_NEWS_PUBLISHERS.includes(
              (item.publisherId ?? '') as (typeof PUBLIC_NEWS_PUBLISHERS)[number],
            )),
      )
      .filter((item) => {
        const company = linkedCompany(item);
        if (
          region !== 'all' &&
          item.source !== 'NEWS_RSS' &&
          (item.source === 'SEC'
            ? region !== 'us'
            : !company || !matchesRegion(company.market, region))
        )
          return false;
        return matches(item.title, item.externalId) || Boolean(company && companyMatches(company));
      })
      .map((item) => {
        const company = linkedCompany(item);
        return sourceItem({
          ...item,
          companyId: company?.id ?? null,
          companyName: company?.nameKo ?? null,
          relatedCompanies: company ? [company] : [],
          sourcePolicyJson: {
            rightsMode: item.rightsMode,
            metadataStorageAllowed: true,
            displayAllowed: true,
          },
          rceptDate: null,
        });
      })
      .filter((row): row is SearchItem => row !== null);
    const filings = this.fixtures.filings
      .filter(() => region !== 'us')
      .filter(
        (item) =>
          matches(item.reportName, item.filerName, item.rceptNo) || companyMatches(item.company),
      )
      .map((item) =>
        filingItem({
          ...item,
          source: 'OPENDART',
          companyId: item.company.id,
          companyName: item.company.nameKo,
        }),
      );
    return {
      companies: companies.map(companyItem),
      news: sourceItems.filter((item) => item.type === 'NEWS').sort(newest),
      filings: [...filings, ...sourceItems.filter((item) => item.type === 'FILING')]
        .filter((row): row is SearchItem => row !== null)
        .sort(newest),
    };
  }
}
