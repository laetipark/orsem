import { RightsMode } from './enums';

export const NewsSourceKind = {
  OFFICIAL_DISCLOSURE: 'OFFICIAL_DISCLOSURE',
  OFFICIAL_RELEASE: 'OFFICIAL_RELEASE',
  COMPANY_IR: 'COMPANY_IR',
  PRESS_RELEASE: 'PRESS_RELEASE',
  INDEPENDENT_MEDIA: 'INDEPENDENT_MEDIA',
  AGGREGATOR: 'AGGREGATOR',
  UNKNOWN: 'UNKNOWN',
} as const;
export type NewsSourceKind = (typeof NewsSourceKind)[keyof typeof NewsSourceKind];
export const NewsContentState = {
  UNAVAILABLE: 'UNAVAILABLE',
  PENDING: 'PENDING',
  AVAILABLE: 'AVAILABLE',
  FAILED: 'FAILED',
} as const;
export type NewsContentState = (typeof NewsContentState)[keyof typeof NewsContentState];
export type NewsPermission = boolean | 'UNKNOWN' | null;
export type NewsAudience = 'ADMIN_UI' | 'MEMBER_UI' | 'SHARED_ROOM' | 'BOT';
export type NewsRightsStatus =
  'APPROVED' | 'METADATA_ONLY' | 'LINK_ONLY' | 'REQUIRES_CONTRACT_REVIEW' | 'UNKNOWN' | 'BLOCKED';
export interface NewsSourcePolicy {
  policyVersion?: 2;
  policyId?: string;
  provider?: string;
  rightsStatus?: NewsRightsStatus;
  summaryStorageAllowed?: NewsPermission;
  translationAllowed?: NewsPermission;
  allowedAudiences?: readonly NewsAudience[];
  rightsMode: RightsMode;
  aiAllowed: NewsPermission;
  fullTextStorageAllowed: NewsPermission;
  publicRedistributionAllowed: NewsPermission;
  displayAllowed: NewsPermission;
  metadataStorageAllowed: NewsPermission;
  notifyAllowed: boolean;
  policyUrl: string;
  checkedAt: string;
}

/** A research finding is not a grant of storage, translation or publisher rights. */
export function unreviewedNewsPolicy(
  policyId: string,
  policyUrl: string,
  provider?: string,
): NewsSourcePolicy {
  return Object.freeze({
    policyVersion: 2,
    policyId,
    provider,
    rightsStatus: 'UNKNOWN',
    rightsMode: RightsMode.STORE_METADATA_ONLY,
    metadataStorageAllowed: null,
    summaryStorageAllowed: null,
    displayAllowed: null,
    aiAllowed: null,
    translationAllowed: null,
    fullTextStorageAllowed: false,
    publicRedistributionAllowed: provider === 'FINNHUB' ? false : null,
    notifyAllowed: false,
    allowedAudiences: Object.freeze(['ADMIN_UI'] as const),
    policyUrl,
    checkedAt: '2026-09-07',
  });
}

export const NEWS_EXTERNAL_API_POLICIES: Readonly<
  Record<'MARKETAUX' | 'ALPHAVANTAGE' | 'FINNHUB', NewsSourcePolicy>
> = Object.freeze({
  MARKETAUX: unreviewedNewsPolicy(
    'marketaux-news-v1',
    'https://www.marketaux.com/tos',
    'MARKETAUX',
  ),
  ALPHAVANTAGE: unreviewedNewsPolicy(
    'alphavantage-news-v1',
    'https://www.alphavantage.co/terms_of_service/',
    'ALPHAVANTAGE',
  ),
  FINNHUB: unreviewedNewsPolicy(
    'finnhub-news-v1',
    'https://finnhub.io/terms-of-service',
    'FINNHUB',
  ),
});

/** Covers the GDELT dataset's title/link metadata, never the linked publisher's full text. */
export const GDELT_METADATA_POLICY: NewsSourcePolicy = Object.freeze({
  rightsMode: RightsMode.STORE_METADATA_ONLY,
  aiAllowed: false,
  fullTextStorageAllowed: false,
  publicRedistributionAllowed: true,
  displayAllowed: true,
  metadataStorageAllowed: true,
  notifyAllowed: false,
  policyUrl: 'https://www.gdeltproject.org/about.html#termsofuse',
  checkedAt: '2026-09-06',
});

