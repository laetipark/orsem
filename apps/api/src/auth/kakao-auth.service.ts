import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { MemberService } from './member.service';
import { regenerateSession, saveSession } from './session';

export const KAKAO_HTTP = Symbol('KAKAO_HTTP');
const ISSUER = 'https://kauth.kakao.com';
const CALLBACK_PATH = '/api/v1/auth/kakao/callback';
const FLOW_TTL_MS = 5 * 60_000;
const callbackSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().max(128).optional(),
});
const claimsSchema = z.object({
  iss: z.literal(ISSUER),
  aud: z.string(),
  sub: z.string().regex(/^[1-9]\d{0,63}$/),
  exp: z.number().int().safe(),
  iat: z.number().int().safe(),
  nbf: z.number().int().safe().optional(),
  nonce: z.string().min(1).max(256),
  nickname: z.string().max(1000).optional(),
});
const jwkSchema = z.object({
  kty: z.literal('RSA'),
  use: z.literal('sig'),
  alg: z.literal('RS256'),
  kid: z.string().min(1).max(128),
  n: z.string().regex(/^[A-Za-z0-9_-]+$/),
  e: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

@Injectable()
export class KakaoAuthService {
  private readonly http: typeof fetch;
  private jwks: { expiresAt: number; keys: Map<string, JsonWebKey> } | null = null;
  private jwksLoading: Promise<Map<string, JsonWebKey>> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly members: MemberService,
    private readonly sessions: SessionRuntimeService,
    @Optional() @Inject(KAKAO_HTTP) http?: typeof fetch,
  ) {
    this.http = http ?? globalThis.fetch;
  }

  get publicConfig(): { enabled: boolean; startUrl: string | null } {
    const enabled = Boolean(
      !this.config.fixtureMode &&
      this.config.kakaoClientId &&
      this.config.kakaoClientSecret &&
      this.redirectUri(),
    );
    return { enabled, startUrl: enabled ? '/api/v1/auth/kakao/start' : null };
  }

  returnUrl(success: boolean): string {
    const url = new URL('/login', this.config.webOrigin);
    url.searchParams.set('kakao', success ? 'success' : 'error');
    return url.toString();
  }

  async start(request: Request): Promise<string> {
    if (!this.publicConfig.enabled)
      throw new ServiceUnavailableException('카카오 로그인이 설정되지 않았습니다.');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const stateHash = digest(state);
    const createdAt = Date.now();
    if (!(await this.sessions.storeKakaoState(request.sessionID, stateHash, nonce, createdAt))) {
      throw new ServiceUnavailableException('로그인 세션을 준비하지 못했습니다.');
    }
    request.session.kakaoOAuthState = { stateHash, createdAt };
    await saveSession(request);
    const url = new URL('/oauth/authorize', ISSUER);
    url.searchParams.set('client_id', this.config.kakaoClientId!);
    url.searchParams.set('redirect_uri', this.redirectUri()!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    return url.toString();
  }

  async complete(request: Request, query: unknown): Promise<void> {
    if (!this.publicConfig.enabled)
      throw new ServiceUnavailableException('카카오 로그인이 설정되지 않았습니다.');
    const input = callbackSchema.safeParse(query);
    const pending = request.session.kakaoOAuthState;
    if (
      !input.success ||
      !pending ||
      !safeEqual(pending.stateHash, digest(input.data.state)) ||
      pending.createdAt > Date.now() + 60_000 ||
      Date.now() - pending.createdAt > FLOW_TTL_MS
    ) {
      throw new UnauthorizedException('로그인 요청이 만료되었거나 일치하지 않습니다.');
    }
    // GETDEL은 동시 콜백과 여러 API 프로세스 사이에서도 원자적으로 동작합니다.
    // 트랜잭션 키는 이 state를 로그인을 시작한 세션 ID에도 연결합니다.
    const consumed = await this.sessions.consumeKakaoState(request.sessionID, pending.stateHash);
    if (!consumed) throw new UnauthorizedException('이미 사용했거나 만료된 로그인 요청입니다.');
    delete request.session.kakaoOAuthState;
    await saveSession(request);
    try {
      const transaction = z
        .object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), createdAt: z.number().int() })
        .parse(JSON.parse(consumed));
      if (transaction.createdAt !== pending.createdAt || input.data.error || !input.data.code)
        throw new Error('Invalid flow');
      const token = await this.fetchJson(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.kakaoClientId!,
          client_secret: this.config.kakaoClientSecret!,
          redirect_uri: this.redirectUri()!,
          code: input.data.code,
        }).toString(),
      });
      const idToken = z.object({ id_token: z.string().min(1).max(16_384) }).parse(token).id_token;
      const identity = await this.verifyIdToken(idToken, transaction.nonce);
      const member = await this.members.signInKakao(identity.sub, identity.nickname ?? null);
      await regenerateSession(request);
      request.session.memberId = member.id;
      request.session.sessionStartedAt = new Date().toISOString();
      request.session.csrfToken = randomBytes(24).toString('base64url');
      await saveSession(request);
    } catch {
      // 인가 코드, 토큰 응답, JWT, 외부 응답 본문을 예외 메시지나
      // 애플리케이션 로그에 포함하지 않습니다.
      throw new UnauthorizedException('카카오 인증을 완료하지 못했습니다. 다시 시도해 주세요.');
    }
  }

  private redirectUri(): string | null {
    const expected = new URL(CALLBACK_PATH, this.config.webOrigin).toString();
    if (this.config.kakaoRedirectUri && this.config.kakaoRedirectUri !== expected) return null;
    return expected;
  }

  private async verifyIdToken(token: string, nonce: string): Promise<z.infer<typeof claimsSchema>> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error('Invalid JWT');
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = z
      .object({ alg: z.literal('RS256'), kid: z.string().min(1).max(128) })
      .parse(decodePart(headerPart));
    let keys = await this.loadJwks();
    if (!keys.has(header.kid)) keys = await this.loadJwks(true);
    const jwk = keys.get(header.kid);
    if (!jwk || Buffer.from(jwk.n!, 'base64url').length < 256)
      throw new Error('Invalid signing key');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        key,
        Buffer.from(signaturePart, 'base64url'),
      )
    )
      throw new Error('Invalid signature');
    const claims = claimsSchema.parse(decodePart(payloadPart));
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.aud !== this.config.kakaoClientId ||
      !safeEqual(claims.nonce, nonce) ||
      claims.exp <= now ||
      claims.iat > now + 60 ||
      claims.exp <= claims.iat ||
      (claims.nbf !== undefined && claims.nbf > now + 60)
    )
      throw new Error('Invalid claims');
    return claims;
  }

  private async loadJwks(force = false): Promise<Map<string, JsonWebKey>> {
    if (!force && this.jwks && this.jwks.expiresAt > Date.now()) return this.jwks.keys;
    if (this.jwksLoading) return this.jwksLoading;
    this.jwksLoading = (async () => {
      const response = z
        .object({ keys: z.array(jwkSchema).min(1).max(20) })
        .parse(await this.fetchJson(`${ISSUER}/.well-known/jwks.json`));
      const keys = new Map<string, JsonWebKey>(response.keys.map((key) => [key.kid, key]));
      this.jwks = { keys, expiresAt: Date.now() + 60 * 60_000 };
      return keys;
    })();
    try {
      return await this.jwksLoading;
    } finally {
      this.jwksLoading = null;
    }
  }

  private async fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.http(url, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Kakao request failed');
    const text = await response.text();
    if (text.length > 65_536) throw new Error('Oversized Kakao response');
    return JSON.parse(text) as unknown;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function decodePart(part: string): unknown {
  const decoded = Buffer.from(part, 'base64url');
  if (decoded.toString('base64url') !== part) throw new Error('Noncanonical JWT');
  return JSON.parse(decoded.toString('utf8')) as unknown;
}
