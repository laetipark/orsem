import { ConnectorStatus, GDELT_METADATA_POLICY } from '@orsem/contracts';
import {
  SecSubmissionsConnector,
  GdeltMetadataConnector,
  type DiscoveryCandidate,
} from '../src/connectors/connector-adapters';
import {
  recoverGdeltWindows,
  DEFAULT_GDELT_RECOVERY,
} from '../src/connectors/gdelt-window-recovery';
import {
  type DiscoveryBatch,
  type RecoveryStore,
  type RecoveryState,
} from '../src/connectors/discovery-recovery';
import {
  AlpacaNewsConnector,
  type AlpacaNewsApproval,
} from '../src/connectors/alpaca-news.connector';

function memoryStore() {
  const states = new Map<string, RecoveryState>();
  const store: RecoveryStore = {
    async load(connector, stream) {
      return states.get(`${connector}:${stream}`) ?? { revision: 0, metadata: {} };
    },
    async commit(connector, stream, expected, metadata) {
      const key = `${connector}:${stream}`;
      if ((states.get(key)?.revision ?? 0) !== expected) throw new Error('conflict');
      states.set(key, { revision: expected + 1, metadata: structuredClone(metadata) });
    },
  };
  return { store, states };
}
async function consume(
  batches: AsyncIterable<DiscoveryBatch>,
  store: RecoveryStore,
  connector: 'SEC' | 'GDELT' | 'ALPACA_NEWS',
  persist: (batch: DiscoveryBatch) => Promise<void> = async () => {},
) {
  const result: DiscoveryBatch[] = [];
  for await (const batch of batches) {
    await persist(batch);
    if (batch.checkpoint)
      await store.commit(
        connector,
        batch.checkpoint.stream,
        batch.checkpoint.expected,
        batch.checkpoint.metadata,
      );
    result.push(batch);
  }
  return result;
}
const cik = '0000000123';
const scope = {
  companies: [
    { cik, ticker: 'TEST', stockCode: null, nameEn: 'Synthetic Company', nameKo: '시험기업' },
  ],
};
const rows = (start: number, count: number) => ({
  accessionNumber: Array.from(
    { length: count },
    (_, i) => `0000000123-26-${String(start + i).padStart(6, '0')}`,
  ),
  filingDate: Array(count).fill('2026-09-05'),
  form: Array(count).fill('4'),
  primaryDocument: Array(count).fill('ownership.xml'),
});
function secFetcher() {
  return jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.endsWith('-001.json')
      ? rows(200, 40)
      : url.endsWith('-002.json')
        ? rows(400, 3)
        : {
            cik: 123,
            name: 'Synthetic Company',
            filings: {
              recent: rows(1, 45),
              files: [
                { name: `CIK${cik}-submissions-001.json` },
                { name: `CIK${cik}-submissions-002.json` },
              ],
            },
          };
    return new Response(JSON.stringify(body));
  });
}
it('SEC retains more than twenty rows and resumes an incomplete initial baseline silently after restart', async () => {
  const { store, states } = memoryStore();
  const fetcher = secFetcher();
  const first = new SecSubmissionsConnector('Orsem test@example.com', fetcher, 1000);
  const batches = await consume(first.discoverBatches(scope, store, 2), store, 'SEC');
  expect(batches.map((b) => b.candidates.length)).toEqual([45, 40]);
  expect(batches.every((b) => b.suppressAlerts)).toBe(true);
  expect(first.discoveryWasTruncated).toBe(true);
  const restarted = new SecSubmissionsConnector('Orsem test@example.com', fetcher, 1000);
  const continued = await consume(restarted.discoverBatches(scope, store, 2), store, 'SEC');
  expect(continued.map((b) => b.candidates.length)).toEqual([45, 3]);
  expect([...states.values()][0]?.metadata).toMatchObject({
    baselineComplete: true,
    incomplete: false,
    pendingFiles: [],
  });
  const poll = await consume(
    new SecSubmissionsConnector('Orsem test@example.com', fetcher, 1000).discoverBatches(
      scope,
      store,
    ),
    store,
    'SEC',
  );
  expect(poll).toHaveLength(1);
  expect(poll[0]?.suppressAlerts).toBe(false);
});
it('SEC does not advance after persistence failure and replays the same accession batch', async () => {
  const { store, states } = memoryStore();
  const fetcher = secFetcher();
  await expect(
    consume(
      new SecSubmissionsConnector('Orsem test@example.com', fetcher, 1000).discoverBatches(
        scope,
        store,
      ),
      store,
      'SEC',
      async () => {
        throw new Error('DB failure');
      },
    ),
  ).rejects.toThrow('DB failure');
  expect(states.size).toBe(0);
  const replay = await consume(
    new SecSubmissionsConnector('Orsem test@example.com', fetcher, 1000).discoverBatches(
      scope,
      store,
      2,
    ),
    store,
    'SEC',
  );
  expect(replay[0]?.candidates).toHaveLength(45);
});
it('SEC detects rollover beyond the saved accession and reads history even after a completed baseline', async () => {
  const { store, states } = memoryStore();
  states.set(`SEC:SUBMISSIONS:CIK:${cik}`, {
    revision: 2,
    metadata: { baselineComplete: true, newestKnownAccession: '0000000123-26-999999' },
  });
  const batches = await consume(
    new SecSubmissionsConnector('Orsem test@example.com', secFetcher(), 1000).discoverBatches(
      scope,
      store,
    ),
    store,
    'SEC',
  );
  expect(batches).toHaveLength(3);
  expect(batches[0]?.suppressAlerts).toBe(false);
  expect(batches[1]?.suppressAlerts).toBe(true);
});
it('SEC rejects mismatched columns and unsafe history filenames before committing', async () => {
  const { store } = memoryStore();
  const connector = new SecSubmissionsConnector(
    'Orsem test@example.com',
    async () =>
      new Response(
        JSON.stringify({
          cik: 123,
          name: 'Test',
          filings: { recent: { ...rows(1, 2), form: [] } },
        }),
      ),
    1000,
  );
  await expect(consume(connector.discoverBatches(scope, store), store, 'SEC')).rejects.toThrow();
});
const candidate: DiscoveryCandidate = {
  connector: 'GDELT',
  externalId: 'x',
  title: 'Synthetic',
  url: 'https://publisher.example/a',
  publishedAt: null,
  sourceName: 'publisher.example',
  tickers: [],
  tags: [],
  rightsMode: 'STORE_METADATA_ONLY',
  metadata: { observedBySourceAt: '2026-09-05T00:00:00Z' },
};
const now = new Date('2026-09-06T00:00:00Z');
it('GDELT splits exactly 250 results and commits left/right windows only after item persistence', async () => {
  const { store, states } = memoryStore();
  const search = jest
    .fn()
    .mockResolvedValueOnce(Array(250).fill(candidate))
    .mockResolvedValueOnce([candidate])
    .mockResolvedValueOnce([]);
  const batches = await consume(
    recoverGdeltWindows(['query'], store, search, DEFAULT_GDELT_RECOVERY, now),
    store,
    'GDELT',
  );
  expect(search).toHaveBeenCalledTimes(3);
  expect(batches).toHaveLength(3);
  expect([...states.values()][0]?.metadata).toMatchObject({
    cursor: now.toISOString(),
    incomplete: false,
    pendingWindows: [],
  });
  expect(search.mock.calls[1]?.[1].end).toBe(search.mock.calls[2]?.[1].start);
});
it('GDELT preserves a completed leaf on a later 429, then resumes pending windows', async () => {
  const { store, states } = memoryStore();
  const search = jest
    .fn()
    .mockResolvedValueOnce(Array(250).fill(candidate))
    .mockResolvedValueOnce([candidate])
    .mockRejectedValueOnce(new Error('429'));
  await expect(
    consume(recoverGdeltWindows(['q'], store, search, DEFAULT_GDELT_RECOVERY, now), store, 'GDELT'),
  ).rejects.toThrow('429');
  expect([...states.values()][0]?.metadata.pendingWindows).toHaveLength(1);
  const next = jest.fn().mockResolvedValue([]);
  await consume(
    recoverGdeltWindows(['q'], store, next, DEFAULT_GDELT_RECOVERY, now),
    store,
    'GDELT',
  );
  expect(next).toHaveBeenCalledTimes(1);
  expect([...states.values()][0]?.metadata.incomplete).toBe(false);
});
it('GDELT caps split/request work, retains pending cursor, and uses overlap for late observations', async () => {
  const { store, states } = memoryStore();
  const search = jest.fn().mockResolvedValue(Array(250).fill(candidate));
  await consume(
    recoverGdeltWindows(['q'], store, search, { ...DEFAULT_GDELT_RECOVERY, maxRequests: 1 }, now),
    store,
    'GDELT',
  );
  expect([...states.values()][0]?.metadata).toMatchObject({
    incomplete: true,
    coverageError: 'REQUEST_BUDGET',
  });
  const { store: clean, states: cleanStates } = memoryStore();
  await consume(
    recoverGdeltWindows(['q'], clean, async () => [], DEFAULT_GDELT_RECOVERY, now),
    clean,
    'GDELT',
  );
  const overlap = jest.fn().mockResolvedValue([]);
  await consume(
    recoverGdeltWindows(
      ['q'],
      clean,
      overlap,
      DEFAULT_GDELT_RECOVERY,
      new Date(now.getTime() + 30 * 60000),
    ),
    clean,
    'GDELT',
  );
  expect(overlap.mock.calls[0]?.[1].start).toBe('2026-09-05T23:50:00.000Z');
  expect([...cleanStates.values()][0]?.metadata.incomplete).toBe(false);
});
it('GDELT saturated minimum/depth never claims complete coverage or advances its cursor', async () => {
  const { store, states } = memoryStore();
  await consume(
    recoverGdeltWindows(
      ['q'],
      store,
      async () => Array(250).fill(candidate),
      { ...DEFAULT_GDELT_RECOVERY, maxDepth: 0 },
      now,
    ),
    store,
    'GDELT',
  );
  expect([...states.values()][0]?.metadata).toMatchObject({
    incomplete: true,
    truncated: true,
    cursor: null,
  });
});
it('GDELT blocks absent/unapproved publishers even when enabled', async () => {
  const fetcher = jest.fn();
  const connector = new GdeltMetadataConnector(true, fetcher, 1000, ['publisher.example']);
  expect(connector.health().status).toBe(ConnectorStatus.UNCONFIGURED);
  expect(connector.health().metadata?.configurationState).toBe('POLICY_NOT_APPROVED');
  expect(await connector.discoverLinks(scope)).toEqual([]);
  expect(await connector.search('anything')).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});