/** User-configured metadata retention for authenticated news readers; no article-body rights. */
export const NAVER_NEWS_METADATA_POLICY: NewsSourcePolicy = Object.freeze({
  policyVersion: 2,
  policyId: 'naver-news-metadata-v1',
  provider: 'NAVER',
  rightsStatus: 'METADATA_ONLY',
  rightsMode: RightsMode.LINK_ONLY,
  metadataStorageAllowed: true,
  summaryStorageAllowed: true,
  displayAllowed: true,
  aiAllowed: false,
  translationAllowed: false,
  fullTextStorageAllowed: false,
  publicRedistributionAllowed: false,
  notifyAllowed: false,
  allowedAudiences: Object.freeze(['ADMIN_UI', 'MEMBER_UI'] as const),
  policyUrl: 'https://developers.naver.com/docs/serviceapi/search/news/news.md',
  checkedAt: '2026-09-24',
});

export function isGdeltDomainFilter(domain: string): boolean {
  return (
    domain.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain) &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/u.test(domain)
  );
}

function officialContentPolicy(policyUrl: string): NewsSourcePolicy {
  return Object.freeze({
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    aiAllowed: true,
    fullTextStorageAllowed: true,
    publicRedistributionAllowed: true,
    displayAllowed: true,
    metadataStorageAllowed: true,
    notifyAllowed: false,
    policyUrl,
    checkedAt: '2026-09-05',
  });
}

const fed = Object.freeze({
  publisher: 'Federal Reserve',
  publisherId: 'federal-reserve',
  marketRegion: 'us' as const,
  sourceKind: NewsSourceKind.OFFICIAL_RELEASE,
  rightsContext: 'OFFICIAL_RSS_READER',
  rightsPolicyUrl: 'https://www.federalreserve.gov/disclaimer.htm',
  policy: officialContentPolicy('https://www.federalreserve.gov/disclaimer.htm'),
});

export const NEWS_RSS_FEED_IDS = Object.freeze([
  'fed-press',
  'fed-speeches',
  'bls-latest',
  'eia-today',
  'eia-press',
  'hankyung-finance-rss',
] as const);
export type NewsRssFeedId = (typeof NEWS_RSS_FEED_IDS)[number];
export interface NewsRssFeedDefinition {
  publisher: string;
  publisherId: string;
  marketRegion: 'kr' | 'us' | 'global';
  sourceKind: NewsSourceKind;
  rightsContext: string;
  rightsPolicyUrl: string;
  policy: NewsSourcePolicy;
  url: string;
  categories: readonly string[];
  enabled?: boolean;
  allowedHosts?: readonly string[];
}

// Covers EIA-authored text; photographs, logos and third-party visual materials are excluded.
const eia = Object.freeze({
  publisher: 'U.S. Energy Information Administration',
  publisherId: 'eia',
  marketRegion: 'global' as const,
  sourceKind: NewsSourceKind.OFFICIAL_RELEASE,
  rightsContext: 'OFFICIAL_RSS_READER',
  rightsPolicyUrl: 'https://www.eia.gov/about/copyrights_reuse.php',
  policy: Object.freeze({
    ...officialContentPolicy('https://www.eia.gov/about/copyrights_reuse.php'),
    checkedAt: '2026-09-06',
  }),
});

