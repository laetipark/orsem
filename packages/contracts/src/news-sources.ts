import { RightsMode } from './enums';

export const NewsSourceKind = {
  OFFICIAL_DISCLOSURE: 'OFFICIAL_DISCLOSURE',
  OFFICIAL_RELEASE: 'OFFICIAL_RELEASE',
  COMPANY_IR: 'COMPANY_IR',
  PRESS_RELEASE: 'PRESS_RELEASE',
  INDEPENDENT_MEDIA: 'INDEPENDENT_MEDIA',
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
export type NewsPermission = boolean | 'UNKNOWN';
export interface NewsSourcePolicy {
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
] as const);
export type NewsRssFeedId = (typeof NEWS_RSS_FEED_IDS)[number];
interface NewsRssFeedDefinition {
  publisher: string;
  publisherId: string;
  marketRegion: 'kr' | 'us' | 'global';
  sourceKind: NewsSourceKind;
  rightsContext: string;
  rightsPolicyUrl: string;
  policy: NewsSourcePolicy;
  url: string;
  categories: readonly string[];
}

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

export const NEWS_IR_SOURCE_PROFILE_IDS = Object.freeze(['samsung-global'] as const);
export type NewsIrSourceProfileId = (typeof NEWS_IR_SOURCE_PROFILE_IDS)[number];
interface NewsIrSourceProfileDefinition {
  url: string;
  publisher: string;
  publisherId: string;
  marketRegion: 'kr' | 'us' | 'global';
  sourceKind: NewsSourceKind;
  rightsContext: string;
  rightsPolicyUrl: string;
  publishedAtMode: 'SOURCE_LOCAL_TIME';
  publishedTimeZone: 'Asia/Seoul';
  policy: NewsSourcePolicy;
}

/** The complete runtime IR allowlist. An arbitrary registered URL never inherits these rights. */
export const NEWS_IR_SOURCE_PROFILES = Object.freeze({
  'samsung-global': Object.freeze({
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
} satisfies Record<NewsIrSourceProfileId, NewsIrSourceProfileDefinition>);

export function isNewsMetadataCollectionAllowed(policy: NewsSourcePolicy | null | undefined) {
  return policy?.metadataStorageAllowed === true;
}

export function isNewsDisplayAllowed(policy: NewsSourcePolicy | null | undefined) {
  return policy?.metadataStorageAllowed === true && policy.displayAllowed === true;
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
    policy && typeof policy === 'object' && 'aiAllowed' in policy && policy.aiAllowed === true,
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
