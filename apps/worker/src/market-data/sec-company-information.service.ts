import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SourceCheckpointEntity } from '@orsem/database';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { readBoundedResponseText } from '../common/bounded-response';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { SecAccessCooldownError, SecAccessPolicyError } from '../connectors/sec-access-policy';
import { HTTP_FETCH, type FetchImplementation } from '../opendart/opendart.client';
import { parseSecCompanyInformation, secCompanyFactsUrl } from './sec-company-information';

const MAX_BYTES = 20 * 1024 * 1024;
type Candidate = {
  id: string;
  cik: string;
  listedClasses: number | string;
  stockMetadata: unknown;
};
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

@Injectable()
export class SecCompanyInformationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private flight: Promise<void> | null = null;
  private stopped = false;
  private abort: AbortController | null = null;
  constructor(
    private readonly source: DataSource,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    // Registered HTTP_FETCH is createSecFetch: shared request slots and persisted 403/429 cooldown.
    @Inject(HTTP_FETCH) private readonly fetchImpl: FetchImplementation,
  ) {}
  onApplicationBootstrap() {
    if (!this.config.secUserAgent) return;
    this.timer = setInterval(() => void this.refresh(), 15 * 60_000);
    this.timer.unref();
    void this.refresh();
  }
  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort?.abort();
    await this.flight;
  }
  refresh(): Promise<void> {
    if (!this.flight)
      this.flight = this.run()
        .catch(() => undefined)
        .finally(() => {
          this.flight = null;
        });
    return this.flight;
  }
  private async cooling() {
    const checkpoint = await this.source
      .getRepository(SourceCheckpointEntity)
      .findOneBy({ connector: 'SEC', stream: 'ACCESS_COOLDOWN' });
    const retryAt = object(checkpoint?.metadataJson).retryAt;
    return typeof retryAt === 'string' && Date.parse(retryAt) > Date.now();
  }
  private async run() {
    if (!this.config.secUserAgent || this.stopped || (await this.cooling())) return;
    const runner = this.source.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const [lock] = await runner.query(
        "SELECT GET_LOCK('orsem-sec-company-information',0) acquired",
      );
      locked = Number(lock?.acquired) === 1;
      if (!locked) return;
      const companies: Candidate[] = await runner.query(`SELECT c.id,c.cik,
        (SELECT COUNT(*) FROM companies sibling WHERE sibling.cik=c.cik AND sibling.is_listed=1 AND sibling.market IN ('NASDAQ','NYSE','AMEX','OTC')) listedClasses,
        stock.metadata_json stockMetadata FROM companies c
        LEFT JOIN (SELECT company_id,MAX(observed_at) collected FROM company_information_snapshots WHERE source='SEC' GROUP BY company_id) latest ON latest.company_id=c.id
        LEFT JOIN source_checkpoints failure ON failure.connector='SEC_COMPANY_INFORMATION_FAILURE' AND failure.stream=c.id
        LEFT JOIN source_checkpoints stock ON stock.connector='TOSS' AND stock.stream=CONCAT('STOCK_INFO:',c.id)
        WHERE c.cik IS NOT NULL AND c.is_listed=1 AND c.market IN ('NASDAQ','NYSE','AMEX','OTC')
        AND (failure.last_success_at IS NULL OR failure.last_success_at < UTC_TIMESTAMP() - INTERVAL 1 DAY)
        AND (latest.collected IS NULL OR latest.collected < UTC_TIMESTAMP() - INTERVAL 7 DAY)
        AND (EXISTS (SELECT 1 FROM source_checkpoints request WHERE request.connector='COMPANY_INFORMATION' AND request.stream=c.id)
          OR EXISTS (SELECT 1 FROM watchlist_group_items i WHERE i.company_id=c.id)
          OR EXISTS (SELECT 1 FROM market_cap_memberships m JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id WHERE m.company_id=c.id))
        ORDER BY latest.collected,c.id LIMIT 4`);
      for (const company of companies) {
        if (this.stopped || (await this.cooling())) break;
        try {
          const url = secCompanyFactsUrl(company.cik);
          this.abort = new AbortController();
          const response = await this.fetchImpl(url, {
            method: 'GET',
            redirect: 'error',
            headers: { Accept: 'application/json', 'User-Agent': this.config.secUserAgent },
            signal: AbortSignal.any([
              this.abort.signal,
              AbortSignal.timeout(this.config.httpTimeoutMs),
            ]),
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`SEC Company Facts HTTP ${response.status}`);
          }
          const text = await readBoundedResponseText(response, {
            maxBytes: MAX_BYTES,
            errorMessage: 'SEC Company Facts response exceeds 20 MiB.',
          });
          const raw: unknown = JSON.parse(text);
          const observedAt = new Date();
          const stock = object(object(company.stockMetadata).rawPayload);
          const perShareEligible =
            Number(company.listedClasses) === 1 &&
            stock.isCommonShare === true &&
            stock.securityType === 'STOCK' &&
            stock.currency === 'USD';
          const result = parseSecCompanyInformation(raw, company.cik, observedAt.toISOString(), {
            perShareEligible,
          });
          if (this.stopped) break;
          await runner.query(
            'INSERT INTO company_information_snapshots(id,company_id,source,report_year,report_code,basis_date,observed_at,source_url,rights_mode,fields_json,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            [
              randomUUID(),
              company.id,
              'SEC',
              result.reportYear,
              result.reportCode,
              result.basisDate,
              observedAt,
              result.sourceUrl,
              'OFFICIAL_PUBLIC_DATA',
              JSON.stringify(result.fields),
              JSON.stringify({
                companyFacts: raw,
                provenanceUrl: url,
                observedAt: observedAt.toISOString(),
                sha256: createHash('sha256').update(text).digest('hex'),
                sourceLastModified: response.headers.get('last-modified'),
                perShareEligibility: {
                  eligible: perShareEligible,
                  listedClasses: Number(company.listedClasses),
                  stockMetadata: object(company.stockMetadata),
                },
              }),
            ],
          );
        } catch (error) {
          if (this.stopped) break;
          await this.source.getRepository(SourceCheckpointEntity).upsert(
            {
              connector: 'SEC_COMPANY_INFORMATION_FAILURE',
              stream: company.id,
              lastSuccessAt: new Date(),
              lastSuccessDate: null,
              cursor: null,
              metadataJson: {
                state: error instanceof SecAccessCooldownError ? 'ACCESS_WAITING' : 'RETRY_PENDING',
                nextAttemptAfterHours: 24,
                reason:
                  error instanceof SecAccessCooldownError
                    ? `SEC ${error.providerStatus} 접근 대기`
                    : '검증된 SEC 재무 자료 수집 대기',
                ...(error instanceof SecAccessCooldownError
                  ? { retryAt: error.retryAt.toISOString(), providerStatus: error.providerStatus }
                  : {}),
              },
            },
            ['connector', 'stream'],
          );
          // The wrapper owns denial persistence; do not probe another company after policy failure.
          if (error instanceof SecAccessCooldownError || error instanceof SecAccessPolicyError)
            break;
        } finally {
          this.abort = null;
        }
      }
    } finally {
      if (locked)
        await runner
          .query("SELECT RELEASE_LOCK('orsem-sec-company-information')")
          .catch(() => undefined);
      await runner.release();
    }
  }
}
