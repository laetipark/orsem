jest.mock('@orsem/contracts', () => {
  const actual = jest.requireActual<typeof import('@orsem/contracts')>('@orsem/contracts');
  return {
    ...actual,
    APPROVED_GDELT_SOURCE_POLICIES: { 'publisher.example': actual.GDELT_METADATA_POLICY },
  };
});
import { Agent, getGlobalDispatcher } from 'undici';
import type { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  createLinkDiscoveryAdapters,
  GdeltMetadataConnector,
  SecSubmissionsConnector,
} from '../src/connectors/connector-adapters';
import { GdeltHttpTransport } from '../src/connectors/gdelt-http-transport';
import { createSecFetch } from '../src/connectors/sec-access-policy';

jest.mock('undici', () => {
  const original = jest.requireActual<typeof import('undici')>('undici');
  return {
    ...original,
    Agent: jest.fn().mockImplementation((options) => new original.Agent(options)),
  };
});

const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc?query=economy&format=json';
const SEC_URL = 'https://data.sec.gov/submissions/CIK0000123456.json';
const initialGlobalDispatcher = getGlobalDispatcher();
let transport: GdeltHttpTransport;
let transportClosed = false;

beforeEach(() => {
  jest.clearAllMocks();
  transport = new GdeltHttpTransport();
  transportClosed = false;
});
afterEach(async () => {
  jest.useRealTimers();
  if (!transportClosed) await transport.onModuleDestroy();
  jest.restoreAllMocks();
});

function mockDeadlineTimers(): void {
  jest.useFakeTimers();
  jest.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), delay);
    return controller.signal;
  });
}

it.each([
  SEC_URL,
  'https://opendart.fss.or.kr/api/list.json',
  'https://naveropenapi.apigw.ntruss.com/news/v1/search',
  'http://127.0.0.1:11434/api/chat',
  'https://api.gdeltproject.org.evil.example/api/v2/doc/doc',
  'http://api.gdeltproject.org/api/v2/doc/doc',
  'https://api.gdeltproject.org:444/api/v2/doc/doc',
  'https://api.gdeltproject.org/other',
])('leaves the existing transport, headers and cancellation unchanged for %s', async (url) => {
  const controller = new AbortController();
  const init = {
    headers: { 'User-Agent': 'Orsem test test@example.com' },
    signal: controller.signal,
  };
  const response = new Response('{}');
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const timeout = jest.spyOn(AbortSignal, 'timeout');

  await expect(transport.fetch(url, init)).resolves.toBe(response);
  expect(fetcher.mock.calls[0]?.[1]).toBe(init);
  expect(timeout).not.toHaveBeenCalled();
});

it('reuses a local 20s connect dispatcher with normal TLS validation and closes it on shutdown', async () => {
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('{}'));
  await transport.fetch(GDELT_URL, { headers: { Accept: 'application/json' }, redirect: 'follow' });
  await transport.fetch(new URL(GDELT_URL));

  expect(jest.mocked(Agent).mock.calls).toEqual([[{ connect: { timeout: 20_000 } }]]);
  expect(jest.mocked(Agent)).toHaveBeenCalledWith({ connect: { timeout: 20_000 } });
  const firstInit = fetcher.mock.calls[0]?.[1] as RequestInit & { dispatcher: Agent };
  const secondInit = fetcher.mock.calls[1]?.[1] as RequestInit & { dispatcher: Agent };
  expect(firstInit).toMatchObject({ redirect: 'error', headers: { Accept: 'application/json' } });
  expect(secondInit.dispatcher).toBe(firstInit.dispatcher);
  expect(getGlobalDispatcher()).toBe(initialGlobalDispatcher);
  const close = jest.spyOn(firstInit.dispatcher, 'close');
  await transport.onModuleDestroy();
  transportClosed = true;
  expect(close).toHaveBeenCalledWith();
  expect(firstInit.dispatcher.closed).toBe(true);
  expect(firstInit.dispatcher.destroyed).toBe(true);
});

it.each(['init', 'request'] as const)(
  'preserves earlier caller cancellation from %s',
  async (kind) => {
    const controller = new AbortController();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending =
      kind === 'init'
        ? transport.fetch(GDELT_URL, { signal: controller.signal })
        : transport.fetch(new Request(GDELT_URL, { signal: controller.signal }));
    const reason = new Error('job cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  },
);

it('allows a slow connection past 10s while the combined request remains bounded at 30s', async () => {
  mockDeadlineTimers();
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  const pending = transport.fetch(GDELT_URL);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  let settled = false;
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  await jest.advanceTimersByTimeAsync(15_000);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(14_999);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await rejected;
  expect(settled).toBe(true);
});

it('bounds a stalled response body as part of the same 30s request', async () => {
  mockDeadlineTimers();
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    return new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      }),
    );
  });
  const response = await transport.fetch(GDELT_URL);
  const rejected = expect(response.json()).rejects.toMatchObject({ name: 'TimeoutError' });
  await jest.advanceTimersByTimeAsync(30_000);
  await rejected;
});

it('gives only the configured GDELT adapter 30s and keeps SEC at the existing 15s', async () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout');
  const fetcher = jest.fn(async () => new Response('{}'));
  const config = loadWorkerConfig({
    GDELT_ENABLED: 'true',
    GDELT_NEWS_DOMAINS: 'publisher.example',
    SEC_USER_AGENT: 'Orsem test test@example.com',
  });
  const adapters = createLinkDiscoveryAdapters(config, fetcher);
  const sec = adapters.find((adapter) => adapter.name === 'SEC') as SecSubmissionsConnector;
  await expect(sec.submissions('0000123456')).rejects.toBeDefined();
  expect(timeout).toHaveBeenLastCalledWith(15_000);
  await adapters.find((adapter) => adapter.name === 'GDELT')!.check();
  expect(timeout).toHaveBeenLastCalledWith(30_000);
});

it('preserves the shared GDELT cooldown across recreated adapters and the SEC DB access policy', async () => {
  const fetcher = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('', { status: 429 }));
  const findOneBy = jest.fn(async () => ({
    metadataJson: { providerStatus: 403, retryAt: new Date(Date.now() + 600_000).toISOString() },
  }));
  const dataSource = { getRepository: () => ({ findOneBy }) } as unknown as DataSource;
  const sharedFetch = createSecFetch(dataSource, transport.fetch);
  const config = loadWorkerConfig({
    GDELT_ENABLED: 'true',
    GDELT_NEWS_DOMAINS: 'publisher.example',
  });
  const first = createLinkDiscoveryAdapters(config, sharedFetch).find(
    (adapter) => adapter.name === 'GDELT',
  ) as GdeltMetadataConnector;
  const second = createLinkDiscoveryAdapters(config, sharedFetch).find(
    (adapter) => adapter.name === 'GDELT',
  ) as GdeltMetadataConnector;

  await expect(first.search('economy')).rejects.toMatchObject({
    httpStatus: 429,
    requestAttempted: true,
  });
  await expect(second.search('economy')).rejects.toMatchObject({
    httpStatus: 429,
    requestAttempted: false,
  });
  expect(findOneBy).not.toHaveBeenCalled();
  await expect(sharedFetch(SEC_URL)).rejects.toMatchObject({
    httpStatus: 403,
    requestAttempted: false,
  });
  expect(findOneBy).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
