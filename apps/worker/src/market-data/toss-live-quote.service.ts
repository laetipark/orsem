import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { RightsMode } from '@orsem/contracts';
import WebSocket from 'ws';
import { z } from 'zod';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { TossMarketClient, TOSS_WS_URL, tossInstantSchema } from './toss-market.client';
import {
  TossMarketDataService,
  tossDecimal,
  type TossScopeCompany,
} from './toss-market-data.service';

const tradeSchema = z
  .object({
    type: z.literal('message'),
    topic: z.string(),
    data: z
      .object({
        price: z.string(),
        volume: z.string(),
        timestamp: tossInstantSchema,
        currency: z.enum(['KRW', 'USD']),
      })
      .passthrough(),
  })
  .passthrough();
export interface TossQuoteSnapshot {
  companyId: string;
  symbol: string;
  source: 'TOSS_KR' | 'TOSS_KR_INTEGRATED' | 'TOSS_US';
  currency: 'KRW' | 'USD';
  price: string;
  providerAt: string;
  observedAt: string;
  rightsMode: typeof RightsMode.PRIVATE_DISPLAY_ONLY;
  lossy: true;
  rawPayload: Record<string, unknown>;
}

export function tossQuoteFromFrame(
  raw: unknown,
  scopes: readonly TossScopeCompany[],
  observedAt: Date,
): TossQuoteSnapshot | null {
  const parsed = tradeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const frame = parsed.data;
  const scope = scopes.find(
    (candidate) => frame.topic === `trade:${candidate.region}:${candidate.symbol}`,
  );
  if (!scope || scope.currency !== frame.data.currency) return null;
  const providerAt = new Date(frame.data.timestamp);
  if (providerAt.getTime() > observedAt.getTime() + 60_000) return null;
  try {
    const price = tossDecimal(frame.data.price, 'trade price');
    tossDecimal(frame.data.volume, 'trade volume');
    return {
      companyId: scope.companyId,
      symbol: scope.symbol,
      source: scope.region === 'kr' ? 'TOSS_KR_INTEGRATED' : 'TOSS_US',
      currency: scope.currency,
      price,
      providerAt: providerAt.toISOString(),
      observedAt: observedAt.toISOString(),
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      lossy: true,
      rawPayload: { ...frame },
    };
  } catch {
    return null;
  }
}

export function tossTradeDeclaration(
  scopes: readonly TossScopeCompany[],
): Array<{ type: 'trade:kr' | 'trade:us'; codes: string[] }> {
  return (['kr', 'us'] as const).flatMap((region) => {
    const codes = [
      ...new Set(scopes.filter((scope) => scope.region === region).map((scope) => scope.symbol)),
    ];
    return codes.length ? [{ type: `trade:${region}` as const, codes }] : [];
  });
}

