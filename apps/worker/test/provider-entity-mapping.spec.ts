import {
  resolveProviderNewsEntities,
  type NewsEntityCompany,
} from '../src/connectors/provider-entity-mapping';

const companies: NewsEntityCompany[] = [
  { id: 'nvda', market: 'NASDAQ', ticker: 'NVDA', stockCode: null, isListed: true },
  { id: 'brkb', market: 'NYSE', ticker: 'BRK.B', stockCode: null, isListed: true },
  { id: 'samsung', market: 'KOSPI', ticker: null, stockCode: '005930', isListed: true },
  { id: 'kosdaq', market: 'KOSDAQ', ticker: null, stockCode: '123456', isListed: true },
  { id: 'legacy', market: 'KRX', ticker: null, stockCode: '987654', isListed: true },
  { id: 'old', market: 'NASDAQ', ticker: 'DELISTED', stockCode: null, isListed: false },
  { id: 'otc', market: 'OTHER', ticker: 'OTC', stockCode: null, isListed: true },
];

describe('provider news symbols reuse the company master', () => {
  it('maps US canonical symbols and exact share classes without altering master records', () => {
    const before = structuredClone(companies);
    const result = resolveProviderNewsEntities(
      [{ symbol: 'nvda', country: 'us', exchange: 'NASDAQ' }, { symbol: 'US:BRK.B' }],
      companies,
    );
    expect(result.companyIds).toEqual(['brkb', 'nvda']);
    expect(result.resolved.map((item) => item.canonicalId)).toEqual(['US:NVDA', 'US:BRK.B']);
    expect(companies).toEqual(before);
    expect(
      resolveProviderNewsEntities([{ symbol: 'BRK-B' }], companies).unresolved[0]?.reason,
    ).toBe('NOT_FOUND');
  });

  it('requires exact KOSPI/KOSDAQ suffixes or explicit Korean metadata for six-digit codes', () => {
    const result = resolveProviderNewsEntities(
      [
        { symbol: '005930.KS' },
        { symbol: '123456.KQ' },
        { symbol: '005930', country: 'kr' },
        { symbol: 'KR:005930' },
        { symbol: '005930', exchange: 'KOSPI' },
        { symbol: '987654.KS' },
      ],
      companies,
    );
    expect(result.companyIds).toEqual(['kosdaq', 'legacy', 'samsung']);
    expect(result.unresolved).toEqual([]);
    expect(
      resolveProviderNewsEntities(
        [{ symbol: '005930' }, { symbol: '005930.KQ' }],
        companies,
      ).unresolved.map((item) => item.reason),
    ).toEqual(['INVALID_SYMBOL', 'NOT_FOUND']);
  });

  it('rejects conflicting country/exchange/suffix and non-stock identifiers', () => {
    for (const symbol of [
      { symbol: '005930.KS', country: 'us' },
      { symbol: 'NVDA', country: 'kr', exchange: 'NASDAQ' },
      { symbol: '123456.KQ', exchange: 'KOSPI' },
      { symbol: 'US:005930.KS' },
    ])
      expect(resolveProviderNewsEntities([symbol], companies).unresolved[0]?.reason).toBe(
        'CONFLICTING_MARKET',
      );
    for (const symbol of [
      { symbol: 'NVDA', country: 'ca' },
      { symbol: 'NVDA', exchange: 'LSE' },
    ])
      expect(resolveProviderNewsEntities([symbol], companies).unresolved[0]?.reason).toBe(
        'UNSUPPORTED_MARKET',
      );
    for (const symbol of ['CRYPTO:BTC', 'FOREX:USD', 'NV DA', '00593.KS'])
      expect(resolveProviderNewsEntities([{ symbol }], companies).unresolved[0]?.reason).toBe(
        'INVALID_SYMBOL',
      );
  });

  it('does not resolve stale, unsupported, unknown or ambiguous tickers and never invents IDs', () => {
    const result = resolveProviderNewsEntities(
      [{ symbol: 'DELISTED' }, { symbol: 'OTC' }, { symbol: 'UNKNOWN' }],
      companies,
    );
    expect(result.companyIds).toEqual([]);
    expect(result.unresolved.map((item) => item.reason)).toEqual([
      'NOT_FOUND',
      'NOT_FOUND',
      'NOT_FOUND',
    ]);
    const duplicate = { ...companies[0]!, id: 'other-nvda', market: 'NYSE' };
    expect(
      resolveProviderNewsEntities([{ symbol: 'NVDA' }], [...companies, duplicate]).unresolved[0]
        ?.reason,
    ).toBe('AMBIGUOUS');
    expect(
      resolveProviderNewsEntities(
        [{ symbol: 'NVDA', exchange: 'NASDAQ' }],
        [...companies, duplicate],
      ).companyIds,
    ).toEqual(['nvda']);
  });

  it('deduplicates repeated symbols and refuses an ambiguous legacy Korean master', () => {
    expect(
      resolveProviderNewsEntities([{ symbol: 'NVDA' }, { symbol: 'NVDA' }], companies).resolved,
    ).toHaveLength(1);
    const duplicate = { ...companies[4]!, id: 'legacy-duplicate' };
    expect(
      resolveProviderNewsEntities([{ symbol: '987654.KS' }], [...companies, duplicate])
        .unresolved[0]?.reason,
    ).toBe('AMBIGUOUS');
    expect(resolveProviderNewsEntities([], companies)).toEqual({
      companyIds: [],
      resolved: [],
      unresolved: [],
    });
  });
});
