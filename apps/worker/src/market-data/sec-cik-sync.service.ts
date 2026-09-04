import { Inject, Injectable } from '@nestjs/common';
import { Market, RightsMode } from '@orsem/contracts';
import { CompanyEntity, SourceCheckpointEntity } from '@orsem/database';
import { DataSource, In } from 'typeorm';
import { z } from 'zod';
import { toKstDateOnly } from '../common/kst-date';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { HTTP_FETCH, type FetchImplementation } from '../opendart/opendart.client';
import {
  SEC_TICKER_MASTER_URL,
  parseSecSearchCacheSnapshot,
  SecTickerMasterClient,
  type SecTickerMasterRow,
  type SecTickerMasterSnapshot,
} from './sec-ticker-master.client';

const US_MARKETS: readonly string[] = [Market.NASDAQ, Market.NYSE, Market.AMEX];
const MAX_COMPANIES = 20_000;
const companyIdsSchema = z.array(z.string().uuid()).max(10_000);
const MASTER_STREAM = 'CIK_TICKER_MASTER';
const mappingStream = (id: string) => `CIK_MAPPING:${id}`;
const normalizedCik = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{1,10}$/u.test(value) && Number(value) > 0
    ? value.padStart(10, '0')
    : null;

function sourceMarket(exchange: string | null): string | null {
  switch (exchange?.trim().toUpperCase()) {
    case 'NASDAQ':
      return Market.NASDAQ;
    case 'NYSE':
      return Market.NYSE;
    case 'AMEX':
    case 'NYSE AMERICAN':
      return Market.AMEX;
    default:
      return null;
  }
}

// BRK.B / BRK-B 등 구분 기호만 동등하게 취급한다. 주식 종류 접미사는 제거하지 않는다.
const tickerAlias = (ticker: string) => ticker.replace(/\./gu, '-');
type MatchRule = 'EXACT_TICKER_EXCHANGE' | 'DOT_HYPHEN_TICKER_EXCHANGE';
export interface SecCikMatch {
  readonly status: 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'NOT_ELIGIBLE';
  readonly rule: MatchRule | null;
  readonly cik: string | null;
  readonly rows: readonly SecTickerMasterRow[];
}

export class SecTickerIndex {
  private readonly exact = new Map<string, SecTickerMasterRow[]>();
  private readonly aliases = new Map<string, SecTickerMasterRow[]>();

  constructor(rows: readonly SecTickerMasterRow[]) {
    for (const row of rows) {
      const market = sourceMarket(row.exchange);
      if (!market) continue;
      const key = `${market}:${row.ticker}`;
      const exactRows = this.exact.get(key);
      if (exactRows) exactRows.push(row);
      else this.exact.set(key, [row]);
      const alias = `${market}:${tickerAlias(row.ticker)}`;
      const aliasRows = this.aliases.get(alias);
      if (aliasRows) aliasRows.push(row);
      else this.aliases.set(alias, [row]);
    }
  }

  match(company: Pick<CompanyEntity, 'ticker' | 'market' | 'isListed'>): SecCikMatch {
    const ticker = company.ticker?.trim().toUpperCase();
    if (
      !company.isListed ||
      !US_MARKETS.includes(company.market) ||
      !ticker ||
      !/^[A-Z0-9][A-Z0-9.-]{0,31}$/u.test(ticker)
    )
      return { status: 'NOT_ELIGIBLE', rule: null, cik: null, rows: [] };
    const exact = this.exact.get(`${company.market}:${ticker}`) ?? [];
    const rule: MatchRule = exact.length ? 'EXACT_TICKER_EXCHANGE' : 'DOT_HYPHEN_TICKER_EXCHANGE';
    const rows = exact.length
      ? exact
      : (this.aliases.get(`${company.market}:${tickerAlias(ticker)}`) ?? []);
    if (!rows.length) return { status: 'UNMATCHED', rule: null, cik: null, rows };
    const ciks = new Set(rows.map((row) => row.cik));
    if (ciks.size !== 1) return { status: 'AMBIGUOUS', rule, cik: null, rows };
    return { status: 'MATCHED', rule, cik: rows[0]!.cik, rows };
  }
}

