import type { Company, Event, IrSource, Review, SourceItem } from '@orsem/contracts';
import { NEWS_RSS_FEEDS, sourceKindForSource, type NewsRssFeedId } from '@orsem/contracts';
import {
  dateToIso,
  type CompanyEntity,
  type IrSourceEntity,
  type NewsItemEntity,
  type ReviewEntity,
  type SourceItemEntity,
} from '@orsem/database';
import { publicNewsDescription, publicNewsTranslation } from '../common/news-translation';

export function mapCompany(row: CompanyEntity): Company {
  return {
    id: row.id,
    market: row.market,
    corpCode: row.corpCode,
    stockCode: row.stockCode,
    ticker: row.ticker,
    cik: row.cik,
    nameKo: row.nameKo,
    nameEn: row.nameEn,
    isListed: row.isListed,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapFixtureSourceItem(item: SourceItem): SourceItem {
  // 예시 계약에는 검증에 필요한 원문 해시가 없으므로 번역을 신뢰하지 않습니다.
  return {
    ...item,
    sourceKind: item.sourceKind ?? sourceKindForSource(item.source),
    publisherId: item.publisherId ?? item.sourceName ?? item.source,
    sourceCount: item.sourceCount ?? 1,
    description: publicNewsDescription(item.rightsMode, item.description),
    translation: null,
  };
}

export function mapFixtureEvent(event: Event): Event {
  return {
    ...event,
    sourceItems: event.sourceItems
      .filter((item) => item.source !== 'NAVER')
      .map((item) => mapFixtureSourceItem(item)),
  };
}

export function mapSourceItem(row: SourceItemEntity, news?: NewsItemEntity | null): SourceItem {
  const metadata = row.rawMetadataJson ?? {};
  const feed =
    typeof metadata.feedId === 'string'
      ? NEWS_RSS_FEEDS[metadata.feedId as NewsRssFeedId]
      : undefined;
  const region = feed?.marketRegion ?? metadata.marketRegion;
  return {
    id: row.id,
    articleId: row.newsArticleId ?? null,
    sourceKind: row.sourceKind ?? feed?.sourceKind ?? sourceKindForSource(row.source),
    sourceCount: 1,
    publisherId:
      feed?.publisherId ??
      (typeof metadata.publisherId === 'string'
        ? metadata.publisherId
        : (row.sourceName ?? row.source)),
    marketRegion:
      region === 'kr' || region === 'us' || region === 'global'
        ? region
        : row.source === 'SEC'
          ? 'us'
          : row.source === 'OPENDART'
            ? 'kr'
            : 'unknown',
    source: row.source,
    externalId: row.externalId,
    url: row.url,
    title: news?.title ?? row.title,
    description: publicNewsDescription(
      row.rightsMode,
      news?.description ?? row.rawMetadataJson?.description,
    ),
    translation: publicNewsTranslation(row),
    sourceName: row.sourceName,
    author: row.author,
    publishedAt: dateToIso(news?.publishedAt ?? row.publishedAt),
    firstObservedAt: row.firstObservedAt.toISOString(),
    processedAt: dateToIso(row.processedAt),
    rightsMode: row.rightsMode,
    provenanceUrl: row.provenanceUrl,
    tickers:
      news?.tickersJson ??
      (Array.isArray(metadata.tickers)
        ? metadata.tickers.filter((value): value is string => typeof value === 'string')
        : []),
    tags:
      news?.tagsJson ??
      (Array.isArray(metadata.tags)
        ? metadata.tags.filter((value): value is string => typeof value === 'string')
        : []),
  };
}

export function mapReview(row: ReviewEntity): Review {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    reason: row.reason,
    status: row.status,
    classificationResult: row.classificationResult,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: dateToIso(row.resolvedAt),
  };
}

export function mapIrSource(row: IrSourceEntity): IrSource {
  return {
    id: row.id,
    companyId: row.companyId,
    url: row.url,
    sourceType: row.sourceType as IrSource['sourceType'],
    rightsMode: row.rightsMode as IrSource['rightsMode'],
    isActive: row.isActive,
    lastCheckedAt: dateToIso(row.lastCheckedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
