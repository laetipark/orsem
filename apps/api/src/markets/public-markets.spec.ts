import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { MARKET_INSTRUMENTS, RightsMode, type MarketOverview } from '@orsem/contracts';
import { ConnectorHealthEntity, MarketObservationEntity } from '@orsem/database';
import { AuthService } from '../auth/auth.service';
import { MemberService } from '../auth/member.service';
import { APP_CONFIG, loadAppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import {
  AdminSessionGuard,
  CsrfGuard,
  HybridRateLimitGuard,
  OriginGuard,
} from '../security/security';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { MarketsController } from './markets.controller';
import { MarketsService } from './markets.service';
import { PublicMarketsController } from './public-markets.controller';

function observation(
  id: string,
  value: string,
  overrides: Partial<MarketObservationEntity> = {},
): MarketObservationEntity {
  const instrument = MARKET_INSTRUMENTS.find((item) => item.id === id)!;
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  return Object.assign(new MarketObservationEntity(), {
    instrumentId: id,
    kind: 'DAILY',
    period: date,
    value,
    sourceDate: date,
    providerAt: null,
    firstObservedAt: now,
    lastObservedAt: now,
    source: instrument.provider,
    sourceUrl: instrument.sourceUrl,
    rightsMode: instrument.rightsMode,
    referenceValue: null,
    referenceDate: null,
    referenceLabel: null,
    rawMetadataJson: { internal: 'private-observation-metadata' },
    ...overrides,
  });
}

function persistedService(rows: MarketObservationEntity[], environment: NodeJS.ProcessEnv = {}) {
  const reads: Array<{ entity: unknown; options: Record<string, unknown> }> = [];
  const health = ['market:treasury', 'market:eia'].map((connector) =>
    Object.assign(new ConnectorHealthEntity(), {
      connector,
      status: 'HEALTHY',
      message: 'private-connector-message',
      metadataJson: { historyStatus: 'HEALTHY', private: 'private-connector-metadata' },
    }),
  );
  const source = {
    getRepository(entity: unknown) {
      return {
        async find(options: Record<string, unknown>) {
          reads.push({ entity, options });
          // Deliberately return unfiltered rows to also test the projection boundary.
          return entity === MarketObservationEntity ? rows : health;
        },
      };
    },
  };
  return {
    service: new MarketsService(
      loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false', ...environment }),
      { requireDataSource: () => source } as unknown as DatabaseRuntimeService,
    ),
    reads,
  };
}

test('public overview excludes private, mismatched-source and noncatalog observations before projection and history', async () => {
  const rows = [
    observation('us2y', '99901', { kind: 'QUOTE', rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY }),
    observation('us2y', '3.8'),
    observation('us10y', '4.1'),
    observation('us10y', '99902', {
      rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
      sourceDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    }),
    observation('us10y', '99903', { kind: 'QUOTE', source: 'TOSS' }),
    observation('sp500', '99904', { rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA }),
    observation('wti', '75'),
  ];
  const { service, reads } = persistedService(rows, { EIA_API_KEY: 'synthetic-eia-key' });
  const overview = await service.publicOverview('all', '1m');
  assert.deepEqual(
    overview.items.map((item) => item.id),
    ['us2y', 'us10y', 'wti'],
  );
  assert.deepEqual(
    overview.items.map((item) => item.value),
    ['3.8', '4.1', '75'],
  );
  assert.equal(overview.items.find((item) => item.id === 'us10y')?.referenceValue, null);
  assert.deepEqual(Object.keys(overview.histories!), ['us2y', 'us10y', 'wti']);
  assert.deepEqual(overview.histories!.us10y!.points, [
    { date: rows[2]!.sourceDate, value: '4.1' },
  ]);
  assert.doesNotMatch(JSON.stringify(overview), /9990|private-|synthetic-eia-key|rawMetadataJson/);

  const read = reads.find((item) => item.entity === MarketObservationEntity)!;
  const where = read.options.where as Array<Record<string, unknown>>;
  assert.equal(where.length, 6);
  for (const clause of where) {
    assert.ok(['us2y', 'us10y', 'wti'].includes(String(clause.instrumentId)));
    assert.equal(clause.rightsMode, RightsMode.OFFICIAL_PUBLIC_DATA);
    assert.equal(clause.source, clause.instrumentId === 'wti' ? 'EIA' : 'TREASURY');
  }
  assert.equal((read.options.select as Record<string, unknown>).rawMetadataJson, undefined);
});

test('public history checks catalog access before reading and filters stored rights for every range', async () => {
  const good = observation('us10y', '4.1');
  const { service, reads } = persistedService([
    good,
    observation('us10y', '99905', { rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY }),
    observation('us10y', '99906', { source: 'TOSS' }),
    observation('us2y', '99907'),
  ]);
  for (const id of ['kospi', 'kosdaq', 'sp500', 'nasdaq', 'btc', 'gold', 'unknown'])
    await assert.rejects(() => service.publicHistory(id, '1m'), NotFoundException);
  assert.equal(reads.length, 0);
  for (const range of ['1m', '3m', '1y'] as const) {
    const result = await service.publicHistory('us10y', range);
    assert.equal(result.range, range);
    assert.deepEqual(result.points, [{ date: good.sourceDate, value: '4.1' }]);
    assert.doesNotMatch(JSON.stringify(result), /9990|private-|rawMetadataJson/);
  }
  for (const read of reads.filter((item) => item.entity === MarketObservationEntity)) {
    const where = read.options.where as Array<Record<string, unknown>>;
    assert.equal(where.length, 1);
    assert.equal(where[0]!.kind, 'DAILY');
    assert.equal(where[0]!.instrumentId, 'us10y');
    assert.equal(where[0]!.source, 'TREASURY');
    assert.equal(where[0]!.rightsMode, RightsMode.OFFICIAL_PUBLIC_DATA);
  }
});

test('catalog rights revocation immediately removes a public market even if old observations are public', async (t) => {
  const instrument = MARKET_INSTRUMENTS.find((item) => item.id === 'us2y')!;
  const originalRights = instrument.rightsMode;
  const row = observation('us2y', '3.8');
  t.after(() => {
    instrument.rightsMode = originalRights;
  });
  instrument.rightsMode = RightsMode.PRIVATE_DISPLAY_ONLY;
  const { service, reads } = persistedService([row]);
  await assert.rejects(() => service.publicHistory('us2y', '1m'), NotFoundException);
  assert.equal(reads.length, 0);
  const overview = await service.publicOverview();
  assert.deepEqual(
    overview.items.map((item) => item.id),
    ['us10y', 'wti'],
  );
});

test('public regions, empty data and missing EIA credentials stay explicit without fixture seeding', async () => {
  const { service, reads } = persistedService([]);
  const kr = await service.publicOverview('kr', '1m');
  assert.deepEqual(kr.items, []);
  assert.deepEqual(kr.histories, {});
  assert.equal(reads.length, 0);
  const us = await service.publicOverview('us', '1m');
  assert.deepEqual(
    us.items.map((item) => item.id),
    ['us2y', 'us10y'],
  );
  assert.ok(us.items.every((item) => item.value === null && item.status === 'WAITING'));
  assert.ok(Object.values(us.histories!).every((history) => history.points.length === 0));
  const wti = await service.publicHistory('wti', '1m');
  assert.equal(wti.status, 'NOT_CONFIGURED');
  assert.deepEqual(wti.points, []);
  const fixture = new MarketsService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {} as DatabaseRuntimeService,
  );
  assert.ok((await fixture.publicOverview()).items.every((item) => item.value === null));
});

