import 'reflect-metadata';
import { Market } from '@orsem/contracts';
import { CompanyEntity, SourceCheckpointEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  KR_ETF_MARKETS,
  planKoreanEtfMaster,
  validateKoreanEtfUniverse,
  type EtfCompany,
  type KoreanEtfIdentity,
  type KoreanEtfUniverse,
} from '../src/market-data/toss-korean-etf-master';
import { TossKoreanEtfMasterService } from '../src/market-data/toss-korean-etf-master.service';
import type { TossListedStock, TossMarketClient } from '../src/market-data/toss-market.client';

const etf = (symbol = '069500', name = 'KODEX 200'): TossListedStock => ({
  symbol,
  name,
  securityType: 'ETF',
  isCommonShare: true,
  isinCode: `KR7${symbol}007`,
});
function snapshots(active = [etf()], delisted: TossListedStock[] = []): KoreanEtfUniverse[] {
  return (['ACTIVE', 'DELISTED'] as const).flatMap((status) =>
    KR_ETF_MARKETS.map((market) => ({
      market,
      status,
      rows: market === 'KOSPI' ? (status === 'ACTIVE' ? active : delisted) : [],
    })),
  );
}
const company = (extra: Partial<EtfCompany> = {}): EtfCompany => ({
  id: 'company-1',
  market: Market.KOSPI,
  stockCode: '069500',
  corpCode: null,
  cik: null,
  ticker: null,
  nameKo: 'KODEX 200',
  nameEn: null,
  isListed: true,
  ...extra,
});
const identity = (extra: Partial<KoreanEtfIdentity> = {}): KoreanEtfIdentity => ({
  companyId: 'company-1',
  symbol: '069500',
  isinCode: etf().isinCode,
  market: 'KOSPI',
  managedCompany: true,
  appliedNameKo: 'KODEX 200',
  ...extra,
});

describe('Korean ETF universe validation and identity reconciliation', () => {
  it('accepts complete Korean responses and six-character alphanumeric ETF codes', () => {
    const rows = snapshots([etf(), etf('0000D0', 'TIGER 엔비디아미국채')]);
    expect(validateKoreanEtfUniverse(rows)).toEqual({ active: 2, delisted: 0 });
    expect(planKoreanEtfMaster(rows, [], []).actions.map((row) => row.kind)).toEqual([
      'CREATE',
      'CREATE',
    ]);
  });
  it('accepts historical code reuse only with a different ISIN and keeps current ownership protected', () => {
    const historical = { ...etf(), isinCode: 'KR7069500999' };
    expect(validateKoreanEtfUniverse(snapshots([etf()], [historical]))).toEqual({
      active: 1,
      delisted: 1,
    });
    const plan = planKoreanEtfMaster(
      snapshots([etf()], [historical]),
      [company()],
      [identity({ isinCode: historical.isinCode })],
    );
    expect(plan.conflicts).toBe(1);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.kind).toBe('DELIST');
  });
  it('rejects missing responses, zero active count and an unexpected shrink', () => {
    expect(() => validateKoreanEtfUniverse(snapshots().slice(1))).toThrow('INCOMPLETE');
    expect(() => validateKoreanEtfUniverse(snapshots([]))).toThrow('SHRANK');
    expect(() => validateKoreanEtfUniverse(snapshots(), 100)).toThrow('SHRANK');
    expect(() => validateKoreanEtfUniverse(snapshots(), NaN)).toThrow('PREVIOUS');
  });
  it('rejects duplicate identities, unsupported securities and malformed codes before persistence', () => {
    expect(() => validateKoreanEtfUniverse(snapshots([etf(), etf()]))).toThrow('IDENTITY');
    expect(() =>
      validateKoreanEtfUniverse(snapshots([{ ...etf(), securityType: 'STOCK' }])),
    ).toThrow('IDENTITY');
    expect(() => validateKoreanEtfUniverse(snapshots([etf('00000d')]))).toThrow('IDENTITY');
    expect(() =>
      validateKoreanEtfUniverse(snapshots([{ ...etf(), isinCode: 'US1234567890' }])),
    ).toThrow('IDENTITY');
  });
  it.each([
    { corpCode: '00123456' },
    { cik: '0000000123' },
    { ticker: '069500' },
    { market: Market.OTHER },
    { nameKo: 'Different owner' },
  ])('preserves an existing issuer or ambiguous owner: %j', (extra) => {
    const result = planKoreanEtfMaster(snapshots(), [company(extra)], []);
    expect(result.actions).toEqual([]);
    expect(result.conflicts).toBe(1);
  });
  it('does not duplicate a same-code company across markets', () => {
    const result = planKoreanEtfMaster(
      snapshots(),
      [company(), company({ id: 'second', market: Market.KRX })],
      [],
    );
    expect(result.actions).toEqual([]);
    expect(result.conflicts).toBe(1);
  });
  it('observes a matching pre-existing ETF without taking ownership or changing fields', () => {
    const result = planKoreanEtfMaster(snapshots(), [company()], []);
    expect(result.actions[0]).toMatchObject({ kind: 'OBSERVE', patch: {}, managedCompany: false });
  });
  it('updates only provider-owned names and preserves a manually edited name', () => {
    expect(
      planKoreanEtfMaster(snapshots([etf('069500', 'KODEX 200 new')]), [company()], [identity()])
        .actions[0]?.patch,
    ).toEqual({ nameKo: 'KODEX 200 new', isListed: true });
    expect(
      planKoreanEtfMaster(snapshots(), [company({ nameKo: '내가 정한 이름' })], [identity()])
        .actions[0]?.patch,
    ).toEqual({ isListed: true });
  });
  it('refuses ticker reuse when the prior ISIN differs', () => {
    const result = planKoreanEtfMaster(snapshots(), [company()], [identity({ isinCode: 'other' })]);
    expect(result.actions).toEqual([]);
    expect(result.conflicts).toBe(1);
  });
  it('never delists by absence and requires explicit DELISTED with the same identity', () => {
    const other = etf('102110', 'TIGER 200');
    const missing = planKoreanEtfMaster(snapshots([other]), [company()], [identity()]);
    expect(missing.actions.some((row) => row.kind === 'DELIST')).toBe(false);
    expect(missing.missingRetained).toBe(1);
    const confirmed = planKoreanEtfMaster(snapshots([other], [etf()]), [company()], [identity()]);
    expect(confirmed.actions.find((row) => row.kind === 'DELIST')?.patch).toEqual({
      isListed: false,
    });
    expect(
      planKoreanEtfMaster(
        snapshots([other], [etf()]),
        [company()],
        [identity({ managedCompany: false })],
      ).actions.some((row) => row.kind === 'DELIST'),
    ).toBe(false);
  });
});

