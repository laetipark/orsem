import { DisclosureDetailType } from '@orsem/contracts';
import type { Queue } from 'bullmq';
import { splitDateWindows } from '../src/common/kst-date';
import { loadWorkerConfig } from '../src/config/worker-config';
import { discoverLinksJobSchema, syncAlpacaAssetsJobSchema } from '../src/queues/job-data';
import {
  ALPACA_ASSET_SYNC_SCHEDULE,
  NEWS_DISCOVERY_SCHEDULES,
  OPENDART_CORP_CODE_SCHEDULE,
  OPENDART_POLL_SCHEDULES,
  SEC_CIK_SYNC_SCHEDULE,
} from '../src/scheduling/schedule-definitions';
import { WorkerSchedulerService } from '../src/scheduling/worker-scheduler.service';

describe('worker schedules', () => {
  it('permits only explicit, alert-suppressed SEC backfills', () => {
    const job = {
      connectors: ['SEC'],
      priorities: [],
      companyIds: ['00000000-0000-4000-8000-000000000001'],
      reason: 'BACKFILL',
      suppressAlerts: true,
    };
    expect(discoverLinksJobSchema.safeParse(job).success).toBe(true);
    for (const invalid of [
      { ...job, suppressAlerts: false },
      { ...job, suppressAlerts: undefined },
      { ...job, companyIds: [] },
      { ...job, connectors: ['NAVER'] },
      { ...job, companyIds: [...job.companyIds, ...job.companyIds] },
      { ...job, priorities: ['P1'] },
    ])
      expect(discoverLinksJobSchema.safeParse(invalid).success).toBe(false);
  });

  it('registers CIK refresh daily and removes only that schedule when SEC is disabled', async () => {
    const queue = (): Queue =>
      ({
        add: jest.fn().mockResolvedValue({}),
        getRepeatableJobs: jest.fn().mockResolvedValue([]),
        removeRepeatableByKey: jest.fn().mockResolvedValue(true),
      }) as unknown as Queue;
    const enabledHealth = queue();
    await new WorkerSchedulerService(
      queue(),
      queue(),
      enabledHealth,
      queue(),
      loadWorkerConfig({ SEC_USER_AGENT: 'Orsem test@example.com' }),
      queue(),
      queue(),
    ).onModuleInit();
    expect(enabledHealth.add).toHaveBeenCalledWith(
      'sync-sec-cik',
      {},
      expect.objectContaining({
        jobId: SEC_CIK_SYNC_SCHEDULE.id,
        repeat: { pattern: '25 7 * * *', tz: 'Asia/Seoul' },
      }),
    );
    const disabledHealth = queue();
    jest.mocked(disabledHealth.getRepeatableJobs).mockResolvedValue([
      {
        id: SEC_CIK_SYNC_SCHEDULE.id,
        name: 'sync-sec-cik',
        pattern: '25 7 * * *',
        tz: 'Asia/Seoul',
        key: 'cik',
      },
      { id: 'other', name: 'other', pattern: '25 7 * * *', tz: 'Asia/Seoul', key: 'other' },
    ] as Awaited<ReturnType<Queue['getRepeatableJobs']>>);
    await new WorkerSchedulerService(
      queue(),
      queue(),
      disabledHealth,
      queue(),
      loadWorkerConfig({}),
      queue(),
      queue(),
    ).onModuleInit();
    expect(disabledHealth.removeRepeatableByKey).toHaveBeenCalledTimes(1);
    expect(disabledHealth.removeRepeatableByKey).toHaveBeenCalledWith('cik');
    expect(
      jest.mocked(disabledHealth.add).mock.calls.some(([name]) => name === 'sync-sec-cik'),
    ).toBe(false);
  });

  it('has disjoint approved weekday cadence windows for every detail type', () => {
    for (const detailType of Object.values(DisclosureDetailType)) {
      const definitions = OPENDART_POLL_SCHEDULES.filter(
        (schedule) => schedule.detailType === detailType,
      );
      expect(definitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pattern: '*/2 8-19 * * 1-5' }),
          expect.objectContaining({ pattern: '*/5 0-7,20-23 * * 1-5' }),
          expect.objectContaining({ pattern: '*/30 * * * 0,6' }),
        ]),
      );
    }
  });

  it('never creates a backfill window longer than 90 calendar days', () => {
    const windows = splitDateWindows('2026-01-01', '2026-09-03');
    expect(windows[0]).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(windows.at(-1)?.end).toBe('2026-09-03');
  });

  it('refreshes corp codes Sunday at 03:30 KST', () => {
    expect(OPENDART_CORP_CODE_SCHEDULE).toEqual({
      id: 'opendart-corp-code-weekly',
      pattern: '30 3 * * 0',
      timezone: 'Asia/Seoul',
    });
  });

  it('uses the approved source and priority-specific discovery cadences', () => {
    expect(NEWS_DISCOVERY_SCHEDULES).toEqual([
      expect.objectContaining({
        id: 'sec-submissions-p1-p2-ten-minutes',
        pattern: '*/10 * * * *',
        timezone: 'Asia/Seoul',
        payload: expect.objectContaining({
          connectors: ['SEC'],
          priorities: ['P1', 'P2'],
        }),
      }),
      expect.objectContaining({
        id: 'registered-ir-fifteen-minutes',
        pattern: '*/15 * * * *',
        timezone: 'Asia/Seoul',
        payload: expect.objectContaining({
          connectors: ['IR'],
          priorities: [],
        }),
      }),
      expect.objectContaining({
        id: 'publisher-news-rss-fifteen-minutes',
        pattern: '*/15 * * * *',
        timezone: 'Asia/Seoul',
        payload: expect.objectContaining({ connectors: ['NEWS_RSS'], priorities: [] }),
      }),
    ]);
    for (const schedule of NEWS_DISCOVERY_SCHEDULES) {
      expect(discoverLinksJobSchema.safeParse(schedule.payload).success).toBe(true);
    }
  });

  it('refreshes the Alpaca asset master after the New York session', () => {
    expect(ALPACA_ASSET_SYNC_SCHEDULE).toEqual({
      id: 'alpaca-asset-master-before-eod',
      jobName: 'sync-alpaca-assets',
      pattern: '15 7 * * 2-6',
      timezone: 'Asia/Seoul',
    });
    expect(syncAlpacaAssetsJobSchema.safeParse({ reason: 'SCHEDULED' }).success).toBe(true);
    expect(syncAlpacaAssetsJobSchema.safeParse({ reason: 'UNKNOWN' }).success).toBe(false);
  });

  it('reconciles durable market schedules and disables them when credentials are absent', async () => {
    const queue = (): Queue =>
      ({
        add: jest.fn().mockResolvedValue({}),
        getRepeatableJobs: jest.fn().mockResolvedValue([]),
        removeRepeatableByKey: jest.fn().mockResolvedValue(true),
      }) as unknown as Queue;
    const poll = queue();
    const outbox = queue();
    const health = queue();
    const market = queue();
    jest.mocked(market.getRepeatableJobs).mockResolvedValue([
      { id: null, name: 'ingest-krx-eod', key: 'old-krx' },
      { id: null, name: 'ingest-alpaca-eod', key: 'old-alpaca' },
      { id: null, name: 'sync-alpaca-assets', key: 'old-alpaca-assets' },
      { id: null, name: 'unmanaged-market-job', key: 'unmanaged' },
    ] as Awaited<ReturnType<Queue['getRepeatableJobs']>>);

    await new WorkerSchedulerService(
      poll,
      outbox,
      health,
      market,
      loadWorkerConfig({}),
      queue(),
      queue(),
    ).onModuleInit();

    expect(market.removeRepeatableByKey).toHaveBeenCalledTimes(3);
    expect(market.removeRepeatableByKey).toHaveBeenCalledWith('old-krx');
    expect(market.removeRepeatableByKey).toHaveBeenCalledWith('old-alpaca');
    expect(market.removeRepeatableByKey).toHaveBeenCalledWith('old-alpaca-assets');
    expect(market.removeRepeatableByKey).not.toHaveBeenCalledWith('unmanaged');
    expect(market.add).toHaveBeenCalledTimes(3);
    expect(market.add).toHaveBeenCalledWith(
      'refresh-market-indicator-quotes',
      {},
      expect.objectContaining({
        repeat: { pattern: '* * * * *', tz: 'Asia/Seoul' },
        attempts: 1,
      }),
    );
    expect(market.add).toHaveBeenCalledWith(
      'refresh-market-indicator-history',
      {},
      expect.objectContaining({
        repeat: { pattern: '10 */6 * * *', tz: 'Asia/Seoul' },
        attempts: 1,
      }),
    );
    expect(market.add).toHaveBeenCalledWith(
      'refresh-market-indicator-history',
      {},
      expect.objectContaining({
        jobId: 'market-indicators-initial-history',
        attempts: 1,
      }),
    );
  });

  it('registers the asset-master schedule only with both Alpaca credentials', async () => {
    const queue = (): Queue =>
      ({
        add: jest.fn().mockResolvedValue({}),
        getRepeatableJobs: jest.fn().mockResolvedValue([]),
        removeRepeatableByKey: jest.fn().mockResolvedValue(true),
      }) as unknown as Queue;
    const market = queue();
    await new WorkerSchedulerService(
      queue(),
      queue(),
      queue(),
      market,
      loadWorkerConfig({ ALPACA_API_KEY: 'test-key', ALPACA_API_SECRET: 'test-secret' }),
      queue(),
      queue(),
    ).onModuleInit();

    expect(market.add).toHaveBeenCalledWith(
      'sync-alpaca-assets',
      { reason: 'SCHEDULED' },
      expect.objectContaining({
        jobId: 'alpaca-asset-master-before-eod',
        repeat: { pattern: '15 7 * * 2-6', tz: 'Asia/Seoul' },
      }),
    );
    expect(market.add).toHaveBeenCalledTimes(4);
  });
});
