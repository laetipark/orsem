import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type PublicCompany,
  type PublicCompanyFilters,
  type PublicNewsFilters,
  type PublicNewsItem,
  type PublicPage,
} from '@orsem/contracts';
import { CompanyEntity, SourceCheckpointEntity, SourceItemEntity } from '@orsem/database';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { cursorInstant, decodeCursor, encodeCursor } from '../common/cursor';
import { literalSearchPattern } from '../common/news-translation';
import { verifyManualNewsSources } from '../resources/manual-news-translation';
import {
  mapPublicCompany,
  PUBLIC_COMPANY_IDENTITY_SQL,
  PUBLIC_COMPANY_NAME_SQL,
  PUBLIC_COMPANY_SELECTION,
  PUBLIC_COMPANY_SYMBOL_SQL,
  SEC_COMPANY_SOURCE,
  type PublicCompanyRow,
} from './public-companies';
import { mapPublicNews, publicNewsSql } from './public-news-policy';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const NEWS_SORT = 'COALESCE(source.published_at, source.first_observed_at)';

@Injectable()
export class PublicResourcesService {
  constructor(
    private readonly database: DatabaseRuntimeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly fixtures: FixtureStoreService,
  ) {}

  private companyQuery() {
    return this.database
      .requireDataSource()
      .getRepository(CompanyEntity)
      .createQueryBuilder('company')
      .leftJoin(
        SourceCheckpointEntity,
        'mapping',
        "mapping.connector = 'SEC_EDGAR' AND mapping.stream = CONCAT('CIK_MAPPING:', company.id)",
      )
      .select(PUBLIC_COMPANY_SELECTION)
      .where(PUBLIC_COMPANY_IDENTITY_SQL, { secCompanySource: SEC_COMPANY_SOURCE });
  }

  async companies(filters: PublicCompanyFilters): Promise<PublicPage<PublicCompany>> {
    const limit = filters.limit ?? 20;
    const cursor = decodeCursor(filters.cursor);
    // Existing fixture companies lack the original master snapshot/date. Do not
    // fabricate provenance or allow the fixture flag to bypass identity checks.
    if (this.config.fixtureMode) return { items: [], nextCursor: null };
    const query = this.companyQuery();
    if (filters.region && filters.region !== 'all')
      query.andWhere(
        filters.region === 'kr'
          ? "company.market IN ('KRX','KOSPI','KOSDAQ','KONEX')"
          : "company.market IN ('NASDAQ','NYSE','AMEX')",
      );
    if (filters.q)
      query.andWhere(
        `(${PUBLIC_COMPANY_NAME_SQL} LIKE :publicQuery ESCAPE '!'
      OR ${PUBLIC_COMPANY_SYMBOL_SQL} LIKE :publicQuery ESCAPE '!')`,
        { publicQuery: literalSearchPattern(filters.q) },
      );
    if (cursor) query.andWhere('company.id > :publicCursor', { publicCursor: cursor.id });
    const rows = await query
      .orderBy('company.id', 'ASC')
      .limit(limit + 1)
      .getRawMany<PublicCompanyRow>();
    return this.page(rows, limit, mapPublicCompany, (row) => row.id);
  }

  async company(value: string): Promise<PublicCompany> {
    const id = value.toUpperCase();
    const isUuid = UUID.test(value);
    if (
      !isUuid &&
      !/^(?:(?:KRX|KOSPI|KOSDAQ|KONEX|NASDAQ|NYSE|AMEX):)?[A-Z0-9][A-Z0-9.-]{0,19}$/u.test(id)
    )
      throw new BadRequestException('종목번호 또는 티커를 확인해 주세요.');
    if (this.config.fixtureMode) throw new NotFoundException('공개된 종목을 찾을 수 없습니다.');
    const query = this.companyQuery();
    if (isUuid) query.andWhere('company.id = :publicId', { publicId: value });
    else {
      const [exchange, symbol] = id.includes(':') ? id.split(':') : [null, id];
      query.andWhere(`${PUBLIC_COMPANY_SYMBOL_SQL} = :publicSymbol`, { publicSymbol: symbol });
      if (exchange)
        query.andWhere('company.market = :publicExchange', { publicExchange: exchange });
    }
    const rows = await query.limit(2).getRawMany<PublicCompanyRow>();
    if (!rows.length) throw new NotFoundException('공개된 종목을 찾을 수 없습니다.');
    if (rows.length > 1)
      throw new ConflictException('같은 종목코드가 여러 개입니다. 종목 목록에서 선택해 주세요.');
    return mapPublicCompany(rows[0]!);
  }