test('anonymous public market HTTP reads work while private markets and mutations remain protected', async (t) => {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  const sessions = new SessionRuntimeService(config);
  let rateCount = 1;
  sessions.consumeRateLimit = async () => rateCount;
  const module = await Test.createTestingModule({
    controllers: [PublicMarketsController, MarketsController],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: SessionRuntimeService, useValue: sessions },
      { provide: AuthService, useValue: {} },
      { provide: MemberService, useValue: {} },
      {
        provide: MarketsService,
        useValue: new MarketsService(config, {} as DatabaseRuntimeService),
      },
      { provide: APP_GUARD, useClass: AdminSessionGuard },
      { provide: APP_GUARD, useClass: OriginGuard },
      { provide: APP_GUARD, useClass: CsrfGuard },
      { provide: APP_GUARD, useClass: HybridRateLimitGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  app.use(sessions.middleware());
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/api/v1`;
  const response = await fetch(`${base}/public/markets/overview?historyRange=1m`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  const overview = (await response.json()) as MarketOverview;
  assert.deepEqual(
    overview.items.map((item) => item.id),
    ['us2y', 'us10y', 'wti'],
  );
  assert.equal((await fetch(`${base}/public/markets/us10y/history`)).status, 200);
  assert.equal((await fetch(`${base}/public/markets/kospi/history`)).status, 404);
  assert.equal((await fetch(`${base}/markets/overview`)).status, 401);
  assert.equal((await fetch(`${base}/markets/us10y/history`)).status, 401);
  assert.equal((await fetch(`${base}/public/markets/overview`, { method: 'POST' })).status, 404);
  for (const query of ['region=global', 'historyRange=1y', 'audience=ADMIN_UI'])
    assert.equal((await fetch(`${base}/public/markets/overview?${query}`)).status, 400);
  assert.equal((await fetch(`${base}/public/markets/us10y/history?range=1d`)).status, 400);
  rateCount = 61;
  assert.equal((await fetch(`${base}/public/markets/overview`)).status, 429);
  assert.equal((await fetch(`${base}/public/markets/us10y/history`)).status, 429);
});
