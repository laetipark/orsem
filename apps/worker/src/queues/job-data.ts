import { DisclosureDetailType, WatchPriority } from '@orsem/contracts';
import { z } from 'zod';

export const pollOpenDartJobSchema = z.object({
  detailType: z.enum(DisclosureDetailType),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  suppressAlerts: z.boolean().default(false),
  reason: z.enum(['SCHEDULED', 'BACKFILL', 'RECOVERY']).default('SCHEDULED'),
});
export type PollOpenDartJob = z.infer<typeof pollOpenDartJobSchema>;

export const enrichFilingJobSchema = z.object({
  filingId: z.string().uuid(),
  rceptNo: z.string().regex(/^\d{14}$/),
  detailType: z.enum(DisclosureDetailType),
  suppressAlerts: z.boolean().default(false),
  documentRetryAttempt: z.number().int().min(0).max(3).default(0),
});
export type EnrichFilingJob = z.infer<typeof enrichFilingJobSchema>;

export const applyParseProjectionJobSchema = z.object({
  filingId: z.string().uuid(),
  parseRunId: z.string().uuid(),
  requestedByAdminId: z.string().uuid(),
  crosscheckOnly: z.boolean().optional(),
});
export type ApplyParseProjectionJob = z.infer<typeof applyParseProjectionJobSchema>;

export const reviewParseWithAiJobSchema = z.object({
  filingId: z.string().uuid(),
  parseRunId: z.string().uuid(),
});
export type ReviewParseWithAiJob = z.infer<typeof reviewParseWithAiJobSchema>;

export const scheduledDiscoveryConnectorSchema = z.enum([
  'NAVER',
  'SEC',
  'IR',
  'NEWS_RSS',
  'GDELT',
  'ALPACA_NEWS',
  'MARKETAUX',
  'ALPHAVANTAGE',
  'FINNHUB',
]);

export const discoverLinksJobSchema = z
  .object({
    connectors: z.array(scheduledDiscoveryConnectorSchema).min(1).max(3),
    priorities: z
      .array(z.enum([WatchPriority.P1, WatchPriority.P2, WatchPriority.P3]))
      .max(3)
      .default([]),
    companyIds: z.array(z.string().uuid()).max(100).default([]),
    reason: z.enum(['SCHEDULED', 'DISCLOSURE_TRIGGER', 'BACKFILL']),
    suppressAlerts: z.boolean().optional(),
    triggerFilingId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    const uniqueConnectors = new Set(value.connectors);
    const uniquePriorities = new Set(value.priorities);
    if (
      uniqueConnectors.size !== value.connectors.length ||
      uniquePriorities.size !== value.priorities.length ||
      new Set(value.companyIds).size !== value.companyIds.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Discovery connectors and priorities must not contain duplicates.',
      });
    }
    if (value.reason === 'BACKFILL') {
      if (
        value.connectors.length !== 1 ||
        value.connectors[0] !== 'SEC' ||
        value.priorities.length !== 0 ||
        value.companyIds.length === 0 ||
        value.suppressAlerts !== true ||
        value.triggerFilingId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'SEC backfill requires explicit companies and suppressed alerts.',
        });
      }
      return;
    }
    if (value.reason === 'DISCLOSURE_TRIGGER') {
      if (
        value.connectors.length !== 1 ||
        value.connectors[0] !== 'NAVER' ||
        value.priorities.length !== 1 ||
        value.priorities[0] !== WatchPriority.P3 ||
        value.companyIds.length !== 1 ||
        !value.triggerFilingId
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Disclosure-triggered discovery must target NAVER/P3 and exactly one company and filing.',
        });
      }
      return;
    }
    if (value.companyIds.length > 0 || value.triggerFilingId) {
      context.addIssue({
        code: 'custom',
        message: 'Scheduled discovery cannot carry explicit company or filing ids.',
      });
    }
    const signature = `${[...value.connectors].sort().join(',')}:${[...value.priorities]
      .sort()
      .join(',')}`;
    if (
      ![
        'NAVER:P1',
        'NAVER:P2',
        'SEC:P1,P2',
        'IR:',
        'NEWS_RSS:',
        'GDELT:',
        'ALPACA_NEWS:',
        'MARKETAUX:',
        'ALPHAVANTAGE:',
        'FINNHUB:',
      ].includes(signature)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Scheduled discovery does not match an approved source cadence.',
      });
    }
  });
export type DiscoverLinksJob = z.infer<typeof discoverLinksJobSchema>;

export const syncSecCikJobSchema = z.object({
  companyIds: z.array(z.string().uuid()).min(1).max(10_000).optional(),
});

export const tossCandlesJobSchema = z.object({
  interval: z.enum(['1d', '1m']),
  companyIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  reason: z.enum(['SCHEDULED', 'MANUAL', 'VIEW']).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  lookbackDays: z.number().int().min(1).max(366).optional(),
  maxPages: z.number().int().min(1).max(6).optional(),
});
export type TossCandlesJob = z.infer<typeof tossCandlesJobSchema>;

export const syncTossStocksJobSchema = z
  .object({
    companyIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    reason: z.enum(['SCHEDULED', 'MANUAL']).default('MANUAL'),
  })
  .strict();

export const syncAlpacaAssetsJobSchema = z
  .object({
    reason: z.enum(['SCHEDULED', 'MANUAL']),
  })
  .strict();
export type SyncAlpacaAssetsJob = z.infer<typeof syncAlpacaAssetsJobSchema>;
