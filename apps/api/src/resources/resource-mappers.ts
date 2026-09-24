import { newsSummaryLine } from './news-summary-line';
import type {
  Company,
  Event,
  IrSource,
  Review,
  SourceItem,
  NewsArticleContentDetail,
} from '@orsem/contracts';
import {
  irSourceSchema,
  NEWS_RSS_FEEDS,
  sourceKindForSource,
  isNewsSummaryStorageAllowed,
  type NewsRssFeedId,
} from '@orsem/contracts';
import {
  dateToIso,
  type CompanyEntity,
  type IrSourceEntity,
  type NewsItemEntity,
  type ReviewEntity,
  type SourceItemEntity,
} from '@orsem/database';
import {
  publicNewsDescription,
  publicNewsTranslation,
  publicNewsTranslationStatus,
} from '../common/news-translation';
import { type NewsContentRecord } from './news-content';

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
    displayMode: 'EXTERNAL_LINK',
    translationStatus: 'UNAVAILABLE',
    contentState: 'UNAVAILABLE',
    contentSourceId: item.contentSourceId ?? null,
    contentLanguage: item.contentLanguage ?? null,
    translated: item.translated ?? false,
    description: publicNewsDescription(item.rightsMode, item.description),
    translation: null,
  };
}

export function mapFixtureEvent(event: Event): Event {
  return {
    ...event,
    sourceItems: event.sourceItems
      .filter((item) => !item.source.startsWith('NAVER'))
      .filter((item) =>
        ['OFFICIAL_DISCLOSURE', 'OFFICIAL_RELEASE', 'COMPANY_IR'].includes(
          item.sourceKind ?? sourceKindForSource(item.source),
        ),
      )
      .map((item) => mapFixtureSourceItem(item)),
  };
}

export function mapSourceItem(
  row: SourceItemEntity,
  news?: NewsItemEntity | null,
  _content?: NewsContentRecord | null,
  _validatedContent?: NewsArticleContentDetail | null,
): SourceItem {
  void _content;
  void _validatedContent;
  const metadata = row.rawMetadataJson ?? {};
  const feed =
    typeof metadata.feedId === 'string'
      ? NEWS_RSS_FEEDS[metadata.feedId as NewsRssFeedId]
      : undefined;
  const region = feed?.marketRegion ?? metadata.marketRegion;
  const providedDescription =
    row.sourcePolicyJson?.policyVersion === 2 && !isNewsSummaryStorageAllowed(row.sourcePolicyJson)
      ? null
      : (news?.description ?? metadata.description);
  const description = ['GDELT', 'ALPACA_NEWS'].includes(row.source)
    ? null
    : publicNewsDescription(row.rightsMode, providedDescription, row.sourcePolicyJson);
  const original = metadata.providerOriginal;
  const providerOriginal =
    row.source === 'NAVER' &&
    description !== null &&
    original &&
    typeof original === 'object' &&
    ['title', 'description', 'link', 'originallink', 'pubDate'].every(
      (key) => typeof (original as Record<string, unknown>)[key] === 'string',
    )
      ? (original as NonNullable<SourceItem['providerOriginal']>)
      : undefined;
  return {
    id: row.id,
    displayMode: 'EXTERNAL_LINK',
    translationStatus: publicNewsTranslationStatus(row),
    articleId: row.newsArticleId ?? null,
    sourceKind: row.sourceKind ?? feed?.sourceKind ?? sourceKindForSource(row.source),
    sourceCount: 1,
    providerCount: 1,
    independentSourceCount:
      (row.sourceKind === 'INDEPENDENT_MEDIA' ||
        (row.sourceKind === 'AGGREGATOR' &&
          metadata.publisherSourceKind === 'INDEPENDENT_MEDIA')) &&
      metadata.independentVerification === true &&
      typeof metadata.originalPublisherId === 'string' &&
      metadata.originalPublisherId.trim().length > 0
        ? 1
        : 0,
    contentState: 'UNAVAILABLE',
    contentSourceId: null,
    contentLanguage:
      typeof metadata.language === 'string' && ['ko', 'en'].includes(metadata.language)
        ? (metadata.language as 'ko' | 'en')
        : null,
    translated: Boolean(publicNewsTranslation(row)),
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
    url: row.url as IrSource['url'],
    title: news?.title ?? row.title,
    summaryLine: newsSummaryLine(
      {
        title: news?.title ?? row.title,
        description: publicNewsDescription(
          row.rightsMode,
          providedDescription,
          row.sourcePolicyJson,
        ),
        translation: publicNewsTranslation(row),
        source: row.source,
        rightsMode: row.rightsMode,
      },
      row.sourcePolicyJson?.aiAllowed === true && row.sourcePolicyJson?.displayAllowed === true,
    ),
    description,
    summaryAllowed: description !== null,
    ...(providerOriginal ? { providerOriginal } : {}),
    ...(typeof metadata.collectedAt === 'string' ? { collectedAt: metadata.collectedAt } : {}),
    translation: ['GDELT', 'ALPACA_NEWS'].includes(row.source) ? null : publicNewsTranslation(row),
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
  return irSourceSchema.parse({
    id: row.id,
    companyId: row.companyId,
    url: row.url,
    sourceType: row.sourceType,
    rightsMode: row.rightsMode,
    isActive: row.isActive,
    lastCheckedAt: dateToIso(row.lastCheckedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
