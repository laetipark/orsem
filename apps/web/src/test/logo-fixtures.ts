import type { CompanyLogoResponse, ReviewedLocalLogo, ReviewedLogoMapping } from '@orsem/contracts';

export const logoCompanyId = '00000000-0000-4000-8000-000000000001';
export const logoCompany = {
  id: logoCompanyId,
  nameKo: 'Apple',
  market: 'NASDAQ',
  stockCode: null,
  ticker: 'AAPL',
};
export function reviewedMapping(value: string): ReviewedLogoMapping {
  return {
    value,
    sourceUrl: 'https://example.com/identity-evidence',
    reviewStatus: 'reviewed',
    reviewedAt: '2026-09-01T00:00:00Z',
  };
}
export function localLogo(path = '/logos/test-only.svg'): ReviewedLocalLogo {
  return {
    path,
    source: 'manual',
    sourceUrl: 'https://example.com/license',
    license: 'Test-only original drawing',
    attribution: 'Orsem test fixture',
    rightsReviewed: true,
    reviewStatus: 'reviewed',
    reviewedAt: '2026-09-01T00:00:00Z',
    logoRole: 'company',
  };
}
export function logoResponse(): CompanyLogoResponse {
  return {
    metadata: {
      companyId: logoCompanyId,
      market: 'US',
      exchange: 'NASDAQ',
      symbol: 'AAPL',
      assetType: 'stock',
      issuerId: null,
      officialDomain: null,
      providers: {
        logoDev: { enabled: true, ticker: null, domain: null, logoRole: 'company' },
        brandfetch: { enabled: true, ticker: null, domain: null, logoRole: 'company' },
      },
      manualLogo: null,
      localLogo: null,
      issuerLogo: null,
      reviewStatus: 'unreviewed',
      reviewedAt: null,
    },
    providers: {
      logoDev: { enabled: true, publishableKey: 'pk_test_only' },
      brandfetch: { enabled: true, clientId: 'test_client' },
    },
  };
}
