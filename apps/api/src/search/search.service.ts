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
} from '../common/news-translation';

export { searchPattern };

export interface SearchItem {
  id: string;
  type: 'COMPANY' | 'NEWS' | 'FILING';
  title: string;
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
  title: string;
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

export function publicSourceUrl(value: string): string | null {
  try {
    if (
      !/^https?:\/\//iu.test(value) ||
      value.includes('\\') ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return null;
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function instant(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function companyCondition(): string {
  return `(company.nameKo LIKE :pattern ESCAPE '!' OR company.nameEn LIKE :pattern ESCAPE '!'
    OR company.stockCode LIKE :pattern ESCAPE '!' OR company.ticker LIKE :pattern ESCAPE '!'
    OR company.corpCode LIKE :pattern ESCAPE '!' OR company.cik LIKE :pattern ESCAPE '!'
    OR EXISTS (SELECT 1 FROM company_aliases alias WHERE alias.company_id = company.id
      AND alias.alias LIKE :pattern ESCAPE '!'))`;
}

function companyItem(row: CompanyRow): SearchItem {
  return {
    id: row.id,
    type: 'COMPANY',
    title: row.nameKo,
    subtitle: [row.market, row.stockCode ?? row.ticker, row.nameEn].filter(Boolean).join(' · '),
    url: `/companies/${encodeURIComponent(row.id)}`,
    external: false,
    companyId: row.id,
    source: null,
    rightsMode: null,
    publishedAt: null,
    rceptDate: null,
    firstObservedAt: null,
  };
}

function sourceItem(row: SourceRow): SearchItem | null {
  const url = publicSourceUrl(row.url);
  if (!url || !metadataRights.includes(row.rightsMode)) return null;
  return {
    id: row.id,
    type: row.source === 'SEC' ? 'FILING' : 'NEWS',
    title: row.title,
    translation: publicNewsTranslation(row),
    subtitle: [row.companyName, row.sourceName ?? row.source].filter(Boolean).join(' · '),
    url,
    external: true,
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
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.rceptNo}`,
    external: true,
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

  async search(input: { q: string; limit: number; region?: Region }): Promise<SearchResults> {
    const groups = this.config.fixtureMode
      ? this.fixtureGroups(input.q, input.region ?? 'all')
      : await this.databaseGroups(input.q, input.limit, input.region ?? 'all');
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

  private async databaseGroups(term: string, limit: number, region: Region) {
    const source = this.database.requireDataSource();
    const parameters = { term, pattern: searchPattern(term), rights: metadataRights };
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
        'CASE WHEN company.stockCode = :term OR company.ticker = :term OR company.nameKo = :term OR company.nameEn = :term THEN 0 ELSE 1 END',
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
        'filing.detailType AS detailType',
        'filing.firstObservedAt AS firstObservedAt',
      ])
      .where("filing.source = 'OPENDART'")
      .andWhere(
        `(filing.reportName LIKE :pattern ESCAPE '!' OR filing.filerName LIKE :pattern ESCAPE '!' OR filing.rceptNo LIKE :pattern ESCAPE '!' OR ${companyCondition()})`,
        parameters,
      )
      .orderBy('filing.rceptDate', 'DESC')
      .addOrderBy('filing.id', 'DESC')
      .limit(limit + 1);
    if (region === 'us') filingQuery.andWhere('1 = 0');

    // 네 조회는 저장된 메타데이터만 읽으며 수집 작업이나 외부 API를 호출하지 않습니다.
    const [companies, news, dart, sec] = await Promise.all([
      companyQuery.getRawMany<CompanyRow>(),
      this.sourceQuery(source, false, parameters, limit, region).getRawMany<SourceRow>(),
      filingQuery.getRawMany<FilingRow>(),
      this.sourceQuery(source, true, parameters, limit, region).getRawMany<SourceRow>(),
    ]);
    return {
      companies: companies.map(companyItem),
      news: news.map(sourceItem).filter((row): row is SearchItem => row !== null),
      filings: [...dart.map(filingItem), ...sec.map(sourceItem)]
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
  ) {
    const query = source
      .getRepository(SourceItemEntity)
      .createQueryBuilder('item')
      .leftJoin(CompanyEntity, 'company', 'company.id = item.companyId')
      .select([
        'item.id AS id',
        'item.title AS title',
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
      ])
      // SEC의 날짜 필드만 추출하고 원본 메타데이터 객체는 조회 결과에 포함하지 않습니다.
      .addSelect(
        secOnly ? "JSON_UNQUOTE(JSON_EXTRACT(item.rawMetadataJson, '$.filingDate'))" : 'NULL',
        'rceptDate',
      )
      .where(secOnly ? "item.source = 'SEC'" : "item.source <> 'SEC'")
      .andWhere('item.rightsMode IN (:...rights)', parameters)
      .andWhere(
        `(item.title LIKE :pattern ESCAPE '!' OR item.externalId LIKE :pattern ESCAPE '!' OR ${companyCondition()} OR ${newsTranslationSearchCondition('item', 'pattern')})`,
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
    if (region !== 'all') {
      if (secOnly) {
        if (region === 'kr') query.andWhere('1 = 0');
      } else {
        query.andWhere(
          "(company.market IN (:...regionMarkets) OR (item.source = 'NEWS_RSS' AND JSON_UNQUOTE(JSON_EXTRACT(item.rawMetadataJson, '$.marketRegion')) IN ('global', :newsRegion)))",
          {
            regionMarkets: marketsForRegion(region),
            newsRegion: region,
          },
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
