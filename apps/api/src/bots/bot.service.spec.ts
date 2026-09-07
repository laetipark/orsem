import assert from 'node:assert/strict';
import test from 'node:test';
import { AlertStatus, RightsMode, type SourceItem } from '@orsem/contracts';
import {
  AlertEntity,
  BotCommandEntity,
  BotDeliveryEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  MarketLeaderScopeEntity,
} from '@orsem/database';
import { alertAllowedByGlobalTypes, BotService } from './bot.service';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { OrsemDataService } from '../resources/orsem-data.service';
import { CompanyInformationApiService } from '../resources/company-information.service';
import { NaverFocusNewsService } from '../news-search/naver-focus-news.service';
import { DiscordBotController } from './bot.controllers';

const emptyInformation = {
  selection: async () => ({ regions: [] }),
} as unknown as CompanyInformationApiService;
const emptyNews = {
  feed: async () => ({ groups: [], status: 'UNCONFIGURED' }),
} as unknown as NaverFocusNewsService;

function fixtureService() {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  const database = new DatabaseRuntimeService(config);
  const fixtures = new FixtureStoreService();
  const data = new OrsemDataService(config, database, fixtures);
  return {
    service: new BotService(config, database, fixtures, data, emptyInformation, emptyNews),
    fixtures,
  };
}

test('Messenger pairing and delivery match the ES5 bridge contract', async () => {
  const { service, fixtures } = fixtureService();
  const pairing = await service.createPairing('fixture-admin');
  assert.match(pairing.code, /^\d{6}$/);
  const claimed = await service.claimPairing({
    code: pairing.code,
    deviceId: 'fixture-device',
    room: '관리자방',
    authorHash: 'fixture-author-hash',
    packageName: 'com.kakao.talk',
    botVersion: '0.1.0',
  });
  assert.ok(claimed.deviceToken.length >= 32);
  const device = await service.authenticateDevice(claimed.deviceToken);
  fixtures.deliveries.push({
    id: 'fixture-delivery',
    consumer: 'MESSENGERBOTR',
    deviceId: device.id,
    payload: { alertId: 'fixture-alert', phase: 'DETECTED', content: '공시 감지' },
    status: AlertStatus.PENDING,
    availableAt: new Date(0),
    leaseUntil: null,
    externalMessageId: null,
    attempts: 0,
    lastError: null,
  });
  const pull = await service.pull('MESSENGERBOTR', 10, 60, device);
  assert.deepEqual(pull.items[0], {
    deliveryId: 'fixture-delivery',
    alertId: 'fixture-alert',
    operation: 'SEND',
    stage: 'DETECTED',
    content: '공시 감지',
    externalMessageId: null,
  });
  await service.acknowledge('MESSENGERBOTR', 'fixture-delivery', true, null, device);
  assert.equal(fixtures.deliveries[0]?.status, AlertStatus.ACKNOWLEDGED);
});

test('Messenger commands always include a human-readable message', async () => {
  const { service } = fixtureService();
  const pairing = await service.createPairing('fixture-admin');
  const claimed = await service.claimPairing({
    code: pairing.code,
    deviceId: 'fixture-device',
    room: '관리자방',
    authorHash: 'fixture-author-hash',
    packageName: 'com.kakao.talk',
    botVersion: '0.1.0',
  });
  const device = await service.authenticateDevice(claimed.deviceToken);
  const result = await service.executeCommand(device, {
    deviceId: 'fixture-device',
    command: 'STATUS',
    query: '',
  });
  assert.equal(typeof result.message, 'string');
});

