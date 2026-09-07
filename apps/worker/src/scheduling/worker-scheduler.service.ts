import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { DisclosureDetailType } from '@orsem/contracts';
import { Queue } from 'bullmq';
import { matchesRepeatSchedule } from '../queues/repeat-schedule-identity';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { splitDateWindows } from '../common/kst-date';
import { JobName, QueueName, RETIRED_MARKET_DATA_JOB_NAMES } from '../queues/queue.constants';
import { MARKET_INDICATOR_JOBS } from '../market-indicators/jobs';
import {
  ALPACA_ASSET_SYNC_SCHEDULE,
  NEWS_DISCOVERY_SCHEDULES,
  SEC_CIK_SYNC_SCHEDULE,
  OPENDART_CORP_CODE_SCHEDULE,
  OPENDART_POLL_SCHEDULES,
  TOSS_CANDLE_SCHEDULES,
} from './schedule-definitions';

const REPEAT_RETENTION = { count: 100 } as const;
const RETIRED_DISCOVERY_SCHEDULES = [
  {
    id: 'connector-link-discovery-fifteen-minutes',
    pattern: '*/15 * * * *',
    timezone: 'Asia/Seoul',
  },
  { id: 'naver-news-p1-twenty-minutes', pattern: '*/20 * * * *', timezone: 'Asia/Seoul' },
  { id: 'naver-news-p2-hourly', pattern: '0 * * * *', timezone: 'Asia/Seoul' },
  { id: 'registered-ir-thirty-minutes', pattern: '*/30 * * * *', timezone: 'Asia/Seoul' },
  { id: 'publisher-news-rss-thirty-minutes', pattern: '*/30 * * * *', timezone: 'Asia/Seoul' },
  { id: 'approved-gdelt-thirty-minutes', pattern: '*/30 * * * *', timezone: 'Asia/Seoul' },
];

