import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import type { WorkerConfig } from '../src/config/worker-config';
import { SecAccessCooldownError } from '../src/connectors/sec-access-policy';
import type { FetchImplementation } from '../src/opendart/opendart.client';
import { SecCompanyInformationService } from '../src/market-data/sec-company-information.service';

const NOW = new Date('2026-09-07T10:00:00.000Z');
const config = {
  secUserAgent: 'Orsem test contact@example.test',
  httpTimeoutMs: 15_000,
} as WorkerConfig;
const candidate = {
  id: '11111111-1111-4111-a111-111111111111',
  cik: '0000123456',
  listedClasses: 1,
  stockMetadata: { rawPayload: { isCommonShare: true, securityType: 'STOCK', currency: 'USD' } },
};
const fact = (val: number) => ({
  val,
  end: '2025-12-31',
  filed: '2026-02-15',
  accn: '0000123456-26-000001',
  form: '10-K',
  fp: 'FY',
});
const raw = {
  cik: 123456,
  entityName: 'Development-only test issuer',
  facts: {
    'us-gaap': {
      Assets: { units: { USD: [fact(1000)] } },
      CommonStockholdersEquity: { units: { USD: [fact(750)] } },
      CommonStockSharesOutstanding: { units: { shares: [fact(100)] } },
      EarningsPerShareBasic: { units: { 'USD/shares': [{ ...fact(5), start: '2025-01-01' }] } },
    },
  },
};
function setup(companies = [candidate], options: { cooling?: boolean; locked?: boolean } = {}) {
  const inserts: unknown[][] = [];
  const repository = {
    findOneBy: jest.fn(async () =>
      options.cooling ? { metadataJson: { retryAt: '2026-09-07T10:10:00.000Z' } } : null,
    ),
    upsert: jest.fn(async () => undefined),
  };
  const runner = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.startsWith('SELECT GET_LOCK'))
        return [{ acquired: options.locked === false ? 0 : 1 }];
      if (sql.startsWith('SELECT c.id,c.cik')) return companies;
      if (sql.startsWith('INSERT INTO company_information_snapshots')) inserts.push(parameters);
      return [];
    }),
  };
  const source = { getRepository: () => repository, createQueryRunner: jest.fn(() => runner) };
  const fetcher = jest.fn<ReturnType<FetchImplementation>, Parameters<FetchImplementation>>(
    async () =>
      Response.json(raw, { headers: { 'last-modified': 'Mon, 07 Sep 2026 09:00:00 GMT' } }),
  );
  const service = new SecCompanyInformationService(
    source as unknown as DataSource,
    config,
    fetcher,
  );
  return { source, repository, runner, fetcher, service, inserts };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('fetches only through the injected SEC transport and persists source facts, field provenance and original payload', async () => {
  const { service, fetcher, inserts, runner } = setup();
  await service.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    'https://data.sec.gov/api/xbrl/companyfacts/CIK0000123456.json',
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': config.secUserAgent },
      signal: expect.any(AbortSignal),
    }),
  );
  expect(inserts).toHaveLength(1);
  expect(inserts[0]?.slice(1, 9)).toEqual([
    candidate.id,
    'SEC',
    2025,
    '10-K',
    '2025-12-31',
    NOW,
    'https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/0000123456-26-000001-index.html',
    'OFFICIAL_PUBLIC_DATA',
  ]);
  const fields = JSON.parse(String(inserts[0]?.[9])) as Array<{
    key: string;
    value: string | null;
  }>;
  expect(fields.find((field) => field.key === 'eps')?.value).toBe('5');
  expect(fields.find((field) => field.key === 'bps')?.value).toBe('7.5');
  expect(JSON.parse(String(inserts[0]?.[10]))).toMatchObject({
    companyFacts: raw,
    observedAt: NOW.toISOString(),
    perShareEligibility: { eligible: true },
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  const selection = runner.query.mock.calls.find(([sql]) =>
    sql.startsWith('SELECT c.id,c.cik'),
  )?.[0];
  expect(selection).toContain("request.connector='COMPANY_INFORMATION'");
  expect(selection).toContain('watchlist_group_items i WHERE i.company_id=c.id');
  expect(selection).toContain('INTERVAL 7 DAY');
  expect(selection).toContain('INTERVAL 1 DAY');
  expect(selection).toContain('LIMIT 4');
  expect(runner.release).toHaveBeenCalledTimes(1);
  await service.onApplicationShutdown();
});

