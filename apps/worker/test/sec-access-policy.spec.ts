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
  expect(db.repository.save).toHaveBeenCalledTimes(1);
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

it('does not let shorter concurrent restrictions or an older in-flight 200 clear the shared cooldown', async () => {
  const db = database();
  const resolveResponses: Array<(response: Response) => void> = [];
  const fetcher = jest.fn(() => new Promise<Response>((resolve) => resolveResponses.push(resolve)));
  const long = createSecFetch(db.dataSource, fetcher)(URL).catch((error: unknown) => error);
  const short = createSecFetch(db.dataSource, fetcher)(URL).catch((error: unknown) => error);
  const success = createSecFetch(db.dataSource, fetcher)(URL);
  await Promise.resolve();
  resolveResponses[0]!(new Response('', { status: 429, headers: { 'Retry-After': '3600' } }));
  await long;
  resolveResponses[1]!(new Response('', { status: 403 }));
  expect(await short).toMatchObject({ retryAt: new Date(NOW + 3_600_000) });
  resolveResponses[2]!(new Response('{}'));
  expect((await success).status).toBe(200);
  expect(db.row()?.metadataJson).toMatchObject({
    retryAt: new Date(NOW + 3_600_000).toISOString(),
    providerStatus: 429,
  });
  await expect(createSecFetch(db.dataSource, fetcher)(URL)).rejects.toBeInstanceOf(
    SecAccessCooldownError,
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
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
  expect(db.repository.save).not.toHaveBeenCalled();
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
