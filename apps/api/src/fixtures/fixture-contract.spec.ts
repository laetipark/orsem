import assert from 'node:assert/strict';
import test from 'node:test';
import {
  companyDetailViewSchema,
  companyTimelineSchema,
  dashboardViewSchema,
  eventDetailViewSchema,
  eventSummaryViewSchema,
  EventType,
  pagedSchema,
  queueMetricSchema,
  reviewViewSchema,
  sourceItemSchema,
  watchlistViewSchema,
} from '@orsem/contracts';
import { loadAppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { OrsemDataService } from '../resources/orsem-data.service';
import { FixtureStoreService } from './fixture-store.service';
import { GoneException } from '@nestjs/common';
import { WatchlistController } from '../resources/resource.controllers';

function fixtureData(): OrsemDataService {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  const database = new DatabaseRuntimeService(config);
  return new OrsemDataService(config, database, new FixtureStoreService());
}

test('이벤트 응답은 연결된 기업의 종목 코드와 티커를 보존한다', async () => {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  const fixtures = new FixtureStoreService();
  fixtures.events.push({
    ...fixtures.events[0]!,
    id: '40000000-0000-4000-8000-000000000099',
    canonicalEventType: EventType.NEWS,
    company: fixtures.companies[2]!,
    filing: null,
  });
  const data = new OrsemDataService(config, new DatabaseRuntimeService(config), fixtures);
  const result = pagedSchema(eventSummaryViewSchema).parse(
    await data.listEventViews({ limit: 30 }),
  );
  const domestic = result.items.find((event) => event.companyId === fixtures.companies[0]!.id)!;
  const overseas = result.items.find((event) => event.companyId === fixtures.companies[2]!.id)!;

  assert.equal(domestic.stockCode, '005930');
  assert.equal(domestic.ticker, null);
  assert.equal(overseas.stockCode, null);
  assert.equal(overseas.ticker, 'NVDA');
  assert.equal(overseas.market, 'NASDAQ');
});

test('company search excludes unlisted fixtures', async () => {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  const database = new DatabaseRuntimeService(config);
  const fixtures = new FixtureStoreService();
  fixtures.companies[0]!.isListed = false;
  const data = new OrsemDataService(config, database, fixtures);

  const companies = await data.listCompanies({ limit: 30 });

  assert.equal(
    companies.items.some((company) => company.id === fixtures.companies[0]!.id),
    false,
  );
  assert.equal(
    companies.items.every((company) => company.isListed),
    true,
  );
});

test('database company search excludes stale Alpaca-only mappings', async () => {
  const predicates: Array<{ clause: string; parameters?: Record<string, unknown> }> = [];
  const queryBuilder = {
    andWhere(clause: string, parameters?: Record<string, unknown>) {
      predicates.push({ clause, parameters });
      return this;
    },
    orderBy() {
      return this;
    },
    addOrderBy() {
      return this;
    },
    take() {
      return this;
    },
    async getMany() {
      return [];
    },
  };
  const database = {
    dataSource: {
      getRepository: () => ({ createQueryBuilder: () => queryBuilder }),
    },
  } as unknown as DatabaseRuntimeService;
  const config = loadAppConfig({
    NODE_ENV: 'test',
    FIXTURE_MODE: 'false',
    DATABASE_URL: 'mysql://orsem:test@127.0.0.1:3306/orsem',
  });
  const data = new OrsemDataService(config, database, new FixtureStoreService());

  await data.listCompanies({ limit: 30 });

  assert.deepEqual(predicates[0], {
    clause: 'company.isListed = :isListed',
    parameters: { isListed: true },
  });
  assert.match(predicates[1]!.clause, /NOT EXISTS[\s\S]*alpaca_history/u);
  assert.match(predicates[1]!.clause, /OR EXISTS[\s\S]*alpaca_current/u);
  assert.match(predicates[1]!.clause, /alpaca_current\.is_current = :alpacaCurrent/u);
  assert.deepEqual(predicates[1]!.parameters, { alpacaCurrent: true });
});

test('fixture dashboard and primary read models honor the public contracts', async () => {
  const data = fixtureData();
  const events = await data.listEventViews({ limit: 30 });
  const reviews = await data.listReviewViews({ limit: 30 });
  const news = await data.listNews({ limit: 30 });
  const watchlist = await data.listWatchlistViews({ limit: 30 });

  dashboardViewSchema.parse(await data.dashboardView());
  pagedSchema(eventSummaryViewSchema).parse(events);
  pagedSchema(reviewViewSchema).parse(reviews);
  pagedSchema(sourceItemSchema).parse(news);
  pagedSchema(watchlistViewSchema).parse(watchlist);
  pagedSchema(queueMetricSchema).parse(await data.listQueueMetrics());

  const firstWatch = watchlist.items[0]!;
  assert.equal(firstWatch.realtimeAlerts, true);
  assert.equal(firstWatch.digestAlerts, false);

  companyDetailViewSchema.parse(await data.getCompanyView('00000000-0000-4000-8000-000000000001'));
  const timeline = companyTimelineSchema.parse(
    await data.companyTimeline('00000000-0000-4000-8000-000000000001', '3M'),
  );
  assert.equal(
    timeline.markers.some((marker) => marker.kind === 'TRADE'),
    true,
  );
  assert.equal(
    timeline.markers.some((marker) => marker.kind === 'FILING'),
    true,
  );
  eventDetailViewSchema.parse(await data.getEventView(events.items[0]!.id));
});

test('retired operating watchlist mutations reject edits without changing saved policies', async () => {
  const data = fixtureData();
  const before = await data.listWatchlistViews({ limit: 30 });
  const controller = new WatchlistController(data, {} as never);
  for (const operation of [
    () => controller.create(),
    () => controller.update(),
    () => controller.remove(),
  ])
    assert.throws(
      operation,
      (error: unknown) => error instanceof GoneException && error.getStatus() === 410,
    );
  assert.deepEqual(await data.listWatchlistViews({ limit: 30 }), before);
});
