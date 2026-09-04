import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import {
  ConnectorStatus,
  RightsMode,
  NewsSourceKind,
  canonicalNewsUrl,
  APPROVED_GDELT_SOURCE_POLICIES,
  NEWS_RSS_FEEDS,
  NEWS_RSS_FEED_IDS,
  type NewsRssFeedId,
  type NewsSourcePolicy,
} from '@orsem/contracts';
export { NEWS_RSS_FEED_IDS, type NewsRssFeedId } from '@orsem/contracts';
import { assertLexicalXmlComplexity, assertSafeXml } from '@orsem/opendart-parser';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { readBoundedResponseBytes } from '../common/bounded-response';
import type { WorkerConfig } from '../config/worker-config';
import type { FetchImplementation } from '../opendart/opendart.client';
import {
  naverFailureMessage,
  readNaverErrorCode,
  type NaverApiProvider,
} from './connector-diagnostics';

export type ConnectorName = 'OPENDART' | 'NAVER' | 'SEC' | 'GDELT' | 'IR' | 'NEWS_RSS';

export interface DiscoveryCandidate {
  readonly connector: ConnectorName;
  readonly externalId: string | null;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly sourceName: string | null;
  readonly tickers: readonly string[];
  readonly tags: readonly string[];
  readonly rightsMode: RightsMode;
  readonly sourceKind?: NewsSourceKind;
  readonly sourcePolicy?: NewsSourcePolicy;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DiscoveryScopeCompany {
  readonly ticker: string | null;
  readonly stockCode: string | null;
  readonly cik: string | null;
  readonly nameKo: string;
  readonly nameEn: string | null;
}

export interface DiscoveryScope {
  readonly companies: readonly DiscoveryScopeCompany[];
}

/** @deprecated 대부분의 커넥터 후보는 링크만이 아닌 메타데이터를 제공합니다. */
export type LinkOnlyCandidate = DiscoveryCandidate;

export interface ConnectorHealthCheck {
  readonly connector: ConnectorName;
  readonly status: ConnectorStatus;
  readonly message: string | null;
  readonly checkedAt: Date;
  readonly rightsMode: RightsMode;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LinkDiscoveryAdapter {
  readonly name: ConnectorName;
  readonly rightsMode: RightsMode;
  health(now?: Date): ConnectorHealthCheck;
  check(now?: Date): Promise<ConnectorHealthCheck>;
  discoverLinks(scope?: DiscoveryScope): Promise<readonly DiscoveryCandidate[]>;
}

export type ConnectorTransportCategory = 'timeout' | 'dns' | 'tls' | 'connect' | 'network';

const CONNECT_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT',
  'UND_ERR_SOCKET',
]);

