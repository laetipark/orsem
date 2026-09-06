import { publicNewsTranslation, storedTranslationSchema } from '../common/news-translation';
import { publicNewsContent, storedTranslationMetadataSchema } from './news-content';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  newsBlocksToMarkdown,
  newsContentBlockSchema,
  newsContentOriginalSchema,
  newsTranslationEditSchema,
  parseNewsMarkdown,
  type NewsTranslationEdit,
  type NewsTranslationEditInput,
} from '@orsem/contracts';
import {
  NewsArticleContentEntity,
  NewsItemEntity,
  NewsTranslationRevisionEntity,
  SourceItemEntity,
  type ManualNewsMetadataTranslation,
  type ManualNewsContentTranslation,
} from '@orsem/database';
import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import {
  allowsNewsEditingPolicy,
  manualContentSchema,
  manualMetadataSchema,
  manualRevisionMatches,
  storedJson,
} from './manual-news-translation';
import { newsFiltersSql, PUBLIC_NEWS_PUBLISHERS } from './news-query';

interface EditableArticle {
  source: SourceItemEntity;
  content: NewsArticleContentEntity;
  news: NewsItemEntity | null;
}
const originalBlocksSchema = z.array(newsContentBlockSchema).min(1).max(2_000);

@Injectable()
export class NewsTranslationEditorService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
  ) {}

  private databaseSource() {
    if (this.config.fixtureMode)
      throw new ServiceUnavailableException('예시 모드에서는 원문 번역을 저장할 수 없습니다.');
    return this.database.requireDataSource();
  }

  private async resolvedId(id: string): Promise<string> {
    const repository = this.databaseSource().getRepository(SourceItemEntity);
    const direct = await repository.findOneBy({ id });
    if (direct) return direct.id;
    // Administrative recovery must still resolve grouped article URLs after a hash change hides
    // the public translation. The locked load below validates the current original and rights.
    const candidate = await repository
      .createQueryBuilder('item')
      .where('(item.news_article_id = :id OR item.externalId = :id)', { id })
      .andWhere(newsFiltersSql('item', {}))
      .orderBy('CASE WHEN item.manual_translation_json IS NULL THEN 1 ELSE 0 END', 'ASC')
      .addOrderBy('item.first_observed_at', 'ASC')
      .addOrderBy('item.id', 'ASC')
      .getOne();
    if (!candidate) throw new NotFoundException('뉴스 원문을 찾을 수 없습니다.');
    return candidate.id;
  }

  private async load(
    manager: EntityManager,
    sourceItemId: string,
    lock: boolean,
    expectedRevision?: string,
  ): Promise<EditableArticle> {
    // The worker uses the same source → content lock order for claims and ingestion.
    const sourceQuery = manager
      .getRepository(SourceItemEntity)
      .createQueryBuilder('source')
      .where('source.id = :id', { id: sourceItemId });
    if (lock) sourceQuery.setLock('pessimistic_write');
    const source = await sourceQuery.getOne();
    if (!source) throw new NotFoundException('뉴스 원문을 찾을 수 없습니다.');
    const contentQuery = manager
      .getRepository(NewsArticleContentEntity)
      .createQueryBuilder('content')
      .where('content.sourceItemId = :id', { id: sourceItemId });
    if (lock) contentQuery.setLock('pessimistic_write');
    const content = await contentQuery.getOne();
    const news = content
      ? await manager.getRepository(NewsItemEntity).findOneBy({ sourceItemId })
      : null;
    if (
      content &&
      expectedRevision &&
      this.revision({ source, content, news }) !== expectedRevision
    )
      throw new ConflictException(
        '원문이나 번역이 변경되었습니다. 최신 내용을 불러온 뒤 다시 저장하세요.',
      );
    const metadata = source.rawMetadataJson ?? {};
    const publisher =
      typeof metadata.publisherId === 'string'
        ? metadata.publisherId
        : (source.sourceName ?? source.source);
    if (
      !content ||
      content.status !== 'AVAILABLE' ||
      content.language !== 'en' ||
      !content.fetchedAt ||
      !Number.isFinite(content.fetchedAt.getTime()) ||
      !source.rawHash ||
      !/^[a-f0-9]{64}$/u.test(source.rawHash) ||
      !content.contentHash ||
      !/^[a-f0-9]{64}$/u.test(content.contentHash) ||
      !['IR', 'NEWS_RSS'].includes(source.source) ||
      !['OFFICIAL_RELEASE', 'COMPANY_IR'].includes(source.sourceKind ?? '') ||
      !PUBLIC_NEWS_PUBLISHERS.includes(publisher as (typeof PUBLIC_NEWS_PUBLISHERS)[number]) ||
      !allowsNewsEditingPolicy(source.sourcePolicyJson, source.rightsMode) ||
      !allowsNewsEditingPolicy(content.rightsPolicyJson, source.rightsMode)
    ) {
      throw new NotFoundException('권리와 원문 본문이 확인된 영문 뉴스만 편집할 수 있습니다.');
    }
    const original = newsContentOriginalSchema.safeParse({
      language: content.language,
      blocks: content.blocksJson,
      fetchedAt: content.fetchedAt.toISOString(),
    });
    const saved = storedJson(content.translationJson) as Record<string, unknown> | null;
    if (
      !original.success ||
      !storedTranslationSchema.safeParse(storedJson(source.translationJson)).success ||
      !storedTranslationMetadataSchema.safeParse(saved).success ||
      !originalBlocksSchema.safeParse(saved?.blocks).success
    ) {
      throw new NotFoundException('원문과 완료된 번역 본문이 확인된 뉴스만 편집할 수 있습니다.');
    }
    if (source.manualTranslationJson != null || content.manualTranslationJson != null) {
      const metadata = manualMetadataSchema.safeParse(storedJson(source.manualTranslationJson));
      const body = manualContentSchema.safeParse(storedJson(content.manualTranslationJson));
      const revision = metadata.success
        ? await manager
            .getRepository(NewsTranslationRevisionEntity)
            .findOneBy({ id: metadata.data.revisionId })
        : null;
      // An existing audited edit can be reviewed again after its original source hash changes.
      if (
        !metadata.success ||
        !body.success ||
        revision?.sourceItemId !== source.id ||
        !manualRevisionMatches(metadata.data, body.data, revision)
      )
        throw new NotFoundException('검증된 수동 번역 이력을 찾을 수 없습니다.');
    } else if (!publicNewsTranslation(source) || !publicNewsContent(content, source.rightsMode)) {
      throw new NotFoundException('원문과 해시·구조가 일치하는 완료 번역만 편집할 수 있습니다.');
    }
    return { source, content, news };
  }

  private revision(article: EditableArticle): string {
    const { source, content, news } = article;
    return createHash('sha256')
      .update(
        JSON.stringify({
          sourceItemId: source.id,
          sourceHash: source.rawHash,
          contentHash: content.contentHash,
          title: source.title,
          description: source.rawMetadataJson?.description,
          newsTitle: news?.title,
          newsDescription: news?.description,
          sourcePolicy: source.sourcePolicyJson,
          contentPolicy: content.rightsPolicyJson,
          fetchedAt: content.fetchedAt,
          blocks: content.blocksJson,
          machineMetadata: source.translationJson,
          machineContent: content.translationJson,
          manualMetadata: source.manualTranslationJson,
          manualContent: content.manualTranslationJson,
        }),
      )
      .digest('hex');
  }

  private view(article: EditableArticle): NewsTranslationEdit {
    const { source, content, news } = article;
    const manualTitle = manualMetadataSchema.safeParse(storedJson(source.manualTranslationJson));
    const manualBody = manualContentSchema.safeParse(storedJson(content.manualTranslationJson));
    const machineTitle = storedJson(source.translationJson) as Record<string, unknown> | null;
    const machineBody = storedJson(content.translationJson) as Record<string, unknown>;
    const savedBlocks = originalBlocksSchema.parse(machineBody.blocks);
    // Stale manual text stays available only to the editor, beside the newly validated original.
    return newsTranslationEditSchema.parse({
      sourceItemId: source.id,
      revision: this.revision(article),
      original: {
        title: news?.title ?? source.title,
        description:
          news?.description ??
          (typeof source.rawMetadataJson?.description === 'string'
            ? source.rawMetadataJson.description
            : null),
        language: content.language,
        markdown: newsBlocksToMarkdown(originalBlocksSchema.parse(content.blocksJson)),
      },
      translation: {
        title: manualTitle.success
          ? manualTitle.data.title
          : typeof machineTitle?.title === 'string'
            ? machineTitle.title
            : '',
        description: manualTitle.success
          ? manualTitle.data.description
          : typeof machineTitle?.description === 'string'
            ? machineTitle.description
            : null,
        markdown: manualBody.success ? manualBody.data.markdown : newsBlocksToMarkdown(savedBlocks),
      },
      editedAt: manualTitle.success ? manualTitle.data.editedAt : null,
      editedByAdminId: manualTitle.success ? manualTitle.data.editedByAdminId : null,
    });
  }

  async get(id: string): Promise<NewsTranslationEdit> {
    const sourceItemId = await this.resolvedId(id);
    return this.databaseSource().transaction('REPEATABLE READ', async (manager) =>
      this.view(await this.load(manager, sourceItemId, false)),
    );
  }

  async save(
    id: string,
    input: NewsTranslationEditInput,
    adminId: string,
  ): Promise<NewsTranslationEdit> {
    let blocks;
    try {
      blocks = parseNewsMarkdown(input.markdown);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '마크다운 본문을 확인하세요.',
      );
    }
    const sourceItemId = await this.resolvedId(id);
    return this.databaseSource().transaction(async (manager) => {
      const article = await this.load(manager, sourceItemId, true, input.revision);
      const { source, content } = article;
      const identity = {
        version: 1 as const,
        revisionId: randomUUID(),
        sourceHash: source.rawHash!,
        contentHash: content.contentHash!,
        editedAt: new Date().toISOString(),
        editedByAdminId: adminId,
      };
      const metadata: ManualNewsMetadataTranslation = {
        ...identity,
        title: input.title,
        description: input.description,
      };
      const body: ManualNewsContentTranslation = {
        ...identity,
        blocks,
        markdown: input.markdown.replace(/\r\n?/gu, '\n'),
      };
      await manager.getRepository(NewsTranslationRevisionEntity).insert({
        id: identity.revisionId,
        sourceItemId: source.id,
        editedByAdminId: adminId,
        sourceHash: identity.sourceHash,
        contentHash: identity.contentHash,
        previousManualJson:
          source.manualTranslationJson || content.manualTranslationJson
            ? { metadata: source.manualTranslationJson, content: content.manualTranslationJson }
            : null,
        manualJson: { metadata, content: body },
      });
      // Only the override columns are changed. Raw fields and the complete AI result remain intact.
      await manager
        .getRepository(SourceItemEntity)
        .update(source.id, { manualTranslationJson: metadata });
      await manager
        .getRepository(NewsArticleContentEntity)
        .update(content.id, { manualTranslationJson: body });
      source.manualTranslationJson = metadata;
      content.manualTranslationJson = body;
      return this.view(article);
    });
  }
}