test('bot pull cancels old cancelled alerts before leasing while preserving operational deliveries', async () => {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' });
  const rows = [
    { id: 'stale', alertId: 'stale-alert', status: AlertStatus.PENDING, attempts: 0, payload: {} },
    {
      id: 'valid',
      alertId: 'operation-alert',
      status: AlertStatus.PENDING,
      attempts: 0,
      payload: { content: '운영 상태' },
    },
  ];
  const alerts = [
    { id: 'stale-alert', status: AlertStatus.CANCELLED, eventClusterId: null, payloadJson: {} },
    {
      id: 'operation-alert',
      status: AlertStatus.PENDING,
      eventClusterId: null,
      payloadJson: { phase: 'OPERATIONAL' },
    },
  ];
  const builder: Record<string, unknown> = {};
  for (const method of ['setLock', 'setOnLocked', 'where', 'andWhere', 'orderBy', 'take'])
    builder[method] = () => builder;
  builder.getMany = async () => rows;
  const manager = {
    getRepository(entity: unknown) {
      if (entity === BotDeliveryEntity)
        return { createQueryBuilder: () => builder, save: async () => rows };
      assert.equal(entity, AlertEntity);
      return { findOneBy: async ({ id }: { id: string }) => alerts.find((row) => row.id === id) };
    },
  };
  const database = {
    requireDataSource: () => ({
      transaction: async (work: (value: typeof manager) => unknown) => work(manager),
    }),
  } as unknown as DatabaseRuntimeService;
  const fixtures = new FixtureStoreService();
  const data = new OrsemDataService(config, database, fixtures);
  const result = await new BotService(
    config,
    database,
    fixtures,
    data,
    emptyInformation,
    emptyNews,
  ).pull('DISCORD', 10, 60);
  assert.deepEqual(
    result.items.map((item) => item.deliveryId),
    ['valid'],
  );
  assert.equal(rows[0]?.status, AlertStatus.CANCELLED);
  assert.equal(rows[0]?.attempts, 0);
  assert.equal(rows[1]?.status, AlertStatus.SENDING);
});

test('global filing type selection defaults to old types and explicit empty disables filing alerts only', () => {
  assert.deepEqual(loadAppConfig({ NODE_ENV: 'test' }).opendartGlobalAlertTypes, [
    'D001',
    'D002',
    'D005',
  ]);
  assert.deepEqual(
    loadAppConfig({ NODE_ENV: 'test', OPENDART_GLOBAL_ALERT_TYPES: 'D003,D005,D003' })
      .opendartGlobalAlertTypes,
    ['D003', 'D005'],
  );
  assert.deepEqual(
    loadAppConfig({ NODE_ENV: 'test', OPENDART_GLOBAL_ALERT_TYPES: '' }).opendartGlobalAlertTypes,
    [],
  );
  assert.equal(alertAllowedByGlobalTypes({ detailType: 'D003' }, []), false);
  assert.equal(alertAllowedByGlobalTypes({ detailType: 'NEWS' }, []), true);
  assert.equal(alertAllowedByGlobalTypes({ phase: 'OPERATIONAL' }, []), true);
});

