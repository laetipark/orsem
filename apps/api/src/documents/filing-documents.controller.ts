import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Res,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilingDocumentEntity, FilingEntity } from '@orsem/database';
import { RightsMode } from '@orsem/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { Inject } from '@nestjs/common';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';

@Controller('filings/:filingId')
export class FilingDocumentsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
  ) {}

  @Get('document')
  async latest(
    @Param('filingId') filingId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.download(filingId, null, response);
  }

  @Get('documents/:documentId')
  async download(
    @Param('filingId') filingId: string,
    @Param('documentId') documentId: string | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const source = this.database.dataSource;
    if (!source) throw new ServiceUnavailableException('공시 문서 저장소를 사용할 수 없습니다.');
    const filing = await source
      .getRepository(FilingEntity)
      .createQueryBuilder('filing')
      .where('filing.id = :filingId OR filing.rceptNo = :filingId', { filingId })
      .getOne();
    if (!filing) throw new NotFoundException('공시를 찾을 수 없습니다.');
    const document = documentId
      ? await source
          .getRepository(FilingDocumentEntity)
          .findOneBy({ id: documentId, filingId: filing.id })
      : await source
          .getRepository(FilingDocumentEntity)
          .findOne({ where: { filingId: filing.id }, order: { retrievedAt: 'DESC' } });
    if (!document) throw new NotFoundException('공시 원문을 찾을 수 없습니다.');
    if (
      document.rightsMode === RightsMode.STORE_METADATA_ONLY ||
      document.rightsMode === RightsMode.LINK_ONLY ||
      document.rightsMode === RightsMode.NO_REDISTRIBUTION
    ) {
      throw new ForbiddenException(
        '이 문서는 권리 정책상 API로 전송할 수 없습니다. 공식 원문 링크를 사용하세요.',
      );
    }
    const path = await this.safeLocalPath(document.objectUri);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException('보관된 공시 원문 파일을 찾을 수 없습니다.');
    const filename = sanitizeFilename(document.originalFilename ?? basename(path));
    response.set({
      'Content-Type': document.mediaType,
      'Content-Length': String(info.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(createReadStream(path));
  }

  private async safeLocalPath(objectUri: string): Promise<string> {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(objectUri) && !objectUri.startsWith('file://')) {
      throw new ServiceUnavailableException('현재 API는 로컬 보관 문서만 직접 전송할 수 있습니다.');
    }
    const base = await realpath(this.config.rawDocumentDir).catch(() =>
      resolve(this.config.rawDocumentDir),
    );
    const supplied = objectUri.startsWith('file://') ? fileURLToPath(objectUri) : objectUri;
    const candidate = isAbsolute(supplied) ? supplied : resolve(base, supplied);
    const canonical = await realpath(candidate).catch(() => candidate);
    const traversal = relative(base, canonical);
    if (traversal === '..' || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) {
      throw new ForbiddenException('허용된 원문 저장 경로 밖의 파일에는 접근할 수 없습니다.');
    }
    return canonical;
  }
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\r\n"\\/]/gu, '_').slice(0, 200) || 'filing-document.bin';
}