@Injectable()
export class WorkerSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(WorkerSchedulerService.name);

  public constructor(
    @InjectQueue(QueueName.POLL) private readonly pollQueue: Queue,
    @InjectQueue(QueueName.OUTBOX) private readonly outboxQueue: Queue,
    @InjectQueue(QueueName.CONNECTOR_HEALTH)
    private readonly healthQueue: Queue,
    @InjectQueue(QueueName.MARKET_DATA)
    private readonly marketDataQueue: Queue,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @InjectQueue(QueueName.NEWS_TRANSLATION) private readonly translationQueue: Queue,
    @InjectQueue(QueueName.MARKET_NEWS) private readonly marketNewsQueue: Queue,
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.removeRetiredDiscoverySchedules();
    await this.removeManagedMarketDataSchedules();
    await this.configureTranslationSchedule();
    if (this.config.secUserAgent) {
      await this.healthQueue.add(
        JobName.SYNC_SEC_CIK,
        {},
        {
          jobId: SEC_CIK_SYNC_SCHEDULE.id,
          repeat: { pattern: SEC_CIK_SYNC_SCHEDULE.pattern, tz: SEC_CIK_SYNC_SCHEDULE.timezone },
          attempts: 1,
          removeOnComplete: REPEAT_RETENTION,
          removeOnFail: REPEAT_RETENTION,
        },
      );
    } else {
      for (const repeat of await this.healthQueue.getRepeatableJobs()) {
        if (matchesRepeatSchedule(repeat, JobName.SYNC_SEC_CIK, SEC_CIK_SYNC_SCHEDULE)) {
          await this.healthQueue.removeRepeatableByKey(repeat.key);
        }
      }
    }
    for (const [name, pattern] of [
      [MARKET_INDICATOR_JOBS.quotes, '* * * * *'],
      [MARKET_INDICATOR_JOBS.history, '10 */6 * * *'],
    ] as const) {
      await this.marketDataQueue.add(
        name,
        {},
        {
          jobId: name,
          repeat: { pattern, tz: 'Asia/Seoul' },
          attempts: 1,
          removeOnComplete: REPEAT_RETENTION,
          removeOnFail: REPEAT_RETENTION,
        },
      );
    }
    await this.marketDataQueue.add(
      MARKET_INDICATOR_JOBS.history,
      {},
      {
        jobId: 'market-indicators-initial-history',
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: REPEAT_RETENTION,
      },
    );
    if (this.config.openDartApiKey) {
      await Promise.all(
        OPENDART_POLL_SCHEDULES.map((schedule) =>
          this.pollQueue.add(
            JobName.POLL_OPENDART,
            {
              detailType: schedule.detailType,
              suppressAlerts: false,
              reason: 'SCHEDULED',
            },
            {
              jobId: schedule.id,
              repeat: {
                pattern: schedule.pattern,
                tz: schedule.timezone,
              },
              attempts: 3,
              backoff: { type: 'exponential', delay: 30_000 },
              removeOnComplete: REPEAT_RETENTION,
              removeOnFail: REPEAT_RETENTION,
            },
          ),
        ),
      );
      await this.pollQueue.add(
        JobName.SYNC_CORP_CODES,
        {},
        {
          jobId: OPENDART_CORP_CODE_SCHEDULE.id,
          repeat: {
            pattern: OPENDART_CORP_CODE_SCHEDULE.pattern,
            tz: OPENDART_CORP_CODE_SCHEDULE.timezone,
          },
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: REPEAT_RETENTION,
          removeOnFail: REPEAT_RETENTION,
        },
      );
    } else {
      this.logger.warn('OPENDART_API_KEY missing; OpenDART schedules are disabled.');
    }
    await this.outboxQueue.add(
      JobName.DISPATCH_OUTBOX,
      {},
      {
        jobId: 'processing-outbox-minute',
        repeat: { pattern: '* * * * *', tz: 'Asia/Seoul' },
        attempts: 1,
        removeOnComplete: REPEAT_RETENTION,
        removeOnFail: REPEAT_RETENTION,
      },
    );
    await this.healthQueue.add(
      JobName.CHECK_CONNECTORS,
      {},
      {
        jobId: 'connector-health-ten-minutes',
        repeat: { pattern: '*/10 * * * *', tz: 'Asia/Seoul' },
        attempts: 1,
        removeOnComplete: REPEAT_RETENTION,
        removeOnFail: REPEAT_RETENTION,
      },
    );
    await Promise.all(
      NEWS_DISCOVERY_SCHEDULES.filter(
        (schedule) =>
          (!schedule.payload.connectors.includes('NEWS_RSS') ||
            this.config.newsRssFeeds.length > 0) &&
          (!schedule.payload.connectors.includes('GDELT') || this.config.gdeltEnabled) &&
          (!schedule.payload.connectors.includes('ALPACA_NEWS') || this.config.alpacaNewsEnabled) &&
          (!schedule.payload.connectors.includes('MARKETAUX') ||
            this.config.marketauxNewsEnabled) &&
          (!schedule.payload.connectors.includes('ALPHAVANTAGE') ||
            this.config.alphaVantageNewsEnabled) &&
          (!schedule.payload.connectors.includes('FINNHUB') || this.config.finnhubNewsEnabled),
      ).map((schedule) =>
        (schedule.payload.connectors.includes('SEC') ? this.healthQueue : this.marketNewsQueue).add(
          JobName.DISCOVER_LINKS,
          schedule.payload,
          {
            jobId: schedule.id,
            repeat: {
              pattern: schedule.pattern,
              tz: schedule.timezone,
            },
            attempts: 1,
            removeOnComplete: REPEAT_RETENTION,
            removeOnFail: REPEAT_RETENTION,
          },
        ),
      ),
    );
    if (this.config.alpacaApiKey && this.config.alpacaApiSecret) {
      await this.marketDataQueue.add(
        JobName.SYNC_ALPACA_ASSETS,
        { reason: 'SCHEDULED' },
        {
          jobId: ALPACA_ASSET_SYNC_SCHEDULE.id,
          repeat: {
            pattern: ALPACA_ASSET_SYNC_SCHEDULE.pattern,
            tz: ALPACA_ASSET_SYNC_SCHEDULE.timezone,
          },
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: REPEAT_RETENTION,
          removeOnFail: REPEAT_RETENTION,
        },
      );
    }
    if (
      this.config.marketDataProvider === 'toss' &&
      this.config.tossClientId &&
      this.config.tossClientSecret
    ) {
      await this.marketDataQueue.add(
        JobName.SYNC_TOSS_STOCKS,
        { reason: 'SCHEDULED' },
        {
          jobId: 'toss-stock-info-daily',
          repeat: { pattern: '30 7 * * *', tz: 'Asia/Seoul' },
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: REPEAT_RETENTION,
          removeOnFail: REPEAT_RETENTION,
        },
      );
      for (const schedule of TOSS_CANDLE_SCHEDULES) {
        await this.marketDataQueue.add(
          JobName.INGEST_TOSS_CANDLES,
          {
            interval: schedule.interval,
            lookbackDays: schedule.lookbackDays,
            maxPages: 1,
            reason: 'SCHEDULED',
          },
          {
            jobId: schedule.id,
            repeat: { pattern: schedule.pattern, tz: 'Asia/Seoul' },
            attempts: 3,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: REPEAT_RETENTION,
            removeOnFail: REPEAT_RETENTION,
          },
        );
      }
      // 최초 배포 때만 관심 기업의 실제 출처 이력을 초기 수집합니다.
      // 제공자에게서 가져오는 데이터이며 예시 데이터를 넣는 작업이 아닙니다.
      await this.marketDataQueue.add(
        JobName.INGEST_TOSS_CANDLES,
        {
          interval: '1d',
          lookbackDays: 366,
          maxPages: 3,
          reason: 'SCHEDULED',
        },
        {
          jobId: 'toss-initial-daily-history',
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    } else if (this.config.marketDataProvider === 'toss') {
      this.logger.warn('Toss credentials missing; Toss candles and live quotes are disabled.');
    }
    if (!this.config.alpacaApiKey || !this.config.alpacaApiSecret) {
      this.logger.warn('Alpaca credentials missing; the asset identity schedule is disabled.');
    }
  }

  public async enqueueBackfill(input: {
    readonly detailTypes: readonly DisclosureDetailType[];
    readonly startDate: string;
    readonly endDate: string;
  }): Promise<number> {
    const windows = splitDateWindows(input.startDate, input.endDate, 90);
    let count = 0;
    for (const detailType of input.detailTypes) {
      for (const window of windows) {
        await this.pollQueue.add(
          JobName.BACKFILL_OPENDART,
          {
            detailType,
            startDate: window.start,
            endDate: window.end,
            suppressAlerts: true,
            reason: 'BACKFILL',
          },
          {
            jobId: `backfill-${detailType}-${window.start}-${window.end}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: false,
            removeOnFail: false,
          },
        );
        count += 1;
      }
    }
    return count;
  }

  private async removeRetiredDiscoverySchedules(): Promise<void> {
    // BullMQ v5 repeat identities may omit their ID; the managed job name is stable.
    // Reconcile both old and new queues so a restart cannot leave parallel schedules behind.
    for (const queue of [this.healthQueue, this.marketNewsQueue]) {
      for (const repeat of await queue.getRepeatableJobs()) {
        if (
          [...NEWS_DISCOVERY_SCHEDULES, ...RETIRED_DISCOVERY_SCHEDULES].some((schedule) =>
            matchesRepeatSchedule(repeat, JobName.DISCOVER_LINKS, schedule),
          )
        )
          await queue.removeRepeatableByKey(repeat.key);
      }
    }
  }

  private async configureTranslationSchedule(): Promise<void> {
    const jobs = await this.translationQueue.getRepeatableJobs();
    for (const job of jobs) {
      if (job.name === JobName.TRANSLATE_NEWS_BATCH)
        await this.translationQueue.removeRepeatableByKey(job.key);
    }
    if (!this.config.newsTranslationEnabled) return;
    await this.translationQueue.add(
      JobName.TRANSLATE_NEWS_BATCH,
      {},
      {
        jobId: 'news-translation-minute',
        repeat: { pattern: '* * * * *', tz: 'Asia/Seoul' },
        attempts: 1,
        removeOnComplete: REPEAT_RETENTION,
        removeOnFail: REPEAT_RETENTION,
      },
    );
  }

  private async removeManagedMarketDataSchedules(): Promise<void> {
    const managedIds = new Set([
      'krx-stock-eod-weekdays',
      'alpaca-p1-p2-eod-tuesday-saturday',
      ...TOSS_CANDLE_SCHEDULES.map((schedule) => schedule.id),
      ALPACA_ASSET_SYNC_SCHEDULE.id,
      'toss-stock-info-daily',
    ]);
    const managedNames = new Set<string>([
      ...RETIRED_MARKET_DATA_JOB_NAMES,
      JobName.INGEST_TOSS_CANDLES,
      JobName.SYNC_TOSS_STOCKS,
      ALPACA_ASSET_SYNC_SCHEDULE.jobName,
      MARKET_INDICATOR_JOBS.quotes,
      MARKET_INDICATOR_JOBS.history,
    ]);
    const repeatable = await this.marketDataQueue.getRepeatableJobs();
    await Promise.all(
      repeatable
        // BullMQ 5의 해시 기반 반복 작업은 보통 getRepeatableJobs() 결과에서
        // `id`를 생략합니다. 작업 이름은 계속 제공되므로, 이를 기준으로
        // 이 스케줄러가 관리하는 영속 작업을 식별합니다.
        .filter(
          (job) =>
            (job.id !== null && job.id !== undefined && managedIds.has(job.id)) ||
            managedNames.has(job.name),
        )
        .map((job) => this.marketDataQueue.removeRepeatableByKey(job.key)),
    );
  }
}
