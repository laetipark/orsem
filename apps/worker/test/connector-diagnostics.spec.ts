import { ConnectorStatus } from '@orsem/contracts';
import { connectorFailureMessage, NaverNewsConnector } from '../src/connectors/connector-adapters';
import { naverFailureMessage, readNaverErrorCode } from '../src/connectors/connector-diagnostics';

describe('NAVER credential diagnostics', () => {
  it('preserves the provider error code and drops reflected credentials and raw error text', async () => {
    const response = new Response(
      JSON.stringify({
        errorCode: '024',
        errorMessage: 'private-test-client-secret',
      }),
      { status: 401 },
    );
    const code = await readNaverErrorCode(response);
    expect(code).toBe('024');
    expect(naverFailureMessage(401, code)).toContain('같은 애플리케이션');
    expect(naverFailureMessage(401, code)).toContain('‘검색’ 권한');
    expect(naverFailureMessage(403, code)).toContain('호출이 거절');
    expect(naverFailureMessage(500, code)).toBeNull();
    expect(naverFailureMessage(401, 'private-test-client-secret')).not.toContain('private-test');
  });

  it.each([
    ['024', { errorCode: '024' }],
    ['200', { error: { errorCode: '200', details: 'private-test-client-secret' } }],
    ['401', { error: { errorCode: '401' } }],
    ['SE02', { errorCode: 'SE02' }],
  ])('reads the documented Developers and API HUB error format for %s', async (code, body) => {
    expect(await readNaverErrorCode(new Response(JSON.stringify(body), { status: 401 }))).toBe(
      code,
    );
  });

  it.each([
    '<html>provider failure</html>',
    JSON.stringify({ errorCode: 'private-test-client-secret' }),
    JSON.stringify({ error: { errorCode: 'private-test-client-secret' } }),
    JSON.stringify({ error: { errorCode: 401 } }),
    JSON.stringify({ error: 'private-test-client-secret' }),
    JSON.stringify({ errorCode: 24 }),
    JSON.stringify({ errorCode: '024', errorMessage: 'x'.repeat(5000) }),
    'null',
  ])('retains the HTTP diagnosis when provider error details are unusable', async (body) => {
    expect(await readNaverErrorCode(new Response(body, { status: 401 }))).toBeNull();
  });

  it('does not hang the connector queue if the error response body stalls', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    try {
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 401 });
      const result = readNaverErrorCode(response);
      await jest.advanceTimersByTimeAsync(1000);
      expect(await result).toBeNull();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports authentication setup failure with metadata and makes no automatic retry', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errorCode: '024',
          errorMessage: 'private-test-client-secret',
        }),
        { status: 401 },
      ),
    );
    const connector = new NaverNewsConnector(
      'test-client-id',
      'private-test-client-secret',
      fetcher,
      1000,
    );
    const health = await connector.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(health).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      metadata: {
        httpStatus: 401,
        providerCode: '024',
        provider: 'developers',
        apiEndpoint: 'https://openapi.naver.com/v1/search/news.json',
      },
    });
    expect(health.message).toContain('‘검색’ 권한');
    expect(JSON.stringify(health)).not.toContain('private-test-client-secret');
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe('https://openapi.naver.com');
    expect(url.search).not.toContain('private-test-client-secret');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('X-Naver-Client-Id')).toBe('test-client-id');
  });

  it('retains Cloud provenance and console guidance for failed health and discovery requests', async () => {
    const fetcher = jest.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { errorCode: '200', message: 'private-test-client-secret' },
          }),
          { status: 401 },
        ),
    );
    const connector = new NaverNewsConnector(
      'test-client-id',
      'private-test-client-secret',
      fetcher,
      1000,
      'ncloud',
    );
    const health = await connector.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(health).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      metadata: {
        httpStatus: 401,
        providerCode: '200',
        provider: 'ncloud',
        apiEndpoint: 'https://naverapihub.apigw.ntruss.com/search/v1/news',
      },
    });
    expect(health.message).toContain('NAVER Cloud 콘솔');
    expect(health.message).toContain('Search API');
    expect(health.message).not.toContain('네이버 개발자센터');
    expect(JSON.stringify(health)).not.toContain('private-test-client-secret');
    const error = await connector.search({ query: '증권' }).catch((cause: unknown) => cause);
    expect(connectorFailureMessage(error)).toContain('NAVER Cloud 콘솔');
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls as [URL, RequestInit][]) {
      expect(url.origin).toBe('https://naverapihub.apigw.ntruss.com');
      expect(url.pathname).toBe('/search/v1/news');
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).has('X-Naver-Client-Id')).toBe(false);
      expect(new Headers(init.headers).has('X-Naver-Client-Secret')).toBe(false);
    }
  });

  it('retains Cloud provenance when the request fails before an HTTP response', async () => {
    const connector = new NaverNewsConnector(
      'test-client-id',
      'test-client-secret',
      async () => {
        throw Object.assign(new Error('private network details'), { code: 'ENOTFOUND' });
      },
      1000,
      'ncloud',
    );
    const health = await connector.check();
    expect(health).toMatchObject({
      status: ConnectorStatus.DEGRADED,
      metadata: { provider: 'ncloud', httpStatus: 0, transportCategory: 'dns' },
    });
    expect(JSON.stringify(health)).not.toContain('private network details');
  });
});