function safeErrorProperty(error: object, property: 'name' | 'code' | 'cause' | 'errors'): unknown {
  try {
    return (error as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function directTransportCategory(error: object): ConnectorTransportCategory | null {
  const rawName = safeErrorProperty(error, 'name');
  const rawCode = safeErrorProperty(error, 'code');
  const name = typeof rawName === 'string' ? rawName.toUpperCase() : '';
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';

  if (
    name === 'ABORTERROR' ||
    name === 'TIMEOUTERROR' ||
    code === 'ABORT_ERR' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code.includes('TIMEOUT')
  ) {
    return 'timeout';
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EAI_FAIL' ||
    code === 'EAI_NODATA' ||
    code === 'EAI_NONAME' ||
    code.startsWith('ERR_DNS_')
  ) {
    return 'dns';
  }
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ) {
    return 'tls';
  }
  return CONNECT_ERROR_CODES.has(code) ? 'connect' : null;
}

function connectorTransportCategory(error: unknown): ConnectorTransportCategory {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  let inspected = 0;

  while (pending.length > 0 && inspected < 16) {
    const candidate = pending.shift();
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    inspected += 1;

    const category = directTransportCategory(candidate);
    if (category) return category;

    pending.push(safeErrorProperty(candidate, 'cause'));
    const errors = safeErrorProperty(candidate, 'errors');
    if (Array.isArray(errors)) pending.push(...errors);
  }

  return 'network';
}

function connectorTimeoutError(): Error {
  const error = new Error('Connector request timed out.');
  error.name = 'TimeoutError';
  return error;
}

export class ConnectorRequestError extends Error {
  public readonly transportCategory: ConnectorTransportCategory | null;

  public constructor(
    public readonly connector: ConnectorName,
    public readonly operation: string,
    public readonly httpStatus: number,
    transportCategory: ConnectorTransportCategory | null = null,
    public readonly retryAt: Date | null = null,
    public readonly providerCode: string | null = null,
    public readonly naverApiProvider: NaverApiProvider | null = null,
  ) {
    const sanitizedCategory = httpStatus === 0 ? (transportCategory ?? 'network') : null;
    super(
      sanitizedCategory
        ? `${connector} ${operation} failed with HTTP 0 (transport: ${sanitizedCategory}).`
        : `${connector} ${operation} failed with HTTP ${httpStatus}.`,
    );
    this.name = 'ConnectorRequestError';
    this.transportCategory = sanitizedCategory;
  }
}

const MAX_METADATA_BYTES = 5 * 1024 * 1024;

function retryAfterDate(value: string | null, now = Date.now()): Date | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const timestamp = /^\d+$/.test(trimmed)
    ? now + Number(trimmed) * 1_000
    : /[a-z]/i.test(trimmed)
      ? Date.parse(trimmed)
      : Number.NaN;
  const retryAt = new Date(timestamp);
  return Number.isFinite(retryAt.getTime()) && timestamp >= now ? retryAt : null;
}

function ipv4Octets(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.length === 4 ? octets : null;
}

function ipv6Groups(address: string): readonly number[] | null {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized.includes('%')) return null;
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    const octets = ipv4Octets(normalized.slice(separator + 1));
    if (separator < 0 || !octets) return null;
    normalized = `${normalized.slice(0, separator)}:${(octets[0]! * 256 + octets[1]!).toString(
      16,
    )}:${(octets[2]! * 256 + octets[3]!).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (value: string): number[] | null => {
    if (!value) return [];
    const groups = value.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  const zeroCount = 8 - left.length - right.length;
  if (
    zeroCount < 0 ||
    (halves.length === 1 && zeroCount !== 0) ||
    (halves.length === 2 && zeroCount < 1)
  ) {
    return null;
  }
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

function isDisallowedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = isIP(normalized);
  const octets = ipv4Octets(normalized);
  if (octets) {
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  const groups = ipv6Groups(normalized);
  if (groups) {
    const mappedV4 =
      groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
        ? `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`
        : null;
    const ipv4Compatible = groups.slice(0, 6).every((group) => group === 0);
    return (
      groups.every((group) => group === 0) ||
      (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
      (groups[0]! & 0xfe00) === 0xfc00 ||
      (groups[0]! & 0xffc0) === 0xfe80 ||
      (groups[0]! & 0xffc0) === 0xfec0 ||
      (groups[0]! & 0xff00) === 0xff00 ||
      (groups[0] === 0x2001 && groups[1] === 0x0db8) ||
      groups[0] === 0x2002 ||
      (groups[0] === 0x0064 && groups[1] === 0xff9b && (groups[2] === 0 || groups[2] === 1)) ||
      ipv4Compatible ||
      (mappedV4 !== null && isDisallowedAddress(mappedV4))
    );
  }
  return ipVersion !== 0;
}

function assertPublicHttpLink(value: string, base?: URL): URL {
  if (value.length > 16_000) {
    throw new Error('Discovered link exceeds the storage safety limit.');
  }
  const url = new URL(value, base);
  if (url.toString().length > 16_000) {
    throw new Error('Resolved discovered link exceeds the storage safety limit.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('Discovered links must be credential-free HTTP(S) URLs.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    isDisallowedAddress(hostname)
  ) {
    throw new Error('Discovered link uses a disallowed host literal.');
  }
  return url;
}

export interface FeedCheckpoint {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checkedAt: string;
  readonly httpStatus: number;
}

export interface FeedCheckpointStore {
  load(connector: ConnectorName, url: string): Promise<FeedCheckpoint | null>;
  save(connector: ConnectorName, url: string, checkpoint: FeedCheckpoint): Promise<void>;
  recordFailure?(connector: ConnectorName, url: string, message: string, at: Date): Promise<void>;
}

export interface FeedResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export type FeedTransport = typeof fetchPinnedHttpsBytes;

function feedValidator(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value) ? value : null;
}

async function fetchPinnedHttpsBytes(
  connector: ConnectorName,
  operation: string,
  url: URL,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<FeedResponse> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => {
      dnsTimer = setTimeout(() => reject(connectorTimeoutError()), timeoutMs);
      dnsTimer.unref?.();
    }),
  ])
    .catch((error: unknown) => {
      throw new ConnectorRequestError(connector, operation, 0, connectorTransportCategory(error));
    })
    .finally(() => {
      if (dnsTimer) clearTimeout(dnsTimer);
    });
  if (addresses.length === 0 || addresses.some((entry) => isDisallowedAddress(entry.address))) {
    throw new Error('Configured endpoint resolves to a disallowed address.');
  }
  const selected = addresses[0]!;
  return new Promise<FeedResponse>((resolve, reject) => {
    let settled = false;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const clearWallTimer = (): void => {
      if (wallTimer) clearTimeout(wallTimer);
      wallTimer = undefined;
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearWallTimer();
      reject(error);
    };
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: selected.address,
        family: selected.family,
        port: url.port ? Number(url.port) : 443,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        servername: hostname,
        headers: { ...headers, Host: url.host },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const etag = feedValidator(response.headers.etag);
        const lastModified = feedValidator(response.headers['last-modified']);
        if (status === 304) {
          response.resume();
          settled = true;
          clearWallTimer();
          resolve({ status, bytes: new Uint8Array(), etag, lastModified });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          fail(new ConnectorRequestError(connector, operation, status));
          return;
        }
        const declared = Number(response.headers['content-length'] ?? 0);
        if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
          response.destroy();
          fail(new Error('Connector metadata response exceeded its size limit.'));
          return;
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > MAX_METADATA_BYTES) {
            response.destroy();
            fail(new Error('Connector metadata response exceeded its size limit.'));
            return;
          }
          chunks.push(bytes);
        });
        response.once('error', (error) => {
          fail(
            new ConnectorRequestError(connector, operation, 0, connectorTransportCategory(error)),
          );
        });
        response.once('end', () => {
          if (settled) return;
          settled = true;
          clearWallTimer();
          const output = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve({ status, bytes: output, etag, lastModified });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(connectorTimeoutError());
    });
    // 바이트를 조금씩 보내는 응답은 소켓 유휴 시간 제한을 피할 수 있습니다.
    // DNS 주소를 고정한 요청 전체에도 실제 경과 시간 제한을 적용합니다.
    wallTimer = setTimeout(() => {
      request.destroy(connectorTimeoutError());
    }, timeoutMs);
    wallTimer.unref?.();
    request.once('error', (error) => {
      fail(
        error instanceof ConnectorRequestError
          ? error
          : new ConnectorRequestError(connector, operation, 0, connectorTransportCategory(error)),
      );
    });
    request.end();
  });
}

async function fetchJson(
  connector: ConnectorName,
  operation: string,
  fetchImpl: FetchImplementation,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  naverApiProvider: NaverApiProvider | null = null,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (connector === 'SEC' && error && typeof error === 'object') {
      const cooldown = error as { httpStatus?: unknown; retryAt?: unknown };
      if (
        (cooldown.httpStatus === 403 || cooldown.httpStatus === 429) &&
        cooldown.retryAt instanceof Date &&
        !Number.isNaN(cooldown.retryAt.getTime())
      ) {
        throw new ConnectorRequestError(
          connector,
          operation,
          cooldown.httpStatus,
          null,
          cooldown.retryAt,
        );
      }
    }
    throw new ConnectorRequestError(
      connector,
      operation,
      0,
      connectorTransportCategory(error),
      null,
      null,
      naverApiProvider,
    );
  }
  if (!response.ok) {
    const retryAt =
      response.status === 429 ? retryAfterDate(response.headers.get('retry-after')) : null;
    const providerCode = connector === 'NAVER' ? await readNaverErrorCode(response) : null;
    // Error bodies are not retained or logged; release the connection without waiting on them.
    void response.body?.cancel().catch(() => undefined);
    throw new ConnectorRequestError(
      connector,
      operation,
      response.status,
      null,
      retryAt,
      providerCode,
      naverApiProvider,
    );
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readBoundedResponseBytes(response, {
          maxBytes: MAX_METADATA_BYTES,
          errorMessage: 'Connector metadata response exceeded its size limit.',
          cancelReason: 'metadata response too large',
        }),
      ),
    );
  } catch {
    throw new Error(`${connector} returned invalid UTF-8 JSON for ${operation}.`);
  }
}

function configuredHealth(
  connector: ConnectorName,
  rightsMode: RightsMode,
  configured: boolean,
  disabledMessage: string,
  now: Date,
): ConnectorHealthCheck {
  return Object.freeze({
    connector,
    status: configured ? ConnectorStatus.HEALTHY : ConnectorStatus.UNCONFIGURED,
    message: configured ? null : disabledMessage,
    checkedAt: now,
    rightsMode,
  });
}

export function connectorFailureMessage(error: unknown): string {
  if (error instanceof ConnectorRequestError) {
    if (error.connector === 'NAVER') {
      const message = naverFailureMessage(
        error.httpStatus,
        error.providerCode,
        error.naverApiProvider ?? 'developers',
      );
      if (message) return message;
    }
    if (
      ((error.connector === 'GDELT' && error.httpStatus === 429) ||
        (error.connector === 'SEC' && [403, 429].includes(error.httpStatus))) &&
      error.retryAt
    ) {
      const retryTime = new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(error.retryAt);
      return `${error.connector} 요청 제한(HTTP ${error.httpStatus})으로 대기 중입니다. ${retryTime} KST 이후 정기 수집에서 재시도합니다.`;
    }
    if (
      error.connector === 'GDELT' &&
      error.httpStatus === 0 &&
      error.transportCategory === 'timeout'
    ) {
      return 'GDELT 서버 연결/응답 시간이 초과되었습니다. 다음 정기 점검에서 다시 확인합니다.';
    }
  }
  return error instanceof Error ? error.message : 'Connector probe failed.';
}

abstract class ConnectorBase implements LinkDiscoveryAdapter {
  public abstract readonly name: ConnectorName;
  public abstract readonly rightsMode: RightsMode;
  protected abstract readonly configured: boolean;
  protected abstract readonly disabledMessage: string;

  public health(now = new Date()): ConnectorHealthCheck {
    return configuredHealth(this.name, this.rightsMode, this.configured, this.disabledMessage, now);
  }

  public async check(now = new Date()): Promise<ConnectorHealthCheck> {
    if (!this.configured) return this.health(now);
    try {
      const metadata = await this.probe();
      return Object.freeze({
        connector: this.name,
        status: ConnectorStatus.HEALTHY,
        message: null,
        checkedAt: now,
        rightsMode: this.rightsMode,
        metadata,
      });
    } catch (error) {
      return Object.freeze({
        connector: this.name,
        status: ConnectorStatus.DEGRADED,
        message: connectorFailureMessage(error),
        checkedAt: now,
        rightsMode: this.rightsMode,
        ...(error instanceof ConnectorRequestError
          ? {
              metadata: {
                httpStatus: error.httpStatus,
                operation: error.operation,
                transportCategory: error.transportCategory,
                retryAt: error.retryAt?.toISOString() ?? null,
                providerCode: error.providerCode,
              },
            }
          : {}),
      });
    }
  }

  protected abstract probe(): Promise<Readonly<Record<string, unknown>>>;
  public abstract discoverLinks(scope?: DiscoveryScope): Promise<readonly DiscoveryCandidate[]>;
}

const naverSchema = z.object({
  items: z.array(
    z.object({
      title: z.string(),
      originallink: z.string().optional(),
      link: z.string(),
      description: z.string().optional(),
      pubDate: z.string().optional(),
    }),
  ),
});

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

export class NaverNewsConnector extends ConnectorBase {
  public override readonly name = 'NAVER' as const;
  public override readonly rightsMode = RightsMode.STORE_METADATA_ONLY;
  protected override readonly configured: boolean;
  protected override readonly disabledMessage = 'NAVER_CLIENT_ID or NAVER_CLIENT_SECRET missing';

  public constructor(
    private readonly clientId: string | null,
    private readonly clientSecret: string | null,
    private readonly fetchImpl: FetchImplementation,
    private readonly timeoutMs: number,
    private readonly apiProvider: NaverApiProvider = 'developers',
  ) {
    super();
    this.configured = Boolean(clientId && clientSecret);
  }

  private get providerMetadata(): Readonly<{
    provider: NaverApiProvider;
    apiEndpoint: string;
  }> {
    return Object.freeze({
      provider: this.apiProvider,
      apiEndpoint:
        this.apiProvider === 'ncloud'
          ? 'https://naverapihub.apigw.ntruss.com/search/v1/news'
          : 'https://openapi.naver.com/v1/search/news.json',
    });
  }

  public override health(now = new Date()): ConnectorHealthCheck {
    return Object.freeze({ ...super.health(now), metadata: this.providerMetadata });
  }

  public override async check(now = new Date()): Promise<ConnectorHealthCheck> {
    const health = await super.check(now);
    return Object.freeze({
      ...health,
      metadata: Object.freeze({ ...this.providerMetadata, ...health.metadata }),
    });
  }

  public async search(input: {
    readonly query: string;
    readonly ticker?: string | null;
    readonly display?: number;
    readonly start?: number;
    readonly sort?: 'date' | 'sim';
  }): Promise<readonly DiscoveryCandidate[]> {
    if (!this.clientId || !this.clientSecret) return [];
    const query = input.query.trim();
    if (!query) throw new Error('NAVER query is required.');
    const display = Math.min(100, Math.max(1, input.display ?? 20));
    const start = Math.min(1000, Math.max(1, input.start ?? 1));
    const url = new URL(this.providerMetadata.apiEndpoint);
    url.searchParams.set('query', query);
    url.searchParams.set('display', String(display));
    url.searchParams.set('start', String(start));
    url.searchParams.set('sort', input.sort ?? 'date');
    if (this.apiProvider === 'ncloud') url.searchParams.set('format', 'json');
    const credentials: Record<string, string> =
      this.apiProvider === 'ncloud'
        ? {
            'X-NCP-APIGW-API-KEY-ID': this.clientId,
            'X-NCP-APIGW-API-KEY': this.clientSecret,
          }
        : {
            'X-Naver-Client-Id': this.clientId,
            'X-Naver-Client-Secret': this.clientSecret,
          };
    const raw = await fetchJson(
      this.name,
      'news-search',
      this.fetchImpl,
      url,
      {
        headers: {
          ...credentials,
          Accept: 'application/json',
        },
      },
      this.timeoutMs,
      this.apiProvider,
    );
    return Object.freeze(
      naverSchema.parse(raw).items.map((item) =>
        Object.freeze({
          connector: this.name,
          externalId: null,
          title: stripMarkup(item.title),
          url: assertPublicHttpLink(item.originallink || item.link).toString(),
          publishedAt:
            item.pubDate && !Number.isNaN(Date.parse(item.pubDate))
              ? new Date(item.pubDate).toISOString()
              : null,
          sourceName: null,
          tickers: Object.freeze(input.ticker ? [input.ticker] : []),
          tags: Object.freeze([]),
          rightsMode: this.rightsMode,
          metadata: Object.freeze({
            ...this.providerMetadata,
            description: stripMarkup(item.description ?? ''),
            discoveryQuery: query,
            aggregatorUrl: assertPublicHttpLink(item.link).toString(),
          }),
        }),
      ),
    );
  }

  protected override async probe(): Promise<Readonly<Record<string, unknown>>> {
    const results = await this.search({ query: '증권', display: 1 });
    return { capability: 'NEWS_SEARCH', resultCount: results.length };
  }

  public override async discoverLinks(
    scope?: DiscoveryScope,
  ): Promise<readonly DiscoveryCandidate[]> {
    const results: DiscoveryCandidate[] = [];
    for (const company of scope?.companies ?? []) {
      const query = company.nameKo.trim() || company.stockCode || company.ticker;
      if (!query) continue;
      results.push(
        ...(await this.search({
          query,
          ticker: company.stockCode ?? company.ticker,
          display: 10,
        })),
      );
    }
    return Object.freeze(results);
  }
}

const secSubmissionsSchema = z.object({
  cik: z
    .union([z.string().regex(/^\d{1,10}$/), z.number().int().positive().max(9_999_999_999)])
    .transform((value) => String(value).padStart(10, '0'))
    .refine((value) => value !== '0000000000'),
  name: z.string(),
  filings: z.object({
    recent: z
      .object({
        accessionNumber: z.array(z.string()),
        filingDate: z.array(z.string()),
        form: z.array(z.string()),
        primaryDocument: z.array(z.string()),
        acceptanceDateTime: z.array(z.string()).optional(),
        reportDate: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
});

function secOriginalFiling(
  rows: Record<string, unknown>,
  index: number,
): {
  fields: Record<string, string | number | boolean | null>;
  truncated: boolean;
} {
  const fields: Record<string, string | number | boolean | null> = {};
  let truncated = false;
  for (const [key, column] of Object.entries(rows)) {
    if (!Array.isArray(column) || column[index] === undefined) continue;
    if (Object.keys(fields).length >= 40) {
      truncated = true;
      break;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key)) {
      truncated = true;
      continue;
    }
    const value: unknown = column[index];
    if (typeof value === 'string') {
      fields[key] = value.slice(0, 2_048);
      truncated ||= value.length > 2_048;
    } else if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      fields[key] = value;
    } else {
      truncated = true;
    }
  }
  return { fields, truncated };
}

export class SecSubmissionsConnector extends ConnectorBase {
  public override readonly name = 'SEC' as const;
  public override readonly rightsMode = RightsMode.OFFICIAL_PUBLIC_DATA;
  protected override readonly configured: boolean;
  protected override readonly disabledMessage = 'SEC_USER_AGENT missing';
  private nextAllowedAt = 0;
  private throttleTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly userAgent: string | null,
    private readonly fetchImpl: FetchImplementation,
    private readonly timeoutMs: number,
  ) {
    super();
    this.configured = Boolean(userAgent);
  }

  public override health(now = new Date()): ConnectorHealthCheck {
    return Object.freeze({
      ...super.health(now),
      status: this.configured ? ConnectorStatus.DEGRADED : ConnectorStatus.UNCONFIGURED,
      message: this.configured
        ? 'Configured; awaiting SEC discovery results.'
        : this.disabledMessage,
      metadata: {
        healthSource: 'SEC_INGESTION',
        configured: this.configured,
        capability: 'SUBMISSIONS',
      },
    });
  }

  public override async check(now = new Date()): Promise<ConnectorHealthCheck> {
    return this.health(now);
  }

  private async throttle(): Promise<void> {
    const turn = this.throttleTail.then(async () => {
      const waitMs = Math.max(0, this.nextAllowedAt - Date.now());
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      this.nextAllowedAt = Date.now() + 200;
    });
    this.throttleTail = turn.catch(() => undefined);
    await turn;
  }

  public async submissions(
    cik: string,
    ticker: string | readonly string[] | null = null,
    limit = 20,
  ): Promise<readonly DiscoveryCandidate[]> {
    if (!this.userAgent) return [];
    if (!/^\d{10}$/.test(cik)) throw new Error('SEC CIK must contain 10 digits.');
    await this.throttle();
    const url = new URL(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const raw = await fetchJson(
      this.name,
      'submissions',
      this.fetchImpl,
      url,
      { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } },
      this.timeoutMs,
    );
    const parsed = secSubmissionsSchema.parse(raw);
    if (parsed.cik !== cik)
      throw new Error('SEC submissions CIK does not match the requested issuer.');
    const rows = parsed.filings.recent;
    const numericCik = parsed.cik.replace(/^0+/, '');
    const tickers = [...new Set(typeof ticker === 'string' ? [ticker] : (ticker ?? []))].sort();
    return Object.freeze(
      rows.accessionNumber.slice(0, Math.min(100, Math.max(1, limit))).map((accession, index) => {
        const primary = rows.primaryDocument[index] ?? '';
        if (!/^\d{10}-\d{2}-\d{6}$/.test(accession))
          throw new Error('SEC returned an invalid accession number.');
        const segments = primary.split('/');
        if (
          primary.length > 1_024 ||
          segments.some(
            (segment) =>
              !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === '.' || segment === '..',
          )
        )
          throw new Error('SEC returned an unsafe primary document path.');
        const acceptanceDateTime = rows.acceptanceDateTime?.[index] ?? null;
        const acceptedInstant = z.string().datetime({ offset: true }).safeParse(acceptanceDateTime);
        const original = secOriginalFiling(rows, index);
        return Object.freeze({
          connector: this.name,
          externalId: accession,
          title: `${rows.form[index] ?? 'SEC filing'} — ${parsed.name}`,
          url: `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accession.replaceAll('-', '')}/${segments.map(encodeURIComponent).join('/')}`,
          // filingDate stays date-only; only an explicitly zoned acceptance time is an instant.
          publishedAt: acceptedInstant.success
            ? new Date(acceptedInstant.data).toISOString()
            : null,
          sourceName: 'SEC EDGAR',
          tickers: Object.freeze(tickers),
          tags: Object.freeze([rows.form[index] ?? 'UNKNOWN']),
          rightsMode: this.rightsMode,
          metadata: Object.freeze({
            cik,
            form: rows.form[index] ?? null,
            filingDate: rows.filingDate[index] ?? null,
            reportDate: rows.reportDate?.[index] ?? null,
            acceptanceDateTime,
            primaryDocument: primary,
            originalFiling: original.fields,
            originalFilingTruncated: original.truncated,
          }),
        });
      }),
    );
  }

  protected override async probe(): Promise<Readonly<Record<string, unknown>>> {
    return this.health().metadata ?? {};
  }

  public override async discoverLinks(
    scope?: DiscoveryScope,
  ): Promise<readonly DiscoveryCandidate[]> {
    const results: DiscoveryCandidate[] = [];
    const issuers = new Map<string, Set<string>>();
    for (const company of scope?.companies ?? []) {
      if (!company.cik) continue;
      const cik = company.cik.padStart(10, '0');
      if (!/^\d{10}$/.test(cik) || cik === '0000000000') continue;
      const tickers = issuers.get(cik) ?? new Set<string>();
      if (company.ticker) tickers.add(company.ticker);
      issuers.set(cik, tickers);
    }
    for (const [cik, tickers] of issuers) {
      results.push(...(await this.submissions(cik, [...tickers].sort(), 20)));
    }
    return Object.freeze(results);
  }
}

const gdeltSchema = z.object({
  articles: z
    .array(
      z.object({
        url: z.string(),
        title: z.string(),
        seendate: z.string().optional(),
        domain: z.string().optional(),
        sourcecountry: z.string().optional(),
        language: z.string().optional(),
      }),
    )
    .optional(),
});

function gdeltInstant(value: string | undefined): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value ?? '');
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`
    : null;
}