export interface SecCikSyncInput {
  readonly companyIds?: readonly string[];
}
export interface SecCikSyncResult {
  readonly connector: 'SEC_EDGAR';
  readonly stream: 'CIK_MAPPING';
  readonly disabled?: boolean;
  companiesRequested: number;
  sourceRows: number;
  linked: number;
  alreadyLinked: number;
  conflicts: number;
  ambiguous: number;
  unmatched: number;
  notEligible: number;
}
type MappingOutcome =
  'linked' | 'alreadyLinked' | 'conflicts' | 'ambiguous' | 'unmatched' | 'notEligible';

@Injectable()
export class SecCikSyncService {
  private readonly client: SecTickerMasterClient;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(HTTP_FETCH) fetchImpl: FetchImplementation,
  ) {
    this.client = new SecTickerMasterClient(config.secUserAgent, fetchImpl, config.httpTimeoutMs);
  }

  async sync(input: SecCikSyncInput = {}, observedAt = new Date()): Promise<SecCikSyncResult> {
    return this.syncSnapshot(input, observedAt);
  }

  async syncFromSearchCache(
    cache: unknown,
    input: { readonly companyIds: readonly string[] },
    observedAt = new Date(),
  ): Promise<SecCikSyncResult> {
    const companyIds = companyIdsSchema.min(1).parse(input.companyIds);
    const snapshot = parseSecSearchCacheSnapshot(cache);
    return this.syncSnapshot({ companyIds }, observedAt, snapshot);
  }

  private async syncSnapshot(
    input: SecCikSyncInput,
    observedAt: Date,
    importedSnapshot?: SecTickerMasterSnapshot,
  ): Promise<SecCikSyncResult> {
    if (!Number.isFinite(observedAt.getTime()))
      throw new Error('Invalid SEC mapping observation time.');
    const ids =
      input.companyIds === undefined
        ? undefined
        : [...new Set(companyIdsSchema.parse(input.companyIds))];
    const result: SecCikSyncResult = {
      connector: 'SEC_EDGAR',
      stream: 'CIK_MAPPING',
      companiesRequested: ids?.length ?? 0,
      sourceRows: 0,
      linked: 0,
      alreadyLinked: 0,
      conflicts: 0,
      ambiguous: 0,
      unmatched: 0,
      notEligible: 0,
    };
    if (!importedSnapshot && !this.config.secUserAgent) return { ...result, disabled: true };
    if (ids?.length === 0) return result;
    const companies = await this.dataSource.getRepository(CompanyEntity).find({
      where: { market: In([...US_MARKETS]), isListed: true, ...(ids ? { id: In(ids) } : {}) },
      order: { market: 'ASC', ticker: 'ASC', id: 'ASC' },
    });
    if (companies.length > MAX_COMPANIES)
      throw new Error('SEC mapping scope exceeds 20000 companies.');
    result.companiesRequested = ids?.length ?? companies.length;
    result.notEligible = ids ? ids.length - companies.length : 0;
    if (!companies.length) return result;
    const snapshot = importedSnapshot ?? (await this.client.fetch());
    result.sourceRows = snapshot.rows.length;
    const index = new SecTickerIndex(snapshot.rows);
    // 부분 캐시를 전체 유니버스로 취급해 다른 종목을 미매칭으로 기록하지 않는다.
    if (importedSnapshot && companies.some((company) => index.match(company).status !== 'MATCHED'))
      throw new Error('SEC cache snapshot does not unambiguously cover the requested companies.');
    await this.saveSnapshot(snapshot, observedAt);
    for (const company of companies) {
      const outcome = await this.persistCompany(company.id, index, snapshot, observedAt);
      result[outcome] += 1;
    }
    return result;
  }

  private async saveSnapshot(snapshot: SecTickerMasterSnapshot, observedAt: Date): Promise<void> {
    const stream =
      snapshot.acquisition.method === 'DIRECT_HTTP'
        ? MASTER_STREAM
        : `CIK_SEARCH_CACHE:${snapshot.sha256}`;
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(SourceCheckpointEntity);
      const previous = await repository.findOne({
        where: { connector: 'SEC_EDGAR', stream },
        lock: { mode: 'pessimistic_write' },
      });
      await repository.save(
        repository.create({
          ...(previous ?? {}),
          connector: 'SEC_EDGAR',
          stream,
          cursor: null,
          lastSuccessAt: observedAt,
          lastSuccessDate: toKstDateOnly(observedAt),
          metadataJson: {
            version: 1,
            source: 'SEC_EDGAR',
            rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
            provenanceUrl: snapshot.provenanceUrl,
            sha256: snapshot.sha256,
            acquisition: { ...snapshot.acquisition },
            sourceLastModified: snapshot.sourceLastModified,
            sourceRows: snapshot.rows.length,
            rawPayload: { ...snapshot.raw },
            firstObservedAt: previous?.metadataJson?.firstObservedAt ?? observedAt.toISOString(),
            observedAt: observedAt.toISOString(),
          },
        }),
      );
    });
  }

  private async persistCompany(
    companyId: string,
    index: SecTickerIndex,
    snapshot: SecTickerMasterSnapshot,
    observedAt: Date,
  ): Promise<MappingOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const companies = manager.getRepository(CompanyEntity);
      const company = await companies.findOne({
        where: { id: companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!company) return 'notEligible';
      const match = index.match(company);
      if (snapshot.acquisition.method === 'SEARCH_CACHE_EXTRACT' && match.status !== 'MATCHED')
        return 'notEligible';
      const checkpoints = manager.getRepository(SourceCheckpointEntity);
      const previous = await checkpoints.findOne({
        where: { connector: 'SEC_EDGAR', stream: mappingStream(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      let outcome: MappingOutcome;
      if (match.status === 'NOT_ELIGIBLE') outcome = 'notEligible';
      else if (match.status === 'UNMATCHED') outcome = 'unmatched';
      else if (match.status === 'AMBIGUOUS') outcome = 'ambiguous';
      else {
        const priorApplied = previous?.metadataJson?.appliedCik;
        if (
          (company.cik !== null && normalizedCik(company.cik) !== match.cik) ||
          (priorApplied != null && normalizedCik(priorApplied) !== match.cik)
        )
          outcome = 'conflicts';
        else if (company.cik !== null) outcome = 'alreadyLinked';
        else {
          await companies.update({ id: company.id }, { cik: match.cik });
          outcome = 'linked';
        }
      }
      const metadata = previous?.metadataJson ?? {};
      await checkpoints.save(
        checkpoints.create({
          ...(previous ?? {}),
          connector: 'SEC_EDGAR',
          stream: mappingStream(companyId),
          cursor: null,
          lastSuccessAt: observedAt,
          lastSuccessDate: toKstDateOnly(observedAt),
          metadataJson: {
            version: 1,
            source: 'SEC_EDGAR',
            rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
            provenanceUrl: SEC_TICKER_MASTER_URL,
            sourceSnapshotSha256: snapshot.sha256,
            acquisition: { ...snapshot.acquisition },
            sourceLastModified: snapshot.sourceLastModified,
            companyId,
            ticker: company.ticker,
            market: company.market,
            outcome,
            matchRule: match.rule,
            candidateCik: match.cik,
            originalCik: Object.hasOwn(metadata, 'originalCik')
              ? metadata.originalCik
              : company.cik,
            appliedCik:
              outcome === 'linked' || outcome === 'alreadyLinked'
                ? match.cik
                : (metadata.appliedCik ?? null),
            rawPayload: match.rows
              .slice(0, 20)
              .map((row) => ({ rowIndex: row.rowIndex, ...row.raw })),
            candidateRows: match.rows.length,
            candidateRowsTruncated: match.rows.length > 20,
            firstObservedAt: metadata.firstObservedAt ?? observedAt.toISOString(),
            observedAt: observedAt.toISOString(),
          },
        }),
      );
      return outcome;
    });
  }
}
