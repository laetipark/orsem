import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  analysisBookmarkSchema,
  analysisExportRequestSchema,
  analysisMappingSchema,
  analysisSelectionSchema,
  saveAnalysisQuerySchema,
} from '@orsem/contracts';
import { parseWith } from '../common/zod';
import { OwnAnalysisAccess, RateLimit } from '../security/security';
import { groupActor } from '../watchlist-groups/watchlist-access.service';
import { AnalysisService } from './analysis.service';

const id = (value: string) => parseWith(z.uuid(), value);
const empty = z.object({}).strict();
const documentRequest = z
  .object({
    runId: z.uuid(),
    reportId: z.uuid().optional(),
    sourceItemId: z.uuid().optional(),
    eventId: z.uuid().optional(),
    filingId: z.union([z.uuid(), z.string().regex(/^\d{14}$/u)]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.reportId, value.sourceItemId, value.eventId, value.filingId].filter(Boolean).length ===
      1,
    '공식 원문 하나를 선택하세요.',
  );
const notesQuery = z
  .object({
    runId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.runId || value.documentId, '검색할 분석 또는 문서를 선택하세요.');

@Controller('analysis')
@OwnAnalysisAccess()
@RateLimit(90)
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Get('capabilities')
  @Header('Cache-Control', 'private, no-store')
  capabilities() {
    return this.analysis.capabilities();
  }

  @Get('periods')
  @Header('Cache-Control', 'private, no-store')
  periods(@Req() request: Request, @Query() query: unknown) {
    const parsed = parseWith(z.object({ companyId: z.uuid() }).strict(), query);
    return this.analysis.periods(groupActor(request), parsed.companyId);
  }

  @Get('runs')
  @Header('Cache-Control', 'private, no-store')
  runs(@Req() request: Request, @Query() query: unknown) {
    const parsed = parseWith(z.object({ savedQueryId: z.uuid().optional() }).strict(), query);
    return this.analysis.listRuns(groupActor(request), parsed.savedQueryId);
  }

  @Post('runs')
  @RateLimit(12)
  createRun(@Req() request: Request, @Body() body: unknown) {
    return this.analysis.createRun(groupActor(request), parseWith(analysisSelectionSchema, body));
  }

  @Get('runs/:id')
  @Header('Cache-Control', 'private, no-store')
  run(@Req() request: Request, @Param('id') runId: string) {
    return this.analysis.getRun(groupActor(request), id(runId));
  }

  @Post('runs/:id/retry')
  @RateLimit(6)
  retry(@Req() request: Request, @Param('id') runId: string, @Body() body: unknown) {
    parseWith(empty, body ?? {});
    return this.analysis.retryRun(groupActor(request), id(runId));
  }

  @Get('runs/:id/validations')
  @Header('Cache-Control', 'private, no-store')
  validations(@Req() request: Request, @Param('id') runId: string) {
    return this.analysis.validations(groupActor(request), id(runId));
  }

  @Get('evidence/:id')
  @Header('Cache-Control', 'private, no-store')
  evidence(@Req() request: Request, @Param('id') factId: string, @Query() query: unknown) {
    const parsed = parseWith(z.object({ runId: z.uuid() }).strict(), query);
    return this.analysis.evidence(groupActor(request), parsed.runId, id(factId));
  }

  @Post('runs/:id/exports')
  @RateLimit(6)
  createExport(@Req() request: Request, @Param('id') runId: string, @Body() body: unknown) {
    return this.analysis.createExport(
      groupActor(request),
      id(runId),
      parseWith(analysisExportRequestSchema, body ?? {}),
    );
  }

  @Get('exports/:id')
  @Header('Cache-Control', 'private, no-store')
  export(@Req() request: Request, @Param('id') exportId: string) {
    return this.analysis.getExport(groupActor(request), id(exportId));
  }

  @Get('exports/:id/download')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(
    @Req() request: Request,
    @Param('id') exportId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const artifact = await this.analysis.downloadExport(groupActor(request), id(exportId));
    response.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${artifact.filename}"`,
      'Content-Length': String(artifact.bytes.length),
    });
    return new StreamableFile(artifact.bytes);
  }

  @Get('saved-queries')
  @Header('Cache-Control', 'private, no-store')
  saved(@Req() request: Request) {
    return this.analysis.listSaved(groupActor(request));
  }

  @Post('saved-queries')
  @RateLimit(12)
  save(@Req() request: Request, @Body() body: unknown) {
    return this.analysis.saveQuery(groupActor(request), parseWith(saveAnalysisQuerySchema, body));
  }

  @Put('saved-queries/:id')
  @RateLimit(30)
  updateSaved(@Req() request: Request, @Param('id') queryId: string, @Body() body: unknown) {
    return this.analysis.saveQuery(
      groupActor(request),
      parseWith(saveAnalysisQuerySchema, body),
      id(queryId),
    );
  }

  @Delete('saved-queries/:id')
  @HttpCode(204)
  deleteSaved(@Req() request: Request, @Param('id') queryId: string) {
    return this.analysis.deleteSaved(groupActor(request), id(queryId));
  }

  @Post('saved-queries/:id/run')
  @RateLimit(12)
  runSaved(@Req() request: Request, @Param('id') queryId: string, @Body() body: unknown) {
    parseWith(empty, body ?? {});
    return this.analysis.runSaved(groupActor(request), id(queryId));
  }

  @Post('documents')
  @RateLimit(12)
  createDocument(@Req() request: Request, @Body() body: unknown) {
    return this.analysis.createDocument(groupActor(request), parseWith(documentRequest, body));
  }

  @Get('documents/:id')
  @Header('Cache-Control', 'private, no-store')
  document(@Req() request: Request, @Param('id') documentId: string) {
    return this.analysis.getDocument(groupActor(request), id(documentId));
  }

  @Get('documents/:id/ownership')
  @Header('Cache-Control', 'private, no-store')
  async ownership(@Req() request: Request, @Param('id') documentId: string) {
    const document = await this.analysis.getDocument(groupActor(request), id(documentId));
    return {
      documentId: document.id,
      status: document.status,
      ownership: document.ownership,
      sourceUrl: document.sourceUrl,
    };
  }

  @Post('diffs')
  @RateLimit(12)
  createDiff(@Req() request: Request, @Body() body: unknown) {
    return this.analysis.createDiff(
      groupActor(request),
      parseWith(
        z
          .object({ runId: z.uuid(), beforeDocumentId: z.uuid(), afterDocumentId: z.uuid() })
          .strict(),
        body,
      ),
    );
  }

  @Get('diffs/:id')
  @Header('Cache-Control', 'private, no-store')
  diff(@Req() request: Request, @Param('id') diffId: string) {
    return this.analysis.getDiff(groupActor(request), id(diffId));
  }

  @Get('notes')
  @Header('Cache-Control', 'private, no-store')
  notes(@Req() request: Request, @Query() query: unknown) {
    return this.analysis.notes(groupActor(request), parseWith(notesQuery, query));
  }

  @Get('search')
  @Header('Cache-Control', 'private, no-store')
  search(@Req() request: Request, @Query() query: unknown) {
    return this.notes(request, query);
  }

  @Get('bookmarks')
  @Header('Cache-Control', 'private, no-store')
  bookmarks(@Req() request: Request) {
    return this.analysis.bookmarks(groupActor(request));
  }

  @Post('bookmarks')
  @RateLimit(30)
  bookmark(@Req() request: Request, @Body() body: unknown) {
    return this.analysis.createBookmark(
      groupActor(request),
      parseWith(analysisBookmarkSchema, body),
    );
  }

  @Delete('bookmarks/:id')
  @HttpCode(204)
  deleteBookmark(@Req() request: Request, @Param('id') bookmarkId: string) {
    return this.analysis.deleteBookmark(groupActor(request), id(bookmarkId));
  }

  @Get('mappings')
  @Header('Cache-Control', 'private, no-store')
  mappings(@Req() request: Request) {
    return this.analysis.mappings(groupActor(request));
  }
}

// Deliberately separate from the member-owned controller: global session guard requires admin.
@Controller('analysis/mappings')
@RateLimit(20)
export class AnalysisMappingAdminController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post()
  create(@Req() request: Request, @Body() body: unknown) {
    return this.analysis.createMapping(groupActor(request), parseWith(analysisMappingSchema, body));
  }
}

@Controller('analysis/diffs')
@RateLimit(12)
export class AnalysisDiffAdminController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post(':id/confirm')
  confirm(@Req() request: Request, @Param('id') diffId: string, @Body() body: unknown) {
    return this.analysis.confirmDiff(
      groupActor(request),
      id(diffId),
      parseWith(
        z
          .object({
            runId: z.uuid(),
            sourceUrl: z.string().url().max(2048),
            note: z.string().trim().min(10).max(2000),
          })
          .strict(),
        body,
      ),
    );
  }
}