test('bot news uses only current regional top20 and common metadata without storing Naver responses', async () => {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' });
  const saved: Array<Record<string, unknown>> = [];
  const queries: unknown[] = [];
  const database = {
    requireDataSource: () => ({
      query: async (sql: string, values: string[]) => {
        assert.match(sql, /FROM market_leader_company_links WHERE region=\?/u);
        assert.deepEqual(values, ['kr']);
        return [{ companyId: 'kr-top' }, { companyId: 'kr-class' }];
      },
      getRepository: (entity: unknown) => {
        assert.equal(entity, BotCommandEntity);
        return {
          create: (row: unknown) => row,
          save: async (row: Record<string, unknown>) => {
            saved.push(row);
          },
        };
      },
    }),
  } as unknown as DatabaseRuntimeService;
  const company = (id: string, market = 'KOSPI') => ({
    id,
    nameKo: id,
    market,
    stockCode: market === 'KOSPI' ? '005930' : null,
    ticker: market === 'NASDAQ' ? 'NVDA' : null,
  });
  const article = (id: string, related: string[], publisherId?: string) =>
    ({
      id,
      source: 'NAVER',
      title: `<b>${id}</b> &amp; 제목`,
      description: '제공 요약\n두 번째 줄',
      sourceName: '네이버 뉴스',
      url: `https://example.com/${id}`,
      publishedAt: '2026-09-06T17:30:00Z',
      firstObservedAt: '2026-09-06T18:00:00Z',
      rightsMode: RightsMode.LINK_ONLY,
      publisherId,
      relatedCompanies: related.map((value) =>
        company(value, value === 'us-top' ? 'NASDAQ' : 'KOSPI'),
      ),
      providerOriginal: { title: '원본 비공개 필드' },
      body: '본문 금지',
    }) as unknown as SourceItem;
  const information = {
    selection: async () => ({
      regions: [
        {
          region: 'kr',
          basisDate: '2026-08-31',
          items: [
            { id: 'kr-top', rank: 1 },
            { id: 'kr-other', rank: 21 },
          ],
        },
        { region: 'us', basisDate: '2026-08-31', items: [{ id: 'us-top', rank: 1 }] },
      ],
    }),
  } as unknown as CompanyInformationApiService;
  const data = {
    listNews: async (query: unknown) => {
      queries.push(query);
      return {
        items: [
          article('private-other', ['private']),
          article('outside-top20', ['kr-other']),
          article('us-only', ['us-top']),
          article('common', [], 'federal-reserve'),
        ],
      };
    },
  } as unknown as OrsemDataService;
  const feedCalls: unknown[] = [];
  const naver = {
    feed: async (input: unknown, actor: string) => {
      feedCalls.push([input, actor]);
      return {
        groups: [
          [
            article('kr-news', ['kr-top', 'private']),
            article('class-news', ['kr-class']),
            article('bad-link', ['kr-top']),
          ].map((item) =>
            item.id === 'bad-link' ? { ...item, url: 'javascript:alert(1)' } : item,
          ),
        ],
        status: 'AVAILABLE',
      };
    },
  } as unknown as NaverFocusNewsService;
  const service = new BotService(
    config,
    database,
    new FixtureStoreService(),
    data,
    information,
    naver,
  );
  const response = await service.executeCommand(
    { id: 'device', externalDeviceId: 'bound' },
    {
      deviceId: 'bound',
      command: 'NEWS',
      query: 'kr',
    },
  );
  const items = response.items as Array<{ title: string; relatedCompanies: Array<{ id: string }> }>;
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.flatMap((item) => item.relatedCompanies.map((company) => company.id)),
    ['kr-top', 'kr-class'],
  );
  assert.ok(items.every((item) => !/private|outside|us-only|bad-link/u.test(item.title)));
  assert.match(String(response.message), /kr-news & 제목/);
  assert.match(String(response.message), /제공 요약 두 번째 줄/);
  assert.match(String(response.message), /2026-09-07 02:30 KST/);
  assert.doesNotMatch(JSON.stringify(response), /providerOriginal|본문 금지|원본 비공개/);
  assert.deepEqual(feedCalls, [[{ region: 'kr', scope: 'company' }, 'BOT:PUBLIC']]);
  assert.deepEqual(queries, [
    { audience: 'BOT', region: 'kr', scope: 'company', limit: 100 },
    { audience: 'BOT', region: 'kr', scope: 'market', limit: 20 },
  ]);
  assert.deepEqual(saved[0]?.responseJson, { command: 'news', itemCount: 3 });
  assert.doesNotMatch(JSON.stringify(saved), /https:\/\/|제공 요약|제목|private/);
});

test('bot market returns ranked top20 plus monthly selection metadata and validates regional queries', async () => {
  const { service } = fixtureService();
  const information = {
    selection: async () => ({
      regions: [
        {
          region: 'us',
          basisDate: '2026-08-31',
          selectionMonth: '2026-09',
          refreshCadence: 'MONTHLY',
          nextRefreshAt: '2026-09-30T15:00:00Z',
          sourceName: '공급원',
          items: Array.from({ length: 21 }, (_, i) => ({
            id: String(i),
            rank: i + 1,
            nameKo: `기업${i}`,
            ticker: 'NVDA',
            stockCode: null,
          })).reverse(),
        },
      ],
    }),
  } as unknown as CompanyInformationApiService;
  Object.assign(service, { information });
  const result = await service.market('us');
  assert.equal(result.items.length, 20);
  assert.equal(result.items[0]?.rank, 1);
  assert.equal((result as unknown as { refreshCadence: string }).refreshCadence, 'MONTHLY');
  const response = await service.executeCommand(
    { id: 'device', externalDeviceId: 'bound' },
    {
      deviceId: 'bound',
      command: 'MARKET',
      query: '미국',
    },
  );
  assert.match(String(response.message), /미국 시가총액 상위 20/);
  await assert.rejects(
    service.executeCommand(
      { id: 'device', externalDeviceId: 'bound' },
      {
        deviceId: 'bound',
        command: 'MARKET',
        query: 'all',
      },
    ),
    /지역/,
  );
  const controller = new DiscordBotController(service, {} as OrsemDataService);
  assert.throws(() => controller.market({ region: 'personal' }));
  assert.throws(() => controller.news({ region: 'all', limit: 100 }));
});

