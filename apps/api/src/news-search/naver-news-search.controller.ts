import { groupActor } from '../watchlist-groups/watchlist-access.service';
import type { Request } from 'express';
import { z } from 'zod';
import { NaverFocusNewsService } from './naver-focus-news.service';
import { BadRequestException, Controller, Get, Header, Headers, Param, Req } from '@nestjs/common';
import { parseWith } from '../common/zod';
import { RateLimit, ReadOnlyMemberAccess } from '../security/security';
import { NaverNewsSearchService, naverNewsSearchQuerySchema } from './naver-news-search.service';

@Controller('news-search/naver')
@ReadOnlyMemberAccess()
export class NaverNewsSearchController {
  constructor(
    private readonly searchService: NaverNewsSearchService,
    private readonly focus: NaverFocusNewsService,
  ) {}

  @Get('focus/:companyId')
  @Header('Cache-Control', 'private, no-store')
  focusNews(@Param('companyId') companyId: string, @Req() request: Request) {
    return this.focus.company(parseWith(z.uuid(), companyId), groupActor(request).key);
  }

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status() {
    return this.searchService.status();
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @RateLimit(20)
  search(
    @Headers('x-orsem-news-query') encodedQuery: string | undefined,
    @Headers('x-orsem-news-start') start: string | undefined,
    @Headers('x-orsem-news-sort') sort: string | undefined,
  ) {
    // Keep user-entered terms out of the URL so a conventional proxy access log
    // cannot retain them. The provider request remains a fixed, no-store GET.
    let q: string | undefined;
    try {
      q = encodedQuery === undefined ? undefined : decodeURIComponent(encodedQuery);
    } catch {
      throw new BadRequestException('잘못된 뉴스 검색 요청입니다.');
    }
    return this.searchService.search(parseWith(naverNewsSearchQuerySchema, { q, start, sort }));
  }
}
