import { newsAudienceForActor } from './news-access';
import { NaverFocusNewsService } from '../news-search/naver-focus-news.service';
import { CompanyInformationApiService } from './company-information.service';
import { groupActor } from '../watchlist-groups/watchlist-access.service';
import { CompanyObservationService } from '../watchlist-groups/company-observation.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  HttpCode,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  companyTimelineQuerySchema,
  createIrSourceSchema,
  cursorQuerySchema,
  eventQuerySchema,
  filingQuerySchema,
  resolveReviewSchema,
  updateIrSourceSchema,
  updateReviewSchema,
  watchlistQuotesQuerySchema,
  NewsSourceKind,
  newsCompanyIdsQuerySchema,
  companyQuotesQuerySchema,
} from '@orsem/contracts';
import { parseWith } from '../common/zod';
import { RateLimit, ReadOnlyMemberAccess } from '../security/security';
import { OrsemDataService } from './orsem-data.service';
import { LivePriceService } from './live-price.service';
import { WorkerQueueService } from '../operations/worker-queue.service';
import { MarketsService } from '../markets/markets.service';

@Controller('dashboard')
@ReadOnlyMemberAccess()
export class DashboardController {
  constructor(
    private readonly data: OrsemDataService,
    private readonly information: CompanyInformationApiService,
    private readonly naver: NaverFocusNewsService,
  ) {}
  @Get('market-selection')
  marketSelection() {
    return this.information.selection();
  }
  @Get('personal-filings')
  @Header('Cache-Control', 'private, no-store')
  personalFilings(@Req() request: Request) {
    return this.data.personalFilings(groupActor(request).key);
  }
  @Get('personal-news')
  @Header('Cache-Control', 'private, no-store')
  async personalNews(@Req() request: Request) {
    const actor = groupActor(request).key;
    const [page, provider] = await Promise.all([
      this.data.personalNews(actor, newsAudienceForActor(groupActor(request))),
      this.naver.feed({ scope: 'personal' }, actor).catch(() => null),
    ]);
    return {
      ...page,
      providerGroups: provider?.groups ?? [],
      naver: provider
        ? {
            fetchedAt: provider.fetchedAt,
            status: provider.status,
            nextRequestAt: provider.nextRequestAt,
          }
        : null,
    };
  }
  @Get()
  dashboard(): Promise<Record<string, unknown>> {
    return this.data.dashboardView();
  }
}

@Controller('sources')
@ReadOnlyMemberAccess()
export class SourcesController {
  constructor(
    private readonly data: OrsemDataService,
    private readonly markets: MarketsService,
  ) {}

  @Get('freshness')
  async freshness() {
    const [base, marketSources] = await Promise.all([
      this.data.connectorFreshness(),
      this.markets.freshness(),
    ]);
    return { ...base, items: [...base.items, ...marketSources] };
  }
}

@Controller('companies')
@ReadOnlyMemberAccess()
export class CompaniesController {
  constructor(
    private readonly data: OrsemDataService,
    private readonly livePrices: LivePriceService,
    private readonly workerQueue: WorkerQueueService,
    private readonly observations: CompanyObservationService,
    private readonly information: CompanyInformationApiService,
  ) {}

  @Get('quotes')
  @RateLimit(90)
  @Header('Cache-Control', 'private, no-store')
  async quotes(@Query() query: unknown) {
    const { ids } = parseWith(companyQuotesQuerySchema, query);
    const companies = await this.data.companiesByIds(ids);
    return this.observations.prices(companies);
  }

