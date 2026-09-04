import { ConnectorStatus, ProcessingStatus, WatchPriority } from '@orsem/contracts';
import {
  CompanyEntity,
  ConnectorHealthEntity,
  IngestionRunEntity,
  NewsItemEntity,
  SourceCheckpointEntity,
  SourceItemEntity,
  WatchlistItemEntity,
} from '@orsem/database';
import { DataSource, FindOperator } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import { SecSubmissionsConnector } from '../src/connectors/connector-adapters';
import { NewsDiscoveryService } from '../src/connectors/news-discovery.service';
import { ConnectorHealthService } from '../src/connectors/connector-health.service';
import type { CompatibleClassifierClient } from '../src/ai/compatible-classifier.client';
import { projectSecFilingEvents } from '../src/connectors/sec-event-projection';
import type { PushFanoutService } from '../src/push/push-fanout.service';
import { discoverLinksJobSchema } from '../src/queues/job-data';

jest.mock('../src/connectors/sec-event-projection', () => ({
  projectSecFilingEvents: jest.fn().mockResolvedValue({ created: 1, existing: 0 }),
}));

const CIK = '0001652044';
const company = (id: string, ticker: string, cik = CIK) => ({
  id,
  ticker,
  cik,
  nameKo: 'Alphabet',
  nameEn: 'Alphabet',
  stockCode: null,
  market: 'NASDAQ',
});
const GOOG = company('00000000-0000-4000-8000-000000000001', 'GOOG');
const GOOGL = company('00000000-0000-4000-8000-000000000002', 'GOOGL');
const config = loadWorkerConfig({
  SEC_USER_AGENT: 'Orsem test@example.com',
  GDELT_ENABLED: 'false',
});
const scheduled = () =>
  discoverLinksJobSchema.parse({
    connectors: ['SEC'],
    priorities: [WatchPriority.P1, WatchPriority.P2],
    reason: 'SCHEDULED',
  });
const backfill = () =>
  discoverLinksJobSchema.parse({
    connectors: ['SEC'],
    companyIds: [GOOG.id],
    priorities: [],
    reason: 'BACKFILL',
    suppressAlerts: true,
  });
function response(count = 1, overrides: Record<string, unknown> = {}) {
  return {
    cik: 1652044,
    name: 'Alphabet Inc.',
    filings: {
      recent: {
        accessionNumber: Array.from(
          { length: count },
          (_, index) => `0001652044-26-${String(index + 1).padStart(6, '0')}`,
        ),
        filingDate: Array.from({ length: count }, () => '2026-09-04'),
        form: Array.from({ length: count }, () => '4'),
        primaryDocument: Array.from({ length: count }, () => 'xslF345X05/ownership.xml'),
        acceptanceDateTime: Array.from({ length: count }, () => '2026-09-04T16:01:00.000Z'),
        ...overrides,
      },
    },
  };
}
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function memoryDatabase() {
  const tables = new Map<unknown, Record<string, unknown>[]>();
  let nextId = 100;
  const rows = (target: unknown) => {
    if (!tables.has(target)) tables.set(target, []);
    return tables.get(target)!;
  };
  const matches = (row: Record<string, unknown>, where: unknown): boolean => {
    if (Array.isArray(where)) return where.some((part) => matches(row, part));
    return Object.entries((where ?? {}) as Record<string, unknown>).every(([key, value]) =>
      value instanceof FindOperator
        ? value.type === 'in' && value.value.includes(row[key])
        : row[key] === value,
    );
  };
  const getRepository = (target: unknown) => ({
    find: jest.fn(async (options?: { where?: unknown }) =>
      rows(target).filter((row) => matches(row, options?.where)),
    ),
    findOne: jest.fn(
      async (options: { where: unknown }) =>
        rows(target).find((row) => matches(row, options.where)) ?? null,
    ),
    create: jest.fn((values: Record<string, unknown>) => ({ id: String(nextId++), ...values })),
    save: jest.fn(async (row: Record<string, unknown>) => {
      const index = rows(target).findIndex((existing) => existing.id === row.id);
      if (index < 0) rows(target).push(row);
      else rows(target)[index] = row;
      return row;
    }),
  });
  const manager = { getRepository };
  const dataSource = {
    ...manager,
    transaction: async (callback: (manager: unknown) => unknown) => callback(manager),
  } as unknown as DataSource;
  rows(CompanyEntity).push(GOOG, GOOGL);
  rows(WatchlistItemEntity).push({ id: 'watch', companyId: GOOG.id, priority: WatchPriority.P1 });
  return { dataSource, rows };
}

