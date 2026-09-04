import { z } from 'zod';
import { isAbsolute, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadWebPushConfig, type WebPushConfig } from '@orsem/database';

const DEVELOPMENT_DATABASE_URL = 'mysql://orsem:change-me@127.0.0.1:3306/orsem';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}, z.boolean());

const optionalString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().optional());

const optionalSecUserAgent = optionalString.refine(
  (value) =>
    !value ||
    (value.length <= 255 && /^[A-Za-z0-9][^\r\n]{0,127}\s+[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)),
  {
    message: 'SEC_USER_AGENT must contain an application identity followed by a contact email',
  },
);

const webOriginSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !parsed.username &&
        !parsed.password
      );
    },
    { message: 'WEB_ORIGIN must be a credential-free HTTP(S) origin' },
  )
  .transform((value) => new URL(value).origin);

function optionalServiceUrl(protocols: readonly string[], label: string) {
  return optionalString.refine(
    (value) => {
      if (!value) return true;
      try {
        const parsed = new URL(value);
        return protocols.includes(parsed.protocol) && Boolean(parsed.hostname);
      } catch {
        return false;
      }
    },
    { message: `${label} must use ${protocols.join(' or ')}` },
  );
}

function isCanonical32ByteBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

const schema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    port: z.coerce.number().int().min(1).max(65535).default(3210),
    webOrigin: webOriginSchema.default('http://localhost:5173'),
    fixtureMode: booleanFromEnv.default(false),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'log', 'debug', 'verbose']).default('log'),
    databaseUrl: optionalServiceUrl(['mysql:'], 'DATABASE_URL'),
    redisUrl: optionalServiceUrl(['redis:', 'rediss:'], 'REDIS_URL'),
    redisPrefix: z.string().default('orsem:'),
    sessionSecret: optionalString,
    totpEncryptionKey: optionalString,
    rawDocumentDir: z.string().default('/tmp/orsem/raw'),
    opendartApiKey: optionalString,
    marketDataProvider: z.literal('toss').default('toss'),
    tossClientId: optionalString,
    tossClientSecret: optionalString,
    goldApiKey: optionalString,
    eiaApiKey: optionalString,
    webPush: z.custom<WebPushConfig>(),
    kakaoClientId: optionalString,
    kakaoClientSecret: optionalString,
    kakaoRedirectUri: optionalString,
    naverApiProvider: z.enum(['developers', 'ncloud']).default('developers'),
    naverClientId: optionalString,
    naverClientSecret: optionalString,
    secUserAgent: optionalSecUserAgent,
    alpacaApiKey: optionalString,
    alpacaApiSecret: optionalString,
    // 자격증명 없이 검색하는 worker의 기본값과 맞춥니다.
    // GDELT를 사용하지 않는 배포 환경은 GDELT_ENABLED=false를 명시해야 합니다.
    gdeltEnabled: booleanFromEnv.default(true),
    irFeedUrls: optionalString,
    newsRssFeeds: z.preprocess(
      (value) =>
        typeof value === 'string'
          ? [
              ...new Set(
                value
                  .split(',')
                  .map((id) => id.trim())
                  .filter(Boolean),
              ),
            ]
          : (value ?? []),
      z.array(z.literal('etoday-market')),
    ),
    aiEnabled: booleanFromEnv.default(false),
    aiBaseUrl: optionalString,
    aiApiKey: optionalString,
    aiModel: optionalString,
    discordServiceToken: optionalString,
    messengerPairingTtlSeconds: z.coerce.number().int().min(60).max(3600).default(600),
    fixtureAdminEmail: z.string().email().default('admin@orsem.local'),
    fixtureAdminPassword: z.string().min(10).default('orsem-fixture-admin'),
  })
  .superRefine((value, context) => {
    if (value.discordServiceToken && value.discordServiceToken.length < 32) {
      context.addIssue({
        code: 'custom',
        path: ['discordServiceToken'],
        message: 'DISCORD_SERVICE_TOKEN must contain at least 32 characters',
      });
    }
    if (value.nodeEnv !== 'production') return;
    if (value.fixtureMode) {
      context.addIssue({
        code: 'custom',
        path: ['fixtureMode'],
        message: 'FIXTURE_MODE cannot be enabled in production',
      });
    }
    if (!value.databaseUrl) {
      context.addIssue({
        code: 'custom',
        path: ['databaseUrl'],
        message: 'DATABASE_URL is required in production',
      });
    } else if (value.databaseUrl === DEVELOPMENT_DATABASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['databaseUrl'],
        message: 'DATABASE_URL cannot use the development placeholder in production',
      });
    }
    if (!value.redisUrl) {
      context.addIssue({
        code: 'custom',
        path: ['redisUrl'],
        message: 'REDIS_URL is required in production',
      });
    }
    if (!value.sessionSecret || value.sessionSecret.length < 32) {
      context.addIssue({
        code: 'custom',
        path: ['sessionSecret'],
        message: 'SESSION_SECRET must contain at least 32 characters',
      });
    }
    if (!value.totpEncryptionKey) {
      context.addIssue({
        code: 'custom',
        path: ['totpEncryptionKey'],
        message: 'TOTP_ENCRYPTION_KEY is required',
      });
    } else if (!isCanonical32ByteBase64(value.totpEncryptionKey)) {
      context.addIssue({
        code: 'custom',
        path: ['totpEncryptionKey'],
        message: 'TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes',
      });
    }
    if (new URL(value.webOrigin).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['webOrigin'],
        message: 'WEB_ORIGIN must use HTTPS in production',
      });
    }
    const fromTemporaryDirectory = (() => {
      const pathFromTmp = relative('/tmp', value.rawDocumentDir);
      return pathFromTmp === '' || (!pathFromTmp.startsWith('..') && !isAbsolute(pathFromTmp));
    })();
    if (!isAbsolute(value.rawDocumentDir) || fromTemporaryDirectory) {
      context.addIssue({
        code: 'custom',
        path: ['rawDocumentDir'],
        message: 'RAW_DOCUMENT_DIR must be an absolute persistent path outside /tmp in production',
      });
    }
  });

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const tossCredentials = readTossCredentials(environment);
  const kakaoCredentials = readKakaoCredentials(environment);
  return schema.parse({
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    webOrigin: environment.WEB_ORIGIN,
    fixtureMode: environment.FIXTURE_MODE,
    logLevel: environment.LOG_LEVEL,
    databaseUrl: environment.DATABASE_URL,
    redisUrl: environment.REDIS_URL,
    redisPrefix: environment.REDIS_PREFIX,
    sessionSecret: environment.SESSION_SECRET,
    totpEncryptionKey: environment.TOTP_ENCRYPTION_KEY,
    rawDocumentDir: environment.RAW_DOCUMENT_DIR,
    opendartApiKey: environment.OPENDART_API_KEY,
    marketDataProvider: environment.MARKET_DATA_PROVIDER,
    tossClientId: tossCredentials.clientId,
    tossClientSecret: tossCredentials.clientSecret,
    goldApiKey: environment.GOLD_API_KEY,
    eiaApiKey: environment.EIA_API_KEY,
    webPush: loadWebPushConfig(environment),
    kakaoClientId: kakaoCredentials.clientId,
    kakaoClientSecret: kakaoCredentials.clientSecret,
    kakaoRedirectUri: kakaoCredentials.redirectUri,
    naverApiProvider: environment.NAVER_API_PROVIDER,
    naverClientId: environment.NAVER_CLIENT_ID,
    naverClientSecret: environment.NAVER_CLIENT_SECRET,
    secUserAgent: environment.SEC_USER_AGENT,
    alpacaApiKey: environment.ALPACA_API_KEY,
    alpacaApiSecret: environment.ALPACA_API_SECRET,
    gdeltEnabled: environment.GDELT_ENABLED,
    irFeedUrls: environment.IR_FEED_URLS,
    newsRssFeeds: environment.NEWS_RSS_FEEDS,
    aiEnabled: environment.AI_ENABLED,
    aiBaseUrl: environment.AI_BASE_URL,
    aiApiKey: environment.AI_API_KEY,
    aiModel: environment.AI_MODEL,
    discordServiceToken: environment.DISCORD_SERVICE_TOKEN,
    messengerPairingTtlSeconds: environment.MESSENGERBOT_PAIRING_TTL_SECONDS,
    fixtureAdminEmail: environment.FIXTURE_ADMIN_EMAIL,
    fixtureAdminPassword: environment.FIXTURE_ADMIN_PASSWORD,
  });
}

