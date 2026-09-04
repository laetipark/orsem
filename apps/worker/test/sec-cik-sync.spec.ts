import { Market, RightsMode } from '@orsem/contracts';
import { CompanyEntity, SourceCheckpointEntity } from '@orsem/database';
import type { DataSource, EntityManager } from 'typeorm';
import type { WorkerConfig } from '../src/config/worker-config';
import { SecCikSyncService, SecTickerIndex } from '../src/market-data/sec-cik-sync.service';
import {
  SEC_TICKER_MASTER_URL,
  SecTickerMasterClient,
} from '../src/market-data/sec-ticker-master.client';

const observedAt = new Date('2026-09-04T16:30:00.000Z');
const fields = ['cik', 'name', 'ticker', 'exchange'];
const rows = [
  [1652044, 'Alphabet Inc.', 'GOOGL', 'Nasdaq'],
  [1652044, 'Alphabet Inc.', 'GOOG', 'Nasdaq'],
  [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-B', 'NYSE'],
  [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-A', 'NYSE'],
];
const company = (
  id: number,
  ticker: string,
  market: typeof Market.NASDAQ | typeof Market.NYSE = Market.NASDAQ,
) =>
  ({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    market,
    ticker,
    stockCode: null,
    cik: null,
    nameKo: '기존 한글명',
    nameEn: 'Original English Name',
    isListed: true,
  }) as CompanyEntity;
const config = {
  secUserAgent: 'OrsemTest contact@example.com',
  httpTimeoutMs: 1000,
} as WorkerConfig;

function harness(seed: CompanyEntity[], initialRows: unknown[][] = rows) {
  const companies = new Map(seed.map((row) => [row.id, { ...row }]));
  const checkpoints = new Map<string, SourceCheckpointEntity>();
  const companyRepository = {
    find: jest.fn(async () => [...companies.values()].map((row) => ({ ...row }))),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = companies.get(where.id);
      return row ? { ...row } : null;
    }),
    update: jest.fn(async ({ id }: { id: string }, patch: Partial<CompanyEntity>) => {
      companies.set(id, { ...companies.get(id)!, ...patch });
    }),
  };
  const checkpointRepository = {
    findOne: jest.fn(
      async ({ where }: { where: { stream: string } }) => checkpoints.get(where.stream) ?? null,
    ),
    create: jest.fn((row: SourceCheckpointEntity) => row),
    save: jest.fn(async (row: SourceCheckpointEntity) => {
      checkpoints.set(row.stream, row);
      return row;
    }),
  };
  const getRepository = (entity: unknown) => {
    if (entity === CompanyEntity) return companyRepository;
    if (entity === SourceCheckpointEntity) return checkpointRepository;
    throw new Error('Unexpected repository');
  };
  const dataSource = {
    getRepository,
    transaction: jest.fn(async (operation: (manager: EntityManager) => Promise<unknown>) =>
      operation({ getRepository } as unknown as EntityManager),
    ),
  } as unknown as DataSource;
  const fetch = jest.fn(
    async () =>
      new Response(JSON.stringify({ fields, data: initialRows }), {
        headers: { 'last-modified': 'Fri, 04 Sep 2026 12:00:00 GMT' },
      }),
  );
  return {
    service: new SecCikSyncService(dataSource, config, fetch),
    dataSource,
    fetch,
    companies,
    checkpoints,
    companyRepository,
    checkpointRepository,
  };
}

