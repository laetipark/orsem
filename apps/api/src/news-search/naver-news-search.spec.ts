import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { HttpException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { parseWith } from '../common/zod';
import { APP_CONFIG, loadAppConfig } from '../config/app-config';
import { AuthService } from '../auth/auth.service';
import { MemberService } from '../auth/member.service';
import { AdminSessionGuard, HybridRateLimitGuard } from '../security/security';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { NaverNewsSearchController } from './naver-news-search.controller';
import {
  NAVER_NEWS_FETCH,
  NaverNewsSearchService,
  naverNewsSearchQuerySchema,
} from './naver-news-search.service';

const providerResult = {
  lastBuildDate: 'Sat, 05 Sep 2026 15:00:00 +0900',
  total: 72,
  start: 1,
  display: 2,
  items: [
    {
      title: '  <b>테스트</b> &amp; 뉴스 제목 ',
      description: '원래 <b>강조</b>와 &quot;설명&quot;',
      originallink: 'https://publisher.example/news?id=2&utm_source=naver',
      link: 'https://news.naver.com/example/2',
      pubDate: 'Sat, 05 Sep 2026 14:00:00 +0900',
    },
    {
      title: '다음 검색 결과',
      description: '',
      originallink: '',
      link: 'https://news.naver.com/example/1',
      pubDate: 'Fri, 04 Sep 2026 14:00:00 +0900',
    },
  ],
};

function config(provider: 'developers' | 'ncloud' = 'developers') {
  return loadAppConfig({
    NODE_ENV: 'test',
    NAVER_API_PROVIDER: provider,
    NAVER_CLIENT_ID: 'synthetic-client-id',
    NAVER_CLIENT_SECRET: 'synthetic-client-secret',
  });
}

test('네이버 검색은 제공자별 고정 주소로 요청하고 원래 순서와 표시 필드를 보존한다', async () => {
  for (const provider of ['developers', 'ncloud'] as const) {
    let calls = 0;
    const http = (async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(
        url.origin,
        provider === 'ncloud'
          ? 'https://naverapihub.apigw.ntruss.com'
          : 'https://openapi.naver.com',
      );
      assert.equal(
        url.pathname,
        provider === 'ncloud' ? '/search/v1/news' : '/v1/search/news.json',
      );
      assert.equal(url.searchParams.get('query'), '삼성 & NVIDIA');
      assert.equal(url.searchParams.get('display'), '20');
      assert.equal(url.searchParams.get('start'), '21');
      assert.equal(url.searchParams.get('sort'), 'sim');
      assert.equal(url.searchParams.get('format'), provider === 'ncloud' ? 'json' : null);
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get(provider === 'ncloud' ? 'X-NCP-APIGW-API-KEY-ID' : 'X-Naver-Client-Id'),
        'synthetic-client-id',
      );
      assert.equal(
        headers.get(provider === 'ncloud' ? 'X-NCP-APIGW-API-KEY' : 'X-Naver-Client-Secret'),
        'synthetic-client-secret',
      );
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ ...providerResult, unknownInternalField: 'must not forward' });
    }) as typeof fetch;
    const service = new NaverNewsSearchService(config(provider), http);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await service.search({ q: '삼성 & NVIDIA', start: 21, sort: 'sim' });
      assert.deepEqual(result, { provider: 'NAVER', ...providerResult });
    }
    assert.equal(calls, 2, '같은 검색도 캐시에서 반환하지 않는다');
  }
});

test('네이버 검색은 빈 검색·잘못된 페이지·제공자 URL 입력을 거절한다', () => {
  assert.deepEqual(naverNewsSearchQuerySchema.parse({ q: '  삼성  ' }), {
    q: '삼성',
    start: 1,
    sort: 'date',
  });
  for (const input of [
    {},
    { q: '' },
    { q: '  ' },
    { q: ['삼성'] },
    { q: 'a'.repeat(121) },
    { q: '삼성', start: 0 },
    { q: '삼성', start: 1001 },
    { q: '삼성', start: 1.2 },
    { q: '삼성', sort: 'other' },
    { q: '삼성', url: 'https://other.example' },
    { q: '삼성', display: 100 },
  ]) {
    assert.throws(
      () => parseWith(naverNewsSearchQuerySchema, input),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
    );
  }
});

