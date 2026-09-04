import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Market, ProcessingStatus, RightsMode } from '@orsem/contracts';
import {
  AlpacaAssetEntity,
  CompanyEntity,
  IngestionRunEntity,
  SourceCheckpointEntity,
} from '@orsem/database';
import { DataSource, In, type EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { addDateOnlyDays, toKstDateOnly } from '../common/kst-date';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { HTTP_FETCH, type FetchImplementation } from '../opendart/opendart.client';
import { AlpacaAssetMasterClient, type AlpacaAssetMasterItem } from './alpaca-asset-master.client';

const ALPACA_ASSET_STREAM = 'ASSET_MASTER';
const DATABASE_CHUNK_SIZE = 500;
const ASSET_UPSERT_CHUNK_SIZE = 250;
const ALPACA_SNAPSHOT_MINIMUM_BASELINE = 100;
const ALPACA_SNAPSHOT_MINIMUM_RETAINED_RATIO = 0.8;
const US_COMPANY_MARKETS = [Market.NASDAQ, Market.NYSE, Market.AMEX] as const;
const ALPACA_SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;

interface EligibleAlpacaAsset {
  readonly asset: AlpacaAssetMasterItem;
  readonly market: (typeof US_COMPANY_MARKETS)[number];
}

export interface AlpacaAssetSyncResult {
  readonly connector: 'ALPACA';
  readonly stream: typeof ALPACA_ASSET_STREAM;
  readonly observedAt: string;
  readonly itemsSeen: number;
  readonly assetsCreated: number;
  readonly assetsUpdated: number;
  readonly eligibleAssets: number;
  readonly companiesCreated: number;
  readonly companiesAvailable: number;
  readonly ambiguousSymbols: number;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown market-data error').slice(0, 4000);
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_unused, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

export function dateOnlyInTimeZone(date: Date, timeZone: string): string {
  if (Number.isNaN(date.getTime()))
    throw new Error('Cannot derive a session from an invalid date.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  const dateOnly = `${part('year')}-${part('month')}-${part('day')}`;
  addDateOnlyDays(dateOnly, 0);
  return dateOnly;
}

export function alpacaAssetMarket(
  asset: Pick<AlpacaAssetMasterItem, 'assetClass' | 'exchange' | 'status' | 'symbol' | 'tradable'>,
): (typeof US_COMPANY_MARKETS)[number] | null {
  if (asset.assetClass !== 'us_equity' || asset.status !== 'active' || !asset.tradable) return null;
  const symbol = asset.symbol.trim().toUpperCase();
  if (!ALPACA_SYMBOL.test(symbol)) return null;
  return US_COMPANY_MARKETS.find((market) => market === asset.exchange) ?? null;
}

export function assertAlpacaAssetSnapshotSize(
  previousCurrentCount: number,
  snapshotCount: number,
): void {
  if (!Number.isSafeInteger(previousCurrentCount) || previousCurrentCount < 0) {
    throw new Error('Invalid previous Alpaca asset count.');
  }
  if (!Number.isSafeInteger(snapshotCount) || snapshotCount <= 0) {
    throw new Error('Alpaca asset-master snapshot was empty.');
  }
  if (
    previousCurrentCount >= ALPACA_SNAPSHOT_MINIMUM_BASELINE &&
    snapshotCount < previousCurrentCount * ALPACA_SNAPSHOT_MINIMUM_RETAINED_RATIO
  ) {
    throw new Error(
      `Alpaca asset-master snapshot shrank unexpectedly (${previousCurrentCount} to ${snapshotCount}).`,
    );
  }
}

@Injectable()
export class MarketDataIngestionService {
  private readonly alpacaAssets: AlpacaAssetMasterClient;

  public constructor(
    private readonly dataSource: DataSource,
    @Inject(WORKER_CONFIG) config: WorkerConfig,
    @Inject(HTTP_FETCH) fetchImpl: FetchImplementation,
  ) {
    this.alpacaAssets = new AlpacaAssetMasterClient(
      config.alpacaApiKey,
      config.alpacaApiSecret,
      config.alpacaTradingBaseUrl,
      fetchImpl,
      config.httpTimeoutMs,
    );
  }

  public async syncAlpacaAssets(observedAt = new Date()): Promise<AlpacaAssetSyncResult> {
    if (Number.isNaN(observedAt.getTime()))
      throw new Error('Invalid Alpaca asset observation time.');
    const run = await this.startAssetRun(observedAt);
    try {
      const snapshot = await this.alpacaAssets.fetchActiveUsEquities();
      const providerIds = new Set<string>();
      for (const asset of snapshot.items) {
        if (providerIds.has(asset.providerAssetId)) {
          throw new Error('Alpaca asset-master snapshot contains a duplicate provider asset ID.');
        }
        providerIds.add(asset.providerAssetId);
      }

      const eligibleBySymbol = new Map<string, EligibleAlpacaAsset[]>();
      for (const asset of snapshot.items) {
        const market = alpacaAssetMarket(asset);
        if (!market) continue;
        const eligible = { asset, market } as const;
        const matches = eligibleBySymbol.get(asset.symbol) ?? [];
        matches.push(eligible);
        eligibleBySymbol.set(asset.symbol, matches);
      }
      let ambiguousSymbols = 0;
      const uniqueEligible: EligibleAlpacaAsset[] = [];
      for (const matches of eligibleBySymbol.values()) {
        if (matches.length === 1) uniqueEligible.push(matches[0]!);
        else ambiguousSymbols += 1;
      }

      return await this.withConnectorTransaction('ALPACA', async (manager) => {
        const assetRepository = manager.getRepository(AlpacaAssetEntity);
        const priorCurrentAssets = await assetRepository.find({
          select: {
            providerAssetId: true,
            companyId: true,
            exchange: true,
            symbol: true,
          },
          where: { isCurrent: true },
        });
        assertAlpacaAssetSnapshotSize(priorCurrentAssets.length, snapshot.items.length);

        const existingAssetsByProviderId = new Map<string, AlpacaAssetEntity>();
        for (const idBatch of chunks([...providerIds], DATABASE_CHUNK_SIZE)) {
          const existing = await assetRepository.find({
            select: {
              providerAssetId: true,
              companyId: true,
              exchange: true,
              symbol: true,
            },
            where: { providerAssetId: In(idBatch) },
          });
          for (const row of existing) existingAssetsByProviderId.set(row.providerAssetId, row);
        }

        const symbols = uniqueEligible.map(({ asset }) => asset.symbol);
        const historicalAssetsByIdentity = new Map<string, AlpacaAssetEntity[]>();
        for (const symbolBatch of chunks([...new Set(symbols)], DATABASE_CHUNK_SIZE)) {
          if (symbolBatch.length === 0) continue;
          const historical = await assetRepository.find({
            select: {
              providerAssetId: true,
              companyId: true,
              exchange: true,
              symbol: true,
            },
            where: {
              symbol: In(symbolBatch),
              exchange: In([...US_COMPANY_MARKETS]),
            },
          });
          for (const row of historical) {
            const key = `${row.exchange}:${row.symbol}`;
            const matches = historicalAssetsByIdentity.get(key) ?? [];
            matches.push(row);
            historicalAssetsByIdentity.set(key, matches);
          }
        }

        const priorCompanies = await this.loadUsCompanies(manager, symbols, false);
        const priorBySymbol = new Map<string, CompanyEntity[]>();
        for (const company of priorCompanies) {
          if (!company.ticker) continue;
          const matches = priorBySymbol.get(company.ticker) ?? [];
          matches.push(company);
          priorBySymbol.set(company.ticker, matches);
        }

        const stableCompanyIds = [
          ...new Set(
            [...existingAssetsByProviderId.values()]
              .map((asset) => asset.companyId)
              .filter((companyId): companyId is string => companyId !== null),
          ),
        ];
        const stableCompanies = await this.loadCompaniesByIds(manager, stableCompanyIds);
        const stableCompanyById = new Map(stableCompanies.map((company) => [company.id, company]));
        const companyByProviderId = new Map<string, CompanyEntity>();
        const claimedCompanyIds = new Set<string>();
        const bootstrapEligible: EligibleAlpacaAsset[] = [];
        for (const eligible of uniqueEligible) {
          const { asset, market } = eligible;
          const priorAsset = existingAssetsByProviderId.get(asset.providerAssetId);
          const stableCompany = priorAsset?.companyId
            ? stableCompanyById.get(priorAsset.companyId)
            : undefined;
          if (stableCompany) {
            const identityUnchanged =
              stableCompany.market === market && stableCompany.ticker === asset.symbol;
            if (!identityUnchanged || claimedCompanyIds.has(stableCompany.id)) {
              ambiguousSymbols += 1;
              continue;
            }
            companyByProviderId.set(asset.providerAssetId, stableCompany);
            claimedCompanyIds.add(stableCompany.id);
            continue;
          }

          const historicalIdentity =
            historicalAssetsByIdentity.get(`${market}:${asset.symbol}`) ?? [];
          const tickerWasMappedToAnotherProvider = historicalIdentity.some(
            (historical) =>
              historical.providerAssetId !== asset.providerAssetId && historical.companyId !== null,
          );
          const existing = priorBySymbol.get(asset.symbol) ?? [];
          const safe =
            !tickerWasMappedToAnotherProvider &&
            (existing.length === 0 ||
              (existing.length === 1 &&
                existing[0]!.market === market &&
                !claimedCompanyIds.has(existing[0]!.id)));
          if (!safe) {
            ambiguousSymbols += 1;
            continue;
          }
          bootstrapEligible.push(eligible);
          if (existing.length === 1) claimedCompanyIds.add(existing[0]!.id);
        }

        const priorKeys = new Set(
          priorCompanies.map((company) => `${company.market}:${company.ticker ?? ''}`),
        );
        const companyRows = bootstrapEligible.map(({ asset, market }) => {
          const displayName = this.companyDisplayName(asset.name, asset.symbol);
          return {
            id: randomUUID(),
            market,
            corpCode: null,
            stockCode: null,
            ticker: asset.symbol,
            cik: null,
            nameKo: displayName,
            nameEn: displayName,
            isListed: true,
            sourceUpdatedDate: null,
          };
        });
        for (const rowBatch of chunks(companyRows, DATABASE_CHUNK_SIZE)) {
          if (rowBatch.length === 0) continue;
          await manager
            .getRepository(CompanyEntity)
            .createQueryBuilder()
            .insert()
            .into(CompanyEntity)
            .values([...rowBatch])
            .orUpdate(['is_listed'])
            .execute();
        }

        const synchronizedCompanies = await this.loadUsCompanies(
          manager,
          bootstrapEligible.map(({ asset }) => asset.symbol),
          true,
        );
        const companiesBySymbol = new Map<string, CompanyEntity[]>();
        for (const company of synchronizedCompanies) {
          if (!company.ticker) continue;
          const matches = companiesBySymbol.get(company.ticker) ?? [];
          matches.push(company);
          companiesBySymbol.set(company.ticker, matches);
        }
        for (const eligible of bootstrapEligible) {
          const matches = companiesBySymbol.get(eligible.asset.symbol) ?? [];
          if (matches.length === 1 && matches[0]!.market === eligible.market) {
            companyByProviderId.set(eligible.asset.providerAssetId, matches[0]!);
          }
        }

        const mappedCompanyIds = new Set(
          [...companyByProviderId.values()].map((company) => company.id),
        );
        const previouslyMappedCompanyIds = new Set(
          priorCurrentAssets
            .map((asset) => asset.companyId)
            .filter((companyId): companyId is string => companyId !== null),
        );
        for (const companyIdBatch of chunks([...mappedCompanyIds], DATABASE_CHUNK_SIZE)) {
          if (companyIdBatch.length === 0) continue;
          await manager
            .getRepository(CompanyEntity)
            .update({ id: In(companyIdBatch) }, { isListed: true });
        }
        const staleCompanyIds = [...previouslyMappedCompanyIds].filter(
          (companyId) => !mappedCompanyIds.has(companyId),
        );
        for (const companyIdBatch of chunks(staleCompanyIds, DATABASE_CHUNK_SIZE)) {
          if (companyIdBatch.length === 0) continue;
          await manager
            .getRepository(CompanyEntity)
            .update({ id: In(companyIdBatch) }, { isListed: false });
        }

        await assetRepository.update({ isCurrent: true }, { isCurrent: false });
        const assetRows = snapshot.items.map((asset) => ({
          id: randomUUID(),
          providerAssetId: asset.providerAssetId,
          companyId: companyByProviderId.get(asset.providerAssetId)?.id ?? null,
          assetClass: asset.assetClass,
          exchange: asset.exchange,
          symbol: asset.symbol,
          name: asset.name,
          status: asset.status,
          tradable: asset.tradable,
          marginable: asset.marginable,
          shortable: asset.shortable,
          easyToBorrow: asset.easyToBorrow,
          fractionable: asset.fractionable,
          maintenanceMarginRequirement: asset.maintenanceMarginRequirement?.slice(0, 64) ?? null,
          attributesJson: asset.attributes ? [...asset.attributes] : null,
          rawJson: { ...asset.raw },
          rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
          provenanceUrl: snapshot.provenanceUrl,
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          isCurrent: true,
        }));
        for (const rowBatch of chunks(assetRows, ASSET_UPSERT_CHUNK_SIZE)) {
          await assetRepository
            .createQueryBuilder()
            .insert()
            .into(AlpacaAssetEntity)
            .values(rowBatch as unknown as QueryDeepPartialEntity<AlpacaAssetEntity>[])
            .orUpdate([
              'company_id',
              'asset_class',
              'exchange',
              'symbol',
              'name',
              'status',
              'tradable',
              'marginable',
              'shortable',
              'easy_to_borrow',
              'fractionable',
              'maintenance_margin_requirement',
              'attributes_json',
              'raw_json',
              'rights_mode',
              'provenance_url',
              'last_observed_at',
              'is_current',
            ])
            .execute();
        }

        const assetsCreated = snapshot.items.length - existingAssetsByProviderId.size;
        const companiesCreated = bootstrapEligible.reduce(
          (count, { asset, market }) =>
            count + (priorKeys.has(`${market}:${asset.symbol}`) ? 0 : 1),
          0,
        );
        const finishedAt = new Date();
        await manager.getRepository(IngestionRunEntity).update(
          { id: run.id },
          {
            status: ProcessingStatus.COMPLETED,
            itemsSeen: String(snapshot.items.length),
            itemsCreated: String(assetsCreated),
            finishedAt,
            errorMessage: null,
          },
        );
        const checkpoints = manager.getRepository(SourceCheckpointEntity);
        const checkpoint =
          (await checkpoints
            .createQueryBuilder('checkpoint')
            .setLock('pessimistic_write')
            .where('checkpoint.connector = :connector', { connector: 'ALPACA' })
            .andWhere('checkpoint.stream = :stream', { stream: ALPACA_ASSET_STREAM })
            .getOne()) ??
          checkpoints.create({
            connector: 'ALPACA',
            stream: ALPACA_ASSET_STREAM,
            lastSuccessDate: null,
            lastSuccessAt: null,
            cursor: null,
            metadataJson: null,
          });
        checkpoint.lastSuccessDate = toKstDateOnly(observedAt);
        checkpoint.lastSuccessAt = finishedAt;
        checkpoint.cursor = null;
        checkpoint.metadataJson = {
          rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
          provenanceUrl: snapshot.provenanceUrl,
          itemsSeen: snapshot.items.length,
          assetsCreated,
          assetsUpdated: existingAssetsByProviderId.size,
          eligibleAssets: companyByProviderId.size,
          companiesCreated,
          companiesAvailable: companyByProviderId.size,
          ambiguousSymbols,
          markets: [...US_COMPANY_MARKETS],
          filters: { assetClass: 'us_equity', status: 'active', tradable: true },
        };
        await checkpoints.save(checkpoint);

        return Object.freeze({
          connector: 'ALPACA' as const,
          stream: ALPACA_ASSET_STREAM,
          observedAt: observedAt.toISOString(),
          itemsSeen: snapshot.items.length,
          assetsCreated,
          assetsUpdated: existingAssetsByProviderId.size,
          eligibleAssets: companyByProviderId.size,
          companiesCreated,
          companiesAvailable: companyByProviderId.size,
          ambiguousSymbols,
        });
      });
    } catch (error) {
      await this.recordAssetFailure(run, error).catch(() => undefined);
      throw error;
    }
  }

  private async startAssetRun(observedAt: Date): Promise<IngestionRunEntity> {
    const repository = this.dataSource.getRepository(IngestionRunEntity);
    return repository.save(
      repository.create({
        connector: 'ALPACA',
        stream: ALPACA_ASSET_STREAM,
        windowStart: null,
        windowEnd: null,
        status: ProcessingStatus.PROCESSING,
        itemsSeen: '0',
        itemsCreated: '0',
        startedAt: observedAt,
        finishedAt: null,
        errorMessage: null,
      }),
    );
  }

  private async recordAssetFailure(run: IngestionRunEntity, error: unknown): Promise<void> {
    await this.dataSource.getRepository(IngestionRunEntity).update(
      { id: run.id },
      {
        status: ProcessingStatus.FAILED,
        finishedAt: new Date(),
        errorMessage: boundedError(error),
      },
    );
  }

  private async loadUsCompanies(
    manager: EntityManager,
    symbols: readonly string[],
    listedOnly: boolean,
  ): Promise<CompanyEntity[]> {
    const companies: CompanyEntity[] = [];
    for (const symbolBatch of chunks([...new Set(symbols)], DATABASE_CHUNK_SIZE)) {
      if (symbolBatch.length === 0) continue;
      companies.push(
        ...(await manager.getRepository(CompanyEntity).find({
          where: {
            ticker: In(symbolBatch),
            market: In(US_COMPANY_MARKETS),
            ...(listedOnly ? { isListed: true } : {}),
          },
        })),
      );
    }
    return companies;
  }

  private async loadCompaniesByIds(
    manager: EntityManager,
    companyIds: readonly string[],
  ): Promise<CompanyEntity[]> {
    const companies: CompanyEntity[] = [];
    for (const companyIdBatch of chunks([...new Set(companyIds)], DATABASE_CHUNK_SIZE)) {
      if (companyIdBatch.length === 0) continue;
      companies.push(
        ...(await manager.getRepository(CompanyEntity).find({
          where: { id: In(companyIdBatch) },
        })),
      );
    }
    return companies;
  }

  private companyDisplayName(name: string, symbol: string): string {
    const value = name.trim() || symbol;
    return [...value].slice(0, 255).join('');
  }

  private async withConnectorTransaction<T>(
    connector: 'ALPACA',
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    const lockName = `orsem:market-data:${connector.toLowerCase()}`;
    try {
      const rows = (await runner.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName])) as Array<{
        acquired: number | string | null;
      }>;
      if (Number(rows[0]?.acquired) !== 1) {
        throw new Error(`Timed out acquiring the ${connector} ingestion lock.`);
      }
      await runner.startTransaction();
      try {
        const result = await operation(runner.manager);
        await runner.commitTransaction();
        return result;
      } catch (error) {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction().catch(() => undefined);
        }
        throw error;
      }
    } finally {
      await runner.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
      await runner.release().catch(() => undefined);
    }
  }
}
