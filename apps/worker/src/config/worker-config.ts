import { z } from 'zod';
import { APPROVED_GDELT_DOMAINS, APPROVED_GDELT_SOURCE_POLICIES } from '@orsem/contracts';
import { readFileSync } from 'node:fs';
import { loadWebPushConfig, type WebPushConfig } from '@orsem/database';
import { DisclosureDetailType } from '@orsem/contracts';
import {
  assertRegisteredFeedUrl,
  isApprovedContentIrFeed,
  MAX_REGISTERED_IR_FEEDS,
  NEWS_RSS_FEED_IDS,
} from '../connectors/connector-adapters';
import { DEFAULT_GLOBAL_ALERT_TYPES } from '../opendart/disclosure-policy';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const DEFAULT_DATABASE_URL = 'mysql://orsem:change-me@127.0.0.1:3306/orsem';
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379/0';
const ALPACA_TRADING_HOSTS = new Set(['api.alpaca.markets', 'paper-api.alpaca.markets']);

function serviceUrl(protocols: readonly string[], label: string) {
  return z
    .string()
    .min(1)
    .superRefine((value, context) => {
      try {
        const parsed = new URL(value);
        if (!protocols.includes(parsed.protocol)) {
          context.addIssue({
            code: 'custom',
            message: `${label} must use ${protocols.join(' or ')}.`,
          });
        }
      } catch {
        context.addIssue({ code: 'custom', message: `${label} must be a valid URL.` });
      }
    });
}

const alpacaTradingBaseUrl = z
  .string()
  .url()
  .default('https://paper-api.alpaca.markets')
  .superRefine((value, context) => {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      !ALPACA_TRADING_HOSTS.has(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== '443') ||
      (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.search ||
      parsed.hash
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'ALPACA_TRADING_BASE_URL must be the HTTPS origin for api.alpaca.markets or paper-api.alpaca.markets.',
      });
    }
  })
  .transform((value) => value.replace(/\/+$/, ''));

const optionalTrimmed = z
  .string()
  .optional()
  .transform((value) => value?.trim() || null);

const secUserAgent = optionalTrimmed.superRefine((value, context) => {
  if (
    value &&
    (value.length > 255 || !/^[A-Za-z0-9][^\r\n]{0,127}\s+[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'SEC_USER_AGENT must contain an application identity followed by a contact email.',
    });
  }
});

const registeredIrFeedUrls = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .superRefine((urls, context) => {
    if (urls.length > MAX_REGISTERED_IR_FEEDS) {
      context.addIssue({
        code: 'custom',
        message: `IR_FEED_URLS supports at most ${MAX_REGISTERED_IR_FEEDS} registered feeds.`,
      });
    }
    urls.forEach((url, index) => {
      try {
        assertRegisteredFeedUrl(url);
        if (!isApprovedContentIrFeed(url))
          throw new Error('IR feed is not in the reviewed content-source registry.');
      } catch (error) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: error instanceof Error ? error.message : 'Invalid registered IR feed URL.',
        });
      }
    });
  })
  .transform((urls) => Object.freeze(urls));

