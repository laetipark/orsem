import { GoneException, Inject, Injectable } from '@nestjs/common';
import type { NewsTranslationEdit, NewsTranslationEditInput } from '@orsem/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';

/** Retained routes fail closed for clients with a cached body editor. Never access stored bodies. */
@Injectable()
export class NewsTranslationEditorService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
  ) {}
  async get(_id: string): Promise<NewsTranslationEdit> {
    void _id;
    throw new GoneException(
      '기사 본문 편집이 종료되었습니다. 원문 페이지에서 기사를 확인해 주세요.',
    );
  }
  async save(
    _id: string,
    _input: NewsTranslationEditInput,
    _adminId: string,
  ): Promise<NewsTranslationEdit> {
    void _id;
    void _input;
    void _adminId;
    throw new GoneException(
      '기사 본문 편집이 종료되었습니다. 원문 페이지에서 기사를 확인해 주세요.',
    );
  }
}