describe('SEC official ticker/CIK synchronization', () => {
  it('preserves original field ordering/values while normalizing CIK and ticker for matching', async () => {
    const raw = {
      fields: ['ticker', 'exchange', 'name', 'cik', 'extra'],
      data: [['brk-b', 'NYSE', 'Original Issuer', 1067983, 'kept']],
      version: 'source-extra',
    };
    const fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(raw)));
    const snapshot = await new SecTickerMasterClient(config.secUserAgent, fetch, 1000).fetch();
    expect(snapshot.raw).toEqual(raw);
    expect(snapshot.rows[0]).toMatchObject({
      cik: '0001067983',
      ticker: 'BRK-B',
      exchange: 'NYSE',
      rowIndex: 0,
      raw: {
        ticker: 'brk-b',
        exchange: 'NYSE',
        name: 'Original Issuer',
        cik: 1067983,
        extra: 'kept',
      },
    });
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.acquisition).toEqual({
      method: 'DIRECT_HTTP',
      sha256Basis: 'HTTP_RESPONSE_TEXT',
    });
    expect(fetch).toHaveBeenCalledWith(
      SEC_TICKER_MASTER_URL,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': config.secUserAgent },
      }),
    );
  });

  it('links both share classes to the same issuer and keeps Korean/English names and tickers', async () => {
    const first = company(1, 'GOOGL');
    const second = company(2, 'GOOG');
    const h = harness([first, second]);
    expect(await h.service.sync({}, observedAt)).toMatchObject({
      linked: 2,
      alreadyLinked: 0,
      conflicts: 0,
      sourceRows: 4,
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.companies.get(first.id)).toEqual({ ...first, cik: '0001652044' });
    expect(h.companies.get(second.id)).toEqual({ ...second, cik: '0001652044' });
    expect(h.checkpoints.get(`CIK_MAPPING:${first.id}`)).toMatchObject({
      connector: 'SEC_EDGAR',
      lastSuccessAt: observedAt,
      lastSuccessDate: '2026-09-05',
      metadataJson: {
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        provenanceUrl: SEC_TICKER_MASTER_URL,
        originalCik: null,
        appliedCik: '0001652044',
        matchRule: 'EXACT_TICKER_EXCHANGE',
        firstObservedAt: observedAt.toISOString(),
        observedAt: observedAt.toISOString(),
        rawPayload: [
          { cik: 1652044, name: 'Alphabet Inc.', ticker: 'GOOGL', exchange: 'Nasdaq', rowIndex: 0 },
        ],
      },
    });
    expect(h.checkpoints.get('CIK_TICKER_MASTER')?.metadataJson).toMatchObject({
      rawPayload: { fields, data: rows },
      sourceLastModified: 'Fri, 04 Sep 2026 12:00:00 GMT',
      firstObservedAt: observedAt.toISOString(),
    });

    const later = new Date(observedAt.getTime() + 86_400_000);
    expect(await h.service.sync({}, later)).toMatchObject({ linked: 0, alreadyLinked: 2 });
    expect(h.companyRepository.update).toHaveBeenCalledTimes(2);
    expect(h.checkpoints.get(`CIK_MAPPING:${first.id}`)?.metadataJson).toMatchObject({
      originalCik: null,
      firstObservedAt: observedAt.toISOString(),
      observedAt: later.toISOString(),
    });
  });

  it('uses dot/hyphen equivalence without dropping a share-class suffix or crossing exchanges', async () => {
    const h = harness([
      company(1, 'BRK.B', Market.NYSE),
      company(2, 'BRK', Market.NYSE),
      company(3, 'GOOGL', Market.NYSE),
    ]);
    expect(await h.service.sync({}, observedAt)).toMatchObject({ linked: 1, unmatched: 2 });
    expect(h.checkpoints.get(`CIK_MAPPING:${company(1, '').id}`)?.metadataJson?.matchRule).toBe(
      'DOT_HYPHEN_TICKER_EXCHANGE',
    );
    expect(h.companyRepository.update).toHaveBeenCalledTimes(1);
  });

  it('prefers an exact ticker over an alias and skips conflicting CIK candidates', async () => {
    const h = harness(
      [],
      [
        [1, 'Exact', 'ABC.B', 'NYSE'],
        [2, 'Alias', 'ABC-B', 'NYSE'],
        [3, 'Issuer One', 'XYZ', 'Nasdaq'],
        [4, 'Issuer Two', 'XYZ', 'Nasdaq'],
        [5, 'Unknown Venue', 'NONE', null],
      ],
    );
    const snapshot = await new SecTickerMasterClient(config.secUserAgent, h.fetch, 1000).fetch();
    const index = new SecTickerIndex(snapshot.rows);
    expect(index.match(company(1, 'ABC.B', Market.NYSE))).toMatchObject({
      status: 'MATCHED',
      cik: '0000000001',
      rule: 'EXACT_TICKER_EXCHANGE',
    });
    expect(index.match(company(2, 'XYZ'))).toMatchObject({ status: 'AMBIGUOUS', cik: null });
    expect(index.match(company(3, 'NONE'))).toMatchObject({ status: 'UNMATCHED', cik: null });
  });

  it('does not overwrite an existing conflicting CIK or an earlier applied identity after it is cleared', async () => {
    const original = { ...company(1, 'GOOGL'), cik: '0000000001' };
    const h = harness([original]);
    expect(await h.service.sync({}, observedAt)).toMatchObject({ conflicts: 1, linked: 0 });
    expect(h.companies.get(original.id)).toEqual(original);
    expect(h.companyRepository.update).not.toHaveBeenCalled();
    expect(h.checkpoints.get(`CIK_MAPPING:${original.id}`)?.metadataJson).toMatchObject({
      outcome: 'conflicts',
      originalCik: original.cik,
      candidateCik: '0001652044',
      appliedCik: null,
    });

    const safe = harness([company(2, 'GOOG')]);
    await safe.service.sync({}, observedAt);
    safe.companies.get(company(2, '').id)!.cik = null;
    safe.fetch.mockResolvedValue(
      new Response(JSON.stringify({ fields, data: [[9, 'Reused Ticker', 'GOOG', 'Nasdaq']] })),
    );
    expect(await safe.service.sync({}, new Date(observedAt.getTime() + 1000))).toMatchObject({
      conflicts: 1,
      linked: 0,
    });
    expect(safe.companyRepository.update).toHaveBeenCalledTimes(1);
  });

  it('rechecks current company identity under lock before applying a mapping', async () => {
    const initial = company(1, 'GOOG');
    const h = harness([initial]);
    h.companyRepository.find.mockImplementationOnce(async () => {
      h.companies.set(initial.id, { ...initial, ticker: 'UNLISTED', isListed: false });
      return [initial];
    });
    expect(await h.service.sync({}, observedAt)).toMatchObject({ notEligible: 1, linked: 0 });
    expect(h.companyRepository.update).not.toHaveBeenCalled();
  });

  it.each([
    { fields: ['cik', 'name', 'ticker', 'ticker'], data: rows },
    { fields, data: [[1652044, 'Alphabet', 'GOOG']] },
    { fields, data: [[0, 'Invalid CIK', 'GOOG', 'Nasdaq']] },
    { fields, data: [] },
  ])('rejects malformed snapshots before writing any company or checkpoint', async (raw) => {
    const h = harness([company(1, 'GOOG')]);
    h.fetch.mockResolvedValue(new Response(JSON.stringify(raw)));
    await expect(h.service.sync({}, observedAt)).rejects.toThrow(/valid bounded JSON/u);
    expect(h.companyRepository.update).not.toHaveBeenCalled();
    expect(h.checkpointRepository.save).not.toHaveBeenCalled();
  });

  it('does not expose provider bodies on HTTP failure or call SEC when configuration/scope is absent', async () => {
    const h = harness([company(1, 'GOOG')]);
    h.fetch.mockResolvedValue(new Response('private request detail', { status: 403 }));
    await expect(h.service.sync({}, observedAt)).rejects.toThrow(
      'SEC ticker-master request failed with HTTP 403.',
    );
    expect(h.checkpointRepository.save).not.toHaveBeenCalled();
    h.fetch.mockClear();
    const disabled = new SecCikSyncService(
      h.dataSource,
      { ...config, secUserAgent: null },
      h.fetch,
    );
    expect(await disabled.sync()).toMatchObject({ disabled: true, linked: 0 });
    expect(await h.service.sync({ companyIds: [] })).toMatchObject({
      companiesRequested: 0,
      linked: 0,
    });
    expect(h.fetch).not.toHaveBeenCalled();
    await expect(
      h.service.sync({ companyIds: Array(10_001).fill(company(1, '').id) }),
    ).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('imports explicitly scoped cache rows without pretending to fetch the full HTTP source', async () => {
    const target = company(1, 'GOOGL');
    const h = harness([target]);
    const cache = {
      formatVersion: 1,
      provenanceUrl: SEC_TICKER_MASTER_URL,
      method: 'SEARCH_CACHE_EXTRACT',
      extractedAt: observedAt.toISOString(),
      sourceLastModified: null,
      cacheAge: 'UNKNOWN',
      coverage: 'SELECTED_ROWS_ONLY',
      liveIssuerValidation: 'NOT_COMPLETED',
      fields,
      data: rows.slice(0, 1),
    };
    expect(
      await h.service.syncFromSearchCache(cache, { companyIds: [target.id] }, observedAt),
    ).toMatchObject({ linked: 1, unmatched: 0, companiesRequested: 1, sourceRows: 1 });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.checkpoints.has('CIK_TICKER_MASTER')).toBe(false);
    expect([...h.checkpoints.keys()].some((key) => key.startsWith('CIK_SEARCH_CACHE:'))).toBe(true);
    expect(h.checkpoints.get(`CIK_MAPPING:${target.id}`)?.metadataJson).toMatchObject({
      sourceLastModified: null,
      acquisition: {
        method: 'SEARCH_CACHE_EXTRACT',
        sha256Basis: 'EXTRACTED_JSON',
        extractedAt: observedAt.toISOString(),
        cacheAge: 'UNKNOWN',
        coverage: 'SELECTED_ROWS_ONLY',
        liveIssuerValidation: 'NOT_COMPLETED',
      },
    });
    await expect(h.service.syncFromSearchCache(cache, { companyIds: [] })).rejects.toThrow();
  });

  it('rejects imports that do not cover the selected company without recording false unmatched checkpoints', async () => {
    const target = company(1, 'GOOG');
    const h = harness([target]);
    const cache = {
      formatVersion: 1,
      provenanceUrl: SEC_TICKER_MASTER_URL,
      method: 'SEARCH_CACHE_EXTRACT',
      extractedAt: observedAt.toISOString(),
      sourceLastModified: null,
      cacheAge: 'UNKNOWN',
      coverage: 'SELECTED_ROWS_ONLY',
      liveIssuerValidation: 'NOT_COMPLETED',
      fields,
      data: rows.slice(0, 1),
    };
    await expect(
      h.service.syncFromSearchCache(cache, { companyIds: [target.id] }, observedAt),
    ).rejects.toThrow(/does not unambiguously cover/u);
    expect(h.checkpointRepository.save).not.toHaveBeenCalled();
    expect(h.companyRepository.update).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    await expect(
      h.service.syncFromSearchCache(
        { ...cache, provenanceUrl: 'https://example.com/' },
        { companyIds: [target.id] },
      ),
    ).rejects.toThrow();
  });
});
