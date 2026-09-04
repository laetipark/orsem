import assert from 'node:assert/strict';
import test from 'node:test';
import type { Queue } from 'bullmq';
import { loadAppConfig } from '../config/app-config';
import { OperationsController } from './operations.controller';
import { MANUAL_ALPACA_ASSET_SYNC_JOB_ID, WorkerQueueService } from './worker-queue.service';

test('fixture backfills use deterministic <=90-day jobs and always suppress alerts', async () => {
  const service = new WorkerQueueService(loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }));
  const result = await service.enqueueBackfill({
    detailTypes: ['D002'],
    startDate: '2026-01-01',
    endDate: '2026-07-01',
  });
  assert.equal(result.queued, 3);
  assert.equal(result.suppressAlerts, true);
  assert.deepEqual(result.jobIds, [
    'backfill-D002-2026-01-01-2026-03-31',
    'backfill-D002-2026-04-01-2026-06-29',
    'backfill-D002-2026-06-30-2026-07-01',
  ]);
});

test('manual Alpaca asset sync enqueues one stable deduplicated market-data job', async () => {
  const service = new WorkerQueueService(
    loadAppConfig({
      NODE_ENV: 'test',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
      ALPACA_API_KEY: 'test-key',
      ALPACA_API_SECRET: 'test-secret',
    }),
  );
  const calls: unknown[][] = [];
  const queue = {
    add: async (...args: unknown[]) => {
      calls.push(args);
      return {};
    },
    close: async () => undefined,
  } as unknown as Queue;
  (service as unknown as { marketDataQueue: Queue | null }).marketDataQueue = queue;

  const result = await service.enqueueAlpacaAssetSync();

  assert.deepEqual(result, {
    queued: 1,
    jobId: MANUAL_ALPACA_ASSET_SYNC_JOB_ID,
    deduplicated: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], 'sync-alpaca-assets');
  assert.deepEqual(calls[0]?.[1], { reason: 'MANUAL' });
  assert.deepEqual(calls[0]?.[2], {
    jobId: MANUAL_ALPACA_ASSET_SYNC_JOB_ID,
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
});

test('manual Alpaca asset sync requires credentials', async () => {
  const service = new WorkerQueueService(loadAppConfig({ NODE_ENV: 'test' }));
  await assert.rejects(service.enqueueAlpacaAssetSync(), /Alpaca 자격 증명/u);
});

test('Alpaca asset sync operation is rate-limited and remains session-authenticated', async () => {
  const queued = {
    queued: 1 as const,
    jobId: MANUAL_ALPACA_ASSET_SYNC_JOB_ID,
    deduplicated: true as const,
  };
  const workerQueue = {
    enqueueAlpacaAssetSync: async () => queued,
  } as WorkerQueueService;
  const controller = new OperationsController(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    null as never,
    null as never,
    workerQueue,
  );

  assert.deepEqual(await controller.syncAlpacaAssets(), queued);
  assert.deepEqual(
    Reflect.getMetadata('orsem:rate-limit', OperationsController.prototype.syncAlpacaAssets),
    { limit: 2, windowMs: 60_000 },
  );
  assert.equal(
    Reflect.getMetadata('orsem:public', OperationsController.prototype.syncAlpacaAssets),
    undefined,
  );
});
