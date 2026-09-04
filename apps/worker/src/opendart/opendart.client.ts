import { Inject, Injectable } from '@nestjs/common';
import type { DisclosureDetailType } from '@orsem/contracts';
import {
  assertLexicalXmlComplexity,
  hasZipMagic,
  OpenDartApiError,
  OpenDartPayloadError,
  readOpenDartArchive,
} from '@orsem/opendart-parser';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { compactDate, nextKstMidnight } from '../common/kst-date';
import { openDartStatusPolicy } from './status-policy';

const OPENDART_BASE_URL = 'https://opendart.fss.or.kr/api/';
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_BYTES = 50 * 1024 * 1024;
const MAX_CORP_CODE_XML_NODES = 2_000_000;
const MAX_CORP_CODE_ITEMS = 250_000;

const optionalString = z.preprocess(
  (value) => (value === null || value === undefined ? '' : value),
  z.string(),
);
const corpCodeSchema = z.string().regex(/^\d{8}$/);
const optionalStockCodeSchema = z.preprocess(
  (value) => (value === null || value === undefined ? '' : value),
  z.string().regex(/^(?:|[0-9A-Z]{6})$/),
);

const envelopeSchema = z.object({
  status: z.string(),
  message: z.string(),
});

const disclosureItemSchema = z.object({
  corp_code: corpCodeSchema,
  corp_name: z.string(),
  stock_code: optionalStockCodeSchema,
  corp_cls: optionalString,
  report_nm: z.string(),
  rcept_no: z.string().regex(/^\d{14}$/),
  flr_nm: z.string(),
  rcept_dt: z.string().regex(/^\d{8}$/),
  rm: optionalString,
});

const disclosureResponseSchema = envelopeSchema.extend({
  page_no: z.coerce.number().int().positive().optional(),
  page_count: z.coerce.number().int().positive().optional(),
  total_count: z.coerce.number().int().nonnegative().optional(),
  total_page: z.coerce.number().int().nonnegative().optional(),
  list: z.array(disclosureItemSchema).optional(),
});

const eleStockItemSchema = z.object({
  rcept_no: z.string().regex(/^\d{14}$/),
  rcept_dt: z.string(),
  corp_code: corpCodeSchema,
  corp_name: z.string(),
  repror: optionalString,
  isu_exctv_rgist_at: optionalString,
  isu_exctv_ofcps: optionalString,
  isu_main_shrholdr: optionalString,
  sp_stock_lmp_cnt: optionalString,
  sp_stock_lmp_irds_cnt: optionalString,
  sp_stock_lmp_rate: optionalString,
  sp_stock_lmp_irds_rate: optionalString,
});

const majorStockItemSchema = z.object({
  rcept_no: z.string().regex(/^\d{14}$/),
  rcept_dt: z.string(),
  corp_code: corpCodeSchema,
  corp_name: z.string(),
  report_tp: optionalString,
  repror: optionalString,
  stkqy: optionalString,
  stkqy_irds: optionalString,
  stkrt: optionalString,
  stkrt_irds: optionalString,
  ctr_stkqy: optionalString,
  ctr_stkrt: optionalString,
  report_resn: optionalString,
});

const corpCodeItemSchema = z.object({
  corp_code: corpCodeSchema,
  corp_name: z.string(),
  corp_eng_name: optionalString,
  stock_code: optionalStockCodeSchema,
  modify_date: z.string().regex(/^\d{8}$/),
});

const summaryResponseSchema = envelopeSchema.extend({ list: z.array(z.unknown()).optional() });

type OpenDartDisclosureRawItem = z.infer<typeof disclosureItemSchema>;
export type OpenDartDisclosureItem = Omit<OpenDartDisclosureRawItem, 'rcept_dt'> & {
  readonly rcept_dt: string;
  readonly rcept_dt_raw: string;
};
export type OpenDartEleStockItem = z.infer<typeof eleStockItemSchema>;
export type OpenDartMajorStockItem = z.infer<typeof majorStockItemSchema>;
export type OpenDartCorpCodeItem = z.infer<typeof corpCodeItemSchema>;

export interface OpenDartDisclosurePage {
  readonly items: readonly OpenDartDisclosureItem[];
  readonly page: number;
  readonly totalPages: number;
  readonly totalCount: number;
}

