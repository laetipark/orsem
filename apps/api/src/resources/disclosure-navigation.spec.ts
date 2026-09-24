import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventState, RightsMode, type FilingDetail } from '@orsem/contracts';
import { EventClusterEntity, FilingEntity, SourceItemEntity } from '@orsem/database';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { SearchService } from '../search/search.service';
import { OrsemDataService } from './orsem-data.service';

test('search disclosure links resolve to internal details with source dates and provenance', async () => {
  const fixtures = new FixtureStoreService();
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  const database = {} as DatabaseRuntimeService;
  const search = new SearchService(config, database, fixtures);
  const data = new OrsemDataService(config, database, fixtures);
  const result = await search.search({ q: '삼성', limit: 10 });
  assert.ok(result.filings.length);
  for (const item of result.filings) {
    assert.equal(item.external, false);
    assert.equal(item.url, `/events/${item.id}`);
    const detail = await data.getEventView(decodeURIComponent(item.url.slice('/events/'.length)));
    assert.equal(detail.title, item.title);
    assert.equal(detail.rceptDate, item.rceptDate);
    assert.match(String(detail.officialUrl), /^https:\/\/dart\.fss\.or\.kr\//);
    assert.ok(Array.isArray(detail.evidence) && detail.evidence.length);
  }
});

function unclusteredData(source: SourceItemEntity | null = null) {
  const fixtures = new FixtureStoreService();
  const filing: FilingDetail = {
    ...fixtures.filings[0]!,
    id: 'unparsed-filing',
    parseStatus: null,
    processedAt: null,
    transactions: [],
    reporter: null,
  };
  const conditions: string[] = [];
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    {
      dataSource: {
        getRepository: (entity: unknown) => {
          if (entity === EventClusterEntity)
            return {
              createQueryBuilder: () => ({
                where(sql: string, params: { id: string }) {
                  conditions.push(sql);
                  assert.ok(['unparsed-filing', 'sec-source', 'news-source'].includes(params.id));
                  return this;
                },
                andWhere(sql: string) {
                  conditions.push(sql);
                  return this;
                },
                async getOne() {
                  return null;
                },
              }),
            };
          return {
            async findOneBy(where: Record<string, unknown>) {
              if (entity === FilingEntity) return where.id === filing.id ? filing : null;
              if (entity === SourceItemEntity)
                return source &&
                  Object.entries(where).every(
                    ([key, value]) => source[key as keyof SourceItemEntity] === value,
                  )
                  ? source
                  : null;
              return null;
            },
          };
        },
      },
    } as unknown as DatabaseRuntimeService,
    fixtures,
  );
  data.getFiling = async () => filing;
  return { data, filing, conditions };
}

test('a collected filing without an event opens pending analysis details without inventing trades', async () => {
  const { data, filing, conditions } = unclusteredData();
  const result = await data.getEvent(filing.id);
  assert.equal(result.filing?.id, filing.id);
  assert.equal(result.firstObservedAt, filing.firstObservedAt);
  assert.equal(result.state, EventState.REVIEW_REQUIRED);
  assert.equal(result.classificationResult, null);
  assert.equal(result.occurredAt, null);
  assert.match(result.summary, /분석 대기/);
  assert.match(conditions[0]!, /linked_disclosure\.item_id=:id/);
  assert.match(conditions[0]!, /linked_source\.source='SEC'/);
  assert.ok(conditions.length > 1, 'event audience policy remains applied');
});

test('an unclustered SEC filing opens only when its public display policy allows it', async () => {
  const source = {
    id: 'sec-source',
    source: 'SEC',
    companyId: null,
    sourceKind: 'OFFICIAL_DISCLOSURE',
    rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
    title: 'Form 8-K',
    url: 'https://www.sec.gov/Archives/report.htm',
    firstObservedAt: new Date('2026-09-04T00:30:00Z'),
    publishedAt: null,
    processedAt: null,
    sourcePolicyJson: {
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      metadataStorageAllowed: true,
      displayAllowed: true,
    },
    rawMetadataJson: { filingDate: '2026-09-03' },
  } as unknown as SourceItemEntity;
  const result = await unclusteredData(source).data.getEvent(source.id);
  assert.equal(result.id, source.id);
  assert.equal(result.filing, null);
  assert.equal(result.sourceItems[0]?.url, source.url);
  assert.equal(result.firstObservedAt, source.firstObservedAt.toISOString());
  assert.equal(result.occurredAt, null);
  source.sourcePolicyJson!.displayAllowed = false;
  await assert.rejects(
    () => unclusteredData(source).data.getEvent(source.id),
    /이벤트를 찾을 수 없습니다/,
  );
  source.id = 'news-source';
  source.source = 'NEWS_RSS';
  await assert.rejects(
    () => unclusteredData(source).data.getEvent(source.id),
    /이벤트를 찾을 수 없습니다/,
  );
});
