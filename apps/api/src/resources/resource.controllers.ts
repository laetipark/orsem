import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createWatchlistItemSchema,
  companyTimelineQuerySchema,
  createIrSourceSchema,
  cursorQuerySchema,
  eventQuerySchema,
  filingQuerySchema,
  resolveReviewSchema,
  updateIrSourceSchema,
  updateReviewSchema,
  updateWatchlistItemSchema,
  watchlistQuotesQuerySchema,
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
  constructor(private readonly data: OrsemDataService) {}
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
  ) {}

  @Get()
  list(@Query() query: unknown) {
    const parsed = parseWith(
      cursorQuerySchema.extend({ q: z.string().trim().max(120).optional() }),
      query,
    );
    return this.data.listCompanyViews(parsed);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.data.getCompanyView(id);
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
  list(@Query() query: unknown) {
    return this.data.listEventViews(parseWith(eventQuerySchema, query));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.data.getEventView(id);
  }
}

@Controller('news')
@ReadOnlyMemberAccess()
export class NewsController {
  constructor(private readonly data: OrsemDataService) {}

  @Get()
  list(@Query() query: unknown) {
    const parsed = parseWith(
      cursorQuerySchema.extend({
        q: z.string().trim().max(120).optional(),
        source: z.enum(['NEWS_RSS', 'NAVER', 'IR', 'SEC', 'GDELT', 'OPENDART']).optional(),
      }),
      query,
    );
    return this.data.listNews(parsed);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.data.getNews(id);
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
  create(@Body() body: unknown) {
    const input = parseWith(createWatchlistItemSchema, body);
    const { note, ...values } = input;
    const notes = input.notes !== undefined ? input.notes : (note ?? null);
    return this.data.createWatchlist({ ...values, notes });
  }

  @Patch(':id')
  @RateLimit(60)
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = parseWith(updateWatchlistItemSchema, body);
    const { note, ...values } = input;
    const notes = input.notes !== undefined ? input.notes : note;
    return this.data.updateWatchlist(id, notes === undefined ? values : { ...values, notes });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.data.deleteWatchlist(id);
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
