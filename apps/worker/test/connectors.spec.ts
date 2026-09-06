import { GdeltMetadataConnector } from './gdelt-approved-fixture';
import { ConnectorStatus, RightsMode } from '@orsem/contracts';
import {
  ConnectorRequestError,
  createLinkDiscoveryAdapters,
  RegisteredIrFeedConnector,
  NaverNewsConnector,
} from '../src/connectors/connector-adapters';
import { loadWorkerConfig } from '../src/config/worker-config';

function standaloneNaver(env: Record<string, string>, fetcher: typeof fetch) {
  const config = loadWorkerConfig(env);
  return new NaverNewsConnector(
    config.naverClientId,
    config.naverClientSecret,
    fetcher,
    config.httpTimeoutMs,
    config.naverApiProvider,
  );
}

describe('connector adapter gates', () => {
  it('disables only connectors with missing credentials', () => {
    const config = loadWorkerConfig({
      SEC_USER_AGENT: 'Orsem test test@example.com',
    });
    const health = Object.fromEntries(
      createLinkDiscoveryAdapters(config).map((adapter) => [adapter.name, adapter.health()]),
    );
    expect(health.NAVER).toBeUndefined();
    expect(health.SEC?.status).toBe(ConnectorStatus.DEGRADED);
    expect(health.SEC?.metadata?.healthSource).toBe('SEC_INGESTION');
    expect(health.GDELT?.status).toBe(ConnectorStatus.UNCONFIGURED);
    expect(health.KRX).toBeUndefined();
    expect(health.SEC?.rightsMode).toBe(RightsMode.OFFICIAL_PUBLIC_DATA);
    expect(health.ALPACA).toBeUndefined();
    expect(health.GDELT?.rightsMode).toBe(RightsMode.STORE_METADATA_ONLY);
    expect(health.IR?.rightsMode).toBe(RightsMode.PRIVATE_DISPLAY_ONLY);
  });

  it('requires a declared SEC application identity in addition to the contact email', () => {
    expect(() => loadWorkerConfig({ SEC_USER_AGENT: 'ops@example.com' })).toThrow(
      /application identity followed by a contact email/u,
    );
    expect(loadWorkerConfig({ SEC_USER_AGENT: 'Orsem ops@example.com' }).secUserAgent).toBe(
      'Orsem ops@example.com',
    );
  });

  it('uses the documented NAVER metadata request without carrying article bodies', async () => {
    let requestedUrl = '';
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString()).toString();
      return new Response(
        JSON.stringify({
          items: [
            {
              title: '<b>테스트</b>',
              originallink: 'https://news.example.test/item',
              link: 'https://search.naver.test/item',
              description: '설명',
              pubDate: 'Thu, 03 Sep 2026 00:00:00 +0900',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const adapter = standaloneNaver(
      {
        NAVER_CLIENT_ID: 'client',
        NAVER_CLIENT_SECRET: 'secret',
      },
      fetcher,
    );
    const items = await adapter?.discoverLinks({
      companies: [
        {
          ticker: null,
          stockCode: '005930',
          cik: null,
          nameKo: '삼성전자',
          nameEn: 'Samsung Electronics',
        },
      ],
    });
    expect(new URL(requestedUrl).hostname).toBe('openapi.naver.com');
    expect(items?.[0]).toMatchObject({
      title: '테스트',
      rightsMode: RightsMode.STORE_METADATA_ONLY,
    });
    expect(items?.[0]).not.toHaveProperty('body');
    expect(items?.[0]).not.toHaveProperty('content');
  });

  it('rejects private configured endpoints and non-HTTP discovered links', async () => {
    expect(() =>
      createLinkDiscoveryAdapters(loadWorkerConfig({ IR_FEED_URLS: 'https://127.0.0.1/feed.xml' })),
    ).toThrow('disallowed host');

    const fetcher = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          items: [
            {
              title: 'unsafe',
              originallink: 'file:///etc/passwd',
              link: 'https://search.naver.test/item',
            },
          ],
        }),
        { status: 200 },
      );
    const adapter = standaloneNaver(
      {
        NAVER_CLIENT_ID: 'client',
        NAVER_CLIENT_SECRET: 'secret',
      },
      fetcher,
    );
    await expect(
      adapter?.discoverLinks({
        companies: [
          {
            ticker: null,
            stockCode: '005930',
            cik: null,
            nameKo: '삼성전자',
            nameEn: 'Samsung Electronics',
          },
        ],
      }),
    ).rejects.toThrow('credential-free HTTP(S)');
  });

  it('uses only API HUB credentials at the Cloud endpoint and preserves source provenance', async () => {
    const fetcher = jest.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                title: '<b>기업</b> 공지',
                originallink: 'https://news.example.test/item',
                link: 'https://search.naver.test/item',
                description: '공시 <b>요약</b>',
                pubDate: 'Thu, 03 Sep 2026 00:00:00 +0900',
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const adapter = standaloneNaver(
      {
        NAVER_API_PROVIDER: 'ncloud',
        NAVER_CLIENT_ID: 'cloud-client',
        NAVER_CLIENT_SECRET: 'cloud-secret',
      },
      fetcher,
    );
    const items = await adapter.discoverLinks({
      companies: [
        {
          ticker: null,
          stockCode: '005930',
          cik: null,
          nameKo: '삼성전자',
          nameEn: null,
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe('https://naverapihub.apigw.ntruss.com/search/v1/news');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '삼성전자',
      display: '10',
      start: '1',
      sort: 'date',
      format: 'json',
    });
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      'x-ncp-apigw-api-key-id': 'cloud-client',
      'x-ncp-apigw-api-key': 'cloud-secret',
      accept: 'application/json',
    });
    expect(init.redirect).toBe('error');
    expect(items[0]).toMatchObject({
      title: '기업 공지',
      publishedAt: '2026-09-02T15:00:00.000Z',
      rightsMode: RightsMode.STORE_METADATA_ONLY,
      metadata: {
        provider: 'ncloud',
        apiEndpoint: 'https://naverapihub.apigw.ntruss.com/search/v1/news',
        description: '공시 요약',
        discoveryQuery: '삼성전자',
        aggregatorUrl: 'https://search.naver.test/item',
      },
    });
    expect(JSON.stringify(items)).not.toContain('cloud-secret');
    expect(await adapter.check()).toMatchObject({
      status: ConnectorStatus.HEALTHY,
      metadata: { provider: 'ncloud', capability: 'NEWS_SEARCH', resultCount: 1 },
    });
  });

  it('leaves the Cloud connector disabled if either required credential is missing', async () => {
    const fetcher = jest.fn();
    const adapter = standaloneNaver(
      { NAVER_API_PROVIDER: 'ncloud', NAVER_CLIENT_ID: 'cloud-client' },
      fetcher,
    );
    expect(await adapter.check()).toMatchObject({
      status: ConnectorStatus.UNCONFIGURED,
      metadata: { provider: 'ncloud' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not persist health-probe sample traffic as discovery data', async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const adapter = standaloneNaver(
      {
        NAVER_CLIENT_ID: 'client',
        NAVER_CLIENT_SECRET: 'secret',
      },
      fetcher,
    );
    await expect(adapter?.discoverLinks({ companies: [] })).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects unreviewed registered IR feeds before any network request', () => {
    expect(() => new RegisteredIrFeedConnector(['https://one.example.test/feed'], 5_000)).toThrow(
      /reviewed content-source registry/u,
    );
  });

  it('rejects invalid explicitly configured IR feeds during config loading', () => {
    expect(() => loadWorkerConfig({ IR_FEED_URLS: 'https://127.0.0.1/feed.xml' })).toThrow(
      'disallowed host',
    );
  });

  it('requires explicit production infrastructure URLs and validates protocols', () => {
    expect(() => loadWorkerConfig({ NODE_ENV: 'production' })).toThrow(
      'DATABASE_URL must be explicitly configured in production',
    );
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: 'postgres://db.example.test/orsem',
        REDIS_URL: 'https://cache.example.test',
      }),
    ).toThrow('DATABASE_URL must use mysql:');
    expect(
      loadWorkerConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://orsem:secret@db.example.test:3306/orsem',
        REDIS_URL: 'rediss://cache.example.test:6380/0',
      }),
    ).toMatchObject({ nodeEnv: 'production' });
    expect(
      loadWorkerConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://orsem:secret@127.0.0.1:23306/orsem',
        REDIS_URL: 'redis://127.0.0.1:6379/0',
      }),
    ).toMatchObject({ redisUrl: 'redis://127.0.0.1:6379/0' });
  });
});

