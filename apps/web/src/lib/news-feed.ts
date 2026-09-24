import type { NaverNewsResultSet, NewsFeedPage, SourceItem } from '../types';

const published = (item: SourceItem) => Date.parse(item.publishedAt ?? item.firstObservedAt) || 0;
const key = (item: Pick<SourceItem, 'url' | 'id'>) => {
  try {
    const url = new URL(item.url);
    url.hash = '';
    for (const name of [...url.searchParams.keys()])
      if (/^utm_/iu.test(name)) url.searchParams.delete(name);
    return url.href;
  } catch {
    return item.id;
  }
};

/** Merge sorted streams by their heads, retaining the original order within each provider response. */
export function mergeNews(stored: SourceItem[], providerGroups: SourceItem[][], limit: number) {
  const groups = [[...stored].sort((a, b) => published(b) - published(a)), ...providerGroups];
  const positions = groups.map(() => 0),
    seen = new Set<string>(),
    items: SourceItem[] = [];
  while (items.length < limit) {
    let selected = -1;
    for (let i = 0; i < groups.length; i++) {
      const item = groups[i]![positions[i]!];
      if (
        item &&
        (selected < 0 || published(item) > published(groups[selected]![positions[selected]!]!))
      )
        selected = i;
    }
    if (selected < 0) break;
    const item = groups[selected]![positions[selected]!]!;
    positions[selected]!++;
    const identity = key(item);
    if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) continue;
    if (seen.has(identity)) continue;
    seen.add(identity);
    items.push(item);
  }
  return items;
}

export function newsItems(
  pages: Array<{ items: SourceItem[]; providerGroups?: SourceItem[][] }>,
  limit = Infinity,
) {
  return mergeNews(
    pages.flatMap((page) => page.items),
    [],
    limit,
  ).filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > Date.now());
}

/** Keep each search response independent, including its original ordering and duplicates. */
export function newsResultSets(pages: Array<{ providerResultSets?: NaverNewsResultSet[] }>) {
  const sets = new Map<string, NaverNewsResultSet>();
  for (const page of pages) {
    for (const set of page.providerResultSets ?? []) {
      if (set.expiresAt && Date.parse(set.expiresAt) <= Date.now()) continue;
      if (!sets.has(set.queryId)) sets.set(set.queryId, set);
    }
  }
  return [...sets.values()];
}

function publicUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A chronological view of company and NAVER news; provider responses stay untouched. */
export function chronologicalNewsItems(
  pages: Array<Pick<NewsFeedPage, 'items' | 'providerGroups' | 'providerResultSets'>>,
  limit = Infinity,
) {
  const providerItems = pages.flatMap((page) => page.providerGroups?.flat() ?? []);
  const metadata = new Map(providerItems.map((item) => [key(item), item]));
  const results = newsResultSets(pages).flatMap((set) =>
    set.items.map((original, index): SourceItem => {
      const url = publicUrl(original.originallink) ?? publicUrl(original.link) ?? '';
      const related = metadata.get(key({ url, id: '' }));
      return {
        ...related,
        id: `naver:${set.queryId}:${index}`,
        articleId: null,
        source: 'NAVER',
        sourceName: url ? new URL(url).hostname : '네이버 뉴스',
        externalId: original.link,
        url,
        title: original.title,
        description: original.description,
        providerOriginal: original,
        provenanceUrl: publicUrl(original.link),
        publishedAt: Number.isFinite(Date.parse(original.pubDate))
          ? new Date(original.pubDate).toISOString()
          : null,
        firstObservedAt: set.fetchedAt ?? '',
        expiresAt: set.expiresAt ?? undefined,
        author: null,
        processedAt: null,
        rightsMode: 'LINK_ONLY',
        tickers: related?.tickers ?? [],
        tags: [],
        contentState: 'UNAVAILABLE',
        contentSourceId: null,
        contentLanguage: 'ko',
        translated: false,
        translation: null,
        translationStatus: 'UNAVAILABLE',
        displayMode: 'EXTERNAL_LINK',
      };
    }),
  );
  // Older responses can expose only the normalized provider groups.
  const legacyResults = pages.flatMap((page) =>
    page.providerResultSets === undefined ? (page.providerGroups?.flat() ?? []) : [],
  );
  return mergeNews(
    [...pages.flatMap((page) => page.items), ...results, ...legacyResults],
    [],
    limit,
  );
}
