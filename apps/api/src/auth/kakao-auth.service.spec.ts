import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import type { Request } from 'express';
import { loadAppConfig } from '../config/app-config';
import type { SessionRuntimeService } from '../security/session-runtime.service';
import { KakaoAuthService } from './kakao-auth.service';
import type { MemberService } from './member.service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const config = loadAppConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'https://orsem.example',
  KAKAO_CLIENT_ID: 'test-client',
  KAKAO_CLIENT_SECRET: 'test-secret',
});

function request(id = 'original-session'): Request {
  const value = { sessionID: id } as Request;
  const replace = () => {
    value.session = {
      cookie: { maxAge: 12 * 60 * 60 * 1000 },
      save: (callback: (error?: Error) => void) => callback(),
      regenerate: (callback: (error?: Error) => void) => {
        replace();
        value.sessionID = `${id}-regenerated`;
        callback();
      },
    } as unknown as Request['session'];
  };
  replace();
  return value;
}

function harness(
  options: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    badSignature?: boolean;
    tokenStatus?: number;
    noIdToken?: boolean;
  } = {},
) {
  const transactions = new Map<string, string>();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const identities: Array<{ subject: string; name: string | null }> = [];
  let nonce = '';
  const sessions = {
    storeKakaoState: async (id: string, hash: string, value: string, createdAt: number) => {
      transactions.set(`${id}:${hash}`, JSON.stringify({ nonce: value, createdAt }));
      nonce = value;
      return true;
    },
    consumeKakaoState: async (id: string, hash: string) => {
      const key = `${id}:${hash}`;
      const value = transactions.get(key) ?? null;
      transactions.delete(key);
      return value;
    },
  } as unknown as SessionRuntimeService;
  const members = {
    signInKakao: async (subject: string, name: string | null) => {
      identities.push({ subject, name });
      return { id: 'member-id' };
    },
  } as unknown as MemberService;
  const http = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    assert.equal(url, 'https://kauth.kakao.com/oauth/token');
    if (options.tokenStatus)
      return new Response('upstream-test-secret-and-code', { status: options.tokenStatus });
    if (options.noIdToken) return Response.json({ access_token: 'must-not-be-used-as-identity' });
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'test-key', ...options.header }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://kauth.kakao.com',
        aud: 'test-client',
        sub: '900719925474099312345',
        iat: now,
        exp: now + 3600,
        nonce,
        nickname: '사용자',
        email: 'admin@example.com',
        ...options.claims,
      }),
    ).toString('base64url');
    const signed = `${header}.${payload}`;
    const signature = options.badSignature
      ? Buffer.alloc(256).toString('base64url')
      : sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url');
    return Response.json({
      id_token: `${signed}.${signature}`,
      access_token: 'never-persist',
      refresh_token: 'never-persist',
    });
  }) as unknown as typeof fetch;
  return {
    service: new KakaoAuthService(config, members, sessions, http),
    sessions,
    members,
    http,
    calls,
    identities,
    transactions,
  };
}

async function begin(value = harness(), req = request()) {
  const url = new URL(await value.service.start(req));
  return { ...value, req, url, state: url.searchParams.get('state')! };
}

test('Kakao configuration and redirects are fixed to the configured browser origin', () => {
  const { members, sessions, http } = harness();
  for (const overrides of [
    { kakaoClientId: undefined },
    { kakaoClientSecret: undefined },
    { fixtureMode: true },
    { kakaoRedirectUri: 'https://attacker.example/callback' },
  ]) {
    assert.deepEqual(
      new KakaoAuthService({ ...config, ...overrides }, members, sessions, http).publicConfig,
      { enabled: false, startUrl: null },
    );
  }
  const service = new KakaoAuthService(config, members, sessions, http);
  assert.deepEqual(service.publicConfig, { enabled: true, startUrl: '/api/v1/auth/kakao/start' });
  assert.equal(service.returnUrl(false), 'https://orsem.example/login?kakao=error');
  assert.equal(service.returnUrl(true), 'https://orsem.example/login?kakao=success');
});

test('authorization requests use separate random state and nonce with minimum OIDC scope', async () => {
  const { url, req } = await begin();
  assert.equal(url.origin, 'https://kauth.kakao.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://orsem.example/api/v1/auth/kakao/callback',
  );
  assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.match(url.searchParams.get('state')!, /^[\w-]{43}$/u);
  assert.notEqual(url.searchParams.get('state'), url.searchParams.get('nonce'));
  assert.notEqual(req.session.kakaoOAuthState?.stateHash, url.searchParams.get('state'));
});