  @Get()
  async list(@Query() query: unknown) {
    const parsed = parseWith(
      cursorQuerySchema.extend({ q: z.string().trim().max(120).optional() }),
      query,
    );
    const page = await this.data.listCompanyViews(parsed);
    const [quotes, paths] = await Promise.all([
      this.information.quotes(page.items.map((item) => item.id)),
      this.information.canonicalPaths(page.items),
    ]);
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        canonicalPath: paths.get(item.id),
        quote: quotes.get(item.id) ?? null,
      })),
    };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const view = await this.data.getCompanyView(await this.information.resolveId(id));
    const paths = await this.information.canonicalPaths([
      view as unknown as {
        id: string;
        market: string;
        stockCode: string | null;
        ticker: string | null;
        isListed: boolean;
      },
    ]);
    return { ...view, canonicalPath: paths.get(String(view.id)) };
  }

  @Get(':id/information')
  informationForCompany(@Param('id') id: string) {
    return this.information.company(parseWith(z.uuid(), id));
  }

  @Get(':id/timeline')
  async timeline(@Param('id') id: string, @Query() query: unknown) {
    const input = parseWith(companyTimelineQuerySchema, query);
    const result = await this.data.companyTimeline(id, input.range, input.interval);
    // 큐 장애 중에도 저장된 타임라인은 조회할 수 있습니다. worker만 토큰을
    // 소유하고 모든 조회자의 수집 요청을 하나로 합칩니다.
    await this.workerQueue.requestTossCandles(id, input.interval).catch(() => undefined);
    return result;
  }

  @Get(':id/recent-activity')
  async recentActivity(@Param('id') id: string, @Query() query: unknown) {
    const companyId = parseWith(z.uuid(), id);
    const { limit } = parseWith(
      z.object({
        limit: z
          .union([z.string().regex(/^\d+$/u).transform(Number), z.number()])
          .pipe(z.number().int().min(1).max(20))
          .default(3),
      }),
      query,
    );
    await this.data.getCompany(companyId);
    return this.observations.recent(companyId, limit);
  }

  @Get(':id/live-price')
  livePrice(@Param('id') id: string) {
    return this.livePrices.companyLivePrice(id);
  }
}

@Controller('filings')
@ReadOnlyMemberAccess()
export class FilingsController {
  constructor(private readonly data: OrsemDataService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.data.listFilings(parseWith(filingQuerySchema, query));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.data.getFiling(id);
  }
}

@Controller('events')
@ReadOnlyMemberAccess()
export class EventsController {
  constructor(private readonly data: OrsemDataService) {}

  @Get()
  list(@Query() query: unknown, @Req() request: Request) {
    return this.data.listEventViews({
      ...parseWith(eventQuerySchema, query),
      audience: newsAudienceForActor(groupActor(request)),
    });
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: Request) {
    return this.data.getEventView(id, newsAudienceForActor(groupActor(request)));
  }
}

@Controller('news')
@ReadOnlyMemberAccess()
export class NewsController {
  constructor(
    private readonly data: OrsemDataService,
    private readonly naver: NaverFocusNewsService,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(@Query() query: unknown, @Req() request: Request) {
    const parsed = parseWith(
      cursorQuerySchema
        .extend({
          q: z.string().trim().max(120).optional(),
          source: z
            .enum([
              'NEWS_RSS',
              'IR',
              'SEC',
              'GDELT',
              'ALPACA_NEWS',
              'MARKETAUX',
              'ALPHAVANTAGE',
              'FINNHUB',
              'OPENDART',
            ])
            .optional(),
          sourceKind: z.enum(NewsSourceKind).optional(),
          scope: z.enum(['all', 'market', 'company']).default('all'),
          asset: z.enum(['gold', 'silver', 'wti', 'btc', 'eth']).optional(),
          publisher: z.string().trim().max(255).optional(),
          companyId: z.string().uuid().optional(),
          companyIds: newsCompanyIdsQuerySchema.optional(),
        })
        .refine(
          (value) =>
            value.companyIds === undefined ||
            (value.companyId === undefined &&
              value.asset === undefined &&
              value.scope === 'company'),
          {
            message: 'companyIds는 scope=company로만 사용하며 companyId와 함께 지정할 수 없습니다.',
          },
        ),
      query,
    );
    const page = await this.data.listNews({
      ...parsed,
      audience: newsAudienceForActor(groupActor(request)),
    });
    const include =
      !parsed.cursor &&
      !parsed.source &&
      !parsed.publisher &&
      !parsed.sourceKind &&
      (parsed.companyIds === undefined || parsed.companyIds.length > 0);
    const provider = include
      ? await this.naver.feed(parsed, groupActor(request).key).catch(() => null)
      : null;
    const term = parsed.q?.toLocaleLowerCase();
    return {
      ...page,
      providerGroups:
        provider?.groups.map((items) =>
          term
            ? items.filter((item) =>
                `${item.title} ${item.description ?? ''}`.toLocaleLowerCase().includes(term),
              )
            : items,
        ) ?? [],
      naver: provider
        ? {
            fetchedAt: provider.fetchedAt,
            status: provider.status,
            nextRequestAt: provider.nextRequestAt,
          }
        : null,
    };
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: Request) {
    return this.data.getNews(id, newsAudienceForActor(groupActor(request)));
  }
}

@Controller('ir-sources')
export class IrSourcesController {
  constructor(private readonly data: OrsemDataService) {}

