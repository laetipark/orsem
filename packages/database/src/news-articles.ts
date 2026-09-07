import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalNewsUrl,
  currentNewsSourcePolicy,
  isNewsDisplayAllowed,
  newsPolicyAllowsAudience,
} from '@orsem/contracts';
import type { EntityManager } from 'typeorm';
import { CompanyEntity, NewsArticleEntity, SourceItemEntity } from './entities';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep amounts, signs and punctuation: similar headlines alone cannot prove syndication. */
export function normalizedNewsTitleHash(title: string): string | null {
  const normalized = title.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

export function originalNewsPublisher(source: SourceItemEntity): string | null {
  const metadata = source.rawMetadataJson;
  const explicitDomain = metadata?.sourceDomain ?? metadata?.publisherDomain;
  if (typeof explicitDomain === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(explicitDomain))
    return explicitDomain.toLowerCase().replace(/^www\./u, '');
  try {
    // Adapters must preserve the original article URL, never their discovery API URL.
    return new URL(source.url).hostname.toLowerCase().replace(/^www\./u, '') || null;
  } catch {
    return null;
  }
}

export function hasReadableNewsMetadata(source: SourceItemEntity): boolean {
  const policy = source.sourcePolicyJson;
  return (
    source.source !== 'NAVER' &&
    isNewsDisplayAllowed(policy) &&
    policy?.rightsMode === source.rightsMode &&
    (policy.policyVersion !== 2 ||
      (newsPolicyAllowsAudience(policy, 'ADMIN_UI') &&
        currentNewsSourcePolicy(policy)?.rightsMode === source.rightsMode))
  );
}

export function isExactSyndicatedNews(
  source: SourceItemEntity,
  candidate: SourceItemEntity,
  companyIds: readonly string[],
  candidateCompanyIds: readonly string[],
): boolean {
  const publisher = originalNewsPublisher(source);
  const titleHash = normalizedNewsTitleHash(source.title);
  return Boolean(
    hasReadableNewsMetadata(source) &&
    hasReadableNewsMetadata(candidate) &&
    titleHash &&
    titleHash === normalizedNewsTitleHash(candidate.title) &&
    publisher &&
    publisher === originalNewsPublisher(candidate) &&
    source.publishedAt &&
    candidate.publishedAt &&
    Math.abs(source.publishedAt.getTime() - candidate.publishedAt.getTime()) <= DAY_MS &&
    companyIds.some((id) => candidateCompanyIds.includes(id)),
  );
}

/** Acquire before writing source rows; sorted row locks serialize overlapping-company ingestion. */
export async function lockNewsArticleCompanies(
  manager: EntityManager,
  companyIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(companyIds)].sort();
  if (!ids.length) return;
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error('News company locks require the ingestion transaction.');
  await manager
    .getRepository(CompanyEntity)
    .createQueryBuilder('company')
    .select('company.id')
    .where('company.id IN (:...ids)', { ids })
    .orderBy('company.id', 'ASC')
    .setLock('pessimistic_write')
    .getMany();
}

export interface AttachNewsArticleOptions {
  companyIds?: readonly string[];
}

/** Called inside the source ingestion transaction; never merges/deletes provenance rows. */
export async function attachNewsArticle(
  manager: EntityManager,
  source: SourceItemEntity,
  options: AttachNewsArticleOptions = {},
): Promise<void> {
  if (source.source === 'NAVER') return;
  source.normalizedTitleHash = normalizedNewsTitleHash(source.title);
  const sourceRepository = manager.getRepository(SourceItemEntity);
  await sourceRepository.update(source.id, { normalizedTitleHash: source.normalizedTitleHash });
  // Do not move existing groups or delete any provider provenance on later refreshes.
  if (source.newsArticleId) return;
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalNewsUrl(source.url);
  } catch {
    return;
  }
  const urlHash = createHash('sha256').update(canonicalUrl).digest('hex');
  const repository = manager.getRepository(NewsArticleEntity);
  let article = await repository.findOneBy({ urlHash });
  const companyIds = [
    ...new Set(options.companyIds ?? (source.companyId ? [source.companyId] : [])),
  ];
  // The caller holds company locks before its first source write. A locking read sees
  // committed rows from preceding transactions even under MySQL REPEATABLE READ.
  if (
    !article &&
    companyIds.length &&
    source.normalizedTitleHash &&
    source.publishedAt &&
    hasReadableNewsMetadata(source) &&
    manager.queryRunner?.isTransactionActive
  ) {
    const candidates = await sourceRepository
      .createQueryBuilder('source')
      .where('source.normalizedTitleHash = :titleHash', { titleHash: source.normalizedTitleHash })
      .andWhere('source.publishedAt BETWEEN :after AND :before', {
        after: new Date(source.publishedAt.getTime() - DAY_MS),
        before: new Date(source.publishedAt.getTime() + DAY_MS),
      })
      .andWhere('source.id <> :sourceId', { sourceId: source.id })
      .andWhere('source.newsArticleId IS NOT NULL')
      .andWhere(
        `(source.companyId IN (:...companyIds) OR EXISTS (
        SELECT 1 FROM news_source_companies related
        WHERE related.source_item_id = source.id AND related.company_id IN (:...companyIds)))`,
        { companyIds },
      )
      .orderBy('source.firstObservedAt', 'ASC')
      .addOrderBy('source.id', 'ASC')
      .take(25)
      .setLock('pessimistic_write')
      .getMany();
    for (const candidate of candidates) {
      // The SQL existence predicate already proves a shared canonical company.
      if (!isExactSyndicatedNews(source, candidate, companyIds, companyIds)) continue;
      article = await repository.findOneBy({ id: candidate.newsArticleId! });
      if (article) break;
    }
  }
  if (article) {
    source.newsArticleId = article.id;
    await sourceRepository.update(source.id, { newsArticleId: article.id });
    return;
  }
  await repository
    .createQueryBuilder()
    .insert()
    .values({
      id: randomUUID(),
      canonicalUrl,
      urlHash,
      sortAt: source.publishedAt ?? source.firstObservedAt,
      firstObservedAt: source.firstObservedAt,
    })
    .orIgnore()
    .execute();
  article = await repository.findOneByOrFail({ urlHash });
  source.newsArticleId = article.id;
  await manager.getRepository(SourceItemEntity).update(source.id, { newsArticleId: article.id });
}
