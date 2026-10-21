import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { marketHistoryRangeSchema, regionSchema } from '@orsem/contracts';
import { z } from 'zod';
import { parseWith } from '../common/zod';
import { Public, RateLimit } from '../security/security';
import { MarketsService } from './markets.service';

@Controller('public/markets')
export class PublicMarketsController {
  constructor(private readonly markets: MarketsService) {}

  @Get('overview')
  @Public()
  @RateLimit(60)
  @Header('Cache-Control', 'public, max-age=60')
  overview(@Query() query: unknown) {
    const input = parseWith(
      z.object({ region: regionSchema, historyRange: z.literal('1m').optional() }).strict(),
      query,
    );
    return this.markets.publicOverview(input.region, input.historyRange);
  }

  @Get(':id/history')
  @Public()
  @RateLimit(60)
  @Header('Cache-Control', 'public, max-age=60')
  history(@Param('id') id: string, @Query() query: unknown) {
    const input = parseWith(
      z.object({ range: marketHistoryRangeSchema.default('1m') }).strict(),
      query,
    );
    return this.markets.publicHistory(id, input.range);
  }
}
