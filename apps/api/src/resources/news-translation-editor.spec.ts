import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NewsTranslationRevisionEntity, SourceItemEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import type { AuthService } from '../auth/auth.service';
import type { MemberService } from '../auth/member.service';
import { AdminSessionGuard, CsrfGuard } from '../security/security';
import { NewsTranslationEditorController } from './news-translation-editor.controller';
import { NewsTranslationEditorService } from './news-translation-editor.service';
import { publicNewsTranslation } from '../common/news-translation';
import { verifyManualNewsSources } from './manual-news-translation';

test('retired body editor returns 410 without reading or writing database rows', async () => {
  const editor = new NewsTranslationEditorService(loadAppConfig({ NODE_ENV: 'test' }), {
    requireDataSource: () => {
      throw Error('must not read bodies');
    },
  } as unknown as DatabaseRuntimeService);
  const gone = (error: unknown) =>
    Boolean(
      error &&
      typeof error === 'object' &&
      'getStatus' in error &&
      (error as { getStatus(): number }).getStatus() === 410,
    );
  await assert.rejects(() => editor.get('source'), gone);
  await assert.rejects(() => editor.save('source', {} as never, 'admin'), gone);
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

test('migrated manual metadata verifies the saved revision without fetching article bodies', async () => {
  const metadata = {
    version: 2 as const,
    revisionId: '11111111-1111-4111-a111-111111111111',
    sourceHash: 'a'.repeat(64),
    editedAt: '2026-09-05T00:00:00Z',
    editedByAdminId: 'admin',
    title: '검토한 제목',
    description: '검토한 요약',
  };
  const source = Object.assign(new SourceItemEntity(), {
    id: 'source',
    source: 'IR',
    rawHash: metadata.sourceHash,
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    sourcePolicyJson: {
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
      metadataStorageAllowed: true,
      displayAllowed: true,
      aiAllowed: true,
      fullTextStorageAllowed: false,
    },
    manualTranslationJson: metadata,
    translationJson: {
      version: 1,
      status: 'COMPLETED',
      inputHash: metadata.sourceHash,
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      provider: 'AZURE',
      model: 'historical-model',
      title: '자동 번역',
      description: '자동 요약',
      translatedAt: metadata.editedAt,
      attemptedAt: metadata.editedAt,
      attempts: 1,
      nextAttemptAt: null,
    },
  });
  const snapshot = structuredClone(metadata);
  const db = {
    getRepository: (entity: unknown) => {
      assert.equal(entity, NewsTranslationRevisionEntity);
      return {
        find: async () => [
          {
            id: metadata.revisionId,
            sourceItemId: source.id,
            sourceHash: metadata.sourceHash,
            manualJson: { metadata: snapshot },
          },
        ],
      };
    },
  } as unknown as DataSource;
  await verifyManualNewsSources(db, [source]);
  assert.equal(publicNewsTranslation(source)?.title, '검토한 제목');
  assert.equal(publicNewsTranslation(source)?.provider, 'AZURE');
  source.manualTranslationJson = { ...metadata, title: '감사 이력 없는 변경' };
  await verifyManualNewsSources(db, [source]);
  assert.equal(publicNewsTranslation(source), null);
  source.manualTranslationJson = metadata;
  source.rawHash = 'b'.repeat(64);
  await verifyManualNewsSources(db, [source]);
  assert.equal(publicNewsTranslation(source), null);
});