function harness(options: { previous?: SourceCheckpointEntity; companies?: EtfCompany[] } = {}) {
  const query = (rows: unknown[]) => {
    const builder: Record<string, jest.Mock> = {};
    for (const method of ['where', 'andWhere', 'orderBy', 'setLock'])
      builder[method] = jest.fn().mockReturnValue(builder);
    builder.getMany = jest.fn().mockResolvedValue(rows);
    return builder;
  };
  const checkpoints = {
    findOne: jest.fn().mockResolvedValue(options.previous ?? null),
    createQueryBuilder: jest.fn().mockReturnValue(query([])),
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
  };
  const companies = {
    createQueryBuilder: jest.fn().mockReturnValue(query(options.companies ?? [])),
    create: jest.fn((value: object) => ({ id: 'new-etf-id', ...value })),
    save: jest.fn(async (value: unknown) => value),
    update: jest.fn(),
  };
  const runner = {
    connect: jest.fn(),
    release: jest.fn(),
    query: jest.fn().mockResolvedValue([{ acquired: 1 }]),
    startTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    isTransactionActive: false,
    manager: {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === CompanyEntity) return companies;
        if (entity === SourceCheckpointEntity) return checkpoints;
        throw new Error('Unrelated repository accessed');
      }),
    },
  };
  const client = {
    enabled: true,
    stocksAll: jest.fn(async (market: string, { status }: { status: string }) =>
      market === 'KOSPI' && status === 'ACTIVE' ? [etf()] : [],
    ),
  };
  const source = { createQueryRunner: () => runner };
  const service = new TossKoreanEtfMasterService(
    loadWorkerConfig({ NODE_ENV: 'test' }),
    source as unknown as DataSource,
    client as unknown as TossMarketClient,
  );
  return { service, client, runner, companies, checkpoints };
}

describe('Korean ETF master persistence boundaries', () => {
  it('makes only six filtered universe reads and persists ETF identities/provenance without fake issuers', async () => {
    const h = harness();
    const result = await h.service.sync({ force: true });
    expect(result).toMatchObject({ status: 'UPDATED', created: 1, activeEtfs: 1 });
    expect(h.client.stocksAll).toHaveBeenCalledTimes(6);
    expect(h.client.stocksAll).toHaveBeenCalledWith('KOSPI', {
      status: 'ACTIVE',
      securityType: 'ETF',
    });
    expect(h.companies.save.mock.calls[0]?.[0]).toMatchObject({
      stockCode: '069500',
      corpCode: null,
      cik: null,
      ticker: null,
      sourceUpdatedDate: null,
    });
    const saved = h.checkpoints.save.mock.calls.map(([row]) => row) as SourceCheckpointEntity[];
    expect(saved[0]?.metadataJson).toMatchObject({
      source: 'TOSS',
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
      managedCompany: true,
      rawPayload: etf(),
    });
    expect(saved[1]?.metadataJson?.rawSnapshot).toHaveLength(6);
    expect(h.runner.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('dry-run never saves rows', async () => {
    const h = harness();
    expect(await h.service.sync({ force: true, dryRun: true })).toMatchObject({
      status: 'DRY_RUN',
      created: 1,
    });
    expect(h.companies.save).not.toHaveBeenCalled();
    expect(h.checkpoints.save).not.toHaveBeenCalled();
    expect(h.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
  it('keeps a daily successful snapshot without making another provider request', async () => {
    const h = harness({
      previous: Object.assign(new SourceCheckpointEntity(), {
        lastSuccessAt: new Date(),
        metadataJson: { activeEtfs: 1167 },
      }),
    });
    expect(await h.service.sync()).toMatchObject({ status: 'CACHED', activeEtfs: 1167 });
    expect(h.client.stocksAll).not.toHaveBeenCalled();
  });
  it('stops before transactions when a market response fails or a snapshot is invalid', async () => {
    const h = harness();
    h.client.stocksAll.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(h.service.sync({ force: true })).rejects.toThrow();
    expect(h.runner.startTransaction).not.toHaveBeenCalled();
    expect(h.companies.save).not.toHaveBeenCalled();
    expect(h.runner.query).toHaveBeenLastCalledWith('SELECT RELEASE_LOCK(?)', [
      'orsem-toss-kr-etf-master',
    ]);
  });
  it('missing Toss credentials disable only this sync before DB access', async () => {
    const h = harness();
    h.client.enabled = false;
    expect(await h.service.sync()).toMatchObject({ status: 'DISABLED' });
    expect(h.runner.connect).not.toHaveBeenCalled();
    expect(h.client.stocksAll).not.toHaveBeenCalled();
  });
});
