import type { Request } from 'express';
import { groupActor } from '../watchlist-groups/watchlist-access.service';
import { newsAudienceForActor } from '../resources/news-access';
import { Controller, Get, Query, Header, Headers, Req } from '@nestjs/common';
import { z } from 'zod';
import { regionSchema, NewsSourceKind } from '@orsem/contracts';
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

  @Get('suggestions')
  @RateLimit(90)
  @Header('Cache-Control', 'private, no-store')
  suggestions(
    @Query() query: unknown,
    @Headers('x-orsem-search-query') encoded?: string,
    @Req() request?: Request,
  ) {
    let term = encoded;
    try {
      if (encoded) term = decodeURIComponent(encoded);
    } catch {
      term = '';
    }
    const input = parseWith(
      searchQuerySchema.extend({
        kind: z.enum(['all', 'companies', 'news', 'events']).default('all'),
        scope: z.enum(['all', 'market', 'company']).optional(),
        sourceKind: z.enum(NewsSourceKind).optional(),
        publisher: z.string().max(120).optional(),
        companyId: z.string().uuid().optional(),
      }),
      { ...(typeof query === 'object' ? query : {}), ...(term !== undefined ? { q: term } : {}) },
    );
    return this.searchService.suggestions(
      input,
      request ? newsAudienceForActor(groupActor(request)) : 'MEMBER_UI',
    );
  }

  @Get()
  @RateLimit(90)
  search(@Query() query: unknown, @Req() request?: Request) {
    return this.searchService.search(
      parseWith(searchQuerySchema, query),
      request ? newsAudienceForActor(groupActor(request)) : 'MEMBER_UI',
    );
  }
}
