import 'reflect-metadata';
import {
  CompanyAliasEntity,
  CompanyEntity,
  SourceItemEntity,
  createTypeOrmOptions,
} from '@orsem/database';
import { DataSource, In, MoreThan } from 'typeorm';
import { createNewsCompanyMatcher, newsCompanyAliases } from '../connectors/news-company-matching';
import { replaceNewsCompanyRelevance } from '../connectors/news-relevance';

/** Dry-run by default. No source, rights, content, translation, date or alert records are changed. */
export async function backfillNewsRelevance(
  source: DataSource,
  apply = false,
): Promise<{ scanned: number; relatedSources: number; relations: number; applied: boolean }> {
  const aliases = newsCompanyAliases(
    await source
      .getRepository(CompanyEntity)
      .find({ select: { id: true, nameKo: true, nameEn: true, ticker: true, stockCode: true } }),
    await source.getRepository(CompanyAliasEntity).find(),
  );
  const matchCompanies = createNewsCompanyMatcher(aliases);
  const evidence = (row: SourceItemEntity) =>
    [row.title, row.rawMetadataJson?.description]
      .filter((value) => typeof value === 'string')
      .join('\n');
  let after = '';
  const summary = { scanned: 0, relatedSources: 0, relations: 0, applied: apply };
  for (;;) {
    const rows = await source.getRepository(SourceItemEntity).find({
      select: { id: true, title: true, companyId: true, source: true, rawMetadataJson: true },
      where: {
        source: In(['IR', 'NEWS_RSS', 'GDELT', 'SEC']),
        ...(after ? { id: MoreThan(after) } : {}),
      },
      order: { id: 'ASC' },
      take: 100,
    });
    if (!rows.length) break;
    for (const snapshot of rows) {
      const classify = (row: SourceItemEntity) => {
        const matches = matchCompanies(evidence(row)).map((companyId) => ({
          companyId,
          matchMethod: 'METADATA_ALIAS',
        }));
        if (row.source === 'IR' && row.companyId)
          matches.push({ companyId: row.companyId, matchMethod: 'REGISTERED_IR' });
        if (row.source === 'SEC') {
          const ids = row.rawMetadataJson?.companyIds;
          for (const id of [...(Array.isArray(ids) ? ids : []), row.companyId])
            if (typeof id === 'string' && /^[a-f0-9-]{36}$/iu.test(id))
              matches.push({ companyId: id, matchMethod: 'SEC_CIK' });
        }
        return [...new Map(matches.map((match) => [match.companyId, match])).values()];
      };
      // The locked row is authoritative on apply; avoid classifying the same article twice.
      let count = apply ? 0 : classify(snapshot).length;
      if (apply)
        await source.transaction(async (manager) => {
          const row = await manager.getRepository(SourceItemEntity).findOne({
            select: {
              id: true,
              title: true,
              source: true,
              companyId: true,
              rawMetadataJson: true,
            },
            where: { id: snapshot.id },
            lock: { mode: 'pessimistic_write' },
          });
          if (!row) return;
          const matches = classify(row);
          count = matches.length;
          await replaceNewsCompanyRelevance(manager, row.id, evidence(row), matches);
        });
      summary.scanned++;
      summary.relations += count;
      if (count) summary.relatedSources++;
    }
    after = rows.at(-1)!.id;
  }
  return summary;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !['--apply', '--dry-run'].includes(arg)) ||
    (args.includes('--apply') && args.includes('--dry-run'))
  )
    throw new Error('Usage: backfill-news-relevance [--dry-run | --apply]');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const source = new DataSource(createTypeOrmOptions(process.env.DATABASE_URL));
  void source
    .initialize()
    .then(() => backfillNewsRelevance(source, args.includes('--apply')))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write(
        'News relevance backfill failed; no source text or credentials were logged.\n',
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      if (source.isInitialized) await source.destroy();
    });
}