@Injectable()
export class TossLiveQuoteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TossLiveQuoteService.name);
  private readonly owner = randomUUID();
  private socket: WebSocket | null = null;
  private scopes: readonly TossScopeCompany[] = [];
  private signature = '';
  private lease = false;
  private stopped = false;
  private connecting = false;
  private refreshing = false;
  private reconnectAttempt = 0;
  private readonly rejected = new Set<string>();
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private scopeTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRetryAttempt = 0;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly client: TossMarketClient,
    private readonly marketData: TossMarketDataService,
  ) {}

  onModuleInit(): void {
    if (!this.client.enabled) return;
    void this.maintainLease();
    this.leaseTimer = setInterval(() => {
      void this.maintainLease();
    }, 10_000);
    this.scopeTimer = setInterval(() => {
      void this.refreshScope().catch(() => undefined);
    }, 15_000);
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('PING');
    }, 60_000);
    for (const timer of [this.leaseTimer, this.scopeTimer, this.pingTimer]) timer.unref();
  }

  private get leaseKey(): string {
    return `${this.config.redisPrefix}market:toss:ws-leader`;
  }

  private async maintainLease(): Promise<void> {
    if (this.stopped) return;
    try {
      const redis = await this.client.storage();
      const acquired =
        Number(
          await redis.eval(
            "local v=redis.call('GET',KEYS[1]); if not v or v==ARGV[1] then redis.call('SET',KEYS[1],ARGV[1],'PX',30000); return 1 end return 0",
            1,
            this.leaseKey,
            this.owner,
          ),
        ) === 1;
      this.lease = acquired;
      if (!acquired) {
        this.closeSocket();
        return;
      }
      if (!this.socket && !this.connecting && !this.reconnectTimer) await this.connect();
    } catch {
      this.lease = false;
      this.closeSocket();
    }
  }

  private async refreshScope(): Promise<void> {
    if (!this.lease || this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const candidates = await this.marketData.scope();
      const previous = new Set(this.scopes.map((scope) => scope.companyId));
      this.scopes = candidates
        .filter((scope) => !this.rejected.has(`trade:${scope.region}:${scope.symbol}`))
        .slice(0, this.config.tossMaxSubscriptions);
      const declaration = JSON.stringify(tossTradeDeclaration(this.scopes));
      if (declaration !== this.signature && this.socket?.readyState === WebSocket.OPEN) {
        this.signature = declaration;
        this.socket.send(declaration);
        // 새 구독에는 초기 WebSocket 가격 프레임이 전송되지 않습니다.
        const added = this.scopes.filter((scope) => !previous.has(scope.companyId));
        if (added.length) await this.initialSnapshot(added);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async connect(): Promise<void> {
    if (!this.lease || this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      await this.refreshScope();
      if (!this.scopes.length) return;
      const token = await this.client.accessToken();
      if (!this.lease || this.stopped) return;
      const socket = new WebSocket(TOSS_WS_URL, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: this.config.httpTimeoutMs,
        maxPayload: 1_000_000,
      });
      this.socket = socket;
      socket.on('open', () => {
        if (this.socket !== socket || !this.lease || this.stopped) {
          socket.terminate();
          return;
        }
        this.reconnectAttempt = 0;
        this.signature = JSON.stringify(tossTradeDeclaration(this.scopes));
        socket.send(this.signature);
        void this.initialSnapshot().catch(() => undefined);
      });
      socket.on('message', (data) => {
        void this.receive(data.toString()).catch(() => undefined);
      });
      socket.on('unexpected-response', (_request, response) => {
        if (response.statusCode === 401)
          void this.client.invalidateToken(token).catch(() => undefined);
        response.resume();
        socket.terminate();
      });
      socket.on('error', () => {
        /* close가 재시도를 처리하며 헤더나 자격증명은 로그에 남기지 않습니다. */
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        this.scheduleReconnect();
      });
    } catch {
      this.logger.warn(
        'Toss live quote connection is unavailable; REST candles remain independently scheduled.',
      );
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.lease || this.reconnectTimer) return;
    const wait =
      Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 6)) + Math.random() * 500;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
    this.reconnectTimer.unref();
  }

  private async initialSnapshot(scopes = this.scopes): Promise<void> {
    for (const price of await this.client.prices(scopes.map((scope) => scope.symbol))) {
      const scope = scopes.find(
        (candidate) => candidate.symbol === price.symbol && candidate.currency === price.currency,
      );
      if (!scope || !price.timestamp) continue;
      await this.cache({
        companyId: scope.companyId,
        symbol: scope.symbol,
        source: scope.region === 'kr' ? 'TOSS_KR' : 'TOSS_US',
        currency: scope.currency,
        price: tossDecimal(price.lastPrice, 'snapshot price'),
        providerAt: new Date(price.timestamp).toISOString(),
        observedAt: new Date().toISOString(),
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        lossy: true,
        rawPayload: { endpoint: '/api/v1/prices', ...price },
      });
    }
  }

  async receive(text: string): Promise<void> {
    if (text.length > 1_000_000 || !this.lease || this.stopped) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const frame = z.object({ type: z.string() }).passthrough().safeParse(raw);
    if (!frame.success) return;
    if (frame.data.type === 'subscriptions') {
      this.subscriptionRetryAttempt = 0;
      const ack = z
        .object({ rejected: z.array(z.object({ target: z.string(), code: z.string() })) })
        .safeParse(raw);
      if (ack.success)
        for (const rejection of ack.data.rejected) this.rejected.add(rejection.target);
      return;
    }
    if (frame.data.type === 'error') {
      const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(raw);
      if (error.success && error.data.error.code === 'server-shutdown') this.closeSocket();
      if (
        error.success &&
        ['internal-error', 'rate-limit-exceeded'].includes(error.data.error.code) &&
        !this.subscriptionRetryTimer
      ) {
        this.signature = '';
        const wait = Math.min(30_000, 1100 * 2 ** Math.min(this.subscriptionRetryAttempt++, 5));
        this.subscriptionRetryTimer = setTimeout(() => {
          this.subscriptionRetryTimer = null;
          void this.refreshScope().catch(() => undefined);
        }, wait);
        this.subscriptionRetryTimer.unref();
      }
      return;
    }
    const quote = tossQuoteFromFrame(raw, this.scopes, new Date());
    if (quote) await this.cache(quote);
  }

  private async cache(quote: TossQuoteSnapshot): Promise<void> {
    const redis = await this.client.storage();
    // 지연되거나 순서가 뒤바뀐 프레임은 거절하고, 누락될 수 있는 체결량은 합산하지 않습니다.
    await redis.eval(
      "local old=redis.call('GET',KEYS[1]); if old then local p=cjson.decode(old); if p.providerAt>ARGV[2] then return 0 end end redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[3]); return 1",
      1,
      `${this.config.redisPrefix}market:quote:${quote.companyId}`,
      JSON.stringify(quote),
      quote.providerAt,
      86_400,
    );
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.leaseTimer, this.scopeTimer, this.pingTimer])
      if (timer) clearInterval(timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.subscriptionRetryTimer) clearTimeout(this.subscriptionRetryTimer);
    this.closeSocket();
    if (this.lease) {
      try {
        const redis = await this.client.storage();
        await redis.eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
          1,
          this.leaseKey,
          this.owner,
        );
      } catch {
        /* Redis가 이미 종료 중이면 임대 만료로 리더 권한이 해제됩니다. */
      }
    }
    this.lease = false;
  }
}
