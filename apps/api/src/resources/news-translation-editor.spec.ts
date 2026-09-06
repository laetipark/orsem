import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  NewsArticleContentEntity,
  NewsItemEntity,
  NewsTranslationRevisionEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { DataSource } from 'typeorm';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import type { AuthService } from '../auth/auth.service';
import type { MemberService } from '../auth/member.service';
import { AdminSessionGuard, CsrfGuard } from '../security/security';
import { NewsTranslationEditorController } from './news-translation-editor.controller';
import { NewsTranslationEditorService } from './news-translation-editor.service';
import { publicNewsContent } from './news-content';
import { publicNewsTranslation } from '../common/news-translation';
import { verifyManualNewsSources } from './manual-news-translation';

function context() {
  const now = new Date('2026-09-05T00:00:00Z');
  const policy = {
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    metadataStorageAllowed: true,
    displayAllowed: true,
    fullTextStorageAllowed: true,
    aiAllowed: true,
  };
  const source: SourceItemEntity = Object.assign(new SourceItemEntity(), {
    id: '10000000-0000-4000-8000-000000000001',
    source: 'IR',
    sourceKind: 'COMPANY_IR',
    title: 'Original title',
    rawMetadataJson: { publisherId: 'samsung-global-newsroom', description: 'Original summary' },
    rawHash: 'a'.repeat(64),
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    sourcePolicyJson: policy,
    translationJson: {
      version: 1,
      status: 'COMPLETED',
      inputHash: 'a'.repeat(64),
      provider: 'LOCAL',
      model: 'original-model',
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      title: '기존 번역',
      description: '기존 요약',
      translatedAt: now.toISOString(),
      attemptedAt: now.toISOString(),
      attempts: 1,
      nextAttemptAt: null,
    },
    manualTranslationJson: null,
  });
  const content: NewsArticleContentEntity = Object.assign(new NewsArticleContentEntity(), {
    id: '10000000-0000-4000-8000-000000000002',
    sourceItemId: source.id,
    status: 'AVAILABLE',
    language: 'en',
    blocksJson: [{ type: 'PARAGRAPH', text: 'Original body' }],
    contentHash: 'b'.repeat(64),
    fetchedAt: now,
    rightsPolicyJson: policy,
    translationJson: {
      version: 1,
      status: 'COMPLETED',
      inputHash: 'b'.repeat(64),
      provider: 'LOCAL',
      model: 'original-model',
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      blocks: [{ type: 'PARAGRAPH', text: '기존 본문' }],
      translatedAt: now.toISOString(),
      attemptedAt: now.toISOString(),
      attempts: 1,
      nextAttemptAt: null,
    },
    manualTranslationJson: null,
  });
  const revisions: Record<string, unknown>[] = [];
  const locks: string[] = [];
  const updates: Array<{ entity: unknown; data: Record<string, unknown> }> = [];
  const database = {
    getRepository(entity: unknown) {
      const row =
        entity === SourceItemEntity ? source : entity === NewsArticleContentEntity ? content : null;
      return {
        findOneBy: async (where: { id?: string }) =>
          entity === NewsTranslationRevisionEntity
            ? (revisions.find((revision) => revision.id === where.id) ?? null)
            : entity === NewsItemEntity
              ? null
              : row && (!where.id || row.id === where.id)
                ? row
                : null,
        findBy: async () => (row ? [row] : []),
        find: async () => (entity === NewsTranslationRevisionEntity ? revisions : []),
        createQueryBuilder(alias: string) {
          return {
            where() {
              return this;
            },
            andWhere() {
              return this;
            },
            orderBy() {
              return this;
            },
            addOrderBy() {
              return this;
            },
            setLock() {
              locks.push(alias);
              return this;
            },
            getOne: async () => row,
          };
        },
        insert: async (value: Record<string, unknown>) => {
          revisions.push(structuredClone(value));
        },
        update: async (_id: string, data: Record<string, unknown>) => {
          updates.push({ entity, data });
          Object.assign(row!, data);
        },
      };
    },
    async transaction<T>(
      isolationOrCallback: unknown,
      callback?: (manager: unknown) => Promise<T>,
    ) {
      const execute = typeof isolationOrCallback === 'function' ? isolationOrCallback : callback;
      return execute!(database);
    },
  } as unknown as DataSource;
  const editor = new NewsTranslationEditorService(loadAppConfig({ NODE_ENV: 'test' }), {
    requireDataSource: () => database,
  } as DatabaseRuntimeService);
  return { editor, database, source, content, revisions, locks, updates };
}

