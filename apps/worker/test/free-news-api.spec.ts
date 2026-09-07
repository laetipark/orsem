import {
  ConnectorStatus,
  NEWS_EXTERNAL_API_POLICIES,
  NewsSourceKind,
  type NewsSourcePolicy,
} from '@orsem/contracts';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  ConnectorRequestError,
  type DiscoveryCandidate,
  type DiscoveryScope,
} from '../src/connectors/connector-adapters';
import type { RecoveryStore } from '../src/connectors/discovery-recovery';
import {
  AlphaVantageNewsConnector,
  FinnhubNewsConnector,
  FreeNewsApiConnector,
  MarketauxNewsConnector,
  alphaPublishedAt,
  createFreeNewsApiAdapters,
  newsApiSymbols,
  type FreeNewsApiApproval,
} from '../src/connectors/free-news-api.connector';
import type { FreeNewsProvider, NewsApiBudgetStore } from '../src/connectors/news-api-budget';
import type { FetchImplementation } from '../src/opendart/opendart.client';

const NOW = new Date('2026-09-07T03:00:00.000Z');
const scope: DiscoveryScope = {
  companies: [
    {
      ticker: 'NVDA',
      stockCode: null,
      cik: null,
      market: 'NASDAQ',
      nameKo: '합성 기업',
      nameEn: 'Synthetic Company',
    },
  ],
};
function policy(provider: FreeNewsProvider): NewsSourcePolicy {
  return {
    ...NEWS_EXTERNAL_API_POLICIES[provider],
    rightsStatus: 'METADATA_ONLY',
    metadataStorageAllowed: true,
    displayAllowed: true,
  };
}
function approval(provider: FreeNewsProvider): FreeNewsApiApproval {
  return {
    entitlementConfirmed: true,
    freeAccessVerifiedUntil: '2027-01-01T00:00:00Z',
    providerPolicy: policy(provider),
    verifiedRequestsPerMinute: 100,
    publisherPolicies: {
      'publisher.example': {
        domain: 'publisher.example',
        sourceNames: ['Synthetic News'],
        sourceKind: NewsSourceKind.INDEPENDENT_MEDIA,
        independentVerification: true,
        policy: { ...policy(provider), policyId: 'synthetic-publisher-policy' },
      },
    },
  };
}
function recovery() {
  const states = new Map<string, { revision: number; metadata: Record<string, unknown> }>();
  const store: RecoveryStore = {
    async load(provider, stream) {
      return states.get(`${provider}:${stream}`) ?? { revision: 0, metadata: {} };
    },
    async commit(provider, stream, expected, metadata) {
      if ((states.get(`${provider}:${stream}`)?.revision ?? 0) !== expected)
        throw new Error('Conflict');
      states.set(`${provider}:${stream}`, { revision: expected + 1, metadata });
    },
  };
  return { states, store };
}
function budget(): NewsApiBudgetStore {
  return {
    reserve: jest.fn().mockResolvedValue(undefined),
    defer: jest.fn().mockResolvedValue(undefined),
  };
}
const marketaux = (id = 'synthetic-1') => ({
  meta: { found: 1, returned: 1, limit: 3, page: 1 },
  data: [
    {
      uuid: id,
      title: 'Synthetic company announces an update',
      description: 'Summary requires a separate grant.',
      url: `https://publisher.example/${id}`,
      source: 'Synthetic News',
      published_at: '2026-09-07T01:02:03Z',
      entities: [{ symbol: 'NVDA', country: 'us', exchange: 'NASDAQ' }],
      content: 'NEVER_STORE_BODY',
      image_url: 'NEVER_STORE_IMAGE',
      highlights: [{ highlight: 'NEVER_STORE_HIGHLIGHT' }],
    },
  ],
});
const alpha = () => ({
  items: '1',
  feed: [
    {
      title: 'Synthetic company announces an update',
      summary: 'Summary requires a separate grant.',
      url: 'https://publisher.example/synthetic-1',
      source: 'Synthetic News',
      time_published: '20260907T010203',
      ticker_sentiment: [{ ticker: 'NVDA', relevance_score: '0.9', ticker_sentiment_score: '0.2' }],
      banner_image: 'NEVER_STORE_IMAGE',
      overall_sentiment_score: 0.2,
    },
  ],
});
const finnhub = () => [
  {
    id: 101,
    headline: 'Synthetic company announces an update',
    summary: 'Summary requires a separate grant.',
    url: 'https://publisher.example/synthetic-1',
    source: 'Synthetic News',
    datetime: Date.parse('2026-09-07T01:02:03Z') / 1000,
    related: 'NVDA',
    category: 'company',
    image: 'NEVER_STORE_IMAGE',
  },
];
const cases = [
  {
    name: 'MARKETAUX' as const,
    Adapter: MarketauxNewsConnector,
    fixture: marketaux,
    empty: { meta: { found: 0, returned: 0, limit: 3, page: 1 }, data: [] },
  },
  {
    name: 'ALPHAVANTAGE' as const,
    Adapter: AlphaVantageNewsConnector,
    fixture: alpha,
    empty: { items: '0', feed: [] },
  },
  { name: 'FINNHUB' as const, Adapter: FinnhubNewsConnector, fixture: finnhub, empty: [] },
];
async function collect(
  adapter: FreeNewsApiConnector,
  store: RecoveryStore = recovery().store,
  requestedScope = scope,
) {
  const results: DiscoveryCandidate[] = [];
  for await (const batch of adapter.discoverBatches(requestedScope, store)) {
    results.push(...batch.candidates);
    if (batch.checkpoint)
      await store.commit(
        adapter.name,
        batch.checkpoint.stream,
        batch.checkpoint.expected,
        batch.checkpoint.metadata,
      );
  }
  return results;
}