function readTossCredentials(environment: NodeJS.ProcessEnv): {
  clientId?: string;
  clientSecret?: string;
} {
  let file: { clientId?: string; clientSecret?: string } = {};
  if (environment.TOSS_CREDENTIALS_FILE?.trim()) {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(environment.TOSS_CREDENTIALS_FILE.trim(), 'utf8'),
      );
      const result = z
        .object({ clientId: optionalString, clientSecret: optionalString })
        .safeParse(parsed);
      if (result.success) file = result.data;
    } catch {
      // 외부 자격증명이 없거나 잘못되어도 이 커넥터만 비활성화합니다.
      // 비밀 값이 포함될 수 있는 파일 내용이나 파싱 오류는 기록하지 않습니다.
    }
  }
  return {
    clientId: environment.TOSS_CLIENT_ID?.trim() || file.clientId,
    clientSecret: environment.TOSS_CLIENT_SECRET?.trim() || file.clientSecret,
  };
}

function readKakaoCredentials(environment: NodeJS.ProcessEnv): {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
} {
  let file: { clientId?: string; clientSecret?: string; redirectUri?: string } = {};
  if (environment.KAKAO_CREDENTIALS_FILE?.trim()) {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(environment.KAKAO_CREDENTIALS_FILE.trim(), 'utf8'),
      );
      const result = z
        .object({
          clientId: optionalString,
          clientSecret: optionalString,
          redirectUri: optionalString,
        })
        .safeParse(parsed);
      if (result.success) file = result.data;
    } catch {
      // 외부 자격증명 파일을 사용할 수 없으면 카카오 로그인만 비활성화합니다.
      // 파싱 오류와 파일 내용에는 비밀 값이 있을 수 있으므로 기록하지 않습니다.
    }
  }
  return {
    clientId: environment.KAKAO_CLIENT_ID?.trim() || file.clientId,
    clientSecret: environment.KAKAO_CLIENT_SECRET?.trim() || file.clientSecret,
    redirectUri: environment.KAKAO_REDIRECT_URI?.trim() || file.redirectUri,
  };
}
