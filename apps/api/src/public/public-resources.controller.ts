import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { parseWith } from '../common/zod';
import { Public, RateLimit } from '../security/security';
import { PublicResourcesService } from './public-resources.service';

export const publicCompanyQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    region: z.enum(['all', 'kr', 'us']).default('all'),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const publicNewsQuerySchema = publicCompanyQuerySchema.extend({
  companyId: z.string().uuid().optional(),
});

@Controller('public')
export class PublicResourcesController {
  constructor(private readonly resources: PublicResourcesService) {}

  @Get('companies')
  @Public()
  @RateLimit(90)
  @Header('Cache-Control', 'public, max-age=30')
  companies(@Query() query: unknown) {
    return this.resources.companies(parseWith(publicCompanyQuerySchema, query));
  }

  @Get('companies/:id')
  @Public()
  @RateLimit(90)
  @Header('Cache-Control', 'public, max-age=30')
  company(@Param('id') id: string) {
    return this.resources.company(id);
  }

  @Get('news')
  @Public()
  @RateLimit(90)
  @Header('Cache-Control', 'public, max-age=30')
  news(@Query() query: unknown) {
    return this.resources.news(parseWith(publicNewsQuerySchema, query));
  }

  @Get('news/:id')
  @Public()
  @RateLimit(90)
  @Header('Cache-Control', 'public, max-age=30')
  newsItem(@Param('id') id: string) {
    return this.resources.newsItem(id);
  }
}