describe('connector transport failure reporting', () => {
  const transportCases = [
    {
      category: 'timeout',
      error: () => Object.assign(new Error('secret timeout detail'), { name: 'TimeoutError' }),
    },
    {
      category: 'dns',
      error: () =>
        Object.assign(new TypeError('fetch failed for https://secret.example.test'), {
          cause: Object.assign(new Error('getaddrinfo secret.example.test'), { code: 'ENOTFOUND' }),
        }),
    },
    {
      category: 'tls',
      error: () =>
        Object.assign(new TypeError('fetch failed with private certificate detail'), {
          cause: Object.assign(new Error('certificate detail'), {
            code: 'ERR_TLS_CERT_ALTNAME_INVALID',
          }),
        }),
    },
    {
      category: 'connect',
      error: () =>
        Object.assign(new TypeError('fetch failed for internal socket'), {
          cause: Object.assign(new Error('socket detail'), { code: 'ECONNREFUSED' }),
        }),
    },
    {
      category: 'network',
      error: () => new TypeError('arbitrary upstream secret and URL'),
    },
  ] as const;

  it.each(transportCases)(
    'reports a sanitized $category category with HTTP 0',
    async (testCase) => {
      const fetcher = async (): Promise<Response> => {
        throw testCase.error();
      };
      const adapter = new GdeltMetadataConnector(true, fetcher, 5_000);
      const failure = await adapter.search('stock market', 1).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ConnectorRequestError);
      const requestError = failure as ConnectorRequestError;
      expect(requestError).toMatchObject({
        connector: 'GDELT',
        operation: 'document-search',
        httpStatus: 0,
        transportCategory: testCase.category,
      });
      expect(requestError.message).toBe(
        `GDELT document-search failed with HTTP 0 (transport: ${testCase.category}).`,
      );
      expect(requestError.message).not.toContain('secret');
      expect(requestError.message).not.toContain('https://');
    },
  );

  it('keeps HTTP response error messages and status codes compatible', () => {
    const failure = new ConnectorRequestError('GDELT', 'document-search', 503);

    expect(failure.httpStatus).toBe(503);
    expect(failure.transportCategory).toBeNull();
    expect(failure.message).toBe('GDELT document-search failed with HTTP 503.');
  });
});