test('manual edits atomically preserve original and AI fields, allow new block structure, and record history', async () => {
  const { editor, database, source, content, revisions, locks, updates } = context();
  const originalSource = structuredClone(source);
  const originalContent = structuredClone(content);
  const form = await editor.get(source.id);
  const saved = await editor.save(
    source.id,
    {
      revision: form.revision,
      title: '수정 제목',
      description: null,
      markdown: '## 제목\n\n새 **문단**\n\n- 목록',
    },
    'admin-1',
  );
  assert.notEqual(saved.revision, form.revision);
  assert.equal(saved.translation.title, '수정 제목');
  assert.equal(saved.editedByAdminId, 'admin-1');
  assert.deepEqual(locks, ['source', 'content']);
  assert.equal(revisions.length, 1);
  assert.ok(updates.every((update) => Object.keys(update.data).join() === 'manualTranslationJson'));
  assert.deepEqual(source.translationJson, originalSource.translationJson);
  assert.deepEqual(content.translationJson, originalContent.translationJson);
  assert.deepEqual(content.blocksJson, originalContent.blocksJson);
  assert.equal(source.title, originalSource.title);
  await verifyManualNewsSources(database, [source], [content]);
  assert.equal(publicNewsTranslation(source)?.title, '수정 제목');
  const displayed = publicNewsContent(content, source.rightsMode)!;
  assert.equal(displayed.translation?.format, 'MARKDOWN');
  assert.equal(displayed.translation?.blocks.length, 3);
  assert.equal(displayed.translation?.provider, 'LOCAL');
  assert.equal(displayed.translation?.model, 'original-model');
  assert.ok(!JSON.stringify(displayed).includes('admin-1'));
  await assert.rejects(
    () =>
      editor.save(
        source.id,
        { revision: form.revision, title: '늦은 저장', description: '', markdown: '본문' },
        'admin-2',
      ),
    ConflictException,
  );
  assert.equal(revisions.length, 1);
  const next = await editor.save(
    source.id,
    { revision: saved.revision, title: '다음 수정', description: '요약', markdown: '본문' },
    'admin-1',
  );
  assert.notEqual(next.revision, saved.revision);
  assert.equal(revisions.length, 2);
  assert.ok(revisions[1]!.previousManualJson);
});

test('stale source/content hashes hide manual output and require a refreshed editor before saving', async () => {
  const { editor, database, source, content } = context();
  const first = await editor.get(source.id);
  const saved = await editor.save(
    source.id,
    { revision: first.revision, title: '수정 제목', description: null, markdown: '수동 본문' },
    'admin-1',
  );
  content.contentHash = 'c'.repeat(64);
  content.blocksJson = [{ type: 'PARAGRAPH', text: 'Changed original body' }];
  await verifyManualNewsSources(database, [source], [content]);
  assert.equal(publicNewsTranslation(source), null);
  assert.equal(publicNewsContent(content, source.rightsMode), null);
  await assert.rejects(
    () =>
      editor.save(
        source.id,
        { revision: saved.revision, title: 'stale', description: null, markdown: 'stale' },
        'admin-1',
      ),
    ConflictException,
  );
  source.newsArticleId = '10000000-0000-4000-8000-000000000003';
  const current = await editor.get(source.newsArticleId);
  assert.equal(current.sourceItemId, source.id);
  assert.equal(current.original.markdown, 'Changed original body');
  assert.equal(current.translation.markdown, '수동 본문');
  await editor.save(
    source.id,
    {
      revision: current.revision,
      title: '새 원문 검토',
      description: null,
      markdown: '새 원문 기준 번역',
    },
    'admin-1',
  );
  await verifyManualNewsSources(database, [source], [content]);
  assert.equal(
    publicNewsContent(content, source.rightsMode)?.translation?.blocks[0]?.type,
    'PARAGRAPH',
  );
});

