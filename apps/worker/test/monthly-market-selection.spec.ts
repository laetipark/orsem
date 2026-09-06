import {
  MONTHLY_SELECTION_METHOD,
  selectMonthlyMarketLeaders,
  selectionMonth,
  shouldRefreshMonthlySelection,
  type MonthlySelectionCompany,
} from '../src/market-data/market-selection';
import { MarketSelectionService } from '../src/market-data/market-selection.service';

const now = new Date('2026-09-06T16:00:00Z');
function input(region: 'us' | 'kr' = 'us') {
  const listings = Array.from({ length: 25 }, (_, i) => ({
    name: `Company ${i}`,
    symbol: region === 'us' ? `S${i}` : String(i).padStart(6, '0'),
    isinCode: `${region === 'us' ? 'US' : 'KR'}${String(i).padStart(6, '0')}1000`,
    securityType: 'STOCK',
    isCommonShare: true,
    requestedMarket: region === 'us' ? 'NASDAQ' : 'KOSPI',
  }));
  const companies: MonthlySelectionCompany[] = listings.map((row, i) => ({
    id: `company-${i}`,
    stockCode: region === 'kr' ? row.symbol : null,
    ticker: row.symbol,
    corpCode: region === 'kr' ? String(i + 1).padStart(8, '0') : null,
    cik: null,
    market: region === 'kr' ? 'KRX' : 'NASDAQ',
  }));
  const stocks = listings.map((row) => ({
    ...row,
    market: row.requestedMarket,
    status: 'ACTIVE',
    currency: region === 'us' ? 'USD' : 'KRW',
    sharesOutstanding: '10000000000000000',
  }));
  const prices = listings.map((row, i) => ({
    symbol: row.symbol,
    lastPrice: `${100 - i}.1234`,
    currency: region === 'us' ? 'USD' : 'KRW',
    timestamp: '2026-09-04T20:00:00Z' as string | null,
  }));
  return { region, listings, stocks, prices, companies, observedAt: now };
}
test('month boundary is KST and one success prevents repeat collection during the same month', () => {
  expect(selectionMonth(new Date('2026-09-30T14:59:59Z'))).toBe('2026-09');
  expect(selectionMonth(new Date('2026-09-30T15:00:00Z'))).toBe('2026-10');
  expect(shouldRefreshMonthlySelection({ selectionMonth: '2026-09' }, now)).toBe(false);
  expect(shouldRefreshMonthlySelection({ selectionMonth: '2026-08' }, now)).toBe(true);
  expect(
    shouldRefreshMonthlySelection({ last_attempt_at: new Date(now.getTime() - 5 * 3600_000) }, now),
  ).toBe(false);
  expect(
    shouldRefreshMonthlySelection({ last_attempt_at: new Date(now.getTime() - 6 * 3600_000) }, now),
  ).toBe(true);
  expect(shouldRefreshMonthlySelection(undefined, now)).toBe(true);
});
test.each(['kr', 'us'] as const)(
  '%s calculates exact decimal prices with large share counts and keeps 20 issuers',
  (region) => {
    const result = selectMonthlyMarketLeaders(input(region));
    expect(result.leaders).toHaveLength(20);
    expect(result.leaders[0]!.marketCap).toBe('1001234000000000000');
    expect(result.leaders[0]!.companyId).toBe('company-0');
    expect(result.currency).toBe(region === 'kr' ? 'KRW' : 'USD');
  },
);
test('US CUSIP classes are added once and the largest class represents the issuer', () => {
  const data = input();
  data.listings[1]!.isinCode = 'US0000002000';
  data.stocks[1]!.isinCode = 'US0000002000';
  const result = selectMonthlyMarketLeaders(data);
  expect(result.leaders[0]).toMatchObject({
    stockCode: 'S0',
    marketCap: '1992468000000000000',
    issuer: 'CUSIP6:000000',
  });
  expect(result.leaders[0]!.components.map((row) => row.symbol)).toEqual(['S0', 'S1']);
  expect(result.leaders.map((row) => row.stockCode)).not.toContain('S1');
});
test('CIK joins differing issuer codes, normalizes padding, and rejects contradictory identities', () => {
  const data = input();
  data.companies[0]!.cik = '12';
  data.companies[1]!.cik = '0000000012';
  const result = selectMonthlyMarketLeaders(data);
  expect(result.leaders[0]!.components).toHaveLength(2);
  data.listings[1]!.isinCode = 'US0000002000';
  data.stocks[1]!.isinCode = 'US0000002000';
  data.companies[1]!.cik = '13';
  expect(() => selectMonthlyMarketLeaders(data)).toThrow('충돌');
});
test('KR corp identity joins classes without changing company records; ambiguous top owners fail', () => {
  const data = input('kr');
  data.companies[1]!.corpCode = data.companies[0]!.corpCode;
  expect(selectMonthlyMarketLeaders(data).leaders[0]!.components).toHaveLength(2);
  data.companies.push({ ...data.companies[0]!, id: 'duplicate' });
  expect(() => selectMonthlyMarketLeaders(data)).toThrow('식별');
});
test('never substitutes ETFs, preferred shares or unverifiable ADR share units', () => {
  const data = input();
  data.listings.push({
    ...data.listings[0]!,
    symbol: 'ETF',
    isinCode: 'US9000001000',
    securityType: 'ETF',
  });
  data.listings.push({
    ...data.listings[0]!,
    symbol: 'ADR',
    isinCode: 'US9000011000',
    securityType: 'DEPOSITARY_RECEIPT',
  });
  data.listings.push({
    ...data.listings[0]!,
    symbol: 'PREF',
    isinCode: 'US9000021000',
    isCommonShare: false,
  });
  expect(selectMonthlyMarketLeaders(data).eligibleCount).toBe(25);
});
test('partial responses, duplicate ISIN, unknown types, mismatched market/currency and future prices fail closed', () => {
  const mutations = [
    (d: ReturnType<typeof input>) => d.stocks.pop(),
    (d: ReturnType<typeof input>) => d.prices.pop(),
    (d: ReturnType<typeof input>) => {
      d.listings[1]!.isinCode = d.listings[0]!.isinCode;
    },
    (d: ReturnType<typeof input>) => {
      d.listings[0]!.securityType = 'UNKNOWN';
    },
    (d: ReturnType<typeof input>) => {
      d.stocks[0]!.market = 'NYSE';
    },
    (d: ReturnType<typeof input>) => {
      d.prices[0]!.currency = 'KRW';
    },
    (d: ReturnType<typeof input>) => {
      d.prices[0]!.timestamp = '2026-10-01T00:00:00Z';
    },
  ];
  for (const mutate of mutations) {
    const d = input();
    mutate(d);
    expect(() => selectMonthlyMarketLeaders(d)).toThrow();
  }
});
test('missing timestamp cannot hide a top-20 sized stock; smaller exclusions retain provenance and bounds', () => {
  const data = input();
  data.prices[0]!.timestamp = null;
  expect(() => selectMonthlyMarketLeaders(data)).toThrow('경계');
  data.prices[0]!.timestamp = '2026-09-04T20:00:00Z';
  data.prices[24]!.timestamp = null;
  const result = selectMonthlyMarketLeaders(data);
  expect(result.excluded[0]).toMatchObject({ symbol: 'S24', reason: 'NO_PRICE_TIME' });
  expect(BigInt(result.quality.excludedMaximumMarketCap)).toBeLessThan(
    BigInt(result.quality.cutoffMarketCap),
  );
  data.stocks[24]!.sharesOutstanding = '0';
  expect(() => selectMonthlyMarketLeaders(data)).toThrow('시총 상한');
  data.stocks[24]!.sharesOutstanding = '100';
  data.prices[24]!.lastPrice = '0';
  expect(() => selectMonthlyMarketLeaders(data)).toThrow('시총 상한');
});
function serviceFixture(enabled = true, currentMonth: string | null = null) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const runner = {
    connect: async () => undefined,
    release: jest.fn(async () => undefined),
    isTransactionActive: false,
    startTransaction: jest.fn(async () => {
      runner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      runner.isTransactionActive = false;
    }),
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
      if (sql.includes('SELECT st.*'))
        return [{ selectionMonth: currentMonth, active_snapshot_id: 'old', last_attempt_at: null }];
      return [];
    }),
  };
  const ingest = jest.fn(async () => undefined),
    stocksAll = jest.fn();
  const service = new MarketSelectionService(
    { nodeEnv: 'production' } as never,
    { createQueryRunner: () => runner } as never,
    { enabled, stocksAll } as never,
    { ingest } as never,
    jest.fn(),
  );
  return { service, queries, runner, ingest, stocksAll };
}
afterEach(() => jest.useRealTimers());
test('missing Toss config disables both regions independently, with no source fetch', async () => {
  const f = serviceFixture(false);
  await f.service.refresh();
  expect(f.stocksAll).not.toHaveBeenCalled();
  expect(f.queries.filter((q) => q.sql.includes('UNCONFIGURED')).map((q) => q.values[0])).toEqual([
    'kr',
    'us',
  ]);
});
test('already successful current month makes no collection or database mutation', async () => {
  jest.useFakeTimers().setSystemTime(now);
  const f = serviceFixture(true, '2026-09');
  const collect = jest.spyOn(f.service, 'collect');
  await f.service.refresh();
  expect(collect).not.toHaveBeenCalled();
  expect(f.queries.some((q) => /^INSERT|^UPDATE/.test(q.sql))).toBe(false);
});
test('regional failure preserves old snapshot and does not block the other region', async () => {
  jest.useFakeTimers().setSystemTime(now);
  const f = serviceFixture();
  jest.spyOn(f.service, 'collect').mockRejectedValue(new Error('provider failed'));
  await f.service.refresh();
  expect(
    f.queries.filter((q) => q.sql.includes("status='VALIDATION_PENDING'")).map((q) => q.values[0]),
  ).toEqual(['kr', 'us']);
  expect(
    f.queries.some(
      (q) =>
        q.sql.includes('INSERT INTO market_cap_snapshots') || q.sql.includes("status='AVAILABLE'"),
    ),
  ).toBe(false);
});
test('each monthly snapshot commits all 20 memberships before switching its active pointer', async () => {
  jest.useFakeTimers().setSystemTime(now);
  const f = serviceFixture();
  jest.spyOn(f.service, 'collect').mockImplementation(
    async (region) =>
      ({
        region,
        observedAt: now,
        basisDate: '2026-09-04',
        ...selectMonthlyMarketLeaders(input(region)),
        sourceCount: 2000,
        raw: { selectionMonth: '2026-09', method: MONTHLY_SELECTION_METHOD },
      }) as never,
  );
  await f.service.refresh();
  expect(f.runner.commitTransaction).toHaveBeenCalledTimes(2);
  expect(
    f.queries.filter((q) => q.sql.includes('INSERT INTO market_cap_memberships')),
  ).toHaveLength(40);
  const updates = f.queries.filter((q) => q.sql.includes("status='AVAILABLE'"));
  expect(updates.map((q) => q.values[2])).toEqual(['kr', 'us']);
  expect(f.ingest).toHaveBeenCalledTimes(2);
});