  @Get()
  list(@Query() query: unknown) {
    const parsed = parseWith(
      cursorQuerySchema.extend({ companyId: z.string().min(1).max(64).optional() }),
      query,
    );
    return this.data.listIrSources(parsed);
  }

  @Post()
  create(@Body() body: unknown) {
    return this.data.createIrSource(parseWith(createIrSourceSchema, body));
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.data.updateIrSource(id, parseWith(updateIrSourceSchema, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.data.deleteIrSource(id);
  }
}

@Controller('watchlist')
@ReadOnlyMemberAccess()
export class WatchlistController {
  constructor(
    private readonly data: OrsemDataService,
    private readonly livePrices: LivePriceService,
  ) {}

  @Get()
  list(@Query() query: unknown) {
    return this.data.listWatchlistViews(parseWith(cursorQuerySchema, query));
  }

  @Get('quotes')
  @RateLimit(90)
  quotes(@Query() query: unknown) {
    return this.livePrices.watchlistQuotes(parseWith(watchlistQuotesQuerySchema, query).ids);
  }

  @Post()
  @RateLimit(30)
  create(): never {
    throw new GoneException('운영 관심 목록은 월간 시가총액 상위 20종목으로 대체되었습니다.');
  }

  @Patch(':id')
  @RateLimit(60)
  update(): never {
    throw new GoneException('시가총액 상위 종목은 매월 자동 선정되며 수동으로 변경할 수 없습니다.');
  }

  @Delete(':id')
  @HttpCode(204)
  remove(): never {
    throw new GoneException('시가총액 상위 종목은 매월 자동 선정되며 수동으로 변경할 수 없습니다.');
  }
}

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly data: OrsemDataService) {}

  @Get()
  list(@Query() query: unknown) {
    const parsed = parseWith(
      cursorQuerySchema.extend({
        status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED', 'SUPERSEDED']).optional(),
        reviewStatus: z.enum(['OPEN', 'RESOLVED', 'DISMISSED', 'SUPERSEDED']).optional(),
      }),
      query,
    );
    return this.data.listReviewViews({
      ...parsed,
      status: parsed.status ?? parsed.reviewStatus ?? 'OPEN',
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    const parsed = parseWith(updateReviewSchema, body);
    return this.data.updateReview(
      id,
      parsed.status,
      parsed.resolution ?? null,
      request.session.adminId!,
    );
  }

  @Post(':id/source-review')
  @RateLimit(30)
  confirmSource(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    return this.data.confirmReviewSource(
      parseWith(z.uuid(), id),
      parseWith(
        z
          .object({ confirmed: z.literal(true), note: z.string().trim().max(2000).optional() })
          .strict(),
        body,
      ),
      request.session.adminId!,
    );
  }

  @Post(':id/resolve')
  resolve(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    return this.data.resolveReview(
      id,
      parseWith(resolveReviewSchema, body),
      request.session.adminId!,
    );
  }
}

export const RESOURCE_CONTROLLERS = [
  DashboardController,
  SourcesController,
  CompaniesController,
  FilingsController,
  EventsController,
  NewsController,
  IrSourcesController,
  WatchlistController,
  ReviewsController,
] as const;
