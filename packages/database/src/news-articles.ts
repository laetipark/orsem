import { createHash, randomUUID } from 'node:crypto';
import { canonicalNewsUrl } from '@orsem/contracts';
import type { EntityManager } from 'typeorm';
import { NewsArticleEntity, SourceItemEntity } from './entities';

/** Called inside the source ingestion transaction; never merges/deletes provenance rows. */
export async function attachNewsArticle(
  manager: EntityManager,
  source: SourceItemEntity,
): Promise<void> {
  if (source.source === 'NAVER' || source.newsArticleId) return;
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalNewsUrl(source.url);
  } catch {
    return;
  }
  const urlHash = createHash('sha256').update(canonicalUrl).digest('hex');
  const repository = manager.getRepository(NewsArticleEntity);
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
  const article = await repository.findOneByOrFail({ urlHash });
  source.newsArticleId = article.id;
  await manager.getRepository(SourceItemEntity).update(source.id, { newsArticleId: article.id });
}