/** The complete runtime allowlist for the NEWS_RSS connector. */
export const NEWS_RSS_FEEDS = Object.freeze({
  'fed-press': Object.freeze({
    ...fed,
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    categories: Object.freeze(['ECONOMY', 'POLICY']),
  }),
  'fed-speeches': Object.freeze({
    ...fed,
    url: 'https://www.federalreserve.gov/feeds/speeches_and_testimony.xml',
    categories: Object.freeze(['ECONOMY', 'POLICY']),
  }),
  'bls-latest': Object.freeze({
    publisher: 'Bureau of Labor Statistics',
    publisherId: 'bls',
    marketRegion: 'us' as const,
    sourceKind: NewsSourceKind.OFFICIAL_RELEASE,
    rightsContext: 'OFFICIAL_RSS_READER',
    rightsPolicyUrl: 'https://www.bls.gov/opub/copyright-information.htm',
    policy: officialContentPolicy('https://www.bls.gov/opub/copyright-information.htm'),
    url: 'https://www.bls.gov/feed/bls_latest.rss',
    categories: Object.freeze(['ECONOMY']),
  }),
  'eia-today': Object.freeze({
    ...eia,
    url: 'https://www.eia.gov/rss/todayinenergy.xml',
    categories: Object.freeze(['ECONOMY', 'ENERGY', 'COMMODITIES']),
  }),
  'eia-press': Object.freeze({
    ...eia,
    url: 'https://www.eia.gov/rss/press_rss.xml',
    categories: Object.freeze(['ECONOMY', 'ENERGY', 'COMMODITIES']),
  }),
  'hankyung-finance-rss': Object.freeze({
    publisher: '한국경제',
    publisherId: 'hankyung',
    marketRegion: 'kr' as const,
    sourceKind: NewsSourceKind.INDEPENDENT_MEDIA,
    rightsContext: 'REVIEWED_NEWS_METADATA_V2',
    rightsPolicyUrl: 'https://www.hankyung.com/feed',
    policy: unreviewedNewsPolicy('hankyung-finance-v1', 'https://www.hankyung.com/feed'),
    url: 'https://www.hankyung.com/feed/finance',
    enabled: false,
    allowedHosts: Object.freeze(['www.hankyung.com']),
    categories: Object.freeze(['COMPANY', 'MARKET']),
  }),
} satisfies Record<NewsRssFeedId, NewsRssFeedDefinition>);

export const DEFAULT_REGISTERED_IR_POLICY: NewsSourcePolicy = Object.freeze({
  rightsMode: RightsMode.STORE_METADATA_ONLY,
  aiAllowed: false,
  fullTextStorageAllowed: false,
  publicRedistributionAllowed: false,
  displayAllowed: false,
  metadataStorageAllowed: true,
  notifyAllowed: false,
  policyUrl: 'about:blank',
  checkedAt: '2026-09-05',
});

export const NEWS_IR_SOURCE_PROFILE_IDS = Object.freeze([
  'samsung-global',
  'nvidia-ir-press',
  'broadcom-ir-news',
  'palo-alto-networks-ir-news',
] as const);
export type NewsIrSourceProfileId = (typeof NEWS_IR_SOURCE_PROFILE_IDS)[number];
export interface NewsIrSourceProfileDefinition {
  url: string;
  publisher: string;
  publisherId: string;
  marketRegion: 'kr' | 'us' | 'global';
  sourceKind: NewsSourceKind;
  rightsContext: string;
  rightsPolicyUrl: string;
  publishedAtMode?: 'SOURCE_LOCAL_TIME';
  publishedTimeZone?: 'Asia/Seoul';
  enabled: boolean;
  allowedHosts: readonly string[];
  companySymbols?: readonly string[];
  companyMarketRegion?: 'us';
  policy: NewsSourcePolicy;
}

/** The complete runtime IR allowlist. An arbitrary registered URL never inherits these rights. */
export const NEWS_IR_SOURCE_PROFILES = Object.freeze({
  'samsung-global': Object.freeze({
    enabled: true,
    allowedHosts: Object.freeze(['news.samsung.com']),
    url: 'https://news.samsung.com/global/feed',
    publisher: 'Samsung Global Newsroom',
    publisherId: 'samsung-global-newsroom',
    marketRegion: 'global' as const,
    sourceKind: NewsSourceKind.COMPANY_IR,
    rightsContext: 'PRIVATE_COMPANY_NEWSROOM_READER',
    rightsPolicyUrl: 'https://news.samsung.com/global/terms',
    publishedAtMode: 'SOURCE_LOCAL_TIME' as const,
    publishedTimeZone: 'Asia/Seoul' as const,
    policy: Object.freeze({
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      aiAllowed: true,
      fullTextStorageAllowed: true,
      publicRedistributionAllowed: false,
      displayAllowed: true,
      metadataStorageAllowed: true,
      notifyAllowed: false,
      policyUrl: 'https://news.samsung.com/global/terms',
      checkedAt: '2026-09-05',
    }) satisfies NewsSourcePolicy,
  }),
  'nvidia-ir-press': conditionalIrProfile(
    'nvidia-ir-press',
    'NVIDIA',
    'NVDA',
    'https://nvidianews.nvidia.com/cats/press_release.xml',
    'https://www.nvidia.com/en-us/about-nvidia/rss/',
  ),
  'broadcom-ir-news': conditionalIrProfile(
    'broadcom-ir-news',
    'Broadcom',
    'AVGO',
    'https://investors.broadcom.com/rss/news-releases.xml',
    'https://www.broadcom.com/company/legal/terms-of-use',
  ),
  'palo-alto-networks-ir-news': conditionalIrProfile(
    'palo-alto-networks-ir-news',
    'Palo Alto Networks',
    'PANW',
    'https://investors.paloaltonetworks.com/rss/news-releases.xml',
    'https://www.paloaltonetworks.com/legal-notices/terms-of-use',
  ),
} satisfies Record<NewsIrSourceProfileId, NewsIrSourceProfileDefinition>);