test('queued bot deliveries recheck monthly leaders at pull and ack while operational alerts remain eligible', async () => {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' });
  const currentLeaders = new Set(['current-company']);
  const rows = [
    {
      id: 'old-delivery',
      alertId: 'old-alert',
      consumer: 'DISCORD',
      alertDeliveryId: null,
      status: AlertStatus.PENDING,
      attempts: 0,
      payload: {},
    },
    {
      id: 'current-delivery',
      alertId: 'current-alert',
      consumer: 'DISCORD',
      alertDeliveryId: null,
      status: AlertStatus.PENDING,
      attempts: 0,
      payload: {},
    },
    {
      id: 'operation-delivery',
      alertId: 'operation-alert',
      consumer: 'DISCORD',
      alertDeliveryId: null,
      status: AlertStatus.PENDING,
      attempts: 0,
      payload: {},
    },
  ];
  const alerts = [
    { id: 'old-alert', eventClusterId: 'old-event', status: AlertStatus.PENDING, payloadJson: {} },
    {
      id: 'current-alert',
      eventClusterId: 'current-event',
      status: AlertStatus.PENDING,
      payloadJson: {},
    },
    { id: 'operation-alert', eventClusterId: null, status: AlertStatus.PENDING, payloadJson: {} },
  ];
  const manager = {
    getRepository(entity: unknown) {
      if (entity === EventClusterEntity)
        return {
          findOneBy: async ({ id }: { id: string }) => ({
            id,
            companyId: id === 'old-event' ? 'old-company' : 'current-company',
          }),
        };
      if (entity === EventClusterItemEntity) return { find: async () => [] };
      if (entity === MarketLeaderScopeEntity)
        return {
          findOneBy: async ({ companyId }: { companyId: string }) =>
            currentLeaders.has(companyId) ? { priority: 'P1', realtimeAlerts: true } : null,
        };
      assert.ok(entity === BotDeliveryEntity || entity === AlertEntity);
      const records = entity === BotDeliveryEntity ? rows : alerts;
      return {
        findOneBy: async ({ id }: { id: string }) => records.find((row) => row.id === id),
        save: async (value: unknown) => value,
        createQueryBuilder: () => {
          let selected: string | null = null;
          const builder: Record<string, unknown> = {};
          for (const method of ['setLock', 'setOnLocked', 'andWhere', 'orderBy', 'take'])
            builder[method] = () => builder;
          builder.where = (_condition: string, params: Record<string, unknown>) => {
            selected = String(params.id ?? params.deliveryId ?? '');
            return builder;
          };
          builder.getMany = async () => records;
          builder.getOne = async () => records.find((row) => row.id === selected);
          return builder;
        },
      };
    },
  };
  const source = {
    getRepository: manager.getRepository,
    transaction: async (work: (value: typeof manager) => unknown) => work(manager),
  };
  const database = { requireDataSource: () => source } as unknown as DatabaseRuntimeService;
  const service = new BotService(
    config,
    database,
    new FixtureStoreService(),
    {} as OrsemDataService,
    emptyInformation,
    emptyNews,
  );
  const pulled = await service.pull('DISCORD', 10, 60);
  assert.deepEqual(
    pulled.items.map((item) => item.deliveryId),
    ['current-delivery', 'operation-delivery'],
  );
  assert.equal(rows[0]?.status, AlertStatus.CANCELLED);
  currentLeaders.clear(); // The company leaves the monthly selection after leasing.
  await service.acknowledge(
    'DISCORD',
    'current-delivery',
    true,
    null,
    undefined,
    'already-sent-id',
  );
  assert.equal(rows[1]?.status, AlertStatus.CANCELLED);
  await service.acknowledge('DISCORD', 'operation-delivery', true, null, undefined, 'operation-id');
  assert.equal(rows[2]?.status, AlertStatus.ACKNOWLEDGED);
});