beforeEach(() => jest.clearAllMocks());

describe('SEC recent submissions metadata', () => {
  it('does not mistake configured credentials or a health check for successful SEC ingestion', async () => {
    const fetch = jest.fn();
    const adapter = new SecSubmissionsConnector('Orsem test@example.com', fetch, 1000);
    expect(adapter.health()).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      metadata: { healthSource: 'SEC_INGESTION' },
    });
    expect(await adapter.check()).toMatchObject({ status: ConnectorStatus.DEGRADED });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([403, 429])(
    'preserves the shared SEC cooldown HTTP %s and retry instant',
    async (httpStatus) => {
      const retryAt = new Date('2026-09-05T00:10:00Z');
      const fetch = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('private upstream details'), { httpStatus, retryAt }),
        );
      await expect(
        new SecSubmissionsConnector('Orsem test@example.com', fetch, 1000).submissions(CIK),
      ).rejects.toMatchObject({ httpStatus, retryAt, transportCategory: null });
    },
  );
  it('fetches one issuer once and associates all scoped share classes', async () => {
    const fetch = jest.fn().mockResolvedValue(
      jsonResponse(
        response(1, {
          reportDate: ['2026-09-03'],
          fileNumber: ['001-37580'],
          filmNumber: ['26123456'],
          items: ['5.02'],
          size: [12345],
          isXBRL: [0],
          isInlineXBRL: [0],
          primaryDocDescription: ['Form 4'],
        }),
      ),
    );
    const adapter = new SecSubmissionsConnector('Orsem test@example.com', fetch, 1000);
    const candidates = await adapter.discoverLinks({ companies: [GOOG, GOOGL, GOOG] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://data.sec.gov/submissions/CIK${CIK}.json`,
    );
    expect(candidates[0]).toMatchObject({
      externalId: '0001652044-26-000001',
      tickers: ['GOOG', 'GOOGL'],
      publishedAt: '2026-09-04T16:01:00.000Z',
      url: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000001/xslF345X05/ownership.xml',
      metadata: {
        cik: CIK,
        form: '4',
        filingDate: '2026-09-04',
        acceptanceDateTime: '2026-09-04T16:01:00.000Z',
      },
    });
    expect(candidates[0]?.metadata).not.toHaveProperty('body');
    expect(candidates[0]?.metadata).toMatchObject({
      reportDate: '2026-09-03',
      originalFilingTruncated: false,
      originalFiling: {
        accessionNumber: '0001652044-26-000001',
        filingDate: '2026-09-04',
        reportDate: '2026-09-03',
        form: '4',
        fileNumber: '001-37580',
        filmNumber: '26123456',
        items: '5.02',
        size: 12345,
        isXBRL: 0,
        isInlineXBRL: 0,
        primaryDocDescription: 'Form 4',
        primaryDocument: 'xslF345X05/ownership.xml',
        acceptanceDateTime: '2026-09-04T16:01:00.000Z',
      },
    });
  });

  it('bounds additional original row fields and records when metadata was truncated', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(response(1, { futureMetadata: ['x'.repeat(3_000)] })));
    const [candidate] = await new SecSubmissionsConnector(
      'Orsem test@example.com',
      fetch,
      1000,
    ).submissions(CIK);
    expect(candidate?.metadata.originalFilingTruncated).toBe(true);
    expect(
      (candidate?.metadata.originalFiling as Record<string, unknown>).futureMetadata,
    ).toHaveLength(2_048);
  });

  it.each([undefined, ['2026-09-04T16:01:00']])(
    'preserves date-only/zoneless source values without inventing publication time (%s)',
    async (acceptanceDateTime) => {
      const fetch = jest.fn().mockResolvedValue(jsonResponse(response(1, { acceptanceDateTime })));
      const [candidate] = await new SecSubmissionsConnector(
        'Orsem test@example.com',
        fetch,
        1000,
      ).submissions(CIK);
      expect(candidate?.publishedAt).toBeNull();
      expect(candidate?.metadata).toMatchObject({
        filingDate: '2026-09-04',
        acceptanceDateTime: acceptanceDateTime?.[0] ?? null,
      });
    },
  );

  it('rejects a response for another issuer before producing candidates', async () => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse({ ...response(), cik: 320193 }));
    await expect(
      new SecSubmissionsConnector('Orsem test@example.com', fetch, 1000).submissions(CIK),
    ).rejects.toThrow('does not match');
  });

  it.each([
    { accessionNumber: ['../../bad'] },
    { primaryDocument: ['../secret.xml'] },
    { primaryDocument: ['https://other.example/item'] },
    { primaryDocument: ['file.xml?secret=value'] },
  ])('rejects unsafe accession/document metadata %#', async (override) => {
    const fetch = jest.fn().mockResolvedValue(jsonResponse(response(1, override)));
    await expect(
      new SecSubmissionsConnector('Orsem test@example.com', fetch, 1000).submissions(CIK),
    ).rejects.toThrow(/invalid accession|unsafe primary/u);
  });
});