const GDELT_REQUEST_INTERVAL_MS = 5_000;
const GDELT_INITIAL_COOLDOWN_MS = 60_000;
const GDELT_MAX_FALLBACK_COOLDOWN_MS = 15 * 60_000;
const GDELT_HEALTH_CACHE_MS = 10 * 60_000;

interface GdeltRequestState {
  nextRequestAt: number;
  retryAt: Date | null;
  rateLimitStreak: number;
  requestTail: Promise<void>;
  successfulCheck: ConnectorHealthCheck | null;
  pendingCheck: Promise<ConnectorHealthCheck> | null;
}

// Health checks recreate adapters. Share limits within the worker's HTTP transport
// so those instances and discovery traffic cannot each consume a separate quota.
const gdeltRequestStates = new WeakMap<FetchImplementation, GdeltRequestState>();

function gdeltRequestState(fetchImpl: FetchImplementation): GdeltRequestState {
  const existing = gdeltRequestStates.get(fetchImpl);
  if (existing) return existing;
  const state: GdeltRequestState = {
    nextRequestAt: 0,
    retryAt: null,
    rateLimitStreak: 0,
    requestTail: Promise.resolve(),
    successfulCheck: null,
    pendingCheck: null,
  };
  gdeltRequestStates.set(fetchImpl, state);
  return state;
}

