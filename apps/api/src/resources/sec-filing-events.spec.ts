import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventType, RightsMode, type Event } from '@orsem/contracts';
import { CompanyEntity, EventClusterEntity, SourceItemEntity } from '@orsem/database';
import { DataSource } from 'typeorm';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { OrsemDataService } from './orsem-data.service';

function secEvent(): Event {
  const fixtures = new FixtureStoreService();
  return {
    ...fixtures.events[0]!,
    id: 'sec-event',
    canonicalEventType: EventType.OTHER,
    company: fixtures.companies[2]!,
    filing: null,
    occurredAt: '2026-09-03T00:00:00.000Z',
    publishedAt: '2026-09-04T01:00:00.000Z',
    summary: 'SEC 4/A 공시 접수 · 2026-09-03',
    sourceItems: [
      {
        ...fixtures.sourceItems[0]!,
        id: 'sec-source',
        source: 'SEC',
        title: 'Form 4/A',
        sourceName: 'SEC EDGAR',
        rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
        url: 'https://www.sec.gov/Archives/edgar/data/1045810/report.htm',
      },
    ],
  };
}

test('SEC receipt retains filingDate independently of acceptance instant and has filing-only timeline markers', async () => {
  const event = secEvent();
  const database = {
    dataSource: {
      getRepository: (entity: unknown) => ({
        findOneBy: async () =>
          entity === SourceItemEntity
            ? {
                rawMetadataJson: {
                  form: '4/A',
                  filingDate: '2026-09-03',
                  reportDate: '2026-08-31',
                },
              }
            : null,
      }),
    },
  } as unknown as DatabaseRuntimeService;
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    database,
    new FixtureStoreService(),
  );
  data.getEvent = async () => event;
  data.getCompany = async () => event.company!;
  data.listEvents = async () => ({
    items: [event],
    nextCursor: null,
    pageInfo: { nextCursor: null, hasMore: false },
  });
  const detail = await data.getEventView(event.id);
  assert.equal(detail.detailType, 'SEC');
  assert.equal(detail.title, 'Form 4/A');
  assert.equal(detail.rceptDate, '2026-09-03');
  assert.equal(detail.publishedAt, '2026-09-04T01:00:00.000Z');
  assert.equal(detail.eventAt, null);
  assert.equal(detail.nature, null);
  assert.equal(detail.direction, 'UNKNOWN');
  assert.equal(detail.submissionKind, 'CORRECTION');
  assert.deepEqual(detail.transactions, []);
  assert.match(JSON.stringify(detail.limitations), /Form 4/u);
  const timeline = await data.companyTimeline(event.company!.id, '1M');
  assert.deepEqual(
    timeline.markers.map((marker) => ({
      time: marker.time,
      kind: marker.kind,
      detailType: marker.detailType,
    })),
    [{ time: '2026-09-03', kind: 'FILING', detailType: 'SEC' }],
  );
});

test('SEC fixture filter finds shared source projections for both share-class companies', async () => {
  const fixtures = new FixtureStoreService();
  const first = secEvent();
  const second = {
    ...first,
    id: 'sec-event-class-b',
    company: { ...first.company!, id: 'class-b', ticker: 'CLASSB' },
  };
  fixtures.events.push(first, second);
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {} as DatabaseRuntimeService,
    fixtures,
  );
  const all = await data.listEvents({ detailType: 'SEC', region: 'us', limit: 10 });
  assert.equal(all.items.length, 2);
  for (const event of [first, second]) {
    const page = await data.listEvents({
      detailType: 'SEC',
      companyId: event.company!.id,
      limit: 10,
    });
    assert.deepEqual(
      page.items.map((item) => item.id),
      [event.id],
    );
    assert.equal(page.items[0]?.sourceItems[0]?.id, 'sec-source');
  }
  assert.equal(
    (await data.listEvents({ detailType: 'SEC', region: 'kr', limit: 10 })).items.length,
    0,
  );
});

test('SEC event SQL filters linked source provenance rather than forcing an empty result', async () => {
  const metadata = new DataSource({
    type: 'mysql',
    database: 'test',
    entities: [CompanyEntity, EventClusterEntity],
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  let sql = '';
  let values: unknown[] = [];
  const database = {
    dataSource: {
      getRepository: () => ({
        createQueryBuilder: () => {
          const qb = metadata.getRepository(EventClusterEntity).createQueryBuilder('event');
          qb.getMany = async () => {
            [sql, values] = qb.getQueryAndParameters();
            return [];
          };
          return qb;
        },
      }),
    },
  } as unknown as DatabaseRuntimeService;
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    database,
    new FixtureStoreService(),
  );
  await data.listEvents({ detailType: 'SEC', companyId: 'class-b', region: 'us', limit: 1 });
  assert.match(sql, /JOIN source_items ess/u);
  assert.match(sql, /esi.item_type = 'SOURCE_ITEM' AND ess.source = \?/u);
  assert.ok(values.includes('SEC'));
  assert.ok(values.includes('class-b'));
  assert.doesNotMatch(sql, /1 = 0/u);
  assert.match(sql, /LIMIT 2$/u);
});
