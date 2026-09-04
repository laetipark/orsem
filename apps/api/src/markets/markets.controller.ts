import { Controller, Get, Param, Query } from '@nestjs/common';
import { marketHistoryRangeSchema, regionSchema } from '@orsem/contracts';
import { z } from 'zod';
import { parseWith } from '../common/zod';
import { ReadOnlyMemberAccess } from '../security/security';
import { MarketsService } from './markets.service';

@Controller('markets')
@ReadOnlyMemberAccess()
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}
  @Get('overview')
  overview(@Query() query: unknown) {
    return this.markets.overview(parseWith(z.object({ region: regionSchema }), query).region);
  }
  @Get(':id/history')
  history(@Param('id') id: string, @Query() query: unknown) {
    return this.markets.history(
      id,
      parseWith(z.object({ range: marketHistoryRangeSchema.default('1m') }), query).range,
    );
  }
}
