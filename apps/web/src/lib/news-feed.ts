import type { SourceItem } from '../types';

const published = (item: SourceItem) => Date.parse(item.publishedAt ?? item.firstObservedAt) || 0;
const key = (item: SourceItem) => {
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
    pages.flatMap((page) => page.providerGroups ?? []),
    limit,
  ).filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > Date.now());
}
