import { RightsMode } from '@orsem/contracts';
import {
  CompanyEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { EntityManager } from 'typeorm';
import { projectSecFilingEvents } from '../src/connectors/sec-event-projection';

function setup() {
  const events: Record<string, unknown>[] = [];
  const memberships: Record<string, unknown>[] = [];
  const manager = {
    getRepository(target: unknown) {
      const rows = target === EventClusterEntity ? events : memberships;
      return {
        findOneBy: async (where: Record<string, unknown>) =>
          rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ??
          null,
        createQueryBuilder() {
          let values: Record<string, unknown>;
          const query = {
            insert: () => query,
            values: (row: Record<string, unknown>) => {
              values = row;
              return query;
            },
            orIgnore: () => query,
            execute: async () => {
              const keys =
                target === EventClusterEntity
                  ? ['dedupeKey']
                  : ['eventClusterId', 'itemType', 'itemId'];
              if (!rows.some((row) => keys.every((key) => row[key] === values[key])))
                rows.push(values);
            },
          };
          return query;
        },
      };
    },
  } as unknown as EntityManager;
  const source = Object.assign(new SourceItemEntity(), {
    id: 'source-sec',
    source: 'SEC',
    externalId: '0000123456-26-000001',
    companyId: null,
    url: 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/report.htm',
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    firstObservedAt: new Date('2026-09-04T01:00:00Z'),
    publishedAt: new Date('2026-09-03T21:00:00Z'),
    rawMetadataJson: { cik: '0000123456', form: '4', filingDate: '2026-09-03' },
  });
  const companies = ['class-a', 'class-b'].map((id) =>
    Object.assign(new CompanyEntity(), {
      id,
      cik: id === 'class-a' ? '123456' : '0000123456',
      market: 'NASDAQ',
    }),
  );
  return { manager, source, companies, events, memberships };
}

it('projects shared issuer accession per share class and preserves original observation on retries', async () => {
  const { manager, source, companies, events, memberships } = setup();
  const unrelated = Object.assign(new CompanyEntity(), { id: 'other', cik: '0000999999' });
  const domestic = Object.assign(new CompanyEntity(), {
    id: 'domestic',
    cik: '0000123456',
    market: 'KOSPI',
  });
  expect(
    await projectSecFilingEvents(manager, source, [
      ...companies,
      companies[0]!,
      unrelated,
      domestic,
    ]),
  ).toEqual({ created: 2, existing: 0 });
  expect(events.map((event) => event.companyId)).toEqual(['class-a', 'class-b']);
  for (const event of events) {
    expect(event).toMatchObject({
      canonicalEventType: 'OTHER',
      occurredAt: null,
      state: 'OPEN',
      evidenceGrade: 'A',
    });
    expect(event.metadataJson).toMatchObject({
      observationKind: 'FILING_RECEIPT',
      form: '4',
      filingDate: '2026-09-03',
    });
  }
  expect(memberships).toHaveLength(2);
  expect(
    memberships.every((item) => item.itemId === source.id && item.itemType === 'SOURCE_ITEM'),
  ).toBe(true);
  const first = events.map((event) => ({ id: event.id, firstObservedAt: event.firstObservedAt }));
  source.firstObservedAt = new Date('2026-09-05T01:00:00Z');
  expect(await projectSecFilingEvents(manager, source, companies)).toEqual({
    created: 0,
    existing: 2,
  });
  expect(events.map((event) => ({ id: event.id, firstObservedAt: event.firstObservedAt }))).toEqual(
    first,
  );
  expect(memberships).toHaveLength(2);
  memberships.pop();
  await projectSecFilingEvents(manager, source, companies);
  expect(memberships).toHaveLength(2);
});

it.each([
  { source: 'NEWS_RSS' },
  { rightsMode: RightsMode.LINK_ONLY },
  { url: 'https://www.sec.gov.evil.example/Archives/report.htm' },
  { url: 'https://user:secret@www.sec.gov/Archives/report.htm' },
  { url: 'http://www.sec.gov/Archives/report.htm' },
  { url: 'https://www.sec.gov/news/report.htm' },
  { rawMetadataJson: { cik: 'invalid', form: '4', filingDate: '2026-09-03' } },
])('does not project a source without verified official provenance: %j', async (invalid) => {
  const { manager, source, companies, events, memberships } = setup();
  expect(await projectSecFilingEvents(manager, Object.assign(source, invalid), companies)).toEqual({
    created: 0,
    existing: 0,
  });
  expect(events).toHaveLength(0);
  expect(memberships).toHaveLength(0);
});
