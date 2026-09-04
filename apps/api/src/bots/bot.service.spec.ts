import assert from 'node:assert/strict';
import test from 'node:test';
import { AlertStatus } from '@orsem/contracts';
import { AlertEntity, BotDeliveryEntity } from '@orsem/database';
import { BotService } from './bot.service';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { OrsemDataService } from '../resources/orsem-data.service';

function fixtureService() {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  const database = new DatabaseRuntimeService(config);
  const fixtures = new FixtureStoreService();
  const data = new OrsemDataService(config, database, fixtures);
  return { service: new BotService(config, database, fixtures, data), fixtures };
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
  const result = await new BotService(config, database, fixtures, data).pull('DISCORD', 10, 60);
  assert.deepEqual(
    result.items.map((item) => item.deliveryId),
    ['valid'],
  );
  assert.equal(rows[0]?.status, AlertStatus.CANCELLED);
  assert.equal(rows[0]?.attempts, 0);
  assert.equal(rows[1]?.status, AlertStatus.SENDING);
});
