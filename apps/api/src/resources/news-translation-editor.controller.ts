import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import { newsTranslationEditInputSchema } from '@orsem/contracts';
import type { Request } from 'express';
import { parseWith } from '../common/zod';
import { RateLimit } from '../security/security';
import { NewsTranslationEditorService } from './news-translation-editor.service';

// No ReadOnlyMemberAccess: both reading editor source and saving require an administrator.
@Controller('news')
export class NewsTranslationEditorController {
  constructor(private readonly editor: NewsTranslationEditorService) {}
  @Get(':id/translation-edit')
  get(@Param('id') id: string) {
    return this.editor.get(id);
  }
  @Patch(':id/translation-edit')
  @RateLimit(30)
  save(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    return this.editor.save(
      id,
      parseWith(newsTranslationEditInputSchema, body),
      request.session.adminId!,
    );
  }
}
