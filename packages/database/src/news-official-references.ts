import { canonicalNewsUrl, RightsMode } from '@orsem/contracts';
import { Between, In, type EntityManager } from 'typeorm';
import { FilingEntity, NewsItemEntity, SourceItemEntity } from './entities';
import { hasReadableNewsMetadata } from './news-articles';
import { NewsSourceCompanyEntity } from './news-relevance-entities';

const kstDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export interface NewsOfficialReference {
  kind: 'FILING' | 'SOURCE_ITEM';
  id: string;
  matchMethod: 'EXPLICIT_ID' | 'EXPLICIT_URL' | 'COMPANY_TIME';
  status: 'RELATED' | 'CONFIRMED' | 'REJECTED';
  sourceHash: string;
  targetHash?: string | null;
  reviewedAt?: string;
  reviewedByAdminId?: string;
}

export interface NewsOfficialReferenceOptions {
  companyIds?: readonly string[];
  /** Only trusted adapter-selected URL/id fields, never an entire raw response. */
  explicitReferences?: readonly string[];
}

export function extractNewsOfficialIdentifiers(texts: readonly string[]) {
  const text = texts
    .slice(0, 32)
    .map((value) => value.slice(0, 8192))
    .join('\n');
  const dartReceiptIds = new Set(text.match(/\b\d{14}\b/gu) ?? []);
  const secAccessions = new Set(text.match(/\b\d{10}-\d{2}-\d{6}\b/gu) ?? []);
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/gu, ''));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.username || url.password) continue;
      if (url.hostname === 'dart.fss.or.kr') {
        const receipt = url.searchParams.get('rcpNo');
        if (receipt && /^\d{14}$/u.test(receipt)) dartReceiptIds.add(receipt);
      }
      if (url.hostname === 'www.sec.gov' || url.hostname === 'sec.gov') {
        for (const accession of url.pathname.matchAll(/\b(\d{10})(\d{2})(\d{6})\b/gu))
          secAccessions.add(`${accession[1]}-${accession[2]}-${accession[3]}`);
      }
      urls.add(canonicalNewsUrl(url.toString()));
    } catch {
      // Invalid URLs are untrusted input, not alternate fetch instructions.
    }
  }
  return {
    dartReceiptIds: [...dartReceiptIds],
    secAccessions: [...secAccessions],
    urls: [...urls],
  };
}

export function isReadableOfficialNewsSource(source: SourceItemEntity): boolean {
  if (source.source === 'SEC' || source.source === 'OPENDART')
    return (
      source.rightsMode === RightsMode.OFFICIAL_PUBLIC_DATA &&
      (!source.sourcePolicyJson || hasReadableNewsMetadata(source))
    );
  return (
    hasReadableNewsMetadata(source) &&
    ['COMPANY_IR', 'OFFICIAL_RELEASE', 'OFFICIAL_DISCLOSURE'].includes(source.sourceKind ?? '')
  );
}

function canonicalUrlOrNull(value: string): string | null {
  try {
    return canonicalNewsUrl(value);
  } catch {
    return null;
  }
}

