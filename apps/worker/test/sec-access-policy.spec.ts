import { SourceCheckpointEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import {
  createSecFetch,
  SecAccessCooldownError,
  SecAccessPolicyError,
} from '../src/connectors/sec-access-policy';

const NOW = Date.parse('2026-09-04T15:00:00Z');
const URL = 'https://data.sec.gov/submissions/CIK0000123456.json';
function database() {
  let row: SourceCheckpointEntity | null = null;
  const repository = {
    findOneBy: jest.fn(async () => row),
    findOne: jest.fn(async () => row),
    save: jest.fn(async (value: SourceCheckpointEntity) => {
      row = value;
      return value;
    }),
    createQueryBuilder() {
      let input: Partial<SourceCheckpointEntity>;
      const query = {
        insert: () => query,
        values: (value: Partial<SourceCheckpointEntity>) => {
          input = value;
          return query;
        },
        orIgnore: () => query,
        execute: async () => {
          row ??= Object.assign(new SourceCheckpointEntity(), { metadataJson: null }, input);
        },
      };
      return query;
    },
  };
  let pending: Promise<unknown> = Promise.resolve();
  const dataSource = {
    getRepository: () => repository,
    transaction: <T>(run: (manager: unknown) => Promise<T>) => {
      const current = pending.then(() => run({ getRepository: () => repository }));
      pending = current.catch(() => undefined);
      return current;
    },
  } as unknown as DataSource;
  return { dataSource, repository, row: () => row };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

it('shares a ten-minute SEC 403 cooldown across wrappers and allows a request at expiry', async () => {
  const db = database();
  const fetcher = jest.fn(async () => new Response('provider private body', { status: 403 }));
  const wrapped = createSecFetch(db.dataSource, fetcher);
  await expect(wrapped(URL)).rejects.toMatchObject({
    httpStatus: 403,
    retryAt: new Date(NOW + 600_000),
  });
  expect(db.row()).toMatchObject({
    connector: 'SEC',
    stream: 'ACCESS_COOLDOWN',
    metadataJson: {
      source: 'SEC',
      providerStatus: 403,
      provenanceUrl: URL,
      retryAt: new Date(NOW + 600_000).toISOString(),
    },
  });
  expect(JSON.stringify(db.row())).not.toContain('private body');
  const another = createSecFetch(db.dataSource, fetcher);
  await expect(
    another('https://www.sec.gov/files/company_tickers_exchange.json'),
  ).rejects.toBeInstanceOf(SecAccessCooldownError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  jest.setSystemTime(NOW + 600_000);
  fetcher.mockImplementation(async () => new Response('{}'));
  await expect(another(URL)).resolves.toMatchObject({ status: 200 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(db.repository.save).toHaveBeenCalledTimes(3);
  expect(jest.getTimerCount()).toBe(0);
});

it.each([
  ['1800', 1_800_000],
  ['Fri, 04 Sep 2026 15:40:00 GMT', 2_400_000],
  ['20', 600_000],
  ['-10', 600_000],
  ['not-a-date', 600_000],
  ['9'.repeat(400), 600_000],
])('uses the greater of Retry-After and ten minutes: %s', async (header, duration) => {
  const db = database();
  const wrapped = createSecFetch(
    db.dataSource,
    async () => new Response('', { status: 429, headers: { 'Retry-After': header } }),
  );
  await expect(wrapped(URL)).rejects.toMatchObject({
    providerStatus: 429,
    retryAt: new Date(NOW + duration),
  });
});

it('serializes transports and marks queued requests skipped after the first provider denial', async () => {
  const db = database();
  const fetcher = jest.fn(async () => new Response('', { status: 403 }));
  const calls = [
    createSecFetch(db.dataSource, fetcher)(URL).catch((e: unknown) => e),
    createSecFetch(
      db.dataSource,
      fetcher,
    )('https://www.sec.gov/files/company_tickers_exchange.json').catch((e: unknown) => e),
  ];
  const [observed, skipped] = await Promise.all(calls);
  expect(observed).toMatchObject({ providerStatus: 403, requestAttempted: true });
  expect(skipped).toMatchObject({ providerStatus: 403, requestAttempted: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('spaces all SEC transports through the same 250ms start gate', async () => {
  const db = database();
  const starts: number[] = [];
  const fetcher = jest.fn(async () => {
    starts.push(Date.now());
    return new Response('{}');
  });
  await createSecFetch(db.dataSource, fetcher)(URL);
  const second = createSecFetch(
    db.dataSource,
    fetcher,
  )('https://www.sec.gov/files/company_tickers_exchange.json');
  await jest.advanceTimersByTimeAsync(250);
  await second;
  expect(starts).toEqual([NOW, NOW + 250]);
});

it('passes through other hosts and preserves transport failures without recording provider denial', async () => {
  const db = database();
  const response = new Response('{}');
  const timeout = new DOMException('timed out', 'TimeoutError');
  const fetcher = jest.fn(async () => response);
  const wrapped = createSecFetch(db.dataSource, fetcher);
  const headers = { 'User-Agent': 'Orsem contact@example.com' };
  await expect(wrapped('https://sec.gov.example.com/data', { headers })).resolves.toBe(response);
  expect(db.repository.findOneBy).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenLastCalledWith('https://sec.gov.example.com/data', { headers });
  fetcher.mockRejectedValue(timeout);
  await expect(wrapped(URL, { headers })).rejects.toBe(timeout);
  expect(db.row()?.metadataJson?.retryAt).toBeUndefined();
  expect(db.row()?.metadataJson?.nextRequestAt).toBeDefined();
});

it('fails closed on checkpoint database failures without leaking database details', async () => {
  const db = database();
  const fetcher = jest.fn(async () => new Response('{}'));
  db.repository.findOneBy.mockRejectedValue(new Error('private database credentials'));
  const wrapped = createSecFetch(db.dataSource, fetcher);
  await expect(wrapped(URL)).rejects.toBeInstanceOf(SecAccessPolicyError);
  await expect(wrapped(URL)).rejects.not.toThrow('private');
  expect(fetcher).not.toHaveBeenCalled();
});

it('reserves request slots across independent worker DataSource handles sharing the same database', async () => {
  const db = database();
  const other = {
    getRepository: db.dataSource.getRepository.bind(db.dataSource),
    transaction: db.dataSource.transaction.bind(db.dataSource),
  } as unknown as DataSource;
  const starts: number[] = [];
  const fetcher = async () => {
    starts.push(Date.now());
    return new Response('{}');
  };
  const first = createSecFetch(db.dataSource, fetcher)(URL);
  const second = createSecFetch(other, fetcher)(URL);
  await jest.advanceTimersByTimeAsync(250);
  await Promise.all([first, second]);
  expect(starts).toEqual([NOW, NOW + 250]);
});

it('keeps the SEC error classification across fresh wrappers without storing provider text', async () => {
  const db = database();
  const fetcher = jest.fn(
    async () =>
      new Response(
        '<title>Your Request Originates from an Undeclared Automated Tool</title>private-contact@example.com 192.0.2.1',
        { status: 403 },
      ),
  );
  await expect(createSecFetch(db.dataSource, fetcher)(URL)).rejects.toMatchObject({
    providerCode: 'SEC_UNDECLARED_AUTOMATION',
    requestAttempted: true,
  });
  expect(db.row()?.metadataJson).toMatchObject({
    providerCode: 'SEC_UNDECLARED_AUTOMATION',
  });
  const serialized = JSON.stringify(db.row());
  expect(serialized).not.toContain('private-contact');
  expect(serialized).not.toContain('192.0.2.1');
  expect(serialized).not.toContain('<title>');
  await expect(createSecFetch(db.dataSource, fetcher)(URL)).rejects.toMatchObject({
    providerCode: 'SEC_UNDECLARED_AUTOMATION',
    requestAttempted: false,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('commits the cooldown before reading a stalled diagnostic body and never waits for cancellation', async () => {
  const db = database();
  const cancel = jest.fn(() => new Promise<void>(() => undefined));
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
    status: 403,
  });
  const first = createSecFetch(
    db.dataSource,
    async () => response,
  )(URL).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(0);
  expect(db.row()?.metadataJson?.retryAt).toBe(new Date(NOW + 600_000).toISOString());
  const otherHandle = {
    getRepository: db.dataSource.getRepository.bind(db.dataSource),
    transaction: db.dataSource.transaction.bind(db.dataSource),
  } as unknown as DataSource;
  const fetcher = jest.fn();
  await expect(createSecFetch(otherHandle, fetcher)(URL)).rejects.toMatchObject({
    requestAttempted: false,
  });
  expect(fetcher).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1000);
  expect(await first).toMatchObject({
    httpStatus: 403,
    requestAttempted: true,
    providerCode: null,
  });
  expect(cancel).toHaveBeenCalledTimes(1);
});
