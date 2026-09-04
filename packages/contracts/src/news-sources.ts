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

function readerPolicy(policyUrl: string, official = false): NewsSourcePolicy {
  return Object.freeze({
    rightsMode: official ? RightsMode.OFFICIAL_PUBLIC_DATA : RightsMode.STORE_METADATA_ONLY,
    aiAllowed: false,
    fullTextStorageAllowed: false,
    publicRedistributionAllowed: false,
    displayAllowed: true,
    metadataStorageAllowed: true,
    notifyAllowed: false,
    policyUrl,
    checkedAt: '2026-09-05',
  });
}

const etoday = {
  publisher: '이투데이',
  publisherId: 'etoday',
  marketRegion: 'kr' as const,
  sourceKind: NewsSourceKind.INDEPENDENT_MEDIA,
  rightsContext: 'NONCOMMERCIAL_RSS_READER',
  rightsPolicyUrl: 'https://www.etoday.co.kr/rss/',
  policy: readerPolicy('https://www.etoday.co.kr/rss/'),
};
const fed = {
  publisher: 'Federal Reserve',
  publisherId: 'federal-reserve',
  marketRegion: 'us' as const,
  sourceKind: NewsSourceKind.OFFICIAL_RELEASE,
  rightsContext: 'OFFICIAL_RSS_READER',
  rightsPolicyUrl: 'https://www.federalreserve.gov/disclaimer.htm',
  policy: readerPolicy('https://www.federalreserve.gov/disclaimer.htm', true),
};
export const NEWS_RSS_FEEDS = Object.freeze({
  'etoday-market': {
    ...etoday,
    url: 'https://rss.etoday.co.kr/eto/market_news.xml',
    categories: ['MARKET'],
  },
  'etoday-finance': {
    ...etoday,
    url: 'https://rss.etoday.co.kr/eto/finance_news.xml',
    categories: ['FINANCE'],
  },
  'etoday-industry': {
    ...etoday,
    url: 'https://rss.etoday.co.kr/eto/industry_news.xml',
    categories: ['INDUSTRY'],
  },
  'etoday-economy': {
    ...etoday,
    url: 'https://rss.etoday.co.kr/eto/economy_news.xml',
    categories: ['ECONOMY'],
  },
  'fed-press': {
    ...fed,
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    categories: ['ECONOMY', 'POLICY'],
  },
  'fed-speeches': {
    ...fed,
    url: 'https://www.federalreserve.gov/feeds/speeches_and_testimony.xml',
    categories: ['ECONOMY', 'POLICY'],
  },
  'bls-latest': {
    publisher: 'Bureau of Labor Statistics',
    publisherId: 'bls',
    marketRegion: 'us' as const,
    sourceKind: NewsSourceKind.OFFICIAL_RELEASE,
    rightsContext: 'OFFICIAL_RSS_READER',
    rightsPolicyUrl: 'https://www.bls.gov/opub/copyright-information.htm',
    policy: readerPolicy('https://www.bls.gov/opub/copyright-information.htm', true),
    url: 'https://www.bls.gov/feed/bls_latest.rss',
    categories: ['ECONOMY'],
  },
});
export const NEWS_RSS_FEED_IDS = [
  'etoday-market',
  'etoday-finance',
  'etoday-industry',
  'etoday-economy',
  'fed-press',
  'fed-speeches',
  'bls-latest',
] as const;
export type NewsRssFeedId = (typeof NEWS_RSS_FEED_IDS)[number];

// Search availability does not grant the original publisher's storage/display rights.
// Add a publisher only after recording those rights in this registry.
export const APPROVED_GDELT_DOMAINS: readonly string[] = Object.freeze([]);
export const APPROVED_GDELT_SOURCE_POLICIES: Readonly<Record<string, NewsSourcePolicy>> =
  Object.freeze({});
export const NEWS_SOURCE_CANDIDATES = Object.freeze([
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
