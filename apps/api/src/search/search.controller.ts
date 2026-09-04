import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { regionSchema } from '@orsem/contracts';
import { parseWith } from '../common/zod';
import { RateLimit, ReadOnlyMemberAccess } from '../security/security';
import { SearchService } from './search.service';

export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(120),
    limit: z.coerce.number().int().min(1).max(10).default(5),
    region: regionSchema,
  })
  .strict();

@Controller('search')
@ReadOnlyMemberAccess()
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @RateLimit(90)
  search(@Query() query: unknown) {
    return this.searchService.search(parseWith(searchQuerySchema, query));
  }
}