test('an unpriced secondary share class prevents publishing an understated top issuer', () => {
  const data = input();
  data.listings[24]!.isinCode = 'US0000002000';
  data.stocks[24]!.isinCode = 'US0000002000';
  data.prices[24]!.timestamp = null;
  expect(() => selectMonthlyMarketLeaders(data)).toThrow('경계');
});
test('membership failure rolls back each snapshot and never publishes a partial active list', async () => {
  jest.useFakeTimers().setSystemTime(now);
  const f = serviceFixture();
  jest.spyOn(f.service, 'collect').mockImplementation(
    async (region) =>
      ({
        region,
        observedAt: now,
        basisDate: '2026-09-04',
        ...selectMonthlyMarketLeaders(input(region)),
        sourceCount: 2000,
        raw: { selectionMonth: '2026-09', method: MONTHLY_SELECTION_METHOD },
      }) as never,
  );
  const originalQuery = f.runner.query.getMockImplementation()!;
  f.runner.query.mockImplementation(async (sql, values) => {
    if (sql.includes('INSERT INTO market_cap_memberships')) throw new Error('database failed');
    return originalQuery(sql, values);
  });
  await f.service.refresh();
  expect(f.runner.rollbackTransaction).toHaveBeenCalledTimes(2);
  expect(f.runner.commitTransaction).not.toHaveBeenCalled();
  expect(f.queries.some((row) => row.sql.includes("status='AVAILABLE'"))).toBe(false);
  expect(f.ingest).not.toHaveBeenCalled();
});