describe.each(cases)('$name free news metadata adapter', ({ name, Adapter, fixture, empty }) => {
  function adapter(
    fetchImpl: FetchImplementation,
    access: FreeNewsApiApproval | null = approval(name),
    requestBudget = budget(),
  ) {
    return new Adapter({
      enabled: true,
      key: 'SECRET_TEST_KEY',
      fetchImpl,
      timeoutMs: 1000,
      approval: access,
      dailyBudget: 20,
      requestsPerRun: 2,
      clock: () => NOW,
      budgetStore: requestBudget,
    });
  }
  it('is blocked before HTTP without explicit rights, free access and entitlement', async () => {
    const fetchImpl = jest.fn();
    for (const access of [
      null,
      { ...approval(name), entitlementConfirmed: false },
      { ...approval(name), freeAccessVerifiedUntil: NOW.toISOString() },
      { ...approval(name), providerPolicy: NEWS_EXTERNAL_API_POLICIES[name] },
      { ...approval(name), publisherPolicies: {} },
    ]) {
      const connector = adapter(fetchImpl, access);
      expect(connector.health().status).toBe(ConnectorStatus.UNCONFIGURED);
      expect(await collect(connector)).toEqual([]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('normalizes approved fields only and reserves before requesting', async () => {
    const requestBudget = budget();
    const fetchImpl = jest.fn(async () => {
      expect(requestBudget.reserve).toHaveBeenCalledTimes(1);
      return Response.json(fixture());
    });
    const results = await collect(adapter(fetchImpl, approval(name), requestBudget));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      connector: name,
      publishedAt: '2026-09-07T01:02:03.000Z',
      observedAt: NOW.toISOString(),
      sourceKind: NewsSourceKind.AGGREGATOR,
      tickers: ['NVDA'],
      sourcePolicy: {
        provider: name,
        fullTextStorageAllowed: false,
        aiAllowed: false,
        translationAllowed: false,
        notifyAllowed: false,
        allowedAudiences: ['ADMIN_UI'],
      },
    });
    expect(results[0]?.summary).toBeUndefined();
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('NEVER_STORE');
    expect(serialized).not.toContain('Summary requires');
    if (name === 'ALPHAVANTAGE')
      expect(results[0]?.metadata.providerFields).toMatchObject({
        overall_sentiment_score: 0.2,
        sentimentMeaning: 'UNVERIFIED_PROVIDER_METADATA',
      });
    expect(serialized).not.toContain('SECRET_TEST_KEY');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('stores summary only with grants from both provider and publisher', async () => {
    const access = approval(name);
    access.publisherPolicies['publisher.example']!.policy.summaryStorageAllowed = true;
    const fetchImpl = jest.fn(async () => Response.json(fixture()));
    expect((await collect(adapter(fetchImpl, access)))[0]?.summary).toBeUndefined();
    access.providerPolicy.summaryStorageAllowed = true;
    expect((await collect(adapter(fetchImpl, access)))[0]?.summary).toBe(
      'Summary requires a separate grant.',
    );
  });
  it('rejects unknown publishers and mismatched names without persisting response fields', async () => {
    const access = approval(name);
    access.publisherPolicies['publisher.example']!.sourceNames = ['Different Publisher'];
    expect(await collect(adapter(async () => Response.json(fixture()), access))).toEqual([]);
  });
  it('accepts an empty page', async () => {
    expect(await collect(adapter(async () => Response.json(empty)))).toEqual([]);
  });
  it('redacts malformed JSON and schema errors', async () => {
    const requestBudget = budget();
    for (const response of [
      new Response('{SECRET_TEST_KEY'),
      Response.json({ content: 'SECRET_TEST_KEY' }),
    ]) {
      const connector = adapter(async () => response, approval(name), requestBudget);
      await expect(collect(connector)).rejects.toThrow(
        /invalid UTF-8 JSON|malformed news metadata/,
      );
    }
    expect(requestBudget.defer).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 429, 500])(
    'classifies HTTP %i, retains the reservation and records cooldown',
    async (status) => {
      const requestBudget = budget();
      const fetchImpl = jest.fn(
        async () => new Response('SECRET_TEST_KEY', { status, headers: { 'Retry-After': '60' } }),
      );
      const connector = adapter(fetchImpl, approval(name), requestBudget);
      await expect(collect(connector)).rejects.toMatchObject({
        httpStatus: status,
        requestAttempted: true,
      });
      expect(requestBudget.reserve).toHaveBeenCalledTimes(1);
      expect(requestBudget.defer).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(connector.discoveryMetadata)).not.toContain('SECRET_TEST_KEY');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it('classifies timeout without retrying another provider', async () => {
    const requestBudget = budget();
    const fetchImpl = jest.fn(async () => {
      throw new DOMException('SECRET_TEST_KEY', 'TimeoutError');
    });
    await expect(collect(adapter(fetchImpl, approval(name), requestBudget))).rejects.toMatchObject({
      transportCategory: 'timeout',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBudget.defer).toHaveBeenCalledWith(name, expect.any(Date), 'TIMEOUT');
  });
  it('does not request if durable budget cannot reserve', async () => {
    const requestBudget = budget();
    jest
      .mocked(requestBudget.reserve)
      .mockRejectedValue(
        new ConnectorRequestError(name, 'news-budget', 429, null, NOW, null, null, false),
      );
    const fetchImpl = jest.fn();
    await expect(collect(adapter(fetchImpl, approval(name), requestBudget))).rejects.toMatchObject({
      requestAttempted: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('free news pagination, scope and configuration', () => {
  it('defaults all sources to disabled and bounds application budgets', () => {
    const config = loadWorkerConfig({});
    expect(
      createFreeNewsApiAdapters(config, jest.fn()).every(
        (item) => item.health().status === ConnectorStatus.UNCONFIGURED,
      ),
    ).toBe(true);
    expect(config).toMatchObject({
      marketauxNewsDailyBudget: 50,
      marketauxNewsRequestsPerRun: 2,
      alphaVantageNewsDailyBudget: 20,
      alphaVantageNewsRequestsPerRun: 10,
      finnhubNewsDailyBudget: 120,
      finnhubNewsRequestsPerRun: 5,
    });
    expect(() => loadWorkerConfig({ MARKETAUX_NEWS_DAILY_BUDGET: '101' })).toThrow();
    expect(() => loadWorkerConfig({ FINNHUB_NEWS_REQUESTS_PER_RUN: '6' })).toThrow();
  });
  it('requires a verified Finnhub account minute rate', () => {
    const connector = new FinnhubNewsConnector({
      enabled: true,
      key: 'test',
      fetchImpl: jest.fn(),
      timeoutMs: 1000,
      dailyBudget: 120,
      requestsPerRun: 5,
      approval: { ...approval('FINNHUB'), verifiedRequestsPerMinute: null },
      clock: () => NOW,
    });
    expect(connector.health().status).toBe(ConnectorStatus.UNCONFIGURED);
  });
  it('uses exact known Korean markets and excludes unknown exchange guesses', () => {
    const krScope: DiscoveryScope = {
      companies: ['KOSPI', 'KOSDAQ', 'UNKNOWN'].map((market) => ({
        ticker: null,
        stockCode: '123456',
        cik: null,
        market,
        nameKo: '합성 회사',
        nameEn: null,
      })),
    };
    expect(newsApiSymbols('MARKETAUX', krScope)).toEqual(['123456.KS', '123456.KQ']);
    expect(newsApiSymbols('ALPHAVANTAGE', krScope)).toEqual([]);
    expect(newsApiSymbols('FINNHUB', krScope)).toEqual([]);
    const unsupported = { companies: [{ ...scope.companies[0]!, market: 'OTC' }] };
    for (const provider of ['MARKETAUX', 'ALPHAVANTAGE', 'FINNHUB'] as const)
      expect(newsApiSymbols(provider, unsupported)).toEqual([]);
  });
  it('sends a single Alpha Vantage ticker, UTC minute filters and no fictional page parameter', async () => {
    const fetchImpl = jest.fn(async () => Response.json({ items: '0', feed: [] }));
    const connector = new AlphaVantageNewsConnector({
      enabled: true,
      key: 'secret',
      fetchImpl,
      timeoutMs: 1000,
      dailyBudget: 20,
      requestsPerRun: 2,
      approval: approval('ALPHAVANTAGE'),
      budgetStore: budget(),
      clock: () => NOW,
    });
    await collect(connector, recovery().store, {
      companies: [...scope.companies, { ...scope.companies[0]!, ticker: 'MSFT' }],
    });
    const urls = fetchImpl.mock.calls.map((call) => new URL((call as unknown as [URL])[0]));
    expect(urls.map((url) => url.searchParams.get('tickers'))).toEqual(['NVDA', 'MSFT']);
    expect(urls[0]?.searchParams.get('time_to')).toBe('20260907T0300');
    expect(urls.every((url) => !url.searchParams.has('page'))).toBe(true);
    expect(alphaPublishedAt('20260101T000000')).toBe('2026-01-01T00:00:00.000Z');
    expect(() => alphaPublishedAt('20260230T000000')).toThrow();
  });
  it.each(['Information', 'Note', 'Error Message'])(
    'rejects Alpha Vantage 200 %s envelope without retaining its text',
    async (field) => {
      const connector = new AlphaVantageNewsConnector({
        enabled: true,
        key: 'secret',
        fetchImpl: async () => Response.json({ [field]: 'SECRET_TEST_KEY' }),
        timeoutMs: 1000,
        dailyBudget: 20,
        requestsPerRun: 2,
        approval: approval('ALPHAVANTAGE'),
        budgetStore: budget(),
        clock: () => NOW,
      });
      await expect(collect(connector)).rejects.toBeInstanceOf(ConnectorRequestError);
      expect(JSON.stringify(connector.discoveryMetadata)).not.toContain('SECRET_TEST_KEY');
    },
  );
  it('uses a Finnhub header token and date filters without price or sentiment endpoints', async () => {
    const fetchImpl: jest.MockedFunction<FetchImplementation> = jest
      .fn<ReturnType<FetchImplementation>, Parameters<FetchImplementation>>()
      .mockResolvedValue(Response.json([]));
    const connector = new FinnhubNewsConnector({
      enabled: true,
      key: 'secret',
      fetchImpl,
      timeoutMs: 1000,
      dailyBudget: 120,
      requestsPerRun: 5,
      approval: approval('FINNHUB'),
      budgetStore: budget(),
      clock: () => NOW,
    });
    await collect(connector);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/v1/company-news');
    expect(url.searchParams.get('from')).toBe('2026-09-06');
    expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.has('token')).toBe(false);
    expect(fetchImpl.mock.calls[0]![1]?.headers).toEqual({ 'X-Finnhub-Token': 'secret' });
  });
  it('uses only Finnhub company-news request context when related tickers are absent', async () => {
    const response = finnhub();
    response[0]!.related = '';
    const connector = new FinnhubNewsConnector({
      enabled: true,
      key: 'secret',
      fetchImpl: async () => Response.json(response),
      timeoutMs: 1000,
      dailyBudget: 120,
      requestsPerRun: 5,
      approval: approval('FINNHUB'),
      budgetStore: budget(),
      clock: () => NOW,
    });
    const [candidate] = await collect(connector);
    expect(candidate?.tickers).toEqual(['NVDA']);
    expect(candidate?.metadata.providerFields).toMatchObject({
      requestedSymbol: 'NVDA',
      category: 'company',
    });
  });
  it('uses a stable Alpha Vantage URL identity while distinguishing absent provider ids', async () => {
    const options = {
      enabled: true,
      key: 'secret',
      fetchImpl: async () => Response.json(alpha()),
      timeoutMs: 1000,
      dailyBudget: 20,
      requestsPerRun: 2,
      approval: approval('ALPHAVANTAGE'),
      budgetStore: budget(),
    };
    const [first] = await collect(new AlphaVantageNewsConnector({ ...options, clock: () => NOW }));
    const [second] = await collect(
      new AlphaVantageNewsConnector({ ...options, clock: () => new Date(NOW.getTime() + 1000) }),
    );
    expect(first?.externalId).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.externalId).toBe(first?.externalId);
    expect(first?.metadata).toMatchObject({
      providerArticleId: null,
      externalIdentityKind: 'CANONICAL_URL_HASH',
    });
  });
  it('never counts press releases as independent media', async () => {
    const access = approval('MARKETAUX');
    access.publisherPolicies['publisher.example']!.sourceKind = NewsSourceKind.PRESS_RELEASE;
    const connector = new MarketauxNewsConnector({
      enabled: true,
      key: 'secret',
      fetchImpl: async () => Response.json(marketaux()),
      timeoutMs: 1000,
      dailyBudget: 50,
      requestsPerRun: 2,
      approval: access,
      budgetStore: budget(),
      clock: () => NOW,
    });
    const [candidate] = await collect(connector);
    expect(candidate?.sourceKind).toBe(NewsSourceKind.PRESS_RELEASE);
    expect(candidate?.metadata).toMatchObject({
      independentVerification: false,
      originalPublisherId: null,
    });
  });
  it('rotates the persisted ticker position across supplemental runs', async () => {
    const state = recovery();
    const fetchImpl: jest.MockedFunction<FetchImplementation> = jest
      .fn<ReturnType<FetchImplementation>, Parameters<FetchImplementation>>()
      .mockImplementation(async () => Response.json({ items: '0', feed: [] }));
    const options = {
      enabled: true,
      key: 'secret',
      fetchImpl,
      timeoutMs: 1000,
      dailyBudget: 20,
      requestsPerRun: 1,
      approval: approval('ALPHAVANTAGE'),
      budgetStore: budget(),
      clock: () => NOW,
    };
    const multiScope = {
      companies: [...scope.companies, { ...scope.companies[0]!, ticker: 'MSFT' }],
    };
    await collect(new AlphaVantageNewsConnector(options), state.store, multiScope);
    await collect(new AlphaVantageNewsConnector(options), state.store, multiScope);
    expect(
      fetchImpl.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('tickers')),
    ).toEqual(['NVDA', 'MSFT']);
  });
  it('groups Marketaux symbols and keeps the total run within two requests', async () => {
    const fetchImpl: jest.MockedFunction<FetchImplementation> = jest
      .fn<ReturnType<FetchImplementation>, Parameters<FetchImplementation>>()
      .mockImplementation(async () =>
        Response.json({ meta: { found: 0, returned: 0, limit: 3, page: 1 }, data: [] }),
      );
    const connector = new MarketauxNewsConnector({
      enabled: true,
      key: 'secret',
      fetchImpl,
      timeoutMs: 1000,
      dailyBudget: 50,
      requestsPerRun: 2,
      approval: approval('MARKETAUX'),
      budgetStore: budget(),
      clock: () => NOW,
    });
    await collect(connector, recovery().store, {
      companies: Array.from({ length: 60 }, (_, index) => ({
        ...scope.companies[0]!,
        ticker: `X${index}`,
      })),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.map(
        ([url]) => new URL(String(url)).searchParams.get('symbols')?.split(',').length,
      ),
    ).toEqual([25, 25]);
  });
  it('detects repeated Marketaux pages across a restart without advancing the saved cursor', async () => {
    const state = recovery();
    const fetchImpl: jest.MockedFunction<FetchImplementation> = jest.fn(async (url) => {
      const response = marketaux();
      response.data = [
        marketaux('synthetic-a').data[0]!,
        marketaux('synthetic-b').data[0]!,
        marketaux('synthetic-c').data[0]!,
      ];
      response.meta = {
        found: 7,
        returned: 3,
        limit: 3,
        page: Number(new URL(String(url)).searchParams.get('page')),
      };
      return Response.json(response);
    });
    const options = {
      enabled: true,
      key: 'secret',
      fetchImpl,
      timeoutMs: 1000,
      dailyBudget: 50,
      requestsPerRun: 1,
      approval: approval('MARKETAUX'),
      budgetStore: budget(),
      clock: () => NOW,
    };
    await collect(new MarketauxNewsConnector(options), state.store);
    await expect(collect(new MarketauxNewsConnector(options), state.store)).rejects.toThrow(
      'repeated a news result page',
    );
    expect([...state.states.values()][0]?.metadata).toMatchObject({
      nextPage: 2,
      cursor: null,
      incomplete: true,
    });
  });
  it('preserves Marketaux pagination until items are saved and resumes a capped run', async () => {
    const state = recovery();
    const fetchImpl: jest.MockedFunction<FetchImplementation> = jest.fn(async (url) => {
      const page = Number(new URL(String(url)).searchParams.get('page'));
      const response = marketaux(`synthetic-${page}`);
      if (page === 1)
        response.data = [
          marketaux('synthetic-a').data[0]!,
          marketaux('synthetic-b').data[0]!,
          marketaux('synthetic-c').data[0]!,
        ];
      response.meta = { found: 4, returned: response.data.length, limit: 3, page };
      return Response.json(response);
    });
    const options = {
      enabled: true,
      key: 'secret',
      fetchImpl,
      timeoutMs: 1000,
      dailyBudget: 50,
      requestsPerRun: 1,
      approval: approval('MARKETAUX'),
      budgetStore: budget(),
      clock: () => NOW,
    };
    expect(await collect(new MarketauxNewsConnector(options), state.store)).toHaveLength(3);
    const pending = [...state.states.values()].find((row) => row.metadata.nextPage === 2);
    expect(pending?.metadata).toMatchObject({ incomplete: true, cursor: null });
    expect(await collect(new MarketauxNewsConnector(options), state.store)).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('page')),
    ).toEqual(['1', '2']);
    expect(
      [...state.states.values()].some((row) => row.metadata.cursor === NOW.toISOString()),
    ).toBe(true);
  });
  it('does not advance a page cursor when the consumer fails to save items', async () => {
    const state = recovery();
    const fetchImpl = jest.fn(async () => Response.json(marketaux()));
    const connector = new MarketauxNewsConnector({
      enabled: true,
      key: 'secret',
      fetchImpl,
      timeoutMs: 1000,
      dailyBudget: 50,
      requestsPerRun: 2,
      approval: approval('MARKETAUX'),
      budgetStore: budget(),
      clock: () => NOW,
    });
    const iterator = connector.discoverBatches(scope, state.store);
    expect((await iterator.next()).value).toMatchObject({ candidates: expect.any(Array) });
    await iterator.return(undefined);
    expect(state.states.size).toBe(0);
  });
  it('separates Marketaux 402 daily exhaustion from 429 and fails closed on malformed pagination', async () => {
    const requestBudget = budget();
    const options = {
      enabled: true,
      key: 'secret',
      timeoutMs: 1000,
      dailyBudget: 50,
      requestsPerRun: 2,
      approval: approval('MARKETAUX'),
      budgetStore: requestBudget,
      clock: () => NOW,
    };
    await expect(
      collect(
        new MarketauxNewsConnector({
          ...options,
          fetchImpl: async () => new Response('', { status: 402 }),
        }),
      ),
    ).rejects.toMatchObject({ httpStatus: 402 });
    expect(requestBudget.defer).toHaveBeenCalledWith(
      'MARKETAUX',
      new Date(NOW.getTime() + 86400_000),
      'DAILY_LIMIT',
    );
    await expect(
      collect(
        new MarketauxNewsConnector({
          ...options,
          fetchImpl: async () =>
            Response.json({ ...marketaux(), meta: { found: 2, returned: 1, limit: 3, page: 9 } }),
        }),
      ),
    ).rejects.toThrow('malformed news metadata');
  });
});
