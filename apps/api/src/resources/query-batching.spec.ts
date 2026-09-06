import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventState, ParseStatus, type Company } from '@orsem/contracts';
import {
  ENTITIES,
  CompanyEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  InsiderReportEntity,
  InsiderTransactionEntity,
  ParseRunEntity,
  SourceItemEntity,
  MarketLeaderScopeEntity,
} from '@orsem/database';
import { DataSource, FindOperator, type EntityTarget, type ObjectLiteral } from 'typeorm';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { OrsemDataService } from './orsem-data.service';

const now = new Date('2026-09-05T03:04:05.000Z');

async function batchContext(size: number) {
  const fixtures = new FixtureStoreService();
  const records = new Map<unknown, ObjectLiteral[]>();
  const companies = Array.from({ length: size }, (_, index) => ({
    ...fixtures.companies[0]!,
    id: `company-${index}`,
    updatedAt: now,
  }));
  records.set(CompanyEntity, companies);
  records.set(
    EventClusterEntity,
    companies.map((company, index) => ({
      id: `event-${index}`,
      companyId: company.id,
      canonicalEventType: 'INSIDER_OWNERSHIP',
      occurredAt: null,
      publishedAt: now,
      firstObservedAt: now,
      processedAt: now,
      state: EventState.OPEN,
      evidenceGrade: 'A',
      summary: 'Source summary',
    })),
  );
  records.set(
    FilingEntity,
    companies.map((company, index) => ({
      id: `filing-${index}`,
      companyId: company.id,
      detailType: 'D002',
      canonicalType: 'D002',
      classificationStatus: 'CONFIRMED',
      activeParseRunId: `parse-${index}`,
      reportName: `Report ${index}`,
      rceptNo: `20260905${String(index).padStart(6, '0')}`,
      rceptDate: '2026-09-05',
      submissionKind: 'INITIAL',
      effectiveState: 'ACTIVE',
      firstObservedAt: now,
      lastSeenAt: now,
    })),
  );
  records.set(
    ParseRunEntity,
    companies.map((_, index) => ({
      id: `parse-${index}`,
      filingId: `filing-${index}`,
      inputType: 'D002',
      extractorType: 'D002',
      resultType: 'D002',
      status: ParseStatus.SUCCEEDED,
      validationStatus: 'PASSED',
      resultJson: { projectionApplied: true, parsed: { detailType: 'D002' } },
      classificationResult: 'VERIFIED',
      confidence: '1',
      finishedAt: now,
    })),
  );
  records.set(
    EventClusterItemEntity,
    companies.flatMap((_, index) => [
      { eventClusterId: `event-${index}`, itemType: 'FILING', itemId: `filing-${index}` },
      { eventClusterId: `event-${index}`, itemType: 'SOURCE_ITEM', itemId: 'shared-source' },
    ]),
  );
  records.set(SourceItemEntity, [
    {
      id: 'shared-source',
      source: 'OPENDART',
      sourceKind: 'OFFICIAL_DISCLOSURE',
      sourcePolicyJson: { metadataStorageAllowed: true, displayAllowed: true },
      title: 'Official filing',
      rightsMode: 'OFFICIAL_PUBLIC_DATA',
      firstObservedAt: now,
      publishedAt: now,
      processedAt: now,
    },
  ]);
  records.set(
    MarketLeaderScopeEntity,
    companies.map((company) => ({ companyId: company.id, priority: 'P2' })),
  );
  records.set(
    InsiderReportEntity,
    companies.map((_, index) => ({
      id: `reporter-${index}`,
      filingId: `filing-${index}`,
      createdAt: now,
    })),
  );
  records.set(
    InsiderTransactionEntity,
    companies.flatMap((_, index) => [
      {
        insiderReportId: `reporter-${index}`,
        nature: 'MARKET_SELL',
        direction: 'DECREASE',
        eventDate: '2026-09-03',
      },
      {
        insiderReportId: `reporter-${index}`,
        nature: 'MARKET_BUY',
        direction: 'INCREASE',
        eventDate: '2026-09-04',
      },
    ]),
  );
  const metadata = new DataSource({
    type: 'mysql',
    database: 'test',
    entities: [...ENTITIES],
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const reads: Array<{ entity: unknown; method: string; where?: ObjectLiteral; sql?: string }> = [];
  const matches = (row: ObjectLiteral, where: ObjectLiteral = {}) =>
    Object.entries(where).every(([key, value]) =>
      value instanceof FindOperator && value.type === 'in'
        ? value.value.includes(row[key])
        : row[key] === value,
    );
  const source = {
    getRepository(entity: EntityTarget<ObjectLiteral>) {
      const rows = records.get(entity) ?? [];
      return {
        async findBy(where: ObjectLiteral) {
          reads.push({ entity, method: 'findBy', where });
          return rows.filter((row) => matches(row, where));
        },
        async find(options: { where?: ObjectLiteral; order?: Record<string, 'ASC' | 'DESC'> }) {
          reads.push({ entity, method: 'find', where: options.where });
          return rows
            .filter((row) => matches(row, options.where))
            .sort((left, right) => {
              for (const [field, direction] of Object.entries(options.order ?? {})) {
                const comparison = String(left[field]).localeCompare(String(right[field]));
                if (comparison) return direction === 'ASC' ? comparison : -comparison;
              }
              return 0;
            });
        },
        createQueryBuilder(alias: string) {
          const qb = metadata.getRepository(entity).createQueryBuilder(alias);
          qb.getMany = async () => {
            reads.push({ entity, method: 'getMany', sql: qb.getQuery() });
            return [...rows]
              .sort((a, b) => String(b.id).localeCompare(String(a.id)))
              .slice(0, qb.expressionMap.take);
          };
          qb.getRawMany = async <T>() => {
            reads.push({ entity, method: 'getRawMany', sql: qb.getQuery() });
            return companies.map((company) => ({
              companyId: company.id,
              lastEventAt: now.toISOString(),
            })) as T[];
          };
          return qb;
        },
        findOneBy() {
          throw new Error('List requests must not read a relation per row');
        },
        findOne() {
          throw new Error('List requests must not read a relation per row');
        },
      };
    },
  } as unknown as DataSource;
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    { dataSource: source } as DatabaseRuntimeService,
    fixtures,
  );
  service.listCompanies = async () => ({
    items: companies.map((company) => ({ ...company, updatedAt: now.toISOString() })) as Company[],
    nextCursor: null,
    pageInfo: { nextCursor: null, hasMore: false },
  });
  return { service, reads, records };
}

test('event list relation query count stays constant as the page grows and preserves first transaction facts', async () => {
  const counts: number[] = [];
  for (const size of [1, 60]) {
    const { service, reads } = await batchContext(size);
    const page = await service.listEventViews({ limit: size });
    assert.equal(page.items.length, size);
    assert.ok(page.items.every((item) => item.priority === 'P2' && item.detailType === 'D002'));
    assert.ok(
      page.items.every(
        (item) =>
          item.nature === 'MARKET_SELL' &&
          item.direction === 'DECREASE' &&
          item.eventAt === '2026-09-03',
      ),
    );
    assert.equal(reads.filter((read) => read.entity === EventClusterItemEntity).length, 1);
    assert.equal(reads.filter((read) => read.entity === CompanyEntity).length, 1);
    const sourceRead = reads.find((read) => read.entity === SourceItemEntity);
    assert.deepEqual((sourceRead?.where?.id as FindOperator<string>).value, ['shared-source']);
    counts.push(reads.length);
  }
  assert.equal(counts[0], counts[1]);
  assert.ok(counts[0]! <= 11);
});

test('batch event projection never uses a missing, cross-filing, or invalid active parse', async () => {
  const { service, records } = await batchContext(4);
  const runs = records.get(ParseRunEntity)!;
  runs[0]!.filingId = 'another-filing';
  runs[1]!.resultJson.projectionApplied = false;
  runs[2]!.validationStatus = 'FAILED';
  records.get(FilingEntity)![3]!.activeParseRunId = null;
  const page = await service.listEvents({ limit: 4 });
  assert.ok(
    page.items.every(
      (event) => event.state === 'REVIEW_REQUIRED' && event.classificationResult === null,
    ),
  );
  assert.ok(page.items.every((event) => event.summary.startsWith('원문 검증 대기')));
  const views = await service.listEventViews({ limit: 4 });
  assert.ok(
    views.items.every(
      (event) => event.nature === null && event.direction === 'UNKNOWN' && event.eventAt === null,
    ),
  );
});

test('company summaries use two batch queries and latest timestamps retain the supported-filing visibility gate', async () => {
  const { service, reads } = await batchContext(60);
  const page = await service.listCompanyViews({ limit: 60 });
  assert.equal(page.items.length, 60);
  assert.ok(
    page.items.every(
      (company) =>
        company.isWatchlisted &&
        company.priority === 'P2' &&
        company.lastEventAt === now.toISOString(),
    ),
  );
  assert.equal(reads.length, 2);
  const sql = reads.find((read) => read.method === 'getRawMany')!.sql!;
  assert.match(sql, /MAX\(`event`\.`first_observed_at`\)/u);
  assert.match(
    sql,
    /NOT EXISTS[\s\S]*canonical_type NOT IN \('D001','D002','D003','D004','D005'\)/u,
  );
  assert.match(sql, /GROUP BY `event`\.`company_id`/u);
});

test('dashboard view omits discarded legacy dashboard loads while preserving the legacy endpoint', async () => {
  const fixtures = new FixtureStoreService();
  const service = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {} as DatabaseRuntimeService,
    fixtures,
  );
  service.listEvents = async () => {
    throw new Error('Dashboard view must not load discarded recent events');
  };
  service.listEventViews = async () => ({
    items: [],
    nextCursor: null,
    pageInfo: { nextCursor: null, hasMore: false },
  });
  service.connectorSourceViews = async () => [];
  service.connectors = async () => {
    throw new Error('Dashboard view must not load discarded connector health');
  };
  const view = await service.dashboardView();
  assert.equal(view.reviewPending, fixtures.reviews.filter((row) => row.status === 'OPEN').length);
  const legacy = await service.dashboard();
  assert.ok(Array.isArray(legacy.recentEvents));
  assert.deepEqual(legacy.connectors, fixtures.connectors);
});
