import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RightsMode } from '@orsem/contracts';
import { CompanyEntity, SourceCheckpointEntity } from '@orsem/database';
import { DataSource } from 'typeorm';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { toKstDateOnly } from '../common/kst-date';
import { TossMarketClient } from './toss-market.client';
import {
  etfCompanyMarket,
  KR_ETF_MARKETS,
  planKoreanEtfMaster,
  validateKoreanEtfUniverse,
  type KoreanEtfIdentity,
  type KoreanEtfUniverse,
} from './toss-korean-etf-master';

export const KR_ETF_MASTER_STREAM = 'KR_ETF_MASTER';
export const KR_ETF_IDENTITY_PREFIX = 'KR_ETF_IDENTITY:';
const TTL_MS = 24 * 60 * 60_000;
const LOCK_NAME = 'orsem-toss-kr-etf-master';
const endpoint = 'https://openapi.tossinvest.com/api/v1/stocks/all';
const identityStream = (id: string) => `${KR_ETF_IDENTITY_PREFIX}${id}`;

export interface KoreanEtfSyncResult {
  readonly status: 'UPDATED' | 'DRY_RUN' | 'CACHED' | 'DISABLED' | 'BUSY';
  readonly activeEtfs: number;
  readonly delistedEtfs: number;
  readonly created: number;
  readonly refreshed: number;
  readonly observed: number;
  readonly delisted: number;
  readonly conflicts: number;
  readonly missingRetained: number;
}
const emptyResult = (status: KoreanEtfSyncResult['status']): KoreanEtfSyncResult => ({
  status,
  activeEtfs: 0,
  delistedEtfs: 0,
  created: 0,
  refreshed: 0,
  observed: 0,
  delisted: 0,
  conflicts: 0,
  missingRetained: 0,
});
function identity(checkpoint: SourceCheckpointEntity): KoreanEtfIdentity | null {
  const value = checkpoint.metadataJson;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.companyId !== 'string' ||
    typeof value.symbol !== 'string' ||
    typeof value.isinCode !== 'string' ||
    !KR_ETF_MARKETS.includes(value.market as (typeof KR_ETF_MARKETS)[number]) ||
    typeof value.managedCompany !== 'boolean'
  )
    return null;
  return value as unknown as KoreanEtfIdentity;
}

