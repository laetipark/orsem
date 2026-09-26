import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sessionSchema } from '@orsem/contracts';
import { APP_CONFIG, loadAppConfig } from '../config/app-config';
import {
  AdminSessionGuard,
  CsrfGuard,
  HybridRateLimitGuard,
  OriginGuard,
} from '../security/security';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { KakaoAuthController } from './kakao-auth.controller';
import { KAKAO_HTTP, KakaoAuthService } from './kakao-auth.service';
import { MemberService } from './member.service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'http-test', alg: 'RS256', use: 'sig' };
const member = {
  id: '00000000-0000-4000-8000-000000000001',
  provider: 'KAKAO',
  role: 'VIEWER',
  status: 'PENDING',
  displayName: null,
};

async function harness(
  t: TestContext,
  options: { disabled?: boolean; stateUnavailable?: boolean; tokenFailure?: boolean } = {},
) {
  const config = loadAppConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'https://orsem.example',
    SESSION_SECRET: 'synthetic-http-test-session-secret',
    KAKAO_CLIENT_ID: options.disabled ? undefined : 'synthetic-client-id',
    KAKAO_CLIENT_SECRET: 'synthetic-client-secret',
  });
  const transactions = new Map<string, string>();
  let nonce = '';
  let tokenCalls = 0;
  let signIns = 0;
  const sessions = new SessionRuntimeService(config);
  sessions.storeKakaoState = async (id, hash, value, createdAt) => {
    if (options.stateUnavailable) return false;
    nonce = value;
    transactions.set(`${id}:${hash}`, JSON.stringify({ nonce: value, createdAt }));
    return true;
  };
  sessions.consumeKakaoState = async (id, hash) => {
    const key = `${id}:${hash}`;
    const value = transactions.get(key) ?? null;
    transactions.delete(key);
    return value;
  };
  const http = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === 'https://kauth.kakao.com/.well-known/jwks.json')
      return Response.json({ keys: [jwk] });
    assert.equal(url, 'https://kauth.kakao.com/oauth/token');
    assert.equal(init.method, 'POST');
    tokenCalls++;
    if (options.tokenFailure) return new Response('synthetic-upstream-secret', { status: 401 });
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://kauth.kakao.com',
        aud: config.kakaoClientId,
        sub: '900719925474099312345',
        iat: now,
        exp: now + 3600,
        nonce,
      }),
    ).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
    return Response.json({
      id_token: `${unsigned}.${signature}`,
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
    });
  }) as typeof fetch;
  const module = await Test.createTestingModule({
    controllers: [AuthController, KakaoAuthController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: SessionRuntimeService, useValue: sessions },
      {
        provide: AuthService,
        useValue: { setupRequired: async () => false, getAdmin: async () => null },
      },
      {
        provide: MemberService,
        useValue: {
          getMember: async (id: string) => (id === member.id ? member : null),
          signInKakao: async (subject: string) => {
            assert.equal(subject, '900719925474099312345');
            signIns++;
            return member;
          },
        },
      },
      KakaoAuthService,
      { provide: KAKAO_HTTP, useValue: http },
      { provide: APP_GUARD, useClass: AdminSessionGuard },
      { provide: APP_GUARD, useClass: OriginGuard },
      { provide: APP_GUARD, useClass: CsrfGuard },
      { provide: APP_GUARD, useClass: HybridRateLimitGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  app.use(sessions.middleware());
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (path: string, cookie?: string) =>
    fetch(`${baseUrl}/api/v1${path}`, {
      redirect: 'manual',
      headers: cookie ? { Cookie: cookie } : {},
    });
  return { request, transactions, counts: () => ({ tokenCalls, signIns }) };
}

function cookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header);
  assert.match(header, /^orsem\.sid=/u);
  assert.match(header, /; HttpOnly/u);
  assert.match(header, /; SameSite=Lax/u);
  return header.split(';')[0]!;
}

function noStore(response: Response): void {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}

test('Kakao config is public and reveals only availability and the local start route', async (t) => {
  for (const disabled of [false, true]) {
    const h = await harness(t, { disabled });
    const response = await h.request('/auth/kakao/config');
    assert.equal(response.status, 200);
    noStore(response);
    assert.equal(response.headers.has('set-cookie'), false);
    assert.deepEqual(await response.json(), {
      enabled: !disabled,
      startUrl: disabled ? null : '/api/v1/auth/kakao/start',
    });
  }
});

