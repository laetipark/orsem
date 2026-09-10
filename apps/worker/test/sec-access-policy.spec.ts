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

function independentHandle(dataSource: DataSource): DataSource {
  return {
    getRepository: dataSource.getRepository.bind(dataSource),
    transaction: dataSource.transaction.bind(dataSource),
  } as unknown as DataSource;
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
  expect(db.row()?.metadataJson?.consecutiveFailures).toBe(0);
  expect(db.row()?.metadataJson?.recoveryOwner).toBeNull();
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

it('spaces all SEC transports through the same one-second start gate', async () => {
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
  await jest.advanceTimersByTimeAsync(999);
  expect(starts).toEqual([NOW]);
  await jest.advanceTimersByTimeAsync(1);
  await second;
  expect(starts).toEqual([NOW, NOW + 1000]);
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
  const other = independentHandle(db.dataSource);
  const starts: number[] = [];
  const fetcher = async () => {
    starts.push(Date.now());
    return new Response('{}');
  };
  const first = createSecFetch(db.dataSource, fetcher)(URL);
  const second = createSecFetch(other, fetcher)(URL);
  await jest.advanceTimersByTimeAsync(1000);
  await Promise.all([first, second]);
  expect(starts).toEqual([NOW, NOW + 1000]);
});

it('allows only one recovery request across workers while its response is pending', async () => {
  const db = database();
  await expect(
    createSecFetch(db.dataSource, async () => new Response('', { status: 403 }))(URL),
  ).rejects.toBeInstanceOf(SecAccessCooldownError);
  jest.setSystemTime(NOW + 600_000);
  let respond!: (response: Response) => void;
  const recovery = createSecFetch(
    independentHandle(db.dataSource),
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  )(URL);
  await jest.advanceTimersByTimeAsync(0);
  const fetcher = jest.fn(async () => new Response('{}'));
  const competing = createSecFetch(
    independentHandle(db.dataSource),
    fetcher,
  )('https://www.sec.gov/files/company_tickers_exchange.json').catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(1000);
  const result = await competing;
  respond(new Response('{}'));
  await expect(recovery).resolves.toMatchObject({ status: 200 });
  expect(result).toMatchObject({ requestAttempted: false });
  expect(fetcher).not.toHaveBeenCalled();
});

it('recovers an expired lease left by a crashed worker without altering its denial history', async () => {
  const db = database();
  await db.repository.save(
    Object.assign(new SourceCheckpointEntity(), {
      metadataJson: {
        consecutiveFailures: 2,
        lastFailureId: 'existing-denial',
        retryAt: new Date(NOW - 1).toISOString(),
        providerStatus: 403,
        recoveryOwner: 'crashed-worker',
        recoveryExpiresAt: new Date(NOW + 5000).toISOString(),
      },
    }),
  );
  const fetcher = jest.fn(async () => new Response(null, { status: 404 }));
  const wrapped = createSecFetch(independentHandle(db.dataSource), fetcher);
  await expect(wrapped(URL)).rejects.toMatchObject({
    requestAttempted: false,
    retryAt: new Date(NOW + 5000),
  });
  expect(fetcher).not.toHaveBeenCalled();
  jest.setSystemTime(NOW + 5000);
  await expect(wrapped(URL)).resolves.toMatchObject({ status: 404 });
  expect(db.row()?.metadataJson).toMatchObject({
    consecutiveFailures: 2,
    lastFailureId: 'existing-denial',
    retryAt: new Date(NOW - 1).toISOString(),
    recoveryOwner: null,
    recoveryExpiresAt: null,
  });
});

it('aborts a stalled recovery at lease expiry and admits a later recovery', async () => {
  const db = database();
  await expect(
    createSecFetch(db.dataSource, async () => new Response('', { status: 429 }))(URL),
  ).rejects.toBeInstanceOf(SecAccessCooldownError);
  jest.setSystemTime(NOW + 600_000);
  let requestSignal: AbortSignal | null | undefined;
  const stalled = createSecFetch(independentHandle(db.dataSource), async (_input, init) => {
    requestSignal = init?.signal;
    return await new Promise<Response>(() => undefined);
  })(URL).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(29_999);
  expect(requestSignal?.aborted).toBe(false);
  expect(db.row()?.metadataJson?.recoveryOwner).toEqual(expect.any(String));
  await jest.advanceTimersByTimeAsync(1);
  expect(await stalled).toMatchObject({ name: 'TimeoutError' });
  expect(requestSignal?.aborted).toBe(true);
  expect(db.row()?.metadataJson).toMatchObject({ consecutiveFailures: 1, recoveryOwner: null });
  await expect(
    createSecFetch(independentHandle(db.dataSource), async () => new Response('{}'))(URL),
  ).resolves.toMatchObject({ status: 200 });
  expect(db.row()?.metadataJson?.consecutiveFailures).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

it('keeps caller cancellation and never releases a replacement worker lease', async () => {
  const db = database();
  await expect(
    createSecFetch(db.dataSource, async () => new Response('', { status: 403 }))(URL),
  ).rejects.toBeInstanceOf(SecAccessCooldownError);
  jest.setSystemTime(NOW + 600_000);
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const recovery = createSecFetch(independentHandle(db.dataSource), async (_input, init) => {
    requestSignal = init?.signal;
    return await new Promise<Response>(() => undefined);
  })(URL, { signal: caller.signal }).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(0);
  // A later lease may have been acquired by another process after a scheduling stall.
  const row = db.row()!;
  row.metadataJson = { ...row.metadataJson, recoveryOwner: 'replacement-worker' };
  const saved = { ...row.metadataJson };
  const reason = new DOMException('Cancelled by caller', 'AbortError');
  caller.abort(reason);
  expect(await recovery).toBe(reason);
  expect(requestSignal?.aborted).toBe(true);
  expect(db.row()?.metadataJson).toEqual(saved);
  expect(jest.getTimerCount()).toBe(0);
});

it.each([false, true])(
  'does not reset a newer denial observed while recovery success was in flight: %s',
  async (sameCount) => {
    const db = database();
    await expect(
      createSecFetch(db.dataSource, async () => new Response('', { status: 403 }))(URL),
    ).rejects.toBeInstanceOf(SecAccessCooldownError);
    jest.setSystemTime(NOW + 600_000);
    let succeed!: (response: Response) => void;
    const recovery = createSecFetch(
      independentHandle(db.dataSource),
      () =>
        new Promise<Response>((resolve) => {
          succeed = resolve;
        }),
    )(URL);
    await jest.advanceTimersByTimeAsync(0);
    // Model a denial written by an older already-dispatched client, including the ABA count case.
    const row = db.row()!;
    row.metadataJson = {
      ...row.metadataJson,
      consecutiveFailures: sameCount ? 1 : 2,
      lastFailureId: 'newer-denial',
      retryAt: new Date(Date.now() + 1_200_000).toISOString(),
      providerStatus: 429,
    };
    succeed(new Response('{}'));
    await expect(recovery).resolves.toMatchObject({ status: 200 });
    expect(db.row()?.metadataJson).toMatchObject({
      consecutiveFailures: sameCount ? 1 : 2,
      lastFailureId: 'newer-denial',
      retryAt: new Date(Date.now() + 1_200_000).toISOString(),
      providerStatus: 429,
      recoveryOwner: null,
    });
  },
);

it('persists progressive denial backoff across worker restarts and caps it at six hours', async () => {
  const db = database();
  const fetcher = jest.fn(async () => new Response('', { status: 429 }));
  const minutes = [10, 20, 40, 80, 160, 320, 360, 360];
  let now = NOW;
  for (const [index, duration] of minutes.entries()) {
    const wrapped = createSecFetch(independentHandle(db.dataSource), fetcher);
    const retryAt = new Date(now + duration * 60_000);
    await expect(wrapped(URL)).rejects.toMatchObject({ retryAt, requestAttempted: true });
    expect(db.row()?.metadataJson).toMatchObject({
      consecutiveFailures: index + 1,
      lastFailureAt: new Date(now).toISOString(),
      retryAt: retryAt.toISOString(),
    });
    await expect(wrapped(URL)).rejects.toMatchObject({ retryAt, requestAttempted: false });
    expect(db.row()?.metadataJson?.consecutiveFailures).toBe(index + 1);
    now = retryAt.getTime();
    jest.setSystemTime(now);
  }
  expect(fetcher).toHaveBeenCalledTimes(minutes.length);
});

it('preserves a legacy cooldown and counts its denial when the next request is rejected', async () => {
  const db = database();
  const legacyRetryAt = new Date(NOW + 1_800_000).toISOString();
  await db.repository.save(
    Object.assign(new SourceCheckpointEntity(), {
      connector: 'SEC',
      stream: 'ACCESS_COOLDOWN',
      metadataJson: {
        retryAt: legacyRetryAt,
        providerStatus: 403,
        providerCode: 'SEC_UNDECLARED_AUTOMATION',
      },
    }),
  );
  const fetcher = jest.fn(async () => new Response('', { status: 429 }));
  const wrapped = createSecFetch(db.dataSource, fetcher);
  await expect(wrapped(URL)).rejects.toMatchObject({
    retryAt: new Date(legacyRetryAt),
    providerCode: 'SEC_UNDECLARED_AUTOMATION',
    requestAttempted: false,
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(db.row()?.metadataJson?.retryAt).toBe(legacyRetryAt);
  jest.setSystemTime(NOW + 1_800_000);
  await expect(wrapped(URL)).rejects.toMatchObject({
    retryAt: new Date(NOW + 1_800_000 + 1_200_000),
    requestAttempted: true,
  });
  expect(db.row()?.metadataJson?.consecutiveFailures).toBe(2);
});

it('honors Retry-After beyond the six-hour automatic backoff cap', async () => {
  const db = database();
  await db.repository.save(
    Object.assign(new SourceCheckpointEntity(), {
      metadataJson: {
        consecutiveFailures: 6,
        retryAt: new Date(NOW - 1).toISOString(),
        providerStatus: 429,
      },
    }),
  );
  await expect(
    createSecFetch(
      db.dataSource,
      async () => new Response('', { status: 429, headers: { 'Retry-After': '28800' } }),
    )(URL),
  ).rejects.toMatchObject({ retryAt: new Date(NOW + 8 * 60 * 60_000) });
  expect(db.row()?.metadataJson?.consecutiveFailures).toBe(7);
});

it('resets consecutive denials only on a successful SEC response and retains cooldown history', async () => {
  const db = database();
  const fetcher = jest.fn(async () => new Response('', { status: 403 }));
  const wrapped = createSecFetch(db.dataSource, fetcher);
  await expect(wrapped(URL)).rejects.toBeInstanceOf(SecAccessCooldownError);
  const priorRetryAt = db.row()?.metadataJson?.retryAt;
  jest.setSystemTime(NOW + 600_000);
  for (const status of [304, 404, 500]) {
    fetcher.mockImplementation(async () => new Response(null, { status }));
    await expect(wrapped(URL)).resolves.toMatchObject({ status });
    expect(db.row()?.metadataJson?.consecutiveFailures).toBe(1);
    jest.setSystemTime(Date.now() + 1000);
  }
  const timeout = new DOMException('timed out', 'TimeoutError');
  fetcher.mockRejectedValueOnce(timeout);
  await expect(wrapped(URL)).rejects.toBe(timeout);
  expect(db.row()?.metadataJson?.consecutiveFailures).toBe(1);
  jest.setSystemTime(Date.now() + 1000);
  fetcher.mockImplementation(async () => new Response(null, { status: 204 }));
  await expect(wrapped('https://example.com')).resolves.toMatchObject({ status: 204 });
  expect(db.row()?.metadataJson?.consecutiveFailures).toBe(1);
  await expect(wrapped(URL)).resolves.toMatchObject({ status: 204 });
  expect(db.row()?.metadataJson).toMatchObject({
    consecutiveFailures: 0,
    retryAt: priorRetryAt,
    lastSuccessAt: new Date().toISOString(),
  });
  jest.setSystemTime(Date.now() + 1000);
  fetcher.mockImplementation(async () => new Response('', { status: 403 }));
  await expect(
    createSecFetch(independentHandle(db.dataSource), fetcher)(URL),
  ).rejects.toMatchObject({
    retryAt: new Date(Date.now() + 600_000),
  });
  expect(db.row()?.metadataJson?.consecutiveFailures).toBe(1);
});

it.each([false, true])(
  'discards a recovery success arriving after lease expiry and a newer denial: %s',
  async (resetBeforeDenial) => {
    const db = database();
    await expect(
      createSecFetch(db.dataSource, async () => new Response('', { status: 403 }))(URL),
    ).rejects.toBeInstanceOf(SecAccessCooldownError);
    jest.setSystemTime(NOW + 600_000);
    let succeed!: (response: Response) => void;
    const slowSuccess = createSecFetch(
      independentHandle(db.dataSource),
      () =>
        new Promise<Response>((resolve) => {
          succeed = resolve;
        }),
    )(URL).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await slowSuccess).toMatchObject({ name: 'TimeoutError' });
    if (resetBeforeDenial) {
      const fastSuccess = createSecFetch(
        independentHandle(db.dataSource),
        async () => new Response('{}'),
      )(URL);
      await jest.advanceTimersByTimeAsync(1000);
      await fastSuccess;
      expect(db.row()?.metadataJson?.consecutiveFailures).toBe(0);
    }
    const denialAt = Date.now();
    const denial = createSecFetch(
      independentHandle(db.dataSource),
      async () => new Response('', { status: 429 }),
    )(URL).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await denial).toMatchObject({
      retryAt: new Date(denialAt + (resetBeforeDenial ? 600_000 : 1_200_000)),
    });
    const saved = { ...db.row()?.metadataJson };
    const lateResponse = new Response('{}');
    const cancel = jest.spyOn(lateResponse.body!, 'cancel');
    succeed(lateResponse);
    await jest.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(db.row()?.metadataJson).toEqual(saved);
    expect(db.row()?.metadataJson?.consecutiveFailures).toBe(resetBeforeDenial ? 1 : 2);
  },
);

it.each([
  ['20', 600_000, 1_200_000],
  ['7200', 7_200_000, 7_200_000],
])(
  'atomically increments overlapping denials without shortening an existing Retry-After of %s seconds',
  async (retryAfter, firstDuration, finalDuration) => {
    const db = database();
    let rejectFirst!: (response: Response) => void;
    const first = createSecFetch(
      db.dataSource,
      () =>
        new Promise<Response>((resolve) => {
          rejectFirst = resolve;
        }),
    )(URL).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    const second = createSecFetch(
      independentHandle(db.dataSource),
      async () => new Response('', { status: 429, headers: { 'Retry-After': retryAfter } }),
    )(URL).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await second).toMatchObject({ retryAt: new Date(NOW + 1000 + firstDuration) });
    rejectFirst(new Response('', { status: 403 }));
    await expect(first).resolves.toMatchObject({ retryAt: new Date(NOW + 1000 + finalDuration) });
    expect(db.row()?.metadataJson).toMatchObject({
      consecutiveFailures: 2,
      retryAt: new Date(NOW + 1000 + finalDuration).toISOString(),
    });
  },
);

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