it('GDELT explicit windows keep observation time separate and reject unapproved returned hosts', async () => {
  const fetcher = jest.fn(async (input: string | URL | Request) => {
    expect(String(input)).toContain('api.gdeltproject.org');
    return new Response(
      JSON.stringify({
        articles: [
          {
            title: 'A',
            url: 'https://publisher.example/a',
            language: 'English',
            seendate: '20260905T010203Z',
          },
          { title: 'B', url: 'https://evil.example/b', language: 'English' },
        ],
      }),
    );
  });
  const connector = new GdeltMetadataConnector(true, fetcher, 1000, ['publisher.example'], {
    'publisher.example': GDELT_METADATA_POLICY,
  });
  const { store } = memoryStore();
  const result = await consume(connector.discoverBatches({ companies: [] }, store), store, 'GDELT');
  expect(result.at(-1)?.candidates).toHaveLength(1);
  expect(result.at(-1)?.candidates[0]).toMatchObject({
    publishedAt: null,
    metadata: { observedBySourceAt: '2026-09-05T01:02:03.000Z' },
  });
  const url = new URL(String(fetcher.mock.calls[0]?.[0]));
  expect(url.searchParams.has('timespan')).toBe(false);
  expect(url.searchParams.get('startdatetime')).toMatch(/^\d{14}$/);
});
const approval: AlpacaNewsApproval = {
  entitlementConfirmed: true,
  freeAccessVerifiedUntil: '2099-01-01T00:00:00Z',
  publisherPolicies: { synthetic: { domain: 'publisher.example', policy: GDELT_METADATA_POLICY } },
};
const alpacaArticle = {
  id: 42,
  headline: 'Synthetic company news',
  url: 'https://publisher.example/a',
  source: 'synthetic',
  created_at: '2026-09-05T00:00:00Z',
  updated_at: '2026-09-05T01:00:00Z',
  symbols: ['TEST'],
  content: 'must never persist',
  summary: 'also discarded',
};
it('Alpaca is inert with missing keys or unverified entitlement/publisher rights', async () => {
  const fetcher = jest.fn();
  const { store } = memoryStore();
  for (const connector of [
    new AlpacaNewsConnector(true, 'key', 'secret', fetcher, 1000),
    new AlpacaNewsConnector(true, null, null, fetcher, 1000, approval),
  ]) {
    expect(connector.health().status).toBe('UNCONFIGURED');
    expect(await consume(connector.discoverBatches(scope, store), store, 'ALPACA_NEWS')).toEqual(
      [],
    );
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('Alpaca paginates with header auth, excludes content, preserves IDs/symbols/timestamps and commits after persistence', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ news: [alpacaArticle], next_page_token: 'page2' })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ news: [], next_page_token: null })));
  const { store, states } = memoryStore();
  const result = await consume(
    new AlpacaNewsConnector(true, 'key', 'secret', fetcher, 1000, approval).discoverBatches(
      scope,
      store,
    ),
    store,
    'ALPACA_NEWS',
  );
  expect(result).toHaveLength(2);
  expect(result[0]?.candidates[0]).toMatchObject({
    externalId: '42',
    tickers: ['TEST'],
    metadata: { providerUpdatedAt: alpacaArticle.updated_at },
  });
  expect(JSON.stringify(result)).not.toContain('must never persist');
  expect(JSON.stringify(result)).not.toContain('also discarded');
  const url = new URL(String(fetcher.mock.calls[1]?.[0]));
  expect(url.searchParams.get('page_token')).toBe('page2');
  expect(url.searchParams.get('include_content')).toBe('false');
  expect(url.searchParams.has('key')).toBe(false);
  expect([...states.values()][0]?.metadata.incomplete).toBe(false);
});
it.each([401, 403, 429])(
  'Alpaca reports HTTP %s without fallback, checkpoint advance, or leaking response bodies',
  async (status) => {
    const { store, states } = memoryStore();
    const connector = new AlpacaNewsConnector(
      true,
      'key',
      'secret',
      async () => new Response('private provider body', { status }),
      1000,
      approval,
    );
    await expect(
      consume(connector.discoverBatches(scope, store), store, 'ALPACA_NEWS'),
    ).rejects.toMatchObject({ httpStatus: status });
    expect([...states.keys()].filter((key) => !key.endsWith('ACCESS_COOLDOWN'))).toHaveLength(0);
  },
);

