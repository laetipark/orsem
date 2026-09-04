import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readBoundedResponseText } from '../common/bounded-response';
import { SecAccessCooldownError } from '../connectors/sec-access-policy';
import type { FetchImplementation } from '../opendart/opendart.client';

export const SEC_TICKER_MASTER_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const tickerMasterSchema = z
  .object({
    fields: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u))
      .min(4)
      .max(32),
    data: z.array(z.array(z.unknown()).min(4).max(32)).min(1).max(100_000),
  })
  .passthrough();
const sourceRowSchema = z
  .object({
    cik: z.union([
      z.number().int().min(1).max(9_999_999_999),
      z
        .string()
        .regex(/^\d{1,10}$/u)
        .refine((value) => Number(value) > 0),
    ]),
    name: z.string().min(1).max(2_000),
    ticker: z.string().min(1).max(32),
    exchange: z.string().max(64).nullable(),
  })
  .passthrough();

export interface SecTickerMasterRow {
  readonly cik: string;
  readonly ticker: string;
  readonly exchange: string | null;
  readonly rowIndex: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface SecTickerMasterSnapshot {
  readonly provenanceUrl: typeof SEC_TICKER_MASTER_URL;
  readonly sha256: string;
  readonly sourceLastModified: string | null;
  readonly acquisition: Readonly<
    Record<string, unknown> & {
      method: 'DIRECT_HTTP' | 'SEARCH_CACHE_EXTRACT';
      sha256Basis: 'HTTP_RESPONSE_TEXT' | 'EXTRACTED_JSON';
    }
  >;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly rows: readonly SecTickerMasterRow[];
}

function parseSnapshot(
  text: string,
  sourceLastModified: string | null,
  acquisition: SecTickerMasterSnapshot['acquisition'],
): SecTickerMasterSnapshot {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
    throw new Error('SEC ticker-master snapshot exceeded its size limit.');
  const raw = tickerMasterSchema.parse(JSON.parse(text));
  const fields = new Set(raw.fields);
  if (
    fields.size !== raw.fields.length ||
    !['cik', 'name', 'ticker', 'exchange'].every((field) => fields.has(field))
  )
    throw new Error('Invalid ticker-master columns.');
  const rows = raw.data.map((values, rowIndex) => {
    if (values.length !== raw.fields.length) throw new Error('Invalid ticker-master row.');
    const record = Object.fromEntries(raw.fields.map((field, index) => [field, values[index]]));
    const row = sourceRowSchema.parse(record);
    return Object.freeze({
      cik: String(row.cik).padStart(10, '0'),
      ticker: row.ticker.trim().toUpperCase(),
      exchange: row.exchange?.trim() || null,
      rowIndex,
      raw: Object.freeze(record),
    });
  });
  return Object.freeze({
    provenanceUrl: SEC_TICKER_MASTER_URL,
    sha256: createHash('sha256').update(text).digest('hex'),
    sourceLastModified,
    acquisition: Object.freeze({ ...acquisition }),
    raw: Object.freeze(raw),
    rows: Object.freeze(rows),
  });
}

const searchCacheSchema = z
  .object({
    formatVersion: z.literal(1),
    provenanceUrl: z.literal(SEC_TICKER_MASTER_URL),
    method: z.literal('SEARCH_CACHE_EXTRACT'),
    extractedAt: z.iso.datetime(),
    sourceLastModified: z.null(),
    cacheAge: z.literal('UNKNOWN'),
    coverage: z.literal('SELECTED_ROWS_ONLY'),
    liveIssuerValidation: z.literal('NOT_COMPLETED'),
    fields: z.tuple([
      z.literal('cik'),
      z.literal('name'),
      z.literal('ticker'),
      z.literal('exchange'),
    ]),
    data: tickerMasterSchema.shape.data,
  })
  .strict();

export function parseSecSearchCacheSnapshot(input: unknown): SecTickerMasterSnapshot {
  const cache = searchCacheSchema.parse(input);
  return parseSnapshot(JSON.stringify({ fields: cache.fields, data: cache.data }), null, {
    method: cache.method,
    sha256Basis: 'EXTRACTED_JSON',
    extractedAt: cache.extractedAt,
    cacheAge: cache.cacheAge,
    coverage: cache.coverage,
    liveIssuerValidation: cache.liveIssuerValidation,
  });
}

export class SecTickerMasterClient {
  constructor(
    private readonly userAgent: string | null,
    private readonly fetchImpl: FetchImplementation,
    private readonly timeoutMs: number,
  ) {}

  async fetch(): Promise<SecTickerMasterSnapshot> {
    if (!this.userAgent || this.userAgent.length > 255 || /[\r\n]/u.test(this.userAgent))
      throw new Error('A valid SEC_USER_AGENT is required for SEC ticker-master requests.');
    let response: Response;
    try {
      response = await this.fetchImpl(SEC_TICKER_MASTER_URL, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof SecAccessCooldownError) throw error;
      throw new Error('SEC ticker-master request failed before receiving an HTTP response.');
    }
    if (!response.ok)
      throw new Error(`SEC ticker-master request failed with HTTP ${response.status}.`);
    try {
      const text = await readBoundedResponseText(response, {
        maxBytes: MAX_RESPONSE_BYTES,
        errorMessage: 'SEC ticker-master response exceeded its size limit.',
      });
      return parseSnapshot(text, response.headers.get('last-modified'), {
        method: 'DIRECT_HTTP',
        sha256Basis: 'HTTP_RESPONSE_TEXT',
      });
    } catch {
      throw new Error('SEC ticker-master response was not valid bounded JSON.');
    }
  }
}
