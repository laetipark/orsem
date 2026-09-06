import { ConnectorStatus } from '@orsem/contracts';
import { GdeltMetadataConnector } from './gdelt-approved-fixture';

const NOW = new Date('2026-09-04T03:00:00.000Z');

function success(): Response {
  return new Response(JSON.stringify({ articles: [] }), { status: 200 });
}

describe('GDELT request limits', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('distinguishes connection timeouts from rate limits without retrying or leaking errors', async () => {
    const fetcher = jest.fn(async (): Promise<Response> => {
      throw new TypeError('private connection details', {
        cause: Object.assign(new Error('private socket details'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      });
    });
    const health = await new GdeltMetadataConnector(true, fetcher, 15_000).check();
    expect(health).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      metadata: { httpStatus: 0, transportCategory: 'timeout', retryAt: null },
    });
    expect(health.message).toContain('서버 연결/응답 시간이 초과');
    expect(health.message).not.toContain('429');
    expect(JSON.stringify(health)).not.toContain('private');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares Retry-After cooldown across recreated adapters without sleeping or requesting again', async () => {
    const fetcher = jest.fn(
      async () =>
        new Response('private upstream response', {
          status: 429,
          headers: { 'Retry-After': '120' },
        }),
    );
    const adapter = new GdeltMetadataConnector(true, fetcher, 5_000);
    const health = await adapter.check();
    expect(health).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      metadata: { httpStatus: 429, retryAt: '2026-09-04T03:02:00.000Z' },
    });
    expect(health.message).toContain('KST');
    expect(health.message).not.toContain('private upstream response');

    const recreated = new GdeltMetadataConnector(true, fetcher, 5_000);
    await expect(recreated.check()).resolves.toMatchObject({
      metadata: { httpStatus: 429, retryAt: '2026-09-04T03:02:00.000Z' },
    });
    await expect(recreated.search('another company')).rejects.toMatchObject({ httpStatus: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    jest.setSystemTime(new Date('2026-09-04T03:02:00.000Z'));
    fetcher.mockImplementation(async () => success());
    await expect(recreated.check()).resolves.toMatchObject({ status: ConnectorStatus.HEALTHY });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Fri, 04 Sep 2026 03:30:00 GMT', '2026-09-04T03:30:00.000Z'],
    ['not-a-date', '2026-09-04T03:01:00.000Z'],
    ['-10', '2026-09-04T03:01:00.000Z'],
    ['9'.repeat(400), '2026-09-04T03:01:00.000Z'],
    ['Thu, 03 Sep 2026 03:00:00 GMT', '2026-09-04T03:01:00.000Z'],
  ])('uses safe Retry-After parsing for %s', async (header, expectedRetryAt) => {
    const fetcher = async (): Promise<Response> =>
      new Response('', { status: 429, headers: { 'Retry-After': header } });
    const adapter = new GdeltMetadataConnector(true, fetcher, 5_000);
    await expect(adapter.check()).resolves.toMatchObject({
      metadata: { retryAt: expectedRetryAt },
    });
  });

  it('backs off consecutive rate limits to a bounded fallback and resets after recovery', async () => {
    const fetcher = jest.fn(async () => new Response('', { status: 429 }));
    const adapter = new GdeltMetadataConnector(true, fetcher, 5_000);
    for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      const retryAt = new Date(Date.now() + delay);
      await expect(adapter.search('stock market')).rejects.toMatchObject({ retryAt });
      jest.setSystemTime(retryAt);
    }
    fetcher.mockImplementation(async () => success());
    await expect(adapter.search('stock market')).resolves.toEqual([]);

    jest.setSystemTime(Date.now() + 5_000);
    fetcher.mockImplementation(async () => new Response('', { status: 429 }));
    await expect(adapter.search('stock market')).rejects.toMatchObject({
      retryAt: new Date(Date.now() + 60_000),
    });
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it('coalesces probes, caches successful health for ten minutes and keeps the real observation time', async () => {
    const requested: URL[] = [];
    const fetcher = jest.fn(async (input: string | URL | Request): Promise<Response> => {
      requested.push(new URL(input instanceof Request ? input.url : input.toString()));
      return success();
    });
    const adapter = new GdeltMetadataConnector(true, fetcher, 5_000);
    const recreated = new GdeltMetadataConnector(true, fetcher, 5_000);
    const [first, duplicate] = await Promise.all([adapter.check(), recreated.check()]);
    expect(first.status).toBe(ConnectorStatus.HEALTHY);
    expect(duplicate.status).toBe(ConnectorStatus.HEALTHY);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requested[0]?.searchParams.get('timespan')).toBe('1h');
    expect(requested[0]?.searchParams.get('maxrecords')).toBe('1');

    jest.setSystemTime(Date.now() + 9 * 60_000);
    await expect(recreated.check()).resolves.toMatchObject({
      checkedAt: NOW,
      metadata: { cached: true, lastProbeAt: NOW.toISOString() },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + 60_000);
    await expect(recreated.check()).resolves.toMatchObject({
      checkedAt: new Date('2026-09-04T03:10:00.000Z'),
      metadata: { cached: false },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('spaces overlapping searches across adapter instances by at least five seconds', async () => {
    const startedAt: number[] = [];
    const fetcher = jest.fn(async () => {
      startedAt.push(Date.now());
      return success();
    });
    const first = new GdeltMetadataConnector(true, fetcher, 5_000).search('first company');
    const second = new GdeltMetadataConnector(true, fetcher, 5_000).search('second company');
    await first;
    await jest.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await second;
    expect(startedAt[1]! - startedAt[0]!).toBe(5_000);
  });

  it('waits five seconds after a slow first response body before a queued adapter can request', async () => {
    const startedAt: number[] = [];
    const fetcher = jest.fn(async () => {
      startedAt.push(Date.now());
      if (startedAt.length !== 1) return success();
      await new Promise<void>((resolve) => setTimeout(resolve, 8_000));
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('{"articles":[]}'));
              controller.close();
            }, 3_000);
          },
        }),
      );
    });
    const first = new GdeltMetadataConnector(true, fetcher, 30_000).search('first company');
    const second = new GdeltMetadataConnector(true, fetcher, 30_000).search('second company');

    await jest.advanceTimersByTimeAsync(10_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toEqual([]);
    const completedAt = Date.now();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual([]);
    expect(startedAt).toEqual([NOW.getTime(), completedAt + 5_000]);
  });

  it('also spaces a queued request five seconds after a slow transport failure', async () => {
    const startedAt: number[] = [];
    const fetcher = jest.fn(async () => {
      startedAt.push(Date.now());
      if (startedAt.length !== 1) return success();
      await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
      throw new TypeError('fetch failed');
    });
    const first = new GdeltMetadataConnector(true, fetcher, 30_000).search('first company');
    const second = new GdeltMetadataConnector(true, fetcher, 30_000).search('second company');
    const firstFailure = expect(first).rejects.toMatchObject({ httpStatus: 0 });

    await jest.advanceTimersByTimeAsync(11_000);
    await firstFailure;
    const failedAt = Date.now();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual([]);
    expect(startedAt).toEqual([NOW.getTime(), failedAt + 5_000]);
  });

  it('rejects already queued requests once an earlier response starts a cooldown', async () => {
    const fetcher = jest.fn(async () => new Response('', { status: 429 }));
    const adapter = new GdeltMetadataConnector(true, fetcher, 5_000);
    const results = await Promise.allSettled([
      adapter.search('first company'),
      adapter.search('second company'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not mask a later discovery failure with cached healthy probe data', async () => {
    const fetcher = jest.fn(async () => success());
    const adapter = new GdeltMetadataConnector(true, fetcher, 5_000);
    await adapter.check();
    jest.setSystemTime(Date.now() + 5_000);
    fetcher.mockImplementation(async () => new Response('', { status: 429 }));
    await expect(adapter.search('company')).rejects.toMatchObject({ httpStatus: 429 });
    await expect(adapter.check()).resolves.toMatchObject({ status: ConnectorStatus.DEGRADED });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('makes only one attempt for an authentication failure and leaves it distinct from rate limits', async () => {
    const fetcher = jest.fn(async () => new Response('', { status: 401 }));
    const adapter = new GdeltMetadataConnector(true, fetcher, 5_000);
    await expect(adapter.check()).resolves.toMatchObject({
      metadata: { httpStatus: 401, retryAt: null },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