it('Alpaca checks each publisher proof and URL, permits absent summary, and retains duplicate story identity', async () => {
  const fetcher = jest.fn(async (input: unknown) => {
    expect(new URL(String(input)).searchParams.get('symbols')).toBe('TEST');
    return new Response(
      JSON.stringify({
        news: [
          { ...alpacaArticle, summary: undefined },
          { ...alpacaArticle, source: 'unreviewed' },
          { ...alpacaArticle, url: 'https://other.example/a' },
          { ...alpacaArticle, url: 'https://user:password@publisher.example/a' },
          { ...alpacaArticle, updated_at: '2026-09-05T02:00:00Z' },
        ],
      }),
    );
  });
  const { store } = memoryStore();
  const connector = new AlpacaNewsConnector(true, 'key', 'secret', fetcher, 1000, {
    ...approval,
    publisherPolicies: {
      ...approval.publisherPolicies,
      unreviewed: {
        domain: 'publisher.example',
        policy: { ...GDELT_METADATA_POLICY, checkedAt: '', policyUrl: '' },
      },
    },
  });
  const batches = await consume(connector.discoverBatches(scope, store), store, 'ALPACA_NEWS');
  expect(batches[0]?.candidates.map((item) => item.externalId)).toEqual(['42', '42']);
  expect(batches[0]?.candidates.every((item) => !('summary' in item.metadata))).toBe(true);
  expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('symbols')).toBe('TEST');
});