@Injectable()
export class TossKoreanEtfMasterService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TossKoreanEtfMasterService.name);
  private timer?: ReturnType<typeof setInterval>;
  private flight: Promise<KoreanEtfSyncResult> | null = null;
  private stopped = false;
  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly source: DataSource,
    private readonly toss: TossMarketClient,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.nodeEnv === 'test' || !this.toss.enabled) return;
    const refresh = () => {
      void this.sync().catch(() => this.logger.warn('국내 ETF 목록 갱신 실패: 이전 목록 유지'));
    };
    this.timer = setInterval(refresh, 60 * 60_000);
    this.timer.unref();
    refresh();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flight?.catch(() => undefined);
  }

  sync(options: { force?: boolean; dryRun?: boolean } = {}): Promise<KoreanEtfSyncResult> {
    if (!this.flight)
      this.flight = this.run(options).finally(() => {
        this.flight = null;
      });
    return this.flight;
  }

  private async run(options: { force?: boolean; dryRun?: boolean }): Promise<KoreanEtfSyncResult> {
    if (this.stopped || !this.toss.enabled) return emptyResult('DISABLED');
    const runner = this.source.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      const [lock] = await runner.query('SELECT GET_LOCK(?, 0) acquired', [LOCK_NAME]);
      locked = Number(lock?.acquired) === 1;
      if (!locked) return emptyResult('BUSY');
      const checkpoints = runner.manager.getRepository(SourceCheckpointEntity);
      const previous = await checkpoints.findOne({
        where: { connector: 'TOSS', stream: KR_ETF_MASTER_STREAM },
      });
      const checkedAt = new Date();
      const age = checkedAt.getTime() - (previous?.lastSuccessAt?.getTime() ?? NaN);
      if (!options.force && age >= 0 && age < TTL_MS)
        return {
          ...emptyResult('CACHED'),
          activeEtfs: Number(previous?.metadataJson?.activeEtfs ?? 0),
        };

      const snapshots: KoreanEtfUniverse[] = [];
      for (const status of ['ACTIVE', 'DELISTED'] as const)
        for (const market of KR_ETF_MARKETS)
          snapshots.push({
            market,
            status,
            rows: await this.toss.stocksAll(market, { status, securityType: 'ETF' }),
          });
      const counts = validateKoreanEtfUniverse(
        snapshots,
        Number(previous?.metadataJson?.activeEtfs ?? 0),
      );
      const now = new Date();
      const rawSnapshot = snapshots.map((snapshot) => ({
        market: snapshot.market,
        status: snapshot.status,
        rawPayload: snapshot.rows.map((stock) => ({ ...stock })),
      }));
      const snapshotHash = createHash('sha256').update(JSON.stringify(rawSnapshot)).digest('hex');
      await runner.startTransaction();
      const companyRepository = runner.manager.getRepository(CompanyEntity);
      // Include inactive/OTHER issuers with a code so an existing identity is never overwritten.
      const companies = await companyRepository
        .createQueryBuilder('company')
        .where('company.stock_code IS NOT NULL')
        .orderBy('company.id', 'ASC')
        .setLock('pessimistic_write')
        .getMany();
      const identityRows = await checkpoints
        .createQueryBuilder('checkpoint')
        .where('checkpoint.connector = :connector', { connector: 'TOSS' })
        .andWhere('checkpoint.stream LIKE :prefix', { prefix: `${KR_ETF_IDENTITY_PREFIX}%` })
        .setLock('pessimistic_write')
        .getMany();
      const identities = identityRows.flatMap((row) => {
        const value = identity(row);
        return value ? [value] : [];
      });
      const plan = planKoreanEtfMaster(snapshots, companies, identities);
      const result: KoreanEtfSyncResult = {
        status: options.dryRun ? 'DRY_RUN' : 'UPDATED',
        activeEtfs: counts.active,
        delistedEtfs: counts.delisted,
        created: plan.actions.filter((action) => action.kind === 'CREATE').length,
        refreshed: plan.actions.filter((action) => action.kind === 'REFRESH').length,
        observed: plan.actions.filter((action) => action.kind === 'OBSERVE').length,
        delisted: plan.actions.filter((action) => action.kind === 'DELIST').length,
        conflicts: plan.conflicts,
        missingRetained: plan.missingRetained,
      };
      if (options.dryRun) {
        await runner.rollbackTransaction();
        return result;
      }
      const byCompany = new Map(identityRows.map((row) => [identity(row)?.companyId, row]));
      for (const action of plan.actions) {
        const company = action.company
          ? companyRepository.create(action.company)
          : companyRepository.create({
              market: etfCompanyMarket(action.market),
              corpCode: null,
              stockCode: action.stock.symbol,
              ticker: null,
              cik: null,
              nameKo: action.patch.nameKo!,
              nameEn: null,
              isListed: true,
              sourceUpdatedDate: null,
            });
        if (action.kind === 'CREATE') await companyRepository.save(company);
        else if (Object.keys(action.patch).length)
          await companyRepository.update({ id: company.id }, action.patch);
        const old = byCompany.get(company.id);
        const appliedNameKo = action.patch.nameKo ?? old?.metadataJson?.appliedNameKo ?? null;
        await checkpoints.save(
          checkpoints.create({
            ...(old ?? {}),
            connector: 'TOSS',
            stream: identityStream(company.id),
            lastSuccessAt: now,
            lastSuccessDate: toKstDateOnly(now),
            cursor: null,
            metadataJson: {
              version: 1,
              source: 'TOSS',
              rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
              provenanceUrl: `${endpoint}?market=${action.market}&status=${action.kind === 'DELIST' ? 'DELISTED' : 'ACTIVE'}&securityType=ETF`,
              companyId: company.id,
              symbol: action.stock.symbol,
              isinCode: action.stock.isinCode,
              market: action.market,
              securityType: 'ETF',
              status: action.kind === 'DELIST' ? 'DELISTED' : 'ACTIVE',
              managedCompany: action.managedCompany,
              appliedNameKo,
              originalCompanyNames: old?.metadataJson?.originalCompanyNames ?? {
                nameKo: action.company?.nameKo ?? null,
                nameEn: action.company?.nameEn ?? null,
              },
              firstObservedAt: old?.metadataJson?.firstObservedAt ?? now.toISOString(),
              observedAt: now.toISOString(),
              snapshotHash,
              rawPayload: { ...action.stock },
            },
          }),
        );
      }
      await checkpoints.save(
        checkpoints.create({
          ...(previous ?? {}),
          connector: 'TOSS',
          stream: KR_ETF_MASTER_STREAM,
          lastSuccessAt: now,
          lastSuccessDate: toKstDateOnly(now),
          cursor: null,
          metadataJson: {
            version: 1,
            source: 'TOSS',
            rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
            provenanceUrl: endpoint,
            documentationUrl: 'https://developers.tossinvest.com/docs',
            coverage: 'TOSS_TRADABLE_KOREAN_ETF_UNIVERSE',
            completeMarketResponse: true,
            firstObservedAt: previous?.metadataJson?.firstObservedAt ?? now.toISOString(),
            observedAt: now.toISOString(),
            snapshotHash,
            ...result,
            rawSnapshot,
          },
        }),
      );
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      if (locked) await runner.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
      await runner.release();
    }
  }
}
