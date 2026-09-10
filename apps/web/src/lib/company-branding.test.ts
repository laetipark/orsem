import { describe, expect, it } from 'vitest';
import { buildLogoCandidates, providerTicker } from './company-branding';
import { logoResourceKey } from './use-company-logo';
import { localLogo, logoCompany, logoResponse, reviewedMapping } from '../test/logo-fixtures';

describe('provider-specific security identity', () => {
  it.each([
    ['005930', 'KOSPI', '005930.KS'],
    ['005935', 'KOSPI', '005935.KS'],
    ['035720', 'KOSDAQ', '035720.KQ'],
    ['0123A0', 'KOSDAQ', '0123A0.KQ'],
    ['005930.KS', 'KOSPI', '005930.KS'],
    ['035720.KQ', 'KOSDAQ', '035720.KQ'],
    ['005930.KQ', 'KOSPI', null],
    ['005930', null, null],
    ['005930', 'KRX', null],
  ])('preserves %s on %s as %s', (symbol, exchange, expected) => {
    const response = logoResponse();
    Object.assign(response.metadata, { market: 'KR', symbol, exchange });
    expect(providerTicker(response.metadata, 'logoDev')).toBe(expected);
    expect(providerTicker(response.metadata, 'brandfetch')).toBeNull();
    expect(response.metadata.symbol).toBe(symbol);
  });
  it('does not collapse common/preferred stocks or GOOG/GOOGL', () => {
    expect(
      logoResourceKey({ ...logoCompany, id: undefined, market: 'KOSPI', stockCode: '005930' }),
    ).not.toBe(
      logoResourceKey({ ...logoCompany, id: undefined, market: 'KOSPI', stockCode: '005935' }),
    );
    for (const symbol of ['AAPL', 'GOOG', 'GOOGL']) {
      const response = logoResponse();
      response.metadata.symbol = symbol;
      expect(providerTicker(response.metadata, 'logoDev')).toBe(symbol);
    }
    expect(logoResourceKey({ ...logoCompany, id: undefined, ticker: 'GOOG' })).not.toBe(
      logoResourceKey({ ...logoCompany, id: undefined, ticker: 'GOOGL' }),
    );
  });
  it('requires independent reviewed mappings for BRK.B and BRK-B', () => {
    const response = logoResponse();
    response.metadata.symbol = 'BRK.B';
    expect(providerTicker(response.metadata, 'logoDev')).toBeNull();
    expect(providerTicker(response.metadata, 'brandfetch')).toBeNull();
    response.metadata.providers.logoDev.ticker = reviewedMapping('BRK.B');
    response.metadata.providers.brandfetch.ticker = reviewedMapping('BRK-B');
    expect(providerTicker(response.metadata, 'logoDev')).toBe('BRK.B');
    expect(providerTicker(response.metadata, 'brandfetch')).toBe('BRK-B');
    expect(response.metadata.symbol).toBe('BRK.B');
  });
});

describe('reviewed local and direct external candidates', () => {
  it('places reviewed ETF product logos ahead of issuer fallbacks across providers', () => {
    const response = logoResponse();
    response.metadata.assetType = 'etf';
    response.metadata.issuerId = 'reviewed-issuer';
    response.metadata.providers.logoDev.ticker = reviewedMapping('ISSUER');
    response.metadata.providers.logoDev.logoRole = 'issuer';
    response.metadata.providers.brandfetch.ticker = reviewedMapping('FUND');
    response.metadata.providers.brandfetch.logoRole = 'fund';
    response.metadata.localLogo = { ...localLogo(), logoRole: 'issuer' };
    const candidates = buildLogoCandidates(response);
    expect(candidates.map((candidate) => candidate.logoRole)).toEqual(['fund', 'issuer', 'issuer']);
    expect(candidates[0]?.provider).toBe('brandfetch');
  });
  it('orders manual/local/primary ticker/domain/secondary/issuer and preserves load-vs-review meaning', () => {
    const response = logoResponse();
    response.metadata.manualLogo = localLogo('/logos/manual.svg');
    response.metadata.localLogo = localLogo('/logos/reviewed.svg');
    response.metadata.officialDomain = reviewedMapping('apple.com');
    const candidates = buildLogoCandidates(response);
    expect(candidates.map((item) => item.url)).toEqual([
      '/logos/manual.svg',
      '/logos/reviewed.svg',
      'https://img.logo.dev/ticker/AAPL?token=pk_test_only&size=128&format=webp&fallback=404',
      'https://img.logo.dev/apple.com?token=pk_test_only&size=128&format=webp&fallback=404',
      'https://cdn.brandfetch.io/ticker/AAPL/w/128/h/128/fallback/404?c=test_client',
      'https://cdn.brandfetch.io/domain/apple.com/w/128/h/128/fallback/404?c=test_client',
    ]);
    expect(candidates[2]?.reviewStatus).toBe('unreviewed');
    expect(candidates[3]?.reviewStatus).toBe('reviewed');
  });
  it('works without keys and rejects unreviewed rights, paths, domains and secret keys', () => {
    const response = logoResponse();
    response.providers.logoDev.publishableKey = null;
    response.providers.brandfetch.clientId = null;
    expect(buildLogoCandidates(response)).toEqual([]);
    response.metadata.localLogo = localLogo();
    expect(buildLogoCandidates(response)).toHaveLength(1);
    response.metadata.localLogo.rightsReviewed = false;
    expect(buildLogoCandidates(response)).toEqual([]);
    response.metadata.localLogo = localLogo('https://evil.example/x.svg');
    expect(buildLogoCandidates(response)).toEqual([]);
    response.providers.logoDev.publishableKey = 'sk_secret';
    expect(buildLogoCandidates(response)).toEqual([]);
    response.metadata.officialDomain = {
      ...reviewedMapping('apple.com'),
      reviewStatus: 'unreviewed',
    };
    response.metadata.symbol = null;
    response.metadata.exchange = null;
    response.providers.logoDev.publishableKey = 'pk_test_only';
    expect(buildLogoCandidates(response)).toEqual([]);
  });
  it('rejects unresolved identity and respects global/per-instrument provider kill switches', () => {
    const response = logoResponse();
    response.metadata.assetType = 'unknown';
    expect(buildLogoCandidates(response)).toEqual([]);
    response.metadata.assetType = 'stock';
    response.metadata.symbol = null;
    expect(buildLogoCandidates(response)).toEqual([]);
    response.metadata.symbol = 'AAPL';
    response.providers.logoDev.enabled = false;
    response.metadata.providers.brandfetch.enabled = false;
    expect(buildLogoCandidates(response)).toEqual([]);
  });
  it('distinguishes reviewed ETF product and issuer; never infers issuer from ticker/name/index', () => {
    const response = logoResponse();
    response.metadata.assetType = 'etf';
    response.metadata.symbol = 'SPY';
    expect(buildLogoCandidates(response)).toEqual([]);
    response.metadata.providers.logoDev.ticker = reviewedMapping('SPY');
    expect(buildLogoCandidates(response)).toEqual([]); // company role is wrong for fund
    response.metadata.providers.logoDev.logoRole = 'fund';
    expect(buildLogoCandidates(response)[0]?.logoRole).toBe('fund');
    response.metadata.issuerLogo = { ...localLogo('/logos/issuer.svg'), logoRole: 'issuer' };
    expect(buildLogoCandidates(response)).toHaveLength(1);
    response.metadata.issuerId = 'verified-issuer';
    expect(buildLogoCandidates(response).at(-1)?.logoRole).toBe('issuer');
  });
});