const workerConfigSchema = z
  .object({
    nodeEnv: z.string().default('development'),
    databaseUrl: serviceUrl(['mysql:'], 'DATABASE_URL').optional(),
    redisUrl: serviceUrl(['redis:', 'rediss:'], 'REDIS_URL').optional(),
    redisPrefix: z.string().default('orsem:'),
    rawDocumentDir: z.string().min(1).default('/home/laeti/orsem-data/raw'),
    openDartApiKey: optionalTrimmed,
    openDartGlobalAlertTypes: z
      .string()
      .optional()
      .transform((value) => [
        ...new Set(
          (value ?? DEFAULT_GLOBAL_ALERT_TYPES.join(','))
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ])
      .pipe(z.array(z.enum(DisclosureDetailType)).max(5))
      .transform((values) => Object.freeze(values)),
    marketDataProvider: z.literal('toss').default('toss'),
    tossClientId: optionalTrimmed,
    tossClientSecret: optionalTrimmed,
    tossCredentialsFile: optionalTrimmed,
    tossMaxSubscriptions: z.coerce.number().int().min(1).max(100).default(100),
    goldApiKey: optionalTrimmed,
    eiaApiKey: optionalTrimmed,
    naverApiProvider: z.enum(['developers', 'ncloud']).default('developers'),
    naverClientId: optionalTrimmed,
    naverClientSecret: optionalTrimmed,
    secUserAgent,
    alpacaApiKey: optionalTrimmed,
    alpacaApiSecret: optionalTrimmed,
    alpacaTradingBaseUrl,
    gdeltEnabled: booleanFromEnv,
    gdeltApprovedDomains: z
      .string()
      .optional()
      .transform((value) => [
        ...new Set(
          (value ?? '')
            .split(',')
            .map((domain) => domain.trim().toLowerCase())
            .filter(Boolean),
        ),
      ])
      .refine(
        (domains) =>
          domains.every(
            (domain) =>
              APPROVED_GDELT_DOMAINS.includes(domain) &&
              APPROVED_GDELT_SOURCE_POLICIES[domain]?.metadataStorageAllowed === true &&
              APPROVED_GDELT_SOURCE_POLICIES[domain]?.displayAllowed === true,
          ),
        'GDELT domains require a reviewed source policy.',
      )
      .transform((domains) => Object.freeze(domains)),
    irFeedUrls: registeredIrFeedUrls,
    newsRssFeeds: z
      .string()
      .optional()
      .transform((value) => [
        ...new Set(
          (value ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ])
      .pipe(z.array(z.enum(NEWS_RSS_FEED_IDS)).max(NEWS_RSS_FEED_IDS.length))
      .transform((ids) => Object.freeze(ids)),
    aiBaseUrl: z.string().url().default('http://127.0.0.1:11434/v1'),
    aiApiKey: optionalTrimmed,
    aiModel: optionalTrimmed,
    aiEnabled: booleanFromEnv,
    aiTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
    newsTranslationEnabled: booleanFromEnv,
    ollamaUrl: z.string().url().default('http://127.0.0.1:11434'),
    newsTranslationModel: z.string().trim().min(1).max(200).default('qwen3.5:4b-q4_K_M'),
    newsTranslationBatchSize: z.coerce.number().int().min(1).max(10).default(3),
    newsTranslationTimeoutMs: z.coerce.number().int().min(1_000).max(180_000).default(120_000),
    pollOverlapDays: z.coerce.number().int().min(1).max(31).default(3),
    httpTimeoutMs: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  })
  .superRefine((config, context) => {
    if (config.nodeEnv !== 'production') return;
    if (!config.databaseUrl || config.databaseUrl === DEFAULT_DATABASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['databaseUrl'],
        message: 'DATABASE_URL must be explicitly configured in production.',
      });
    }
    if (!config.redisUrl) {
      context.addIssue({
        code: 'custom',
        path: ['redisUrl'],
        message: 'REDIS_URL must be explicitly configured in production.',
      });
    }
  })
  .transform((config) => ({
    ...config,
    databaseUrl: config.databaseUrl ?? DEFAULT_DATABASE_URL,
    redisUrl: config.redisUrl ?? DEFAULT_REDIS_URL,
  }));

export type WorkerConfig = z.infer<typeof workerConfigSchema> & { webPush: WebPushConfig };

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  let fileCredentials: { clientId?: string; clientSecret?: string } = {};
  if (env.TOSS_CREDENTIALS_FILE?.trim()) {
    try {
      const raw: unknown = JSON.parse(readFileSync(env.TOSS_CREDENTIALS_FILE.trim(), 'utf8'));
      fileCredentials = z
        .object({ clientId: z.string().optional(), clientSecret: z.string().optional() })
        .parse(raw);
    } catch {
      // 자격증명이 없거나 잘못되어도 토스만 비활성화하며 파일 내용은 기록하지 않습니다.
    }
  }
  const parsed = workerConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    redisPrefix: env.REDIS_PREFIX,
    rawDocumentDir: env.RAW_DOCUMENT_DIR,
    openDartApiKey: env.OPENDART_API_KEY,
    openDartGlobalAlertTypes: env.OPENDART_GLOBAL_ALERT_TYPES,
    marketDataProvider: env.MARKET_DATA_PROVIDER,
    tossClientId: env.TOSS_CLIENT_ID?.trim() || fileCredentials.clientId,
    tossClientSecret: env.TOSS_CLIENT_SECRET?.trim() || fileCredentials.clientSecret,
    tossCredentialsFile: env.TOSS_CREDENTIALS_FILE,
    tossMaxSubscriptions: env.TOSS_MAX_SUBSCRIPTIONS,
    goldApiKey: env.GOLD_API_KEY,
    eiaApiKey: env.EIA_API_KEY,
    naverApiProvider: env.NAVER_API_PROVIDER,
    naverClientId: env.NAVER_CLIENT_ID,
    naverClientSecret: env.NAVER_CLIENT_SECRET,
    secUserAgent: env.SEC_USER_AGENT,
    alpacaApiKey: env.ALPACA_API_KEY,
    alpacaApiSecret: env.ALPACA_API_SECRET,
    alpacaTradingBaseUrl: env.ALPACA_TRADING_BASE_URL,
    gdeltEnabled: env.GDELT_ENABLED,
    gdeltApprovedDomains: env.GDELT_NEWS_DOMAINS,
    irFeedUrls: env.IR_FEED_URLS,
    newsRssFeeds: env.NEWS_RSS_FEEDS,
    aiBaseUrl: env.AI_BASE_URL,
    aiApiKey: env.AI_API_KEY,
    aiModel: env.AI_MODEL,
    aiEnabled: env.AI_ENABLED,
    aiTimeoutMs: env.AI_TIMEOUT_MS,
    newsTranslationEnabled: env.NEWS_TRANSLATION_ENABLED,
    ollamaUrl: env.OLLAMA_URL,
    newsTranslationModel: env.NEWS_TRANSLATION_MODEL?.trim() || env.AI_MODEL?.trim() || undefined,
    newsTranslationBatchSize: env.NEWS_TRANSLATION_BATCH_SIZE,
    newsTranslationTimeoutMs: env.NEWS_TRANSLATION_TIMEOUT_MS,
    pollOverlapDays: env.OPENDART_POLL_OVERLAP_DAYS,
    httpTimeoutMs: env.HTTP_TIMEOUT_MS,
  });
  return { ...parsed, webPush: loadWebPushConfig(env) };
}
