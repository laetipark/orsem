import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import session, { type Store } from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import { createHash } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

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
    const client = createClient({
      url: this.config.redisUrl,
      socket: { connectTimeout: 1500, reconnectStrategy: false },
    });
    client.on('error', (error) => {
      this.redisReady = false;
      this.detail = error.message;
    });
    try {
      await client.connect();
      this.client = client;
      this.redisReady = true;
      this.detail = null;
      return new RedisStore({ client, prefix: `${this.config.redisPrefix}session:` });
    } catch (error) {
      this.detail = error instanceof Error ? error.message : String(error);
      if (this.config.nodeEnv === 'production') {
        throw new Error(`Redis session store unavailable: ${this.detail}`);
      }
      this.logger.error(`Redis session store unavailable; using process memory: ${this.detail}`);
      return undefined;
    }
  }

  middleware(store?: Store): ReturnType<typeof session> {
    const secret = this.config.sessionSecret ?? 'fixture-session-secret-that-is-not-for-production';
    return session({
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
        maxAge: 12 * 60 * 60 * 1000,
      },
    });
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
      return (
        (await this.client.set(
          this.kakaoStateKey(sessionId, stateHash),
          JSON.stringify({ nonce, createdAt }),
          { EX: 300, NX: true },
        )) === 'OK'
      );
    } catch {
      return false;
    }
  }

  async consumeKakaoState(sessionId: string, stateHash: string): Promise<string | null> {
    if (!this.client?.isReady) return null;
    try {
      return await this.client.getDel(this.kakaoStateKey(sessionId, stateHash));
    } catch {
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
      return count;
    } catch (error) {
      this.redisReady = false;
      this.detail = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client?.isOpen) await this.client.quit();
  }
}