test('editor and manual display reject missing AI completion, denied rights, malformed Markdown, and missing revision history', async () => {
  for (const mutation of [
    (ctx: ReturnType<typeof context>) => {
      ctx.content.contentHash = 'f'.repeat(64);
    },
    (ctx: ReturnType<typeof context>) => {
      ctx.content.blocksJson = [{ type: 'HEADING', level: 2, text: 'Changed structure' }];
    },
    (ctx: ReturnType<typeof context>) => {
      ctx.content.status = 'PENDING';
    },
    (ctx: ReturnType<typeof context>) => {
      ctx.content.translationJson = null;
    },
    (ctx: ReturnType<typeof context>) => {
      ctx.content.rightsPolicyJson = { ...ctx.content.rightsPolicyJson, aiAllowed: false };
    },
    (ctx: ReturnType<typeof context>) => {
      ctx.source.rightsMode = 'STORE_METADATA_ONLY';
    },
  ]) {
    const ctx = context();
    mutation(ctx);
    await assert.rejects(() => ctx.editor.get(ctx.source.id), NotFoundException);
  }
  const ctx = context();
  const form = await ctx.editor.get(ctx.source.id);
  await assert.rejects(
    () =>
      ctx.editor.save(
        ctx.source.id,
        {
          revision: form.revision,
          title: '제목',
          description: null,
          markdown: '<script>alert(1)</script>',
        },
        'admin-1',
      ),
    BadRequestException,
  );
  assert.equal(ctx.updates.length, 0);
  await ctx.editor.save(
    ctx.source.id,
    { revision: form.revision, title: '제목', description: null, markdown: '본문' },
    'admin-1',
  );
  ctx.revisions.splice(0);
  await verifyManualNewsSources(ctx.database, [ctx.source], [ctx.content]);
  assert.equal(publicNewsTranslation(ctx.source), null);
  assert.equal(publicNewsContent(ctx.content, ctx.source.rightsMode), null);
});