test('Kakao HTTP callback persists a rotated member session without granting administrator access', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const signedInAt = Date.now();
  const h = await harness(t);
  const start = await h.request('/auth/kakao/start');
  assert.equal(start.status, 302);
  noStore(start);
  const authorization = new URL(start.headers.get('location')!);
  assert.equal(authorization.origin, 'https://kauth.kakao.com');
  assert.equal(authorization.pathname, '/oauth/authorize');
  assert.equal(
    authorization.searchParams.get('redirect_uri'),
    'https://orsem.example/api/v1/auth/kakao/callback',
  );
  const before = cookie(start);
  const callbackPath = `/auth/kakao/callback?${new URLSearchParams({
    state: authorization.searchParams.get('state')!,
    code: 'synthetic-authorization-code',
    next: 'https://attacker.example',
  })}`;
  const callback = await h.request(callbackPath, before);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), 'https://orsem.example/login?kakao=success');
  noStore(callback);
  const after = cookie(callback);
  const expires = /; Expires=([^;]+)/u.exec(callback.headers.get('set-cookie')!)?.[1];
  assert.ok(expires);
  assert.ok(Math.abs(Date.parse(expires) - signedInAt - 30 * 86400_000) < 1000);
  assert.notEqual(after, before);
  const session = await h.request('/auth/session', after);
  const identity = sessionSchema.parse(await session.json());
  assert.equal(identity.authenticated, true);
  assert.equal(identity.canAccess, false);
  assert.equal(identity.user?.id, member.id);
  assert.equal(identity.user?.provider, 'KAKAO');
  assert.equal(identity.user?.role, 'VIEWER');
  assert.equal(identity.user?.status, 'PENDING');
  assert.ok(identity.csrfToken);
  assert.equal((await h.request('/auth/members', after)).status, 403);
  const oldSession = await h.request('/auth/session', before);
  assert.equal(sessionSchema.parse(await oldSession.json()).authenticated, false);
  const replay = await h.request(callbackPath, after);
  assert.equal(replay.headers.get('location'), 'https://orsem.example/login?kakao=error');
  assert.deepEqual(h.counts(), { tokenCalls: 1, signIns: 1 });

  // Closing the app overnight, or returning after the old seven-day limit,
  // must not discard a valid member login. The cookie remains HTTP-only.
  for (const elapsed of [13 * 3600_000, 8 * 86400_000, 29 * 86400_000]) {
    t.mock.timers.setTime(signedInAt + elapsed);
    const revisit = await h.request('/auth/session', after);
    assert.equal(sessionSchema.parse(await revisit.json()).authenticated, true);
    const revisitExpiry = /; Expires=([^;]+)/u.exec(revisit.headers.get('set-cookie')!)?.[1];
    assert.ok(revisitExpiry);
    assert.ok(Math.abs(Date.parse(revisitExpiry) - signedInAt - 30 * 86400_000) < 1000);
  }
  t.mock.timers.setTime(signedInAt + 31 * 86400_000);
  const expired = await h.request('/auth/session', after);
  assert.equal(sessionSchema.parse(await expired.json()).authenticated, false);
});

test('Kakao HTTP failures return to the fixed login page without exposing provider errors', async (t) => {
  for (const mode of ['disabled', 'state-unavailable', 'cancelled', 'provider-failure'] as const) {
    const h = await harness(t, {
      disabled: mode === 'disabled',
      stateUnavailable: mode === 'state-unavailable',
      tokenFailure: mode === 'provider-failure',
    });
    let response = await h.request('/auth/kakao/start?next=https://attacker.example');
    if (mode === 'cancelled' || mode === 'provider-failure') {
      const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
      const query = new URLSearchParams({
        state,
        ...(mode === 'cancelled' ? { error: 'access_denied' } : { code: 'synthetic-code' }),
      });
      response = await h.request(`/auth/kakao/callback?${query}`, cookie(response));
    }
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://orsem.example/login?kakao=error');
    noStore(response);
    assert.doesNotMatch(await response.text(), /synthetic-|access_denied|attacker/u);
    assert.deepEqual(h.counts(), {
      tokenCalls: mode === 'provider-failure' ? 1 : 0,
      signIns: 0,
    });
    assert.equal(h.transactions.size, 0);
  }
});

test('Kakao callback requires the browser cookie that initiated authorization', async (t) => {
  const h = await harness(t);
  const start = await h.request('/auth/kakao/start');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const response = await h.request(`/auth/kakao/callback?state=${state}&code=synthetic-code`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://orsem.example/login?kakao=error');
  noStore(response);
  assert.deepEqual(h.counts(), { tokenCalls: 0, signIns: 0 });
});

test('public Kakao start requests are still rate limited before creating more transactions', async (t) => {
  const h = await harness(t);
  for (let count = 0; count < 10; count++) {
    assert.equal((await h.request('/auth/kakao/start')).status, 302);
  }
  assert.equal((await h.request('/auth/kakao/start')).status, 429);
  assert.equal(h.transactions.size, 10);
  assert.deepEqual(h.counts(), { tokenCalls: 0, signIns: 0 });
});