test('explicit bond/preferred/warrant names override inconsistent provider common-stock flags', () => {
  const data = input();
  for (const [index, name] of [
    'AT&T 일반채권(2066-11-01 5.350%)',
    '리버티 우선주 A',
    'ADAMAS TRUST INC 9.125% NTS 07/01/29 USD25',
    '코어사이언티픽 콜 워런트',
  ].entries())
    data.listings.push({
      ...data.listings[0]!,
      symbol: `BAD${index}`,
      isinCode: `US99999${index}1000`,
      name,
    });
  const result = selectMonthlyMarketLeaders(data);
  expect(result.eligibleCount).toBe(25);
  expect(result.classificationExcluded.map((row) => row.symbol)).toEqual([
    'BAD0',
    'BAD1',
    'BAD2',
    'BAD3',
  ]);
});

test('ranked share classes retain their own verified company IDs for news scope without inventing identities', () => {
  const data = input();
  data.listings[1]!.isinCode = 'US0000002000';
  data.stocks[1]!.isinCode = 'US0000002000';
  let result = selectMonthlyMarketLeaders(data);
  expect(result.leaders[0]!.components).toMatchObject([
    { symbol: 'S0', companyId: 'company-0' },
    { symbol: 'S1', companyId: 'company-1' },
  ]);
  data.companies = data.companies.filter((company) => company.id !== 'company-1');
  result = selectMonthlyMarketLeaders(data);
  expect(result.leaders[0]!.components).toMatchObject([
    { symbol: 'S0', companyId: 'company-0' },
    { symbol: 'S1', companyId: null },
  ]);
});