  private newsQuery() {
    const policy = publicNewsSql('source');
    return this.database
      .requireDataSource()
      .getRepository(SourceItemEntity)
      .createQueryBuilder('source')
      .select([
        'source.id',
        'source.source',
        'source.sourceKind',
        'source.sourceName',
        'source.title',
        'source.url',
        'source.publishedAt',
        'source.firstObservedAt',
        'source.rightsMode',
        'source.sourcePolicyJson',
        'source.rawMetadataJson',
        'source.rawHash',
        'source.translationJson',
        'source.manualTranslationJson',
      ])
      .where(policy.sql, policy.parameters);
  }

  async news(filters: PublicNewsFilters): Promise<PublicPage<PublicNewsItem>> {
    const limit = filters.limit ?? 20;
    const cursor = decodeCursor(filters.cursor);
    if (filters.companyId) await this.company(filters.companyId);
    if (this.config.fixtureMode) {
      const rows = this.fixtureNews()
        .filter(
          (row) =>
            (!filters.companyId || row.companyId === filters.companyId) &&
            (!filters.q || row.title.toLowerCase().includes(filters.q.toLowerCase())) &&
            (!filters.region ||
              filters.region === 'all' ||
              ['global', filters.region].includes(String(row.rawMetadataJson?.marketRegion))) &&
            (!cursor ||
              this.newsSort(row) < cursor.sort ||
              (this.newsSort(row) === cursor.sort && row.id < cursor.id)),
        )
        .sort(
          (a, b) => this.newsSort(b).localeCompare(this.newsSort(a)) || b.id.localeCompare(a.id),
        );
      return this.newsPage(rows.slice(0, limit + 1), limit);
    }
    const query = this.newsQuery();
    if (filters.q)
      query.andWhere("source.title LIKE :publicQuery ESCAPE '!'", {
        publicQuery: literalSearchPattern(filters.q),
      });
    if (filters.region && filters.region !== 'all')
      query.andWhere(
        "JSON_UNQUOTE(JSON_EXTRACT(source.raw_metadata_json, '$.marketRegion')) IN ('global', :publicRegion)",
        { publicRegion: filters.region },
      );
    // Relevance must belong to this public source, never a private duplicate article.
    if (filters.companyId)
      query.andWhere(
        `EXISTS (SELECT 1 FROM news_source_companies public_relevance
      WHERE public_relevance.source_item_id = source.id AND public_relevance.company_id = :publicCompanyId)`,
        { publicCompanyId: filters.companyId },
      );
    if (cursor)
      query.andWhere(
        `(${NEWS_SORT} < :publicCursorTime OR
      (${NEWS_SORT} = :publicCursorTime AND source.id < :publicCursorId))`,
        { publicCursorTime: cursorInstant(cursor.sort), publicCursorId: cursor.id },
      );
    const rows = await query
      .orderBy(NEWS_SORT, 'DESC')
      .addOrderBy('source.id', 'DESC')
      .take(limit + 1)
      .getMany();
    await verifyManualNewsSources(this.database.requireDataSource(), rows);
    return this.newsPage(rows, limit);
  }

  async newsItem(id: string): Promise<PublicNewsItem> {
    if (!UUID.test(id)) throw new BadRequestException('뉴스 주소를 확인해 주세요.');
    const row = this.config.fixtureMode
      ? this.fixtureNews().find((item) => item.id === id)
      : await this.newsQuery().andWhere('source.id = :publicId', { publicId: id }).getOne();
    if (row && !this.config.fixtureMode)
      await verifyManualNewsSources(this.database.requireDataSource(), [row]);
    const item = row ? mapPublicNews(row) : null;
    if (!item) throw new NotFoundException('공개된 뉴스를 찾을 수 없습니다.');
    return item;
  }

  private fixtureNews(): SourceItemEntity[] {
    return this.fixtures.sourceItems
      .map((row) =>
        Object.assign(new SourceItemEntity(), row, {
          publishedAt: row.publishedAt ? new Date(row.publishedAt) : null,
          firstObservedAt: new Date(row.firstObservedAt),
        }),
      )
      .filter((row) => mapPublicNews(row) !== null);
  }

  private newsSort(row: SourceItemEntity): string {
    return (row.publishedAt ?? row.firstObservedAt).toISOString();
  }

  private newsPage(rows: SourceItemEntity[], limit: number): PublicPage<PublicNewsItem> {
    const result = this.page(rows, limit, mapPublicNews, (row) => this.newsSort(row));
    return {
      ...result,
      items: result.items.filter((item): item is PublicNewsItem => item !== null),
    };
  }

  private page<Row extends { id: string }, Item>(
    rows: Row[],
    limit: number,
    map: (row: Row) => Item,
    sort: (row: Row) => string,
  ): PublicPage<Item> {
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => map(row)),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id, sort: sort(last) }) : null,
    };
  }
}