test('a signed identity creates a member session, preserving a large subject exactly and removing admin access', async () => {
  const req = request();
  req.session.adminId = 'old-admin';
  req.session.csrfToken = 'old-csrf';
  const h = await begin(harness(), req);
  await h.service.complete(req, {
    state: h.state,
    code: 'synthetic-code',
    next: 'https://attacker.example',
  });
  assert.deepEqual(h.identities, [{ subject: '900719925474099312345', name: '사용자' }]);
  assert.equal(req.session.memberId, 'member-id');
  assert.equal(req.session.adminId, undefined);
  assert.equal(req.session.kakaoOAuthState, undefined);
  assert.equal(req.sessionID, 'original-session-regenerated');
  assert.notEqual(req.session.csrfToken, 'old-csrf');
  assert.ok(req.session.sessionStartedAt);
  assert.equal(JSON.stringify(req.session).includes('never-persist'), false);
  const tokenCall = h.calls.find((call) => call.url.endsWith('/oauth/token'))!;
  const body = new URLSearchParams(String(tokenCall.init.body));
  assert.equal(body.get('redirect_uri'), h.url.searchParams.get('redirect_uri'));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'synthetic-code');
  assert.equal(body.get('client_secret'), 'test-secret');
  assert.ok(
    h.calls.every(
      (call) => call.init.redirect === 'error' && call.init.signal instanceof AbortSignal,
    ),
  );
});

for (const [name, query] of [
  ['missing state', { code: 'code' }],
  ['array state', { state: ['invalid'], code: 'code' }],
  ['mismatched state', { state: 'x'.repeat(43), code: 'code' }],
  ['oversized code', { code: 'x'.repeat(2049) }],
] as const) {
  test(`callback rejects ${name} before any provider request`, async () => {
    const h = await begin();
    const input = name === 'oversized code' ? { state: h.state, ...query } : query;
    await assert.rejects(h.service.complete(h.req, input));
    assert.equal(h.calls.length, 0);
    assert.equal(h.identities.length, 0);
  });
}

test('expired, other-session and cancelled authorization flows fail without exchanging a token', async () => {
  for (const mode of ['expired', 'other-session', 'cancelled', 'no-code'] as const) {
    const h = await begin();
    if (mode === 'expired') h.req.session.kakaoOAuthState!.createdAt -= 301_000;
    if (mode === 'other-session') h.req.sessionID = 'different-session';
    const query = {
      state: h.state,
      ...(mode === 'cancelled'
        ? { error: 'access_denied' }
        : mode === 'no-code'
          ? {}
          : { code: 'code' }),
    };
    await assert.rejects(h.service.complete(h.req, query));
    assert.equal(h.calls.length, 0);
    assert.equal(h.identities.length, 0);
  }
});

test('concurrent callbacks consume state once and cannot replay after authentication', async () => {
  const h = await begin();
  const second = request();
  second.session.kakaoOAuthState = { ...h.req.session.kakaoOAuthState! };
  const result = await Promise.allSettled([
    h.service.complete(h.req, { state: h.state, code: 'code' }),
    h.service.complete(second, { state: h.state, code: 'code' }),
  ]);
  assert.equal(result.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(h.calls.filter((call) => call.url.endsWith('/oauth/token')).length, 1);
  assert.equal(h.identities.length, 1);
  await assert.rejects(h.service.complete(h.req, { state: h.state, code: 'code' }));
  assert.equal(h.identities.length, 1);
});

for (const [name, options] of [
  ['wrong signature', { badSignature: true }],
  ['wrong algorithm', { header: { alg: 'none' } }],
  ['unknown signing key', { header: { kid: 'unknown', jku: 'https://attacker.example/keys' } }],
  ['wrong issuer', { claims: { iss: 'https://attacker.example' } }],
  ['wrong audience', { claims: { aud: 'different-client' } }],
  ['expired token', { claims: { exp: 1 } }],
  ['future token', { claims: { iat: 9_999_999_999, exp: 10_000_000_000 } }],
  ['wrong nonce', { claims: { nonce: 'wrong-nonce' } }],
  ['numeric subject', { claims: { sub: 123 } }],
  ['scientific subject', { claims: { sub: '1e20' } }],
  ['no signed ID token', { noIdToken: true }],
  ['provider failure', { tokenStatus: 401 }],
] as const) {
  test(`OAuth rejects ${name} without creating an authenticated identity`, async () => {
    const h = await begin(harness(options));
    await assert.rejects(
      h.service.complete(h.req, { state: h.state, code: 'secret-code' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /test-secret|secret-code|upstream|eyJ/u);
        return true;
      },
    );
    assert.equal(h.identities.length, 0);
    assert.equal(h.req.session.memberId, undefined);
    assert.ok(h.calls.every((call) => new URL(call.url).origin === 'https://kauth.kakao.com'));
  });
}