export class ConnectorDisabledError extends Error {
  public constructor(
    public readonly connector: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorDisabledError';
  }
}

export class OpenDartHttpError extends Error {
  public constructor(
    public readonly endpoint: string,
    public readonly httpStatus: number,
  ) {
    super(`OpenDART HTTP ${httpStatus} at ${endpoint}`);
    this.name = 'OpenDartHttpError';
  }
}

export const HTTP_FETCH = Symbol('HTTP_FETCH');
export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function redactOpenDartUrl(input: string | URL): string {
  const url = new URL(input);
  if (url.searchParams.has('crtfc_key')) {
    url.searchParams.set('crtfc_key', '[REDACTED]');
  }
  return url.toString();
}

export function openDartViewerUrl(rceptNo: string): string {
  if (!/^\d{14}$/.test(rceptNo)) throw new Error('Invalid OpenDART receipt number.');
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('OpenDART response is too large.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('response too large');
      throw new Error('OpenDART response is too large.');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function dateOnlyFromCompact(value: string): string {
  const dateOnly = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (compactDate(dateOnly) !== value) {
    throw new Error(`Invalid OpenDART calendar date: ${value}`);
  }
  return dateOnly;
}

@Injectable()
export class OpenDartClient {
  private rateLimitedUntil: Date | null = null;

  public constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: FetchImplementation,
  ) {}

  public get enabled(): boolean {
    return Boolean(this.config.openDartApiKey);
  }

  public async listDisclosures(input: {
    readonly detailType: DisclosureDetailType;
    readonly startDate: string;
    readonly endDate: string;
    readonly page: number;
  }): Promise<OpenDartDisclosurePage> {
    const raw = await this.requestJson('list.json', {
      bgn_de: compactDate(input.startDate),
      end_de: compactDate(input.endDate),
      pblntf_detail_ty: input.detailType,
      last_reprt_at: 'N',
      sort: 'date',
      sort_mth: 'desc',
      page_no: String(input.page),
      page_count: '100',
    });
    const envelope = envelopeSchema.parse(raw);
    if (this.handleEnvelope(envelope, 'LIST')) {
      return { items: [], page: input.page, totalPages: 0, totalCount: 0 };
    }
    const parsed = disclosureResponseSchema.parse(raw);
    return {
      items: (parsed.list ?? []).map((item) => ({
        ...item,
        rcept_dt_raw: item.rcept_dt,
        rcept_dt: dateOnlyFromCompact(item.rcept_dt),
      })),
      page: parsed.page_no ?? input.page,
      totalPages: parsed.total_page ?? 1,
      totalCount: parsed.total_count ?? parsed.list?.length ?? 0,
    };
  }

  public async fetchDocument(rceptNo: string): Promise<Uint8Array> {
    if (!/^\d{14}$/.test(rceptNo)) throw new Error('Invalid OpenDART receipt number.');
    return this.requestArchive('document.xml', { rcept_no: rceptNo }, 'DOCUMENT');
  }

  public async fetchCorpCodes(): Promise<readonly OpenDartCorpCodeItem[]> {
    const bytes = await this.requestArchive('corpCode.xml', {}, 'CORP_CODE');
    const archive = await readOpenDartArchive(bytes, { operation: 'CORP_CODE' });
    const xmlParser = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      parseTagValue: false,
      trimValues: true,
    });
    const items: OpenDartCorpCodeItem[] = [];
    const lexicalBudget = { nodes: 0 };
    for (const candidate of archive.xmlCandidates) {
      assertLexicalXmlComplexity(candidate.xml, lexicalBudget, {
        maxDepth: 64,
        maxNodes: MAX_CORP_CODE_XML_NODES,
      });
      const parsed = xmlParser.parse(candidate.xml) as Record<string, unknown>;
      const root = (parsed.result ?? parsed) as Record<string, unknown>;
      const rawList = root.list;
      const list = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
      if (items.length + list.length > MAX_CORP_CODE_ITEMS) {
        throw new OpenDartPayloadError(
          `OpenDART corpCode 항목이 안전 한도 ${MAX_CORP_CODE_ITEMS}개를 초과했습니다.`,
          'CORP_CODE_ITEM_LIMIT',
        );
      }
      for (const item of list) items.push(corpCodeItemSchema.parse(item));
    }
    return Object.freeze(items);
  }

  public async fetchEleStock(corpCode: string): Promise<readonly OpenDartEleStockItem[]> {
    return this.requestSummary('elestock.json', corpCode, eleStockItemSchema);
  }

  public async fetchMajorStock(corpCode: string): Promise<readonly OpenDartMajorStockItem[]> {
    return this.requestSummary('majorstock.json', corpCode, majorStockItemSchema);
  }

  private async requestSummary<T>(
    endpoint: string,
    corpCode: string,
    itemSchema: z.ZodType<T>,
  ): Promise<readonly T[]> {
    if (!/^\d{8}$/.test(corpCode)) throw new Error('Invalid OpenDART corporation code.');
    const raw = await this.requestJson(endpoint, { corp_code: corpCode });
    const envelope = envelopeSchema.parse(raw);
    if (this.handleEnvelope(envelope, 'SUMMARY')) return [];
    const parsed = summaryResponseSchema.parse(raw);
    return Object.freeze((parsed.list ?? []).map((item) => itemSchema.parse(item)));
  }

  private handleEnvelope(
    envelope: z.infer<typeof envelopeSchema>,
    operation: 'LIST' | 'SUMMARY',
  ): boolean {
    const policy = openDartStatusPolicy(envelope.status, operation);
    if (policy.emptyResult) return true;
    if (envelope.status === '000') return false;
    if (policy.disablesUntilNextKstDay) {
      this.rateLimitedUntil = nextKstMidnight();
    }
    const safeMessage = this.config.openDartApiKey
      ? envelope.message.replaceAll(this.config.openDartApiKey, '[REDACTED]')
      : envelope.message;
    throw new OpenDartApiError(envelope.status, safeMessage, policy.retryPolicy);
  }

  private assertConfigured(): string {
    if (!this.config.openDartApiKey) {
      throw new ConnectorDisabledError(
        'OPENDART',
        'OPENDART_API_KEY가 없어 커넥터가 비활성화되었습니다.',
      );
    }
    if (this.rateLimitedUntil && this.rateLimitedUntil.getTime() > Date.now()) {
      throw new OpenDartApiError(
        '020',
        `요청 제한으로 ${this.rateLimitedUntil.toISOString()}까지 중단됨`,
        'NEXT_KST_DAY',
      );
    }
    return this.config.openDartApiKey;
  }

  private makeUrl(endpoint: string, params: Readonly<Record<string, string>>): URL {
    const key = this.assertConfigured();
    const url = new URL(endpoint, OPENDART_BASE_URL);
    url.searchParams.set('crtfc_key', key);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    return url;
  }

  private async fetch(
    endpoint: string,
    params: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const url = this.makeUrl(endpoint, params);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json, application/zip, application/xml' },
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });
    } catch {
      throw new OpenDartHttpError(endpoint, 0);
    }
    if (!response.ok) throw new OpenDartHttpError(endpoint, response.status);
    return response;
  }

  private async requestJson(
    endpoint: string,
    params: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const response = await this.fetch(endpoint, params);
    return decodeJson(await readBoundedResponse(response, MAX_JSON_BYTES));
  }

  private async requestArchive(
    endpoint: string,
    params: Readonly<Record<string, string>>,
    operation: 'DOCUMENT' | 'CORP_CODE',
  ): Promise<Uint8Array> {
    const response = await this.fetch(endpoint, params);
    const bytes = await readBoundedResponse(response, MAX_BINARY_BYTES);
    if (!hasZipMagic(bytes)) {
      try {
        await readOpenDartArchive(bytes, { operation });
      } catch (error) {
        if (error instanceof OpenDartApiError) {
          if (error.status === '020') {
            this.rateLimitedUntil = nextKstMidnight();
          }
          const safeMessage = this.config.openDartApiKey
            ? error.apiMessage.replaceAll(this.config.openDartApiKey, '[REDACTED]')
            : error.apiMessage;
          throw new OpenDartApiError(error.status, safeMessage, error.retryPolicy);
        }
        throw error;
      }
    }
    return bytes;
  }
}