test('네이버 설정 누락·제공자 제한·비정상 응답은 비밀 값 없이 구분한다', async () => {
  const input = { q: '테스트', start: 1, sort: 'date' as const };
  const noCredentials = new NaverNewsSearchService(loadAppConfig({ NODE_ENV: 'test' }), (() => {
    throw new Error('인증정보 없이 호출하지 않습니다.');
  }) as typeof fetch);
  await assert.rejects(
    () => noCredentials.search(input),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 503,
  );
  const cases: Array<[() => Promise<Response>, number]> = [
    ...[401, 403, 429, 500].map((status): [() => Promise<Response>, number] => [
      async () => new Response('synthetic-provider-secret', { status }),
      status === 401 || status === 403 ? 503 : status === 429 ? 429 : 502,
    ]),
    [async () => Response.json({ errorCode: 'synthetic-provider-secret' }), 502],
    [async () => new Response('{malformed-secret'), 502],
    [
      async () => {
        throw new Error('synthetic-provider-secret');
      },
      502,
    ],
    [
      async () => {
        const error = new Error('synthetic-provider-secret');
        error.name = 'TimeoutError';
        throw error;
      },
      504,
    ],
  ];
  for (const [http, status] of cases) {
    const service = new NaverNewsSearchService(config(), http as typeof fetch);
    await assert.rejects(
      () => service.search(input),
      (error: unknown) => {
        assert.ok(error instanceof HttpException);
        assert.equal(error.getStatus(), status);
        assert.equal(JSON.stringify(error.getResponse()).includes('synthetic-'), false);
        return true;
      },
    );
  }
});

test('네이버 HTTP 경로는 인증·승인·요청 한도를 적용하고 성공·오류 응답을 저장하지 않는다', async (t) => {
  let calls = 0;
  let memberStatus = 'APPROVED';
  let rateCount = 1;
  let upstreamStatus = 200;
  const http = (async () => {
    calls++;
    return upstreamStatus === 200
      ? Response.json(providerResult)
      : new Response('synthetic-provider-secret', { status: upstreamStatus });
  }) as typeof fetch;
  const module = await Test.createTestingModule({
    controllers: [NaverNewsSearchController],
    providers: [
      { provide: APP_CONFIG, useValue: config() },
      { provide: NAVER_NEWS_FETCH, useValue: http },
      NaverNewsSearchService,
      { provide: AuthService, useValue: { getAdmin: async () => ({ id: 'admin' }) } },
      {
        provide: MemberService,
        useValue: { getMember: async () => ({ role: 'VIEWER', status: memberStatus }) },
      },
      { provide: SessionRuntimeService, useValue: { consumeRateLimit: async () => rateCount } },
      { provide: APP_GUARD, useClass: AdminSessionGuard },
      { provide: APP_GUARD, useClass: HybridRateLimitGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
    const role = req.header('x-test-role');
    req.session = {
      ...(role === 'admin'
        ? { adminId: 'admin' }
        : role === 'member'
          ? { memberId: 'member' }
          : {}),
      sessionStartedAt: new Date().toISOString(),
    } as Request['session'];
    next();
  });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address() as AddressInfo;
  const request = (query = 'test', role?: string) =>
    fetch(`http://127.0.0.1:${address.port}/api/v1/news-search/naver`, {
      headers: {
        ...(role ? { 'x-test-role': role } : {}),
        'x-orsem-news-query': query,
        'x-orsem-news-start': '1',
        'x-orsem-news-sort': 'date',
      },
    });
  assert.equal((await request()).status, 401);
  assert.equal(calls, 0);
  for (const role of ['admin', 'member']) {
    const response = await request('test', role);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { provider: 'NAVER', ...providerResult });
  }
  assert.equal(calls, 2);
  for (const status of ['PENDING', 'REJECTED']) {
    memberStatus = status;
    assert.equal((await request('test', 'member')).status, 403);
  }
  const invalid = await request('', 'admin');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 2);
  upstreamStatus = 403;
  const failed = await request('test', 'admin');
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.equal((await failed.text()).includes('synthetic-provider-secret'), false);
  rateCount = 21;
  assert.equal((await request('test', 'admin')).status, 429);
  assert.equal(calls, 3);
});