function conditionalIrProfile(
  id: string,
  publisher: string,
  symbol: string,
  url: string,
  policyUrl: string,
): NewsIrSourceProfileDefinition {
  return Object.freeze({
    url,
    publisher,
    publisherId: id,
    enabled: false,
    marketRegion: 'us',
    companyMarketRegion: 'us',
    companySymbols: Object.freeze([symbol]),
    allowedHosts: Object.freeze([new URL(url).hostname]),
    sourceKind: NewsSourceKind.COMPANY_IR,
    rightsContext: 'REVIEWED_NEWS_METADATA_V2',
    rightsPolicyUrl: policyUrl,
    policy: unreviewedNewsPolicy(`${id}-v1`, policyUrl),
  });
}

export function getNewsIrSourceProfile(value: string): NewsIrSourceProfileDefinition | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
      return null;
    return (
      Object.values(NEWS_IR_SOURCE_PROFILES).find(
        (profile) => profile.url === url.toString() && profile.allowedHosts.includes(url.hostname),
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function registeredNewsSourcePolicies(): readonly NewsSourcePolicy[] {
  return [
    NAVER_NEWS_METADATA_POLICY,
    ...Object.values(NEWS_EXTERNAL_API_POLICIES),
    ...Object.values(NEWS_IR_SOURCE_PROFILES)
      .filter((profile) => profile.enabled)
      .map((profile) => profile.policy),
    ...Object.values(NEWS_RSS_FEEDS)
      .filter((feed) => !('enabled' in feed) || feed.enabled)
      .map((feed) => feed.policy),
  ];
}

export function currentNewsSourcePolicy(
  policy: NewsSourcePolicy | null | undefined,
): NewsSourcePolicy | null {
  if (!policy || policy.policyVersion !== 2) return policy ?? null;
  return (
    registeredNewsSourcePolicies().find((current) => current.policyId === policy.policyId) ?? null
  );
}

export function isNewsPolicyV2Approved(policy: NewsSourcePolicy | null | undefined): boolean {
  return Boolean(
    policy?.policyVersion === 2 &&
    policy.policyId &&
    ['APPROVED', 'METADATA_ONLY'].includes(policy.rightsStatus ?? '') &&
    policy.metadataStorageAllowed === true &&
    policy.displayAllowed === true &&
    policy.policyUrl.startsWith('https://') &&
    policy.checkedAt &&
    policy.fullTextStorageAllowed === false,
  );
}

export function newsPolicyApprovalReady(policy: NewsSourcePolicy | null | undefined): boolean {
  return policy?.policyVersion === 2
    ? isNewsPolicyV2Approved(policy)
    : policy?.metadataStorageAllowed === true && policy.displayAllowed === true;
}

export function newsPolicyAllowsAudience(
  policy: NewsSourcePolicy | null | undefined,
  audience: NewsAudience = 'MEMBER_UI',
  currentPolicy: NewsSourcePolicy | null | undefined = currentNewsSourcePolicy(policy),
): boolean {
  if (!newsPolicyApprovalReady(policy)) return false;
  if (policy?.policyVersion !== 2) return true;
  return (
    isNewsPolicyV2Approved(currentPolicy) &&
    policy.allowedAudiences?.includes(audience) === true &&
    currentPolicy?.allowedAudiences?.includes(audience) === true
  );
}

export function isNewsSummaryStorageAllowed(policy: NewsSourcePolicy | null | undefined): boolean {
  return policy?.policyVersion === 2
    ? policy.summaryStorageAllowed === true
    : policy?.metadataStorageAllowed === true &&
        [RightsMode.OFFICIAL_PUBLIC_DATA, RightsMode.PRIVATE_DISPLAY_ONLY].includes(
          policy.rightsMode as
            typeof RightsMode.OFFICIAL_PUBLIC_DATA | typeof RightsMode.PRIVATE_DISPLAY_ONLY,
        );
}

export function isNewsTranslationAllowed(policy: NewsSourcePolicy | null | undefined): boolean {
  return (
    policy?.aiAllowed === true && (policy.policyVersion !== 2 || policy.translationAllowed === true)
  );
}

export function isNewsMetadataCollectionAllowed(policy: NewsSourcePolicy | null | undefined) {
  return (
    policy?.metadataStorageAllowed === true &&
    (policy.policyVersion !== 2 || isNewsPolicyV2Approved(policy))
  );
}

export function isNewsDisplayAllowed(policy: NewsSourcePolicy | null | undefined) {
  return newsPolicyApprovalReady(policy);
}

export function isNewsFullTextCollectionAllowed(policy: NewsSourcePolicy | null | undefined) {
  return isNewsDisplayAllowed(policy) && policy?.fullTextStorageAllowed === true;
}

// Search availability does not grant the original publisher's storage/display rights.
// Add a publisher only after recording those rights in this registry.
export const APPROVED_GDELT_DOMAINS: readonly string[] = Object.freeze([]);
export const APPROVED_GDELT_SOURCE_POLICIES: Readonly<Record<string, NewsSourcePolicy>> =
  Object.freeze({});
/** Research inventory only. These entries are deliberately absent from every runtime allowlist. */
export const NEWS_SOURCE_RESEARCH_CANDIDATES = Object.freeze([
  {
    publisher: '이투데이',
    url: 'https://www.etoday.co.kr/rss/',
    status: 'CONTENT_RIGHTS_NOT_APPROVED',
  },
  { publisher: '매일경제', url: 'https://www.mk.co.kr/rss/', status: 'POLICY_REVIEW_REQUIRED' },
  { publisher: '뉴시스', url: 'https://www.newsis.com/RSS/', status: 'POLICY_REVIEW_REQUIRED' },
  {
    publisher: '한국경제TV',
    url: 'https://help.wowtv.co.kr/ServiceInfo/Newsstand/Index?menuSeq=553',
    status: 'FEED_AND_POLICY_REVIEW_REQUIRED',
  },
  { publisher: 'Reuters', url: 'https://www.reuters.com/', status: 'POLICY_REVIEW_REQUIRED' },
  { publisher: 'AP', url: 'https://apnews.com/', status: 'POLICY_REVIEW_REQUIRED' },
  {
    publisher: 'CNBC',
    url: 'https://www.cnbc.com/rss-feeds/',
    status: 'FEED_AND_POLICY_REVIEW_REQUIRED',
  },
]);

export function sourceKindForSource(source: string): NewsSourceKind {
  if (source === 'OPENDART' || source === 'SEC') return NewsSourceKind.OFFICIAL_DISCLOSURE;
  if (source === 'IR') return NewsSourceKind.COMPANY_IR;
  if (source === 'NEWS_RSS') return NewsSourceKind.INDEPENDENT_MEDIA;
  if (['MARKETAUX', 'ALPHAVANTAGE', 'FINNHUB'].includes(source)) return NewsSourceKind.AGGREGATOR;
  return NewsSourceKind.UNKNOWN;
}

export function isNewsAiAllowed(source: {
  source?: string;
  connector?: string;
  sourcePolicyJson?: unknown;
  sourcePolicy?: unknown;
}): boolean {
  if ((source.source ?? source.connector) === 'NAVER') return false;
  const policy = source.sourcePolicyJson ?? source.sourcePolicy;
  return Boolean(
    policy &&
    typeof policy === 'object' &&
    'aiAllowed' in policy &&
    policy.aiAllowed === true &&
    (!('policyVersion' in policy) ||
      policy.policyVersion !== 2 ||
      ('translationAllowed' in policy &&
        policy.translationAllowed === true &&
        newsPolicyAllowsAudience(policy as NewsSourcePolicy, 'ADMIN_UI'))),
  );
}

/** Only remove known tracking fields; query parameters may identify distinct articles. */
export function canonicalNewsUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid article URL');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key))
      url.searchParams.delete(key);
  }
  return url.toString();
}
