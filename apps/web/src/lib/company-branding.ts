import {
  normalizeCompanyLogoDomain,
  safeLocalCompanyLogoPath,
  type CompanyLogoMetadata,
  type CompanyLogoProvider,
  type CompanyLogoResponse,
  type ReviewedLocalLogo,
  type ReviewedLogoMapping,
} from '@orsem/contracts';

export interface LogoCandidate {
  url: string;
  provider: CompanyLogoProvider | null;
  logoRole: 'company' | 'fund' | 'issuer';
  sourceUrl: string;
  reviewStatus: 'reviewed' | 'unreviewed';
}

function reviewed(mapping: ReviewedLogoMapping | ReviewedLocalLogo | null) {
  return (
    mapping?.reviewStatus === 'reviewed' &&
    !!mapping.reviewedAt &&
    Number.isFinite(Date.parse(mapping.reviewedAt)) &&
    Date.parse(mapping.reviewedAt) <= Date.now()
  );
}

/** No class-symbol rewrites: punctuation requires a separately reviewed provider mapping. */
export function providerTicker(
  metadata: CompanyLogoMetadata,
  provider: CompanyLogoProvider,
): string | null {
  const mapping = metadata.providers[provider].ticker;
  if (mapping)
    return reviewed(mapping) && /^[A-Z0-9][A-Z0-9.-]{0,31}$/u.test(mapping.value)
      ? mapping.value
      : null;
  if (metadata.assetType !== 'stock') return null;
  const symbol = metadata.symbol;
  if (!symbol) return null;
  if (metadata.market === 'US')
    return /^[A-Z][A-Z0-9]{0,15}$/u.test(symbol) &&
      ['NASDAQ', 'NYSE', 'AMEX', 'NYSEAMERICAN', 'NYSEARCA', 'BATS'].includes(
        metadata.exchange ?? '',
      )
      ? symbol
      : null;
  if (metadata.market !== 'KR' || provider === 'brandfetch') return null;
  const suffix =
    metadata.exchange === 'KOSPI' ? '.KS' : metadata.exchange === 'KOSDAQ' ? '.KQ' : null;
  if (!suffix) return null;
  if (/\.(?:KS|KQ)$/u.test(symbol))
    return symbol.endsWith(suffix) && /^[A-Z0-9]{6}\.(?:KS|KQ)$/u.test(symbol) ? symbol : null;
  return /^[A-Z0-9]{6}$/u.test(symbol) ? `${symbol}${suffix}` : null;
}

function domain(mapping: ReviewedLogoMapping | null) {
  return reviewed(mapping) && normalizeCompanyLogoDomain(mapping!.value) === mapping!.value
    ? mapping!.value
    : null;
}

export function buildLogoCandidates({ metadata, providers }: CompanyLogoResponse): LogoCandidate[] {
  if (metadata.reviewStatus === 'rejected') return [];
  const result: LogoCandidate[] = [];
  const addLocal = (asset: ReviewedLocalLogo | null, issuer = false) => {
    if (
      !asset ||
      !asset.rightsReviewed ||
      !reviewed(asset) ||
      !safeLocalCompanyLogoPath(asset.path)
    )
      return;
    if (
      issuer &&
      (metadata.assetType !== 'etf' || !metadata.issuerId || asset.logoRole !== 'issuer')
    )
      return;
    if (asset.logoRole === 'fallback') return;
    if (metadata.assetType === 'etf' && !['fund', 'issuer'].includes(asset.logoRole)) return;
    if (asset.logoRole === 'issuer' && (!metadata.issuerId || metadata.assetType !== 'etf')) return;
    result.push({
      url: asset.path,
      provider: null,
      logoRole: asset.logoRole,
      sourceUrl: asset.sourceUrl,
      reviewStatus: 'reviewed',
    });
  };
  const external = (provider: CompanyLogoProvider, lookup: 'ticker' | 'domain', issuer = false) => {
    const config = providers[provider];
    const mapping = metadata.providers[provider];
    if ((mapping.logoRole === 'issuer') !== issuer) return;
    if (!config.enabled || !mapping.enabled || mapping.logoRole === 'fallback') return;
    const key =
      provider === 'logoDev' ? providers.logoDev.publishableKey : providers.brandfetch.clientId;
    // The backend also validates these; never turn a secret key into an image URL.
    if (
      !key ||
      (provider === 'logoDev' && !/^pk_[A-Za-z0-9_-]+$/u.test(key)) ||
      (provider === 'brandfetch' && !/^[A-Za-z0-9_-]{3,200}$/u.test(key))
    )
      return;
    const mappingReview =
      lookup === 'ticker' ? mapping.ticker : (mapping.domain ?? metadata.officialDomain);
    if (
      metadata.assetType === 'etf' &&
      (!reviewed(mappingReview) || !['fund', 'issuer'].includes(mapping.logoRole))
    )
      return;
    if (mapping.logoRole === 'issuer' && (metadata.assetType !== 'etf' || !metadata.issuerId))
      return;
    const value = lookup === 'ticker' ? providerTicker(metadata, provider) : domain(mappingReview);
    if (!value) return;
    const url =
      provider === 'logoDev'
        ? `https://img.logo.dev/${lookup === 'ticker' ? 'ticker/' : ''}${encodeURIComponent(value)}?${new URLSearchParams({ token: key, size: '128', format: 'webp', fallback: '404' })}`
        : `https://cdn.brandfetch.io/${lookup}/${encodeURIComponent(value)}/w/128/h/128/fallback/404?${new URLSearchParams({ c: key })}`;
    result.push({
      url,
      provider,
      logoRole: mapping.logoRole,
      sourceUrl:
        mappingReview?.sourceUrl ??
        (provider === 'logoDev'
          ? 'https://www.logo.dev/docs/logo-images/ticker'
          : 'https://docs.brandfetch.com/logo-api/overview'),
      reviewStatus: reviewed(mappingReview) ? 'reviewed' : 'unreviewed',
    });
  };
  addLocal(metadata.manualLogo);
  if (metadata.localLogo?.logoRole !== 'issuer') addLocal(metadata.localLogo);
  external('logoDev', 'ticker');
  external('logoDev', 'domain');
  external('brandfetch', 'ticker');
  external('brandfetch', 'domain');
  if (metadata.localLogo?.logoRole === 'issuer') addLocal(metadata.localLogo, true);
  addLocal(metadata.issuerLogo, true);
  external('logoDev', 'ticker', true);
  external('logoDev', 'domain', true);
  external('brandfetch', 'ticker', true);
  external('brandfetch', 'domain', true);
  return result.filter(
    (candidate, index) => result.findIndex((other) => other.url === candidate.url) === index,
  );
}
