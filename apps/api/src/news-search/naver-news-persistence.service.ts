import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  NAVER_NEWS_METADATA_POLICY,
  NEWS_MATCHER_VERSION,
  createNewsCompanyMatcher,
  newsBadgeCompanyAliases,
} from '@orsem/contracts';
import {
  CompanyEntity,
  NewsItemEntity,
  NewsSourceCompanyEntity,
  SourceItemEntity,
  attachNewsArticle,
  lockNewsArticleCompanies,
} from '@orsem/database';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { publicSourceUrl } from '../common/news-url';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import type { NaverNewsSearchResult } from './naver-news-search.service';

export interface NaverNewsCollectionContext {
  topicId?: string;
  kind?: 'MARKET' | 'ASSET';
  region?: 'kr' | 'us' | 'global';
}

export function naverPlainText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, '')
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/giu, (entity) => {
      const named: Record<string, string> = {
        '&amp;': '&',
        '&quot;': '"',
        '&apos;': "'",
        '&lt;': '<',
        '&gt;': '>',
        '&nbsp;': ' ',
      };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
      const number =
        entity[2]?.toLowerCase() === 'x'
          ? parseInt(entity.slice(3, -1), 16)
          : parseInt(entity.slice(2, -1), 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
    });
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Persists API metadata only; never requests linked pages or retains user search terms. */
@Injectable()
export class NaverNewsPersistenceService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
  ) {}

  async persist(result: NaverNewsSearchResult, context: NaverNewsCollectionContext = {}) {
    if (this.config.fixtureMode || !result.items.length) return;
    const db = this.database.requireDataSource();
    const companies = await db.getRepository(CompanyEntity).find({ where: { isListed: true } });
    const match = createNewsCompanyMatcher(newsBadgeCompanyAliases(companies));
    const observedAt = new Date();
    // Stable lock order for a batch also prevents two concurrent searches from deadlocking.
    const entries = result.items
      .flatMap((item) => {
        const url = publicSourceUrl(item.originallink) ?? publicSourceUrl(item.link);
        if (!url) return [];
        const title = naverPlainText(item.title);
        const description = naverPlainText(item.description);
        const ids = match(`${title} ${description}`);
        const externalId = createHash('sha256')
          .update(item.link || url)
          .digest('hex');
        return [{ item, url, title, description, ids, externalId }];
      })
      .sort((left, right) => left.externalId.localeCompare(right.externalId));
    await db.transaction(async (manager) => {
      await lockNewsArticleCompanies(
        manager,
        entries.flatMap((entry) => entry.ids),
      );
      const sources = manager.getRepository(SourceItemEntity);
      for (const { item, url, title, description, ids, externalId } of entries) {
        // The unique key also serializes articles with no matching company.
        await sources
          .createQueryBuilder()
          .insert()
          .values({
            id: randomUUID(),
            source: 'NAVER',
            externalId,
            url,
            title,
            firstObservedAt: observedAt,
            rightsMode: NAVER_NEWS_METADATA_POLICY.rightsMode,
          })
          .orIgnore()
          .execute();
        const source = await sources
          .createQueryBuilder('source')
          .where('source.source = :provider AND source.externalId = :externalId', {
            provider: 'NAVER',
            externalId,
          })
          .setLock('pessimistic_write')
          .getOneOrFail();
        const metadata = source.rawMetadataJson ?? {};
        const relevance = manager.getRepository(NewsSourceCompanyEntity);
        const existing = await relevance.find({ where: { sourceItemId: source.id } });
        // Reviews and other explicit evidence survive later metadata refreshes unchanged.
        const preservedIds = new Set(
          existing
            .filter((relation) => relation.matchMethod !== 'TITLE_SUMMARY_ALIAS')
            .map((relation) => relation.companyId),
        );
        const relatedIds = [...new Set([...preservedIds, ...ids])];
        const related = companies.filter((company) => relatedIds.includes(company.id));
        const tickers = related.flatMap((company) =>
          [company.stockCode || company.ticker].filter((ticker): ticker is string =>
            Boolean(ticker),
          ),
        );
        const rawHash = createHash('sha256').update(JSON.stringify(item)).digest('hex');
        const timestamp = Date.parse(item.pubDate);
        Object.assign(source, {
          url,
          title,
          sourceName: '네이버 뉴스',
          sourceKind: 'AGGREGATOR',
          sourcePolicyJson: { ...NAVER_NEWS_METADATA_POLICY },
          companyId: relatedIds.length === 1 ? relatedIds[0]! : null,
          publishedAt: Number.isFinite(timestamp) ? new Date(timestamp) : null,
          processedAt: observedAt,
          rawHash,
          rightsMode: NAVER_NEWS_METADATA_POLICY.rightsMode,
          provenanceUrl: publicSourceUrl(item.link),
          rawMetadataJson: {
            ...metadata,
            providerOriginal: { ...item },
            description,
            tickers,
            language: 'ko',
            publisherId: 'naver-news',
            sourceDomain: new URL(url).hostname,
            marketRegion: metadata.marketRegion ?? context.region ?? 'global',
            collectedAt: observedAt.toISOString(),
            lastBuildDate: result.lastBuildDate,
            topicIds: [
              ...new Set([
                ...strings(metadata.topicIds),
                ...(context.topicId ? [context.topicId] : []),
              ]),
            ],
            topicKinds: [
              ...new Set([
                ...strings(metadata.topicKinds),
                ...(context.kind ? [context.kind] : []),
              ]),
            ],
          },
        });
        await sources.save(source);
        await manager.getRepository(NewsItemEntity).upsert(
          {
            sourceItemId: source.id,
            companyId: source.companyId,
            title,
            description,
            publishedAt: source.publishedAt,
            tickersJson: tickers,
            tagsJson: [],
          },
          ['sourceItemId'],
        );
        await relevance.delete({ sourceItemId: source.id, matchMethod: 'TITLE_SUMMARY_ALIAS' });
        const automaticIds = ids.filter((companyId) => !preservedIds.has(companyId));
        if (automaticIds.length)
          await relevance.insert(
            automaticIds.map((companyId) => ({
              sourceItemId: source.id,
              companyId,
              inputHash: rawHash,
              matchMethod: 'TITLE_SUMMARY_ALIAS',
              matcherVersion: NEWS_MATCHER_VERSION,
            })),
          );
        await attachNewsArticle(manager, source, { companyIds: ids });
      }
    });
  }
}
