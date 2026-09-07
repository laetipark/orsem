import { DisclosureDetailType, WatchPriority, WorkerJobName } from '@orsem/contracts';
import { OPENDART_WORKER_TYPES } from '../opendart/disclosure-policy';

export interface PollScheduleDefinition {
  readonly id: string;
  readonly detailType: DisclosureDetailType;
  readonly pattern: string;
  readonly timezone: 'Asia/Seoul';
  readonly cadence: 'FOCUSED' | 'OFF_HOURS' | 'WEEKEND';
}

export const OPENDART_CORP_CODE_SCHEDULE = Object.freeze({
  id: 'opendart-corp-code-weekly',
  pattern: '30 3 * * 0',
  timezone: 'Asia/Seoul' as const,
});

export const SEC_CIK_SYNC_SCHEDULE = Object.freeze({
  id: 'sec-cik-master-daily',
  pattern: '25 7 * * *',
  timezone: 'Asia/Seoul' as const,
});

export interface NewsDiscoveryScheduleDefinition {
  readonly id: string;
  readonly pattern: string;
  readonly timezone: 'Asia/Seoul';
  readonly payload: Readonly<{
    connectors: readonly (
      'SEC' | 'IR' | 'NEWS_RSS' | 'GDELT' | 'ALPACA_NEWS' | 'MARKETAUX' | 'ALPHAVANTAGE' | 'FINNHUB'
    )[];
    priorities: readonly (
      typeof WatchPriority.P1 | typeof WatchPriority.P2 | typeof WatchPriority.P3
    )[];
    companyIds: readonly string[];
    reason: 'SCHEDULED';
  }>;
}

export const NEWS_DISCOVERY_SCHEDULES: readonly NewsDiscoveryScheduleDefinition[] = Object.freeze([
  ...(
    [
      { id: 'marketaux-news-hourly', pattern: '0 * * * *', connector: 'MARKETAUX' },
      { id: 'alphavantage-news-twice-daily', pattern: '0 0,12 * * *', connector: 'ALPHAVANTAGE' },
      { id: 'finnhub-news-hourly', pattern: '0 * * * *', connector: 'FINNHUB' },
    ] as const
  ).map((schedule) =>
    Object.freeze({
      id: schedule.id,
      pattern: schedule.pattern,
      timezone: 'Asia/Seoul' as const,
      payload: Object.freeze({
        reason: 'SCHEDULED' as const,
        connectors: Object.freeze([schedule.connector]),
        priorities: Object.freeze([]),
        companyIds: Object.freeze([]),
        suppressAlerts: true,
      }),
    }),
  ),
  Object.freeze({
    id: 'alpaca-news-thirty-minutes',
    pattern: '*/30 * * * *',
    timezone: 'Asia/Seoul',
    payload: Object.freeze({
      reason: 'SCHEDULED' as const,
      connectors: Object.freeze(['ALPACA_NEWS'] as const),
      priorities: Object.freeze([]),
      companyIds: Object.freeze([]),
      suppressAlerts: true,
    }),
  }),
  Object.freeze({
    id: 'gdelt-metadata-thirty-minutes',
    pattern: '*/30 * * * *',
    timezone: 'Asia/Seoul',
    payload: Object.freeze({
      reason: 'SCHEDULED' as const,
      connectors: Object.freeze(['GDELT'] as const),
      priorities: Object.freeze([]),
      companyIds: Object.freeze([]),
      suppressAlerts: true,
    }),
  }),
  Object.freeze({
    id: 'sec-submissions-p1-p2-ten-minutes',
    pattern: '*/10 * * * *',
    timezone: 'Asia/Seoul' as const,
    payload: Object.freeze({
      connectors: Object.freeze(['SEC'] as const),
      priorities: Object.freeze([WatchPriority.P1, WatchPriority.P2]),
      companyIds: Object.freeze([]),
      reason: 'SCHEDULED' as const,
    }),
  }),
  Object.freeze({
    id: 'registered-ir-fifteen-minutes',
    pattern: '*/15 * * * *',
    timezone: 'Asia/Seoul' as const,
    payload: Object.freeze({
      connectors: Object.freeze(['IR'] as const),
      priorities: Object.freeze([]),
      companyIds: Object.freeze([]),
      reason: 'SCHEDULED' as const,
    }),
  }),
  Object.freeze({
    id: 'publisher-news-rss-fifteen-minutes',
    pattern: '*/15 * * * *',
    timezone: 'Asia/Seoul' as const,
    payload: Object.freeze({
      connectors: Object.freeze(['NEWS_RSS'] as const),
      priorities: Object.freeze([]),
      companyIds: Object.freeze([]),
      reason: 'SCHEDULED' as const,
    }),
  }),
]);

export const ALPACA_ASSET_SYNC_SCHEDULE = Object.freeze({
  id: 'alpaca-asset-master-before-eod',
  jobName: WorkerJobName.SYNC_ALPACA_ASSETS,
  // 뉴욕 거래 세션이 끝난 뒤 미국 기업 식별 정보를 갱신합니다.
  pattern: '15 7 * * 2-6',
  timezone: 'Asia/Seoul' as const,
});

export const TOSS_CANDLE_SCHEDULES = Object.freeze([
  { id: 'toss-daily-hourly', pattern: '5 * * * *', interval: '1d' as const, lookbackDays: 3 },
  { id: 'toss-minute-candles', pattern: '* * * * *', interval: '1m' as const, lookbackDays: 1 },
]);

const CADENCES = [
  {
    cadence: 'FOCUSED' as const,
    pattern: '*/2 8-19 * * 1-5',
  },
  {
    cadence: 'OFF_HOURS' as const,
    pattern: '*/5 0-7,20-23 * * 1-5',
  },
  {
    cadence: 'WEEKEND' as const,
    pattern: '*/30 * * * 0,6',
  },
];

export const OPENDART_POLL_SCHEDULES: readonly PollScheduleDefinition[] = Object.freeze(
  OPENDART_WORKER_TYPES.flatMap((detailType) =>
    CADENCES.map((cadence) => ({
      id: `opendart-${detailType.toLowerCase()}-${cadence.cadence.toLowerCase()}`,
      detailType,
      pattern: cadence.pattern,
      timezone: 'Asia/Seoul' as const,
      cadence: cadence.cadence,
    })),
  ),
);