it.each([
  { ...candidate, listedClasses: 2 },
  {
    ...candidate,
    stockMetadata: { rawPayload: { isCommonShare: false, securityType: 'ADR', currency: 'USD' } },
  },
])(
  'retains company-wide facts but withholds EPS and BPS when the price share class cannot be verified',
  async (company) => {
    const { service, inserts } = setup([company]);
    await service.refresh();
    const fields = JSON.parse(String(inserts[0]?.[9])) as Array<{
      key: string;
      value: string | null;
    }>;
    expect(fields.find((field) => field.key === 'assets')?.value).toBe('1000');
    expect(fields.find((field) => field.key === 'eps')?.value).toBeNull();
    expect(fields.find((field) => field.key === 'bps')?.value).toBeNull();
  },
);

it('disables collection without a SEC identity and does not fetch or create a lock during a persisted cooldown', async () => {
  const { source, fetcher, service } = setup([candidate], { cooling: true });
  await service.refresh();
  expect(fetcher).not.toHaveBeenCalled();
  expect(source.createQueryRunner).not.toHaveBeenCalled();
  const disabled = new SecCompanyInformationService(
    source as unknown as DataSource,
    { ...config, secUserAgent: null },
    fetcher,
  );
  disabled.onApplicationBootstrap();
  await disabled.refresh();
  await disabled.onApplicationShutdown();
  expect(source.createQueryRunner).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('stops at the first shared SEC denial and preserves an explicit wait state without inventing a snapshot', async () => {
  const { service, fetcher, inserts, repository, runner } = setup([
    candidate,
    { ...candidate, id: 'other-company' },
  ]);
  fetcher.mockRejectedValue(
    new SecAccessCooldownError(new Date('2026-09-07T10:10:00Z'), 403, true),
  );
  await service.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(inserts).toEqual([]);
  expect(repository.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      connector: 'SEC_COMPANY_INFORMATION_FAILURE',
      stream: candidate.id,
      metadataJson: expect.objectContaining({
        state: 'ACCESS_WAITING',
        providerStatus: 403,
        nextAttemptAfterHours: 24,
      }),
    }),
    ['connector', 'stream'],
  );
  expect(runner.query).toHaveBeenCalledWith("SELECT RELEASE_LOCK('orsem-sec-company-information')");
  expect(runner.release).toHaveBeenCalledTimes(1);
});

it('rejects malformed or mismatched source data and oversized responses without overwriting prior data', async () => {
  for (const response of [
    Response.json({ ...raw, cik: 42 }),
    new Response('{}', { headers: { 'content-length': String(21 * 1024 * 1024) } }),
  ]) {
    const { service, fetcher, inserts, repository } = setup();
    fetcher.mockResolvedValue(response);
    await service.refresh();
    expect(inserts).toEqual([]);
    expect(repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataJson: expect.objectContaining({
          state: 'RETRY_PENDING',
          nextAttemptAfterHours: 24,
        }),
      }),
      ['connector', 'stream'],
    );
  }
});

it('uses a single in-flight run and aborts the pending transport before releasing the lock on shutdown', async () => {
  const { service, fetcher, runner, inserts, repository } = setup();
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  fetcher.mockImplementation(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
        started();
      }),
  );
  const flight = service.refresh();
  expect(service.refresh()).toBe(flight);
  await startedPromise;
  await service.onApplicationShutdown();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(inserts).toEqual([]);
  expect(repository.upsert).not.toHaveBeenCalled();
  expect(runner.release).toHaveBeenCalledTimes(1);
  await service.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not request data when another worker owns the collection lock', async () => {
  const { service, fetcher, runner } = setup([candidate], { locked: false });
  await service.refresh();
  expect(fetcher).not.toHaveBeenCalled();
  expect(runner.release).toHaveBeenCalledTimes(1);
  expect(runner.query).not.toHaveBeenCalledWith(
    "SELECT RELEASE_LOCK('orsem-sec-company-information')",
  );
});