export class GdeltMetadataConnector extends ConnectorBase {
  public override readonly name = 'GDELT' as const;
  public override readonly rightsMode = RightsMode.STORE_METADATA_ONLY;
  protected override readonly disabledMessage =
    'GDELT is disabled or has no approved publisher domains';
  private readonly requestState: GdeltRequestState;

  public constructor(
    protected override readonly configured: boolean,
    private readonly fetchImpl: FetchImplementation,
    private readonly timeoutMs: number,
    private readonly approvedDomains: readonly string[] = [],
  ) {
    super();
    if (
      approvedDomains.some(
        (domain) =>
          APPROVED_GDELT_SOURCE_POLICIES[domain]?.metadataStorageAllowed !== true ||
          APPROVED_GDELT_SOURCE_POLICIES[domain]?.displayAllowed !== true,
      )
    )
      throw new Error('GDELT domains require a reviewed source policy.');
    this.requestState = gdeltRequestState(fetchImpl);
  }

  public override health(now = new Date()): ConnectorHealthCheck {
    return {
      ...super.health(now),
      metadata: {
        healthSource: 'GDELT_INGESTION',
        configured: this.configured,
        approvedDomains: this.approvedDomains,
      },
    };
  }

  private assertNotCoolingDown(): void {
    const retryAt = this.requestState.retryAt;
    if (retryAt && retryAt.getTime() > Date.now()) {
      throw new ConnectorRequestError(this.name, 'document-search', 429, null, retryAt);
    }
  }