it('GDELT preserves the initial requested window after first-request failure without claiming successful coverage', async () => {
  const { store, states } = memoryStore();
  await expect(
    consume(
      recoverGdeltWindows(
        ['q'],
        store,
        async () => {
          throw new Error('503');
        },
        DEFAULT_GDELT_RECOVERY,
        now,
      ),
      store,
      'GDELT',
    ),
  ).rejects.toThrow('503');
  expect([...states.values()][0]?.metadata).toMatchObject({
    incomplete: true,
    lastWindowStart: '2026-09-05T00:00:00.000Z',
  });
  expect([...states.values()][0]?.metadata.cursor).toBeUndefined();
  const search = jest.fn().mockResolvedValue([]);
  await consume(
    recoverGdeltWindows(
      ['q'],
      store,
      search,
      DEFAULT_GDELT_RECOVERY,
      new Date(now.getTime() + 3600000),
    ),
    store,
    'GDELT',
  );
  expect(search.mock.calls[0]?.[1].start).toBe('2026-09-05T00:00:00.000Z');
});

it('GDELT refuses a 200 error object as an empty successful window', async () => {
  const { store, states } = memoryStore();
  const connector = new GdeltMetadataConnector(
    true,
    async () => new Response(JSON.stringify({ error: 'temporary service error' })),
    1000,
    ['publisher.example'],
    { 'publisher.example': GDELT_METADATA_POLICY },
  );
  await expect(
    consume(connector.discoverBatches({ companies: [] }, store), store, 'GDELT'),
  ).rejects.toThrow();
  expect([...states.values()][0]?.metadata.incomplete).toBe(true);
  expect([...states.values()][0]?.metadata.cursor).toBeUndefined();
});
