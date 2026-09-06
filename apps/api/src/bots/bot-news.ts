import { matchesRegion, type Region, type SourceItem } from '@orsem/contracts';
import { publicSourceUrl } from '../common/news-url';
import { newsSummaryLine } from '../resources/news-summary-line';

export interface BotNewsItem {
  title: string;
  description: string;
  url: string;
  sourceName: string;
  publishedAt: string | null;
  translationStatus: SourceItem['translationStatus'];
  relatedCompanies: NonNullable<SourceItem['relatedCompanies']>;
}

export function metadataLine(value: string, limit = 240): string {
  const entities: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' ',
  };
  const text = value
    .replace(/<[^>]*>/gu, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/giu, (whole, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? whole;
      const point =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** A transient, allowlisted projection: never return body or providerOriginal fields. */
export function botNewsItems(
  items: readonly SourceItem[],
  companyIds: ReadonlySet<string>,
  region: Region,
  limit: number,
): BotNewsItem[] {
  const seen = new Set<string>();
  return [...items]
    .sort((a, b) =>
      (b.publishedAt ?? b.firstObservedAt).localeCompare(a.publishedAt ?? a.firstObservedAt),
    )
    .flatMap((item): BotNewsItem[] => {
      const relatedCompanies = (item.relatedCompanies ?? []).filter(
        (company) => companyIds.has(company.id) && matchesRegion(company.market, region),
      );
      const common = ['federal-reserve', 'bls'].includes(item.publisherId ?? '');
      const url = publicSourceUrl(item.url);
      if ((!common && !relatedCompanies.length) || !url || url.length > 1500 || seen.has(url))
        return [];
      seen.add(url);
      return [
        {
          title: metadataLine(item.translation?.title ?? item.title, 180),
          description: metadataLine(newsSummaryLine(item, false), 240) || '요약 미제공',
          url,
          sourceName: metadataLine(item.sourceName || item.source, 60),
          publishedAt: item.publishedAt,
          translationStatus: item.translationStatus,
          relatedCompanies,
        },
      ];
    })
    .slice(0, limit);
}

export function botKst(value: string | null | undefined): string {
  if (!value) return '발행 시각 미제공';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value} KST`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '발행 시각 미제공';
  return `${new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)} KST`;
}

export function messengerNews(items: readonly BotNewsItem[]): string {
  if (!items.length) return '시장 상위 종목 뉴스\n표시할 뉴스가 없습니다.';
  return [
    '시장 상위 종목 뉴스',
    ...items.map((item) => {
      const companies = item.relatedCompanies
        .slice(0, 2)
        .map((company) => company.nameKo)
        .join(', ');
      const more =
        item.relatedCompanies.length > 2 ? ` 외 ${item.relatedCompanies.length - 2}개` : '';
      const status =
        item.translationStatus === 'PENDING'
          ? ' · 원문, 번역 대기'
          : item.translationStatus === 'FAILED'
            ? ' · 원문, 번역 실패'
            : '';
      return `${item.title}${companies ? ` [${companies}${more}]` : ''}\n${item.description}\n${item.sourceName} · ${botKst(item.publishedAt)}${status}\n${item.url}`;
    }),
  ].join('\n\n');
}
