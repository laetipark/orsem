import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import session, { type Store } from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import { createHash } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { CompanyLogoProvider } from '@orsem/contracts';
import { applySessionCookieLifetime, SHORT_SESSION_IDLE_MS } from '../auth/session-lifetime';

// Shared by all API processes and users. Reserve before the browser sends one image request.
// 33 UTC-day buckets conservatively cover every rolling 32-day period and hence any
// provider calendar month, regardless of its billing timezone. Counters renew gradually.
export const COMPANY_LOGO_BUDGET_SCRIPT = `
local values = redis.call('MGET', unpack(KEYS))
local count = 0
for _, value in ipairs(values) do count = count + tonumber(value or '0') end
local limit = tonumber(ARGV[1])
if count >= limit then return 0 end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

@Injectable()
export class SessionRuntimeService implements OnApplicationShutdown {
  private readonly logger = new Logger(SessionRuntimeService.name);
  private client: ReturnType<typeof createClient> | null = null;
  private redisReady = false;
  private detail: string | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async createStore(): Promise<Store | undefined> {
    if (this.config.fixtureMode || !this.config.redisUrl) {
      this.detail = this.config.fixtureMode
        ? 'fixture mode uses an in-memory session store'
        : 'REDIS_URL is not configured';
      return undefined;
    }
    let connectedOnce = false;
    const client = createClient({
      url: this.config.redisUrl,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 1500,
        // Startup must fail promptly; a store that was ready can recover without an API restart.
        reconnectStrategy: (retries) =>
          connectedOnce ? Math.min(250 * 2 ** Math.min(retries, 5), 5000) : false,
      },
    });
    client.on('ready', () => {
      connectedOnce = true;
      this.redisReady = true;
      this.detail = null;
    });
    const unavailable = () => {
      this.redisReady = false;
      this.detail = 'Redis connection unavailable.';
    };
    client.on('error', unavailable);
    client.on('reconnecting', unavailable);
    client.on('end', unavailable);
    let startupDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          startupDeadline = setTimeout(() => reject(new Error('Redis startup timed out.')), 2000);
        }),
      ]);
      this.client = client;
      this.redisReady = true;
      this.detail = null;
      return new RedisStore({ client, prefix: `${this.config.redisPrefix}session:` });
    } catch {
      if (client.isOpen) client.destroy();
      unavailable();
      if (this.config.nodeEnv === 'production') {
        throw new Error('Redis session store unavailable.');
      }
      this.logger.error('Redis session store unavailable; using process memory.');
      return undefined;
    } finally {
      clearTimeout(startupDeadline);
    }
  }

  middleware(store?: Store): ReturnType<typeof session> {
    const secret = this.config.sessionSecret ?? 'fixture-session-secret-that-is-not-for-production';
    const loadSession = session({
      name: 'orsem.sid',
      secret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: this.config.nodeEnv === 'production',
        sameSite: 'lax',
        maxAge: SHORT_SESSION_IDLE_MS,
      },
    });
    return (request, response, next) => {
      loadSession(request, response, (error?: unknown) => {
        // A failed store read is a temporary outage, never an anonymous session.
        if (error)
          return next(
            new ServiceUnavailableException(
              '로그인 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
            ),
          );
        if (request.session) applySessionCookieLifetime(request.session);
        next();
      });
    };
  }

  get health(): { ready: boolean; message: string | null } {
    return { ready: this.redisReady, message: this.detail };
  }

  async readMarketQuote(companyId: string): Promise<{ available: boolean; value: string | null }> {
    if (!this.client?.isReady) return { available: false, value: null };
    try {
      const value = await this.client.get(`${this.config.redisPrefix}market:quote:${companyId}`);
      return { available: true, value };
    } catch {
      return { available: false, value: null };
    }
  }

  async consumeCompanyLogoBudget(provider: CompanyLogoProvider, limit: number): Promise<boolean> {
    if (!this.client?.isReady || !Number.isInteger(limit) || limit < 1 || limit > 500_000)
      return false;
    try {
      // No per-client counters or process-memory fallback: absent durable shared storage fails closed.
      const now = Date.now();
      return (
        Number(
          await this.client.eval(COMPANY_LOGO_BUDGET_SCRIPT, {
            keys: Array.from({ length: 33 }, (_, offset) => {
              const date = new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
              return `${this.config.redisPrefix}logo:budget:${provider}:${date}`;
            }),
            arguments: [String(limit), String(34 * 24 * 60 * 60_000)],
          }),
        ) === 1
      );
    } catch {
      return false;
    }
  }

  async readMarketQuotes(
    companyIds: string[],
  ): Promise<{ available: boolean; values: Array<string | null> }> {
    if (!this.client?.isReady) return { available: false, values: companyIds.map(() => null) };
    if (companyIds.length === 0) return { available: true, values: [] };
    try {
      const values = await this.client.mGet(
        companyIds.map((id) => `${this.config.redisPrefix}market:quote:${id}`),
      );
      return { available: true, values };
    } catch {
      return { available: false, values: companyIds.map(() => null) };
    }
  }

  async storeKakaoState(
    sessionId: string,
    stateHash: string,
    nonce: string,
    createdAt: number,
  ): Promise<boolean> {
    if (!this.client?.isReady) return false;
    try {
      const result = await this.client.set(
        this.kakaoStateKey(sessionId, stateHash),
        JSON.stringify({ nonce, createdAt }),
        { EX: 300, NX: true },
      );
      this.redisReady = true;
      this.detail = null;
      return result === 'OK';
    } catch (error) {
      this.recordRedisWriteFailure(error);
      return false;
    }
  }

  async consumeKakaoState(sessionId: string, stateHash: string): Promise<string | null> {
    if (!this.client?.isReady) return null;
    try {
      const value = await this.client.getDel(this.kakaoStateKey(sessionId, stateHash));
      this.redisReady = true;
      this.detail = null;
      return value;
    } catch (error) {
      this.recordRedisWriteFailure(error);
      return null;
    }
  }

  private kakaoStateKey(sessionId: string, stateHash: string): string {
    const sessionHash = createHash('sha256').update(sessionId).digest('hex');
    return `${this.config.redisPrefix}auth:kakao:${sessionHash}:${stateHash}`;
  }

  /** 현재 고정 시간 구간의 횟수를 반환하며 Redis를 사용할 수 없으면 null을 반환합니다. */
  async consumeRateLimit(key: string, windowMs: number): Promise<number | null> {
    if (!this.client?.isReady) return null;
    try {
      const redisKey = `${this.config.redisPrefix}rate:${key}`;
      const count = await this.client.incr(redisKey);
      if (count === 1) await this.client.pExpire(redisKey, windowMs);
      this.redisReady = true;
      this.detail = null;
      return count;
    } catch (error) {
      this.recordRedisWriteFailure(error);
      return null;
    }
  }

  private recordRedisWriteFailure(error: unknown): void {
    this.redisReady = false;
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    // Readiness is public: Redis errors must never expose command arguments or auth state.
    this.detail = /^MISCONF\b/u.test(message)
      ? 'Redis persistence failed; writes are blocked.'
      : 'Redis write failed.';
  }

  async onApplicationShutdown(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.redisReady = false;
    if (!client?.isOpen) return;
    if (!client.isReady) {
      client.destroy();
      return;
    }
    try {
      await client.quit();
    } catch {
      if (client.isOpen) client.destroy();
    }
  }
}
