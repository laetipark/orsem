import { randomUUID } from 'node:crypto';
import { EvidenceGrade, EventState, EventType, RightsMode } from '@orsem/contracts';
import {
  CompanyEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { EntityManager } from 'typeorm';

/** Creates company observations of one shared SEC accession within the caller's transaction. */
export async function projectSecFilingEvents(
  manager: EntityManager,
  sourceItem: SourceItemEntity,
  relatedCompanies: CompanyEntity[],
): Promise<{ created: number; existing: number }> {
  const result = { created: 0, existing: 0 };
  if (sourceItem.source !== 'SEC' || sourceItem.rightsMode !== RightsMode.OFFICIAL_PUBLIC_DATA)
    return result;
  let url: URL;
  try {
    url = new URL(sourceItem.url);
  } catch {
    return result;
  }
  if (
    url.protocol !== 'https:' ||
    !['www.sec.gov', 'sec.gov'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname.startsWith('/Archives/')
  )
    return result;
  const metadata = sourceItem.rawMetadataJson ?? {};
  const accessionNumber = sourceItem.externalId;
  if (!accessionNumber || !/^\d{10}-\d{2}-\d{6}$/.test(accessionNumber)) return result;
  const cik = typeof metadata.cik === 'string' ? metadata.cik : '';
  const form = typeof metadata.form === 'string' ? metadata.form : '';
  const filingDate = typeof metadata.filingDate === 'string' ? metadata.filingDate : '';
  if (!/^\d{10}$/.test(cik) || !form.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate))
    return result;
  const companies = [
    ...new Map(
      relatedCompanies
        .filter(
          (company) =>
            company.cik?.padStart(10, '0') === cik &&
            ['NASDAQ', 'NYSE', 'AMEX'].includes(company.market),
        )
        .map((company) => [company.id, company]),
    ).values(),
  ];
  const events = manager.getRepository(EventClusterEntity);
  const memberships = manager.getRepository(EventClusterItemEntity);
  for (const company of companies) {
    const dedupeKey = `SEC:${sourceItem.id}:${company.id}`;
    let event = await events.findOneBy({ dedupeKey });
    if (!event) {
      const candidateId = randomUUID();
      await events
        .createQueryBuilder()
        .insert()
        .values({
          id: candidateId,
          dedupeKey,
          canonicalEventType: EventType.OTHER,
          companyId: company.id,
          occurredAt: null,
          publishedAt: sourceItem.publishedAt,
          firstObservedAt: sourceItem.firstObservedAt,
          processedAt: new Date(),
          state: EventState.OPEN,
          evidenceGrade: EvidenceGrade.A,
          summary: `SEC ${form} 공시 접수 · ${filingDate}`,
          metadataJson: {
            source: 'SEC',
            sourceItemId: sourceItem.id,
            observationKind: 'FILING_RECEIPT',
            cik,
            form,
            filingDate,
            accessionNumber,
            ...(typeof metadata.reportDate === 'string' ? { reportDate: metadata.reportDate } : {}),
          },
        })
        .orIgnore()
        .execute();
      event = await events.findOneBy({ dedupeKey });
      if (!event) throw new Error('SEC filing event was not persisted.');
      if (event.id === candidateId) result.created += 1;
      else result.existing += 1;
    } else {
      result.existing += 1;
    }
    await memberships
      .createQueryBuilder()
      .insert()
      .values({
        id: randomUUID(),
        eventClusterId: event.id,
        itemType: 'SOURCE_ITEM',
        itemId: sourceItem.id,
        isPrimary: true,
        provenanceJson: { source: 'SEC', cik, accessionNumber },
      })
      .orIgnore()
      .execute();
  }
  return result;
}