function securityContext(
  method: 'GET' | 'PATCH',
  identity: 'member' | 'admin',
  suppliedCsrf = 'csrf',
): ExecutionContext {
  const request = {
    method,
    session: {
      [identity === 'admin' ? 'adminId' : 'memberId']: 'id',
      sessionStartedAt: new Date().toISOString(),
      csrfToken: 'csrf',
    },
    header: () => suppliedCsrf,
  };
  return {
    getClass: () => NewsTranslationEditorController,
    getHandler: () => NewsTranslationEditorController.prototype[method === 'GET' ? 'get' : 'save'],
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

test('both editor endpoints require an administrator and saving retains CSRF protection', async () => {
  const guard = new AdminSessionGuard(
    new Reflector(),
    { getAdmin: async () => ({ id: 'id' }) } as unknown as AuthService,
    { getMember: async () => ({ role: 'VIEWER', status: 'APPROVED' }) } as unknown as MemberService,
  );
  for (const method of ['GET', 'PATCH'] as const) {
    await assert.rejects(() => guard.canActivate(securityContext(method, 'member')));
    assert.equal(await guard.canActivate(securityContext(method, 'admin')), true);
  }
  const csrf = new CsrfGuard(new Reflector());
  assert.throws(() => csrf.canActivate(securityContext('PATCH', 'admin', 'bad')));
  assert.equal(csrf.canActivate(securityContext('PATCH', 'admin')), true);
});

test('historical Azure results retain their original provider through manual corrections after connector removal', async () => {
  const { editor, database, source, content } = context();
  source.translationJson = {
    ...source.translationJson!,
    provider: 'AZURE',
    model: 'azure-translator-v3',
  };
  content.translationJson = {
    ...content.translationJson!,
    provider: 'AZURE',
    model: 'azure-translator-v3',
  };
  assert.equal(publicNewsTranslation(source)?.provider, 'AZURE');
  assert.equal(publicNewsContent(content, source.rightsMode)?.translation?.provider, 'AZURE');
  const form = await editor.get(source.id);
  await editor.save(
    source.id,
    { revision: form.revision, title: '검토 제목', description: null, markdown: '검토 **본문**' },
    'admin-1',
  );
  await verifyManualNewsSources(database, [source], [content]);
  assert.equal(publicNewsTranslation(source)?.provider, 'AZURE');
  assert.equal(
    publicNewsContent(content, source.rightsMode)?.translation?.model,
    'azure-translator-v3',
  );
  assert.ok(publicNewsTranslation(source)?.editedAt);
});

test('manual output rejects valid-looking content or title changes not present in the revision audit', async () => {
  for (const field of ['title', 'body'] as const) {
    const ctx = context();
    const first = await ctx.editor.get(ctx.source.id);
    await ctx.editor.save(
      ctx.source.id,
      {
        revision: first.revision,
        title: '제목',
        description: null,
        markdown: '저장한 본문',
      },
      'admin-1',
    );
    if (field === 'title') ctx.source.manualTranslationJson!.title = '이력에 없는 제목';
    else {
      ctx.content.manualTranslationJson!.markdown = '이력에 없는 본문';
      ctx.content.manualTranslationJson!.blocks = [{ type: 'PARAGRAPH', text: '이력에 없는 본문' }];
    }
    await verifyManualNewsSources(ctx.database, [ctx.source], [ctx.content]);
    assert.equal(publicNewsTranslation(ctx.source), null);
    assert.equal(publicNewsContent(ctx.content, ctx.source.rightsMode), null);
    await assert.rejects(() => ctx.editor.get(ctx.source.id), NotFoundException);
  }
});

test('manual revision validation batches a page and adds no reads for automatic-only news', async () => {
  const untouched = context();
  const noReads = {
    getRepository: () => {
      throw new Error('Unexpected database read');
    },
  } as unknown as DataSource;
  await verifyManualNewsSources(noReads, [untouched.source], [untouched.content]);
  const articles: Array<ReturnType<typeof context>> = [];
  for (let index = 0; index < 20; index += 1) {
    const ctx = context();
    ctx.source.id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    ctx.content.sourceItemId = ctx.source.id;
    const form = await ctx.editor.get(ctx.source.id);
    await ctx.editor.save(
      ctx.source.id,
      { revision: form.revision, title: '제목', description: null, markdown: '본문' },
      'admin-1',
    );
    articles.push(ctx);
  }
  const reads: unknown[] = [];
  const database = {
    getRepository: (entity: unknown) => ({
      findBy: async () => {
        reads.push(entity);
        return articles.map((item) => item.content);
      },
      find: async () => {
        reads.push(entity);
        return articles.flatMap((item) => item.revisions);
      },
    }),
  } as unknown as DataSource;
  await verifyManualNewsSources(
    database,
    articles.map((item) => item.source),
  );
  assert.deepEqual(reads, [NewsArticleContentEntity, NewsTranslationRevisionEntity]);
  assert.ok(articles.every((item) => publicNewsTranslation(item.source)?.title === '제목'));
});

test('first-edit source changes return a conflict before stale AI completion is checked', async () => {
  const ctx = context();
  const form = await ctx.editor.get(ctx.source.id);
  ctx.source.rawHash = 'e'.repeat(64);
  ctx.content.translationJson!.status = 'PENDING';
  await assert.rejects(
    () =>
      ctx.editor.save(
        ctx.source.id,
        {
          revision: form.revision,
          title: '입력 유지',
          description: null,
          markdown: '저장 대기 본문',
        },
        'admin-1',
      ),
    ConflictException,
  );
  assert.equal(ctx.updates.length, 0);
  await assert.rejects(() => ctx.editor.get(ctx.source.id), NotFoundException);
});