  private async request(url: URL): Promise<unknown> {
    // A cooldown is a deferred future attempt, never a long sleep or an immediate retry.
    this.assertNotCoolingDown();
    const state = this.requestState;
    const turn = state.requestTail.then(async () => {
      this.assertNotCoolingDown();
      const waitMs = Math.max(0, state.nextRequestAt - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.assertNotCoolingDown();
      state.nextRequestAt = Date.now() + GDELT_REQUEST_INTERVAL_MS;
      try {
        const result = await fetchJson(
          this.name,
          'document-search',
          this.fetchImpl,
          url,
          { headers: { Accept: 'application/json' } },
          this.timeoutMs,
        );
        state.rateLimitStreak = 0;
        state.retryAt = null;
        return result;
      } catch (error) {
        state.successfulCheck = null;
        if (error instanceof ConnectorRequestError && error.httpStatus === 429) {
          state.rateLimitStreak = Math.min(state.rateLimitStreak + 1, 5);
          const fallbackMs = Math.min(
            GDELT_MAX_FALLBACK_COOLDOWN_MS,
            GDELT_INITIAL_COOLDOWN_MS * 2 ** (state.rateLimitStreak - 1),
          );
          state.retryAt = new Date(
            Math.max(Date.now() + fallbackMs, error.retryAt?.getTime() ?? 0),
          );
          throw new ConnectorRequestError(this.name, 'document-search', 429, null, state.retryAt);
        }
        throw error;
      }
    });
    state.requestTail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  public override async check(now = new Date()): Promise<ConnectorHealthCheck> {
    if (!this.configured) return this.health(now);
    const state = this.requestState;
    const cached = state.successfulCheck;
    if (cached && Date.now() - cached.checkedAt.getTime() < GDELT_HEALTH_CACHE_MS) {
      return Object.freeze({
        ...cached,
        metadata: {
          ...cached.metadata,
          cached: true,
          lastProbeAt: cached.checkedAt.toISOString(),
        },
      });
    }
    if (state.pendingCheck) return state.pendingCheck;
    const pending = super.check(now);
    state.pendingCheck = pending;
    try {
      const result = await pending;
      if (result.status === ConnectorStatus.HEALTHY) state.successfulCheck = result;
      return result;
    } finally {
      state.pendingCheck = null;
    }
  }

  public async search(
    query: string,
    maxRecords = 20,
    options: { readonly timespan?: '1h' } = {},
  ): Promise<readonly DiscoveryCandidate[]> {
    if (!this.configured) return [];
    if (!query.trim()) throw new Error('GDELT query is required.');
    const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
    url.searchParams.set('query', query.trim());
    url.searchParams.set('mode', 'artlist');
    url.searchParams.set('format', 'json');
    url.searchParams.set('sort', 'datedesc');
    url.searchParams.set('maxrecords', String(Math.min(250, Math.max(1, maxRecords))));
    if (options.timespan) url.searchParams.set('timespan', options.timespan);
    const parsed = gdeltSchema.parse(await this.request(url));
    return Object.freeze(
      (parsed.articles ?? []).map((item) =>
        Object.freeze({
          connector: this.name,
          externalId: null,
          title: item.title,
          url: assertPublicHttpLink(item.url).toString(),
          // GDELT seendate is a crawl observation, never the publisher's date.
          publishedAt: null,
          sourceName: item.domain ?? null,
          tickers: Object.freeze([]),
          tags: Object.freeze([]),
          rightsMode: this.rightsMode,
          metadata: Object.freeze({
            observedBySourceAt: gdeltInstant(item.seendate),
            originalSeenDate: item.seendate ?? null,
            country: item.sourcecountry ?? null,
            language: item.language ?? null,
          }),
        }),
      ),
    );
  }

  protected override async probe(): Promise<Readonly<Record<string, unknown>>> {
    const results = await this.search('stock market', 1, { timespan: '1h' });
    return {
      capability: 'DOCUMENT_METADATA_SEARCH',
      resultCount: results.length,
      timespan: '1h',
      minRequestIntervalMs: GDELT_REQUEST_INTERVAL_MS,
      cached: false,
    };
  }

  public override async discoverLinks(): Promise<readonly DiscoveryCandidate[]> {
    if (!this.configured || this.approvedDomains.length === 0) return [];
    const domains = this.approvedDomains.map((domain) => `domainis:${domain}`).join(' OR ');
    const query = `(economy OR earnings OR market OR industry OR company) (${domains})`;
    const candidates = await this.search(query, 250, { timespan: '1h' });
    return Object.freeze(
      candidates
        .filter((candidate) => {
          const hostname = new URL(candidate.url).hostname.toLowerCase();
          return this.approvedDomains.some(
            (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
          );
        })
        .map((candidate) => ({
          ...candidate,
          externalId: createHash('sha256').update(candidate.url).digest('hex'),
          sourceKind: NewsSourceKind.INDEPENDENT_MEDIA,
          sourcePolicy:
            APPROVED_GDELT_SOURCE_POLICIES[
              this.approvedDomains.find(
                (domain) =>
                  new URL(candidate.url).hostname === domain ||
                  new URL(candidate.url).hostname.endsWith(`.${domain}`),
              )!
            ],
          metadata: { ...candidate.metadata, discoveryQuery: query, discoveryProvider: 'GDELT' },
        })),
    );
  }
}

export function assertRegisteredFeedUrl(value: string): URL {
  const url = assertPublicHttpLink(value);
  if (url.protocol !== 'https:') {
    throw new Error('Registered feed URLs must be credential-free HTTPS URLs.');
  }
  return url;
}

export const MAX_REGISTERED_IR_FEEDS = 100;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  const object = objectValue(value);
  return typeof object['#text'] === 'string' ? object['#text'] : '';
}

/** Validator updates are committed only after the associated feed items are persisted. */
class ConditionalFeedReader {
  private readonly pending = new Map<string, FeedCheckpoint>();
  public notModifiedCount = 0;
  public constructor(
    private readonly connector: ConnectorName,
    private readonly timeoutMs: number,
    private readonly store?: FeedCheckpointStore,
    private readonly transport: FeedTransport = fetchPinnedHttpsBytes,
  ) {}
  public reset(): void {
    this.pending.clear();
    this.notModifiedCount = 0;
  }
  public async fetch(url: URL, operation: string): Promise<Uint8Array | null> {
    const previous = await this.store?.load(this.connector, url.toString());
    const headers: Record<string, string> = {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      'User-Agent': 'Orsem/0.1 (+https://orsem.laetipark.me; noncommercial RSS reader)',
    };
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
    const response = await this.transport(this.connector, operation, url, headers, this.timeoutMs);
    if (response.status === 304 && !previous?.etag && !previous?.lastModified)
      throw new Error('RSS returned 304 without an established cached response.');
    this.pending.set(url.toString(), {
      etag: response.etag ?? (response.status === 304 ? (previous?.etag ?? null) : null),
      lastModified:
        response.lastModified ??
        (response.status === 304 ? (previous?.lastModified ?? null) : null),
      checkedAt: new Date().toISOString(),
      httpStatus: response.status,
    });
    if (response.status === 304) {
      this.notModifiedCount += 1;
      return null;
    }
    return response.bytes;
  }
  public async fail(url: string, message: string): Promise<void> {
    this.pending.delete(url);
    await this.store?.recordFailure?.(this.connector, url, message, new Date());
  }
  public async commit(): Promise<void> {
    for (const [url, checkpoint] of this.pending)
      await this.store?.save(this.connector, url, checkpoint);
    this.pending.clear();
  }
}

export class RegisteredIrFeedConnector extends ConnectorBase {
  public override readonly name = 'IR' as const;
  public override readonly rightsMode = RightsMode.OFFICIAL_PUBLIC_DATA;
  protected override readonly configured: boolean;
  protected override readonly disabledMessage = 'IR_FEED_URLS has no registered feeds';
  private latestDiscoveryFailureCount = 0;
  private truncated = false;
  private readonly reader: ConditionalFeedReader;

  public constructor(
    private readonly feedUrls: readonly string[],
    private readonly timeoutMs: number,
    checkpointStore?: FeedCheckpointStore,
    transport?: FeedTransport,
  ) {
    super();
    this.reader = new ConditionalFeedReader(this.name, timeoutMs, checkpointStore, transport);
    if (feedUrls.length > MAX_REGISTERED_IR_FEEDS) {
      throw new Error(`Registered IR feeds exceed the safety limit of ${MAX_REGISTERED_IR_FEEDS}.`);
    }
    this.configured = feedUrls.length > 0;
    for (const feedUrl of feedUrls) assertRegisteredFeedUrl(feedUrl);
  }

  public get discoveryFailureCount(): number {
    return this.latestDiscoveryFailureCount;
  }

  public get discoveryWasTruncated(): boolean {
    return this.truncated;
  }
  public async commitFeedCheckpoints(): Promise<void> {
    await this.reader.commit();
  }
  public get discoveryMetadata(): Readonly<Record<string, unknown>> {
    return {
      failedItemOrFeedCount: this.latestDiscoveryFailureCount,
      truncated: this.truncated,
      notModifiedCount: this.reader.notModifiedCount,
    };
  }
  public override health(now = new Date()): ConnectorHealthCheck {
    return {
      ...super.health(now),
      metadata: {
        healthSource: 'IR_INGESTION',
        configured: this.configured,
        feeds: this.feedUrls.length,
      },
    };
  }
  public override async check(now = new Date()): Promise<ConnectorHealthCheck> {
    const health = this.health(now);
    return this.configured
      ? {
          ...health,
          status: ConnectorStatus.DEGRADED,
          message: 'Configured; health is determined by scheduled IR discovery.',
        }
      : health;
  }

  public async fetchFeed(feedUrl: string): Promise<readonly DiscoveryCandidate[]> {
    if (!this.feedUrls.includes(feedUrl)) {
      throw new Error('IR feed is not registered.');
    }
    const url = assertRegisteredFeedUrl(feedUrl);
    const bytes = await this.reader.fetch(url, 'registered-feed');
    if (bytes === null) return [];
    const parsed = parseIrRssFeed(
      url.toString(),
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    this.latestDiscoveryFailureCount += parsed.skippedItems;
    this.truncated ||= parsed.truncated;
    if (parsed.skippedItems > 0 || parsed.truncated)
      await this.reader.fail(
        url.toString(),
        `${parsed.skippedItems} malformed IR item(s); truncated=${parsed.truncated}`,
      );
    return parsed.candidates;
  }

  protected override async probe(): Promise<Readonly<Record<string, unknown>>> {
    let itemCount = 0;
    let failedFeeds = 0;
    for (const feed of this.feedUrls) {
      try {
        itemCount += (await this.fetchFeed(feed)).length;
      } catch {
        failedFeeds += 1;
      }
    }
    if (failedFeeds > 0) {
      throw new Error(
        `${failedFeeds} of ${this.feedUrls.length} registered IR feeds failed their health probe.`,
      );
    }
    return {
      capability: 'RSS_ATOM',
      feeds: this.feedUrls.length,
      itemCount,
    };
  }

  public override async discoverLinks(): Promise<readonly DiscoveryCandidate[]> {
    this.latestDiscoveryFailureCount = 0;
    this.truncated = false;
    this.reader.reset();
    const results: DiscoveryCandidate[] = [];
    let failedFeeds = 0;
    for (const feed of this.feedUrls) {
      try {
        const candidates = await this.fetchFeed(feed);
        results.push(...candidates);
      } catch (error) {
        failedFeeds += 1;
        await this.reader.fail(feed, connectorFailureMessage(error).slice(0, 1000));
      }
    }
    this.latestDiscoveryFailureCount += failedFeeds;
    if (
      (this.configured && failedFeeds === this.feedUrls.length) ||
      (results.length === 0 && this.latestDiscoveryFailureCount > 0)
    )
      throw new Error('Registered IR discovery failed; no healthy feed items were retained.');
    return Object.freeze(results);
  }
}

const MAX_NEWS_RSS_CANDIDATES = 500;

interface ParsedNewsRssFeed {
  readonly candidates: readonly DiscoveryCandidate[];
  readonly skippedItems: number;
  readonly truncated: boolean;
}

function decodedFeedText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? entity;
    const point =
      code[1]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : entity;
  });
}

