import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { fetchPinnedHttpsBytes } from '../src/connectors/connector-adapters';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));

const dns = lookup as unknown as jest.Mock;
const http = request as unknown as jest.Mock;
const url = new URL('https://www.federalreserve.gov/feeds/press_all.xml');
const fetchFeed = () => fetchPinnedHttpsBytes('NEWS_RSS', 'synthetic-feed', url, {}, 1000);

function respond(
  statusCode: number,
  headers: Record<string, string>,
  body = '<rss><channel/></rss>',
) {
  http.mockImplementation((_options: unknown, callback: (response: unknown) => void) => {
    const response = Object.assign(new EventEmitter(), {
      statusCode,
      headers,
      resume: jest.fn(),
      destroy: jest.fn(),
    });
    const outgoing = Object.assign(new EventEmitter(), {
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      end: () => {
        callback(response);
        response.emit('data', Buffer.from(body));
        response.emit('end');
      },
    });
    return outgoing;
  });
}

describe('registered RSS transport security', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dns.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  it('pins the validated address while retaining TLS server name and Host', async () => {
    respond(200, { 'content-type': 'application/rss+xml' });
    await expect(fetchFeed()).resolves.toMatchObject({ status: 200 });
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0]![0]).toMatchObject({
      hostname: '93.184.216.34',
      servername: 'www.federalreserve.gov',
      headers: { Host: 'www.federalreserve.gov' },
    });
  });
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1'])(
    'rejects a mixed public/private DNS response (%s) before HTTP',
    async (address) => {
      dns.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address, family: address.includes(':') ? 6 : 4 },
      ]);
      await expect(fetchFeed()).rejects.toThrow('disallowed address');
      expect(http).not.toHaveBeenCalled();
    },
  );
  it('never follows a redirect to another host or an internal address', async () => {
    respond(302, { location: 'https://127.0.0.1/private', 'content-type': 'text/html' });
    await expect(fetchFeed()).rejects.toMatchObject({ httpStatus: 302 });
    expect(http).toHaveBeenCalledTimes(1);
    expect(dns).toHaveBeenCalledTimes(1);
  });
  it.each<Record<string, string>>([
    { 'content-type': 'text/html' },
    { 'content-type': 'application/rss+xml', 'content-encoding': 'gzip' },
    { 'content-type': 'application/rss+xml', 'content-length': String(5 * 1024 * 1024 + 1) },
  ])('rejects mismatched, compressed and oversized feeds', async (headers) => {
    respond(200, headers);
    await expect(fetchFeed()).rejects.toThrow();
  });
});
