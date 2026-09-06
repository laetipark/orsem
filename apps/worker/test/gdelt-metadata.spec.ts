import { GdeltMetadataConnector } from './gdelt-approved-fixture';
import { GDELT_METADATA_POLICY } from '@orsem/contracts';
import { type DiscoveryCandidate } from '../src/connectors/connector-adapters';
import { NEWS_DISCOVERY_SCHEDULES } from '../src/scheduling/schedule-definitions';

const candidate = (url: string, language = 'English'): DiscoveryCandidate => ({
  connector: 'GDELT',
  externalId: null,
  title: 'Company headline',
  url,
  publishedAt: null,
  sourceName: 'publisher.example',
  tickers: [],
  tags: [],
  rightsMode: 'STORE_METADATA_ONLY',
  metadata: { language, originalSeenDate: '20260905T000000Z' },
});
it('distinguishes an observed GDELT 429 from cooldown reuse without sending another request', async () => {
  const fetcher = jest.fn(
    async () => new Response('', { status: 429, headers: { 'Retry-After': '600' } }),
  );
  const adapter = new GdeltMetadataConnector(true, fetcher, 1000);
  await expect(adapter.search('economy')).rejects.toMatchObject({
    httpStatus: 429,
    requestAttempted: true,
  });
  await expect(adapter.search('economy')).rejects.toMatchObject({
    httpStatus: 429,
    requestAttempted: false,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('queries macro and the entire company union with 24h ko/en bounds, deduplicating URLs without article requests', async () => {
  const fetcher = jest.fn();
  const adapter = new GdeltMetadataConnector(true, fetcher, 1000);
  const search = jest
    .spyOn(adapter, 'search')
    .mockResolvedValue([
      candidate('https://publisher.example/article?utm_source=gdelt'),
      candidate('https://publisher.example/article'),
      candidate('https://publisher.example/fr', 'French'),
    ]);
  const companies = Array.from({ length: 26 }, (_, i) => ({
    nameEn: `Company ${i}`,
    nameKo: `기업 ${i}`,
    ticker: null,
    stockCode: null,
    cik: null,
  }));
  const results = await adapter.discoverLinks({ companies });
  expect(search).toHaveBeenCalledTimes(7);
  for (const [query, maximum, options] of search.mock.calls) {
    expect(query).toContain('(sourcelang:english OR sourcelang:korean)');
    expect(maximum).toBe(250);
    expect(options).toEqual({ timespan: '24h' });
  }
  expect(search.mock.calls.map(([query]) => query).join(' ')).toContain('Company 25');
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    publishedAt: null,
    sourceKind: 'INDEPENDENT_MEDIA',
    tickers: [],
    sourcePolicy: GDELT_METADATA_POLICY,
    metadata: { rightsContext: 'APPROVED_PUBLISHER_METADATA', metadataOnly: true },
  });
  expect(results[0]).not.toHaveProperty('content');
  expect(results[0]?.metadata).not.toHaveProperty('description');
  expect(fetcher).not.toHaveBeenCalled();
});
it('reports the 250-result cap, retains filters, and has an explicit 30-minute schedule', async () => {
  const adapter = new GdeltMetadataConnector(true, jest.fn(), 1000, ['publisher.example']);
  jest
    .spyOn(adapter, 'search')
    .mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => candidate(`https://publisher.example/${i}`)),
    );
  expect(await adapter.discoverLinks()).toHaveLength(250);
  expect(adapter.discoveryWasTruncated).toBe(true);
  expect(
    NEWS_DISCOVERY_SCHEDULES.find((schedule) => schedule.payload.connectors.includes('GDELT')),
  ).toMatchObject({ pattern: '*/30 * * * *', payload: { reason: 'SCHEDULED' } });
  expect(GDELT_METADATA_POLICY).toMatchObject({
    aiAllowed: false,
    fullTextStorageAllowed: false,
    metadataStorageAllowed: true,
    displayAllowed: true,
    notifyAllowed: false,
  });
});