/** Pure projection: source identity links establish related material, never financial truth. */
export function buildNewsOfficialReferences(input: {
  source: SourceItemEntity;
  companyIds: readonly string[];
  texts: readonly string[];
  filings: readonly FilingEntity[];
  officialSources: readonly SourceItemEntity[];
  officialCompanyIds?: Readonly<Record<string, readonly string[]>>;
  previous?: unknown;
}): {
  officialReferences: NewsOfficialReference[];
  officialVerification: 'UNVERIFIED' | 'LINKED' | 'CONFIRMED';
} {
  const { source } = input;
  if (!source.rawHash || !hasReadableNewsMetadata(source))
    return { officialReferences: [], officialVerification: 'UNVERIFIED' };
  const identifiers = extractNewsOfficialIdentifiers(input.texts);
  const companyIds = new Set(input.companyIds);
  const sourceTime = source.publishedAt?.getTime();
  const references: NewsOfficialReference[] = [];
  const withinWindow = (time: number) =>
    sourceTime !== undefined && Math.abs(time - sourceTime) <= 3 * 24 * 60 * 60 * 1000;
  for (const filing of input.filings) {
    if (!['OPENDART', 'SEC'].includes(filing.source)) continue;
    const explicit =
      filing.source === 'OPENDART'
        ? identifiers.dartReceiptIds.includes(filing.rceptNo)
        : identifiers.secAccessions.includes(filing.rceptNo);
    // DART publishes a date only; compare calendar dates without inventing an instant.
    const sourceDate = source.publishedAt ? kstDate.format(source.publishedAt) : undefined;
    const dateDifference = sourceDate
      ? Math.abs(Date.parse(sourceDate) - Date.parse(filing.rceptDate))
      : Number.POSITIVE_INFINITY;
    if (!explicit && !(companyIds.has(filing.companyId) && dateDifference <= 3 * 86400000))
      continue;
    references.push({
      kind: 'FILING',
      id: filing.id,
      matchMethod: explicit ? 'EXPLICIT_ID' : 'COMPANY_TIME',
      status: 'RELATED',
      sourceHash: source.rawHash,
    });
  }
  for (const official of input.officialSources) {
    if (official.id === source.id || !isReadableOfficialNewsSource(official)) continue;
    const url = canonicalUrlOrNull(official.url);
    const explicitUrl = url !== null && identifiers.urls.includes(url);
    const explicitId =
      official.source === 'SEC' &&
      official.externalId !== null &&
      identifiers.secAccessions.includes(official.externalId);
    const officialCompanyIds = [
      official.companyId,
      ...(input.officialCompanyIds?.[official.id] ?? []),
      ...(Array.isArray(official.rawMetadataJson?.companyIds)
        ? official.rawMetadataJson.companyIds.filter((id): id is string => typeof id === 'string')
        : []),
    ];
    const sharedCompany = officialCompanyIds.some((id) => id !== null && companyIds.has(id));
    if (
      !explicitUrl &&
      !explicitId &&
      !(sharedCompany && official.publishedAt && withinWindow(official.publishedAt.getTime()))
    )
      continue;
    references.push({
      kind: 'SOURCE_ITEM',
      id: official.id,
      matchMethod: explicitUrl ? 'EXPLICIT_URL' : explicitId ? 'EXPLICIT_ID' : 'COMPANY_TIME',
      status: 'RELATED',
      sourceHash: source.rawHash,
      targetHash: official.rawHash,
    });
  }
  const previous = Array.isArray(input.previous) ? input.previous : [];
  for (const reference of references) {
    const decision = previous.find(
      (value): value is NewsOfficialReference =>
        value !== null &&
        typeof value === 'object' &&
        value.kind === reference.kind &&
        value.id === reference.id &&
        value.sourceHash === source.rawHash &&
        (value.targetHash ?? null) === (reference.targetHash ?? null) &&
        (value.status === 'CONFIRMED' || value.status === 'REJECTED'),
    );
    if (decision) Object.assign(reference, decision);
  }
  references.sort(
    (a, b) =>
      Number(b.status === 'CONFIRMED' || b.status === 'REJECTED') -
        Number(a.status === 'CONFIRMED' || a.status === 'REJECTED') ||
      Number(a.matchMethod === 'COMPANY_TIME') - Number(b.matchMethod === 'COMPANY_TIME') ||
      a.id.localeCompare(b.id),
  );
  const officialReferences = [
    ...new Map(references.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values(),
  ].slice(0, 10);
  return {
    officialReferences,
    officialVerification: officialReferences.some((ref) => ref.status === 'CONFIRMED')
      ? 'CONFIRMED'
      : officialReferences.some(
            (ref) => ref.status === 'RELATED' && ref.matchMethod !== 'COMPANY_TIME',
          )
        ? 'LINKED'
        : 'UNVERIFIED',
  };
}

/** Caller saves news and company links first. This function performs no network or AI requests. */
export async function refreshNewsOfficialReferences(
  manager: EntityManager,
  source: SourceItemEntity,
  options: NewsOfficialReferenceOptions = {},
): Promise<void> {
  const repository = manager.getRepository(SourceItemEntity);
  const previous = source.rawMetadataJson?.officialReferences;
  if (!hasReadableNewsMetadata(source) || !source.rawHash) {
    source.rawMetadataJson = {
      ...source.rawMetadataJson,
      officialReferences: [],
      officialVerification: 'UNVERIFIED',
    };
    await repository.save({ id: source.id, rawMetadataJson: source.rawMetadataJson });
    return;
  }
  const companyIds = [
    ...new Set(options.companyIds ?? (source.companyId ? [source.companyId] : [])),
  ];
  const news = await manager.getRepository(NewsItemEntity).findOneBy({ sourceItemId: source.id });
  const texts = [
    source.title,
    source.url,
    news?.description ?? '',
    ...(options.explicitReferences ?? []),
  ];
  const ids = extractNewsOfficialIdentifiers(texts);
  const filings: FilingEntity[] = [];
  if (ids.dartReceiptIds.length)
    filings.push(
      ...(await manager
        .getRepository(FilingEntity)
        .find({ where: { source: 'OPENDART', rceptNo: In(ids.dartReceiptIds) }, take: 10 })),
    );
  const officialSources: SourceItemEntity[] = [];
  if (ids.secAccessions.length)
    officialSources.push(
      ...(await repository.find({
        where: { source: 'SEC', externalId: In(ids.secAccessions) },
        take: 10,
      })),
    );
  if (ids.urls.length)
    officialSources.push(...(await repository.find({ where: { url: In(ids.urls) }, take: 10 })));
  if (companyIds.length && source.publishedAt) {
    const after = new Date(source.publishedAt.getTime() - 3 * 86400000);
    const before = new Date(source.publishedAt.getTime() + 3 * 86400000);
    filings.push(
      ...(await manager.getRepository(FilingEntity).find({
        where: {
          source: 'OPENDART',
          companyId: In(companyIds),
          rceptDate: Between(kstDate.format(after), kstDate.format(before)),
        },
        order: { rceptDate: 'DESC', id: 'ASC' },
        take: 10,
      })),
    );
    officialSources.push(
      ...(await repository
        .createQueryBuilder('source')
        .where(
          '(source.source IN (:...officialConnectors) OR source.sourceKind IN (:...officialKinds))',
          {
            officialConnectors: ['SEC', 'OPENDART'],
            officialKinds: ['COMPANY_IR', 'OFFICIAL_RELEASE', 'OFFICIAL_DISCLOSURE'],
          },
        )
        .andWhere('source.publishedAt BETWEEN :after AND :before', { after, before })
        .andWhere(
          `(source.companyId IN (:...companyIds) OR EXISTS (
        SELECT 1 FROM news_source_companies related WHERE related.source_item_id = source.id
        AND related.company_id IN (:...companyIds)))`,
          { companyIds },
        )
        .orderBy('source.publishedAt', 'DESC')
        .addOrderBy('source.id', 'ASC')
        .take(10)
        .getMany()),
    );
  }
  // Re-read previously reviewed targets to preserve decisions beyond the rolling candidate limit.
  const reviewed = Array.isArray(previous)
    ? previous
        .filter(
          (ref) =>
            ref &&
            typeof ref === 'object' &&
            ref.sourceHash === source.rawHash &&
            (ref.status === 'CONFIRMED' || ref.status === 'REJECTED') &&
            typeof ref.id === 'string',
        )
        .slice(0, 10)
    : [];
  const reviewedFilings = reviewed
    .filter((ref) => ref.kind === 'FILING')
    .map((ref) => ref.id as string);
  const reviewedSources = reviewed
    .filter((ref) => ref.kind === 'SOURCE_ITEM')
    .map((ref) => ref.id as string);
  if (reviewedFilings.length)
    filings.push(
      ...(await manager.getRepository(FilingEntity).find({ where: { id: In(reviewedFilings) } })),
    );
  if (reviewedSources.length)
    officialSources.push(...(await repository.find({ where: { id: In(reviewedSources) } })));
  const officialCompanyIds: Record<string, string[]> = {};
  const officialSourceIds = [...new Set(officialSources.map((item) => item.id))];
  if (officialSourceIds.length && companyIds.length) {
    const links = await manager.getRepository(NewsSourceCompanyEntity).find({
      where: { sourceItemId: In(officialSourceIds), companyId: In(companyIds) },
    });
    for (const link of links) (officialCompanyIds[link.sourceItemId] ??= []).push(link.companyId);
  }
  const projection = buildNewsOfficialReferences({
    source,
    companyIds,
    texts,
    filings,
    officialSources,
    officialCompanyIds,
    previous,
  });
  source.rawMetadataJson = { ...source.rawMetadataJson, ...projection };
  await repository.save({ id: source.id, rawMetadataJson: source.rawMetadataJson });
}