/** Parse only the fields needed by the private, noncommercial RSS reader. */
export function parseNewsRssFeed(feedId: NewsRssFeedId, xml: string): ParsedNewsRssFeed {
  const feed = NEWS_RSS_FEEDS[feedId];
  if (!feed) throw new Error('NEWS_RSS feed is not allowlisted.');
  return parseRegisteredFeed(feedId, feed, xml, 'NEWS_RSS');
}

export function parseIrRssFeed(feedUrl: string, xml: string): ParsedNewsRssFeed {
  const url = assertRegisteredFeedUrl(feedUrl);
  return parseRegisteredFeed(
    url.toString(),
    {
      url: url.toString(),
      publisher: url.hostname,
      marketRegion: 'global',
      sourceKind: NewsSourceKind.COMPANY_IR,
      rightsContext: 'REGISTERED_OFFICIAL_IR',
      rightsPolicyUrl: url.toString(),
      policy: {
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        aiAllowed: 'UNKNOWN',
        fullTextStorageAllowed: false,
        publicRedistributionAllowed: 'UNKNOWN',
        displayAllowed: true,
        metadataStorageAllowed: true,
        notifyAllowed: false,
        policyUrl: url.toString(),
        checkedAt: '2026-09-05',
      },
    },
    xml,
    'IR',
  );
}