describe('SEC ingestion baselines and share classes', () => {
  it('completes a missing-CIK run without claiming a successful request or advancing success timestamps', async () => {
    const db = memoryDatabase();
    db.rows(CompanyEntity)[0] = { ...GOOG, cik: null };
    const previousSuccess = new Date('2026-09-01T00:00:00Z');
    db.rows(ConnectorHealthEntity).push({
      id: 'health',
      connector: 'sec',
      status: ConnectorStatus.DEGRADED,
      lastSuccessAt: previousSuccess,
      metadataJson: { httpStatus: 403 },
    });
    db.rows(SourceCheckpointEntity).push({
      id: 'checkpoint',
      connector: 'SEC',
      stream: 'LINK_DISCOVERY:P1_P2',
      lastSuccessAt: previousSuccess,
    });
    const fetch = jest.fn();
    const service = new NewsDiscoveryService(db.dataSource, config, fetch, {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    expect(await service.discover(scheduled())).toMatchObject([
      { status: ConnectorStatus.DEGRADED, seen: 0, created: 0 },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.rows(IngestionRunEntity)[0]).toMatchObject({
      status: ProcessingStatus.COMPLETED,
      itemsSeen: '0',
    });
    expect(db.rows(ConnectorHealthEntity)[0]).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      lastSuccessAt: previousSuccess,
      metadataJson: {
        healthSource: 'SEC_INGESTION',
        missingScopeCikCount: 1,
        scopedUsCompanyCount: 1,
        eligibleIssuerCount: 0,
        emptyScope: false,
        requestsPlanned: false,
      },
    });
    expect(db.rows(SourceCheckpointEntity)[0]?.lastSuccessAt).toBe(previousSuccess);
  });

  it('distinguishes an empty US watch scope from missing issuer mappings', async () => {
    const db = memoryDatabase();
    db.rows(WatchlistItemEntity).length = 0;
    const fetch = jest.fn();
    const service = new NewsDiscoveryService(db.dataSource, config, fetch, {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    expect(await service.discover(scheduled())).toMatchObject([
      { status: ConnectorStatus.DEGRADED, seen: 0 },
    ]);
    expect(db.rows(ConnectorHealthEntity)[0]).toMatchObject({
      lastSuccessAt: null,
      metadataJson: {
        emptyScope: true,
        missingScopeCikCount: 0,
        scopedUsCompanyCount: 0,
        requestsPlanned: false,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'uses actual SEC discovery health and replaces legacy probe health (actual=%s)',
    async (actual) => {
      const db = memoryDatabase();
      const previous = new Date('2026-09-04T00:00:00Z');
      db.rows(ConnectorHealthEntity).push({
        id: 'health',
        connector: 'sec',
        status: ConnectorStatus.HEALTHY,
        checkedAt: previous,
        lastSuccessAt: previous,
        message: null,
        metadataJson: actual ? { healthSource: 'SEC_INGESTION', requestsPlanned: true } : {},
      });
      const fetch = jest.fn();
      const classifier = {
        probeHealth: jest
          .fn()
          .mockResolvedValue({ status: ConnectorStatus.UNCONFIGURED, checkedAt: previous }),
      };
      const service = new ConnectorHealthService(
        db.dataSource,
        config,
        fetch,
        classifier as unknown as CompatibleClassifierClient,
      );
      const checks = await service.checkAll();
      expect(checks.find((check) => check.connector === 'SEC')?.status).toBe(
        actual ? ConnectorStatus.HEALTHY : ConnectorStatus.DEGRADED,
      );
      const stored = db.rows(ConnectorHealthEntity).find((row) => row.connector === 'sec')!;
      expect(stored.status).toBe(actual ? ConnectorStatus.HEALTHY : ConnectorStatus.DEGRADED);
      expect(stored.lastSuccessAt).toBe(actual ? previous : null);
      if (actual) expect(stored.checkedAt).toBe(previous);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('backfills once per issuer, projects all share classes and only alerts on subsequent new scheduled filings', async () => {
    const db = memoryDatabase();
    const push = { enqueueNews: jest.fn() };
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(response(2)))
      .mockResolvedValueOnce(jsonResponse(response(3)))
      .mockResolvedValueOnce(jsonResponse(response(4)));
    const service = new NewsDiscoveryService(
      db.dataSource,
      config,
      fetch,
      push as unknown as PushFanoutService,
    );
    expect(await service.discover(backfill())).toMatchObject([
      { status: ConnectorStatus.HEALTHY, created: 2 },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(push.enqueueNews).not.toHaveBeenCalled();
    const source = db.rows(SourceItemEntity)[0]!;
    const firstObservedAt = source.firstObservedAt;
    expect(source).toMatchObject({
      companyId: null,
      rawMetadataJson: { companyIds: [GOOG.id, GOOGL.id], tickers: ['GOOG', 'GOOGL'] },
    });
    expect(projectSecFilingEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'SEC' }),
      [GOOG, GOOGL],
    );
    expect(
      db.rows(SourceCheckpointEntity).find((row) => row.stream === `SUBMISSIONS:CIK:${CIK}`),
    ).toMatchObject({ metadataJson: { baselineComplete: true } });

    expect(await service.discover(scheduled())).toMatchObject([{ created: 1 }]);
    expect(push.enqueueNews).toHaveBeenCalledTimes(1);
    expect(db.rows(SourceItemEntity)[0]?.firstObservedAt).toBe(firstObservedAt);
    expect(db.rows(SourceItemEntity)).toHaveLength(3);
    expect(db.rows(NewsItemEntity).every((row) => row.companyId === null)).toBe(true);
    expect(await service.discover(backfill())).toMatchObject([{ created: 1 }]);
    expect(push.enqueueNews).toHaveBeenCalledTimes(1);
  });

  it('suppresses an issuer first encountered by the scheduled job and baselines existing legacy rows too', async () => {
    const db = memoryDatabase();
    const push = { enqueueNews: jest.fn() };
    const fetch = jest.fn().mockResolvedValue(jsonResponse(response(2)));
    db.rows(SourceItemEntity).push({
      id: 'legacy',
      source: 'SEC',
      externalId: '0001652044-26-000001',
      firstObservedAt: new Date('2026-01-01Z'),
    });
    const service = new NewsDiscoveryService(
      db.dataSource,
      config,
      fetch,
      push as unknown as PushFanoutService,
    );
    expect(await service.discover(scheduled())).toMatchObject([{ created: 1 }]);
    expect(push.enqueueNews).not.toHaveBeenCalled();
  });

  it('keeps more than 25 share classes of one issuer in a single request and preserves all ticker links', async () => {
    const db = memoryDatabase();
    for (let index = 3; index <= 28; index++) {
      const row = company(
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        `CLASS${index}`,
      );
      db.rows(CompanyEntity).push(row);
      db.rows(WatchlistItemEntity).push({
        id: `watch-${index}`,
        companyId: row.id,
        priority: WatchPriority.P1,
      });
    }
    const fetch = jest.fn().mockResolvedValue(jsonResponse(response()));
    const service = new NewsDiscoveryService(db.dataSource, config, fetch, {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    expect(await service.discover(scheduled())).toMatchObject([{ created: 1 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.rows(NewsItemEntity)[0]?.tickersJson).toHaveLength(28);
  });

  it('does not mark an issuer baselined after an invalid response', async () => {
    const db = memoryDatabase();
    const fetch = jest.fn().mockResolvedValue(jsonResponse({ ...response(), cik: 320193 }));
    const service = new NewsDiscoveryService(db.dataSource, config, fetch, {
      enqueueNews: jest.fn(),
    } as unknown as PushFanoutService);
    expect(await service.discover(scheduled())).toMatchObject([
      { status: ConnectorStatus.DEGRADED, created: 0 },
    ]);
    expect(
      db.rows(SourceCheckpointEntity).some((row) => row.stream === `SUBMISSIONS:CIK:${CIK}`),
    ).toBe(false);
    expect(db.rows(SourceItemEntity)).toHaveLength(0);
  });
});