function parseRegisteredFeed(
  feedId: string,
  feed: {
    url: string;
    publisher: string;
    marketRegion: string;
    sourceKind: NewsSourceKind;
    rightsContext: string;
    rightsPolicyUrl: string;
    policy: NewsSourcePolicy;
    categories?: readonly string[];
    publisherId?: string;
  },
  xml: string,
  connector: 'IR' | 'NEWS_RSS',
): ParsedNewsRssFeed {
  if (Buffer.byteLength(xml, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error('NEWS_RSS response exceeded its size limit.');
  }
  assertSafeXml(xml, feed.url);
  assertLexicalXmlComplexity(xml, { nodes: 0 }, { maxDepth: 64, maxNodes: 100_000 });
  if (XMLValidator.validate(xml) !== true) throw new Error('NEWS_RSS returned malformed XML.');
  const parsed = objectValue(
    new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      processEntities: false,
      trimValues: false,
      parseTagValue: false,
    }).parse(xml),
  );
  const rss = objectValue(parsed.rss);
  const atom = objectValue(parsed.feed);
  if (!('channel' in rss) && !('feed' in parsed)) {
    throw new Error('NEWS_RSS returned neither RSS nor Atom.');
  }
  const entries = 'channel' in rss ? asArray(objectValue(rss.channel).item) : asArray(atom.entry);
  const candidates: DiscoveryCandidate[] = [];
  const seenIds = new Set<string>();
  let skippedItems = 0;
  let truncated = false;
  for (const value of entries) {
    if (candidates.length >= MAX_NEWS_RSS_CANDIDATES) {
      truncated = true;
      break;
    }
    try {
      const entry = objectValue(value);
      const originalTitle = textValue(entry.title);
      const links = asArray(entry.link);
      const linkObjects = links.map(objectValue);
      const alternate = linkObjects.find(
        (link) => ['', 'alternate'].includes(textValue(link.rel)) && Boolean(link.href),
      );
      const originalLink =
        links.map(textValue).find((link) => link.trim()) || textValue(alternate?.href);
      const originalGuid = textValue(entry.guid) || textValue(entry.id) || null;
      const originalPublishedAt =
        textValue(entry.pubDate) || textValue(entry.published) || textValue(entry.updated) || null;
      if (
        !originalTitle.trim() ||
        !originalLink.trim() ||
        originalTitle.length > 16_000 ||
        originalLink.length > 8_000 ||
        (originalGuid?.length ?? 0) > 8_000 ||
        (originalPublishedAt?.length ?? 0) > 256
      ) {
        throw new Error('Invalid RSS item metadata.');
      }
      const title = decodedFeedText(originalTitle).trim();
      const articleUrl = assertPublicHttpLink(
        decodedFeedText(originalLink).trim(),
        new URL(feed.url),
      );
      // A fragment does not identify another article. Keep the original link in provenance metadata.
      articleUrl.hash = '';
      const url = articleUrl.toString();
      const externalId = createHash('sha256')
        .update(`${feedId}:${canonicalNewsUrl(url)}`)
        .digest('hex');
      if (seenIds.has(externalId)) continue;
      seenIds.add(externalId);
      const publication = originalPublishedAt ? decodedFeedText(originalPublishedAt).trim() : '';
      // A source date without a timezone is not a collection instant or an assumed KST instant.
      const publishedAt =
        /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)$/i.test(publication) &&
        !Number.isNaN(Date.parse(publication))
          ? new Date(publication).toISOString()
          : null;
      candidates.push(
        Object.freeze({
          connector,
          externalId,
          title,
          url,
          publishedAt,
          sourceName: feed.publisher,
          tickers: Object.freeze([]),
          tags: Object.freeze(
            connector === 'IR' ? ['IR', 'RSS'] : [...(feed.categories ?? ['MARKET']), 'RSS'],
          ),
          rightsMode: feed.policy.rightsMode,
          sourceKind: feed.sourceKind,
          sourcePolicy: feed.policy,
          metadata: Object.freeze({
            feedId,
            feedUrl: feed.url,
            publisher: feed.publisher,
            publisherId: feed.publisherId ?? null,
            originalAuthor:
              textValue(entry.author) ||
              textValue(objectValue(entry.author).name) ||
              textValue(entry['dc:creator']) ||
              null,
            originalCategories: asArray(entry.category)
              .map(textValue)
              .filter(Boolean)
              .slice(0, 100),
            marketRegion: feed.marketRegion,
            rightsContext: feed.rightsContext,
            rightsPolicyUrl: feed.rightsPolicyUrl,
            originalTitle,
            originalLink,
            originalGuid,
            originalPublishedAt,
          }),
        }),
      );
    } catch {
      skippedItems += 1;
    }
  }
  return Object.freeze({ candidates: Object.freeze(candidates), skippedItems, truncated });
}

export class PublisherNewsRssConnector extends ConnectorBase {
  public override readonly name = 'NEWS_RSS' as const;
  public override readonly rightsMode = RightsMode.STORE_METADATA_ONLY;
  protected override readonly configured: boolean;
  protected override readonly disabledMessage = 'NEWS_RSS_FEEDS has no enabled publisher feeds';
  private readonly feedIds: readonly NewsRssFeedId[];
  private failedFeeds = 0;
  private skippedItems = 0;
  private truncated = false;
  private readonly reader: ConditionalFeedReader;

  public constructor(
    feedIds: readonly NewsRssFeedId[],
    private readonly timeoutMs: number,
    checkpointStore?: FeedCheckpointStore,
    transport?: FeedTransport,
  ) {
    super();
    this.reader = new ConditionalFeedReader(this.name, timeoutMs, checkpointStore, transport);
    if (feedIds.some((id) => !NEWS_RSS_FEED_IDS.includes(id))) {
      throw new Error('NEWS_RSS feed is not allowlisted.');
    }
    this.feedIds = Object.freeze([...new Set(feedIds)]);
    this.configured = this.feedIds.length > 0;
  }

  public override health(now = new Date()): ConnectorHealthCheck {
    return Object.freeze({
      ...super.health(now),
      metadata: {
        healthSource: 'NEWS_RSS_INGESTION',
        configured: this.configured,
        feeds: this.feedIds,
        rightsContext: 'NONCOMMERCIAL_RSS_READER',
      },
    });
  }

  public override async check(now = new Date()): Promise<ConnectorHealthCheck> {
    const health = this.health(now);
    return this.configured
      ? Object.freeze({
          ...health,
          status: ConnectorStatus.DEGRADED,
          message: 'Configured; health is determined by scheduled RSS discovery.',
        })
      : health;
  }

  protected override async probe(): Promise<Readonly<Record<string, unknown>>> {
    return this.health().metadata ?? {};
  }

  public get discoveryFailureCount(): number {
    return this.failedFeeds + this.skippedItems;
  }
  public get discoveryWasTruncated(): boolean {
    return this.truncated;
  }
  public get discoveryMetadata(): Readonly<Record<string, unknown>> {
    return {
      failedFeedCount: this.failedFeeds,
      notModifiedCount: this.reader.notModifiedCount,
      skippedItemCount: this.skippedItems,
      truncated: this.truncated,
    };
  }

  public async commitFeedCheckpoints(): Promise<void> {
    await this.reader.commit();
  }

  public async fetchFeed(feedId: NewsRssFeedId): Promise<ParsedNewsRssFeed> {
    if (!this.feedIds.includes(feedId)) throw new Error('NEWS_RSS feed is not enabled.');
    const url = assertRegisteredFeedUrl(NEWS_RSS_FEEDS[feedId].url);
    const bytes = await this.reader.fetch(url, feedId);
    if (bytes === null) return { candidates: [], skippedItems: 0, truncated: false };
    const parsed = parseNewsRssFeed(
      feedId,
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    if (parsed.skippedItems > 0 || parsed.truncated)
      await this.reader.fail(
        url.toString(),
        `${parsed.skippedItems} malformed RSS item(s); truncated=${parsed.truncated}`,
      );
    return parsed;
  }

  public override async discoverLinks(): Promise<readonly DiscoveryCandidate[]> {
    this.reader.reset();
    this.failedFeeds = 0;
    this.skippedItems = 0;
    this.truncated = false;
    const candidates: DiscoveryCandidate[] = [];
    for (const feedId of this.feedIds) {
      try {
        const parsed = await this.fetchFeed(feedId);
        this.skippedItems += parsed.skippedItems;
        candidates.push(...parsed.candidates);
        this.truncated ||= parsed.truncated;
      } catch (error) {
        this.failedFeeds += 1;
        await this.reader.fail(
          NEWS_RSS_FEEDS[feedId].url,
          connectorFailureMessage(error).slice(0, 1000),
        );
      }
    }
    if (
      (this.configured && this.failedFeeds === this.feedIds.length) ||
      (candidates.length === 0 && this.skippedItems > 0)
    ) {
      throw new Error(
        `NEWS_RSS discovery failed: ${this.failedFeeds} feed(s) failed, ${this.skippedItems} malformed item(s) skipped.`,
      );
    }
    return Object.freeze(candidates);
  }
}

export function createLinkDiscoveryAdapters(
  config: WorkerConfig,
  fetchImpl: FetchImplementation = globalThis.fetch,
  checkpointStore?: FeedCheckpointStore,
): readonly LinkDiscoveryAdapter[] {
  return Object.freeze([
    new SecSubmissionsConnector(config.secUserAgent, fetchImpl, config.httpTimeoutMs),
    new GdeltMetadataConnector(
      config.gdeltEnabled && config.gdeltApprovedDomains.length > 0,
      fetchImpl,
      config.httpTimeoutMs,
      config.gdeltApprovedDomains,
    ),
    new RegisteredIrFeedConnector(config.irFeedUrls, config.httpTimeoutMs, checkpointStore),
    new PublisherNewsRssConnector(config.newsRssFeeds, config.httpTimeoutMs, checkpointStore),
  ]);
}
