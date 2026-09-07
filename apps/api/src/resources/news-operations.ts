import { createHash } from 'node:crypto';
import {
  NEWS_EXTERNAL_API_POLICIES,
  NEWS_IR_SOURCE_PROFILES,
  NEWS_RSS_FEEDS,
  type NewsSourcePolicy,
} from '@orsem/contracts';
import {
  ApiUsageCounterEntity,
  ConnectorHealthEntity,
  SourceCheckpointEntity,
  dateToIso,
} from '@orsem/database';
import { In, type DataSource } from 'typeorm';

const count = (value: unknown): number | null => {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const instant = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

/** Administrator-only projection. Never returns raw metadata, messages, URLs or opaque tokens. */
export async function adminNewsSourceViews(
  database?: DataSource,
): Promise<Array<Record<string, unknown>>> {
  const [health, checkpoints, usage] = database
    ? await Promise.all([
        database.getRepository(ConnectorHealthEntity).find({
          where: { connector: In(['marketaux', 'alphavantage', 'finnhub', 'ir', 'news_rss']) },
        }),
        database.getRepository(SourceCheckpointEntity).find({
          where: { connector: In(['MARKETAUX', 'ALPHAVANTAGE', 'FINNHUB', 'IR', 'NEWS_RSS']) },
        }),
        database
          .getRepository(ApiUsageCounterEntity)
          .findBy({ usageDate: new Date().toISOString().slice(0, 10) }),
      ])
    : [[], [], []];
  const apis = Object.entries(NEWS_EXTERNAL_API_POLICIES).map(([id, policy]) => ({
    id,
    name: id,
    connector: id,
    policy,
    feedUrl: null as string | null,
  }));
  const feeds = [...Object.entries(NEWS_IR_SOURCE_PROFILES), ...Object.entries(NEWS_RSS_FEEDS)]
    .filter(([, profile]) => (profile.policy as NewsSourcePolicy).policyVersion === 2)
    .map(([id, profile]) => ({
      id,
      name: profile.publisher,
      connector: id in NEWS_IR_SOURCE_PROFILES ? 'IR' : 'NEWS_RSS',
      policy: profile.policy as NewsSourcePolicy,
      feedUrl: profile.url,
    }));
  return [...apis, ...feeds].map((definition) => {
    const row = health.find(
      (item) => item.connector.toLowerCase() === definition.connector.toLowerCase(),
    );
    const stream = definition.feedUrl
      ? `RSS_HTTP:${createHash('sha256').update(definition.feedUrl).digest('hex')}`
      : null;
    const checkpoint = checkpoints.find(
      (item) =>
        item.connector === definition.connector &&
        (stream ? item.stream === stream : item.stream.includes('BUDGET')),
    );
    const recovery = checkpoints.find(
      (item) => item.connector === definition.connector && item.cursor,
    );
    const metadata = { ...row?.metadataJson, ...checkpoint?.metadataJson };
    const code = count(metadata.httpStatus ?? metadata.providerStatus);
    const errorLabels: Record<string, string> = {
      AUTHENTICATION: '인증 오류',
      ENTITLEMENT: '이용 권한 오류',
      DAILY_LIMIT: '일일 호출 한도 대기',
      RATE_LIMIT: '호출 한도 대기',
      PROVIDER_FAILURE: '공급자 장애',
      TIMEOUT: '응답 시간 초과',
      MALFORMED_OR_TRANSPORT: '응답 형식 또는 통신 오류',
    };
    const errorCategory = typeof metadata.lastError === 'string' ? metadata.lastError : '';
    const now = Date.now();
    const rollingRequestCount = Array.isArray(metadata.reservations)
      ? metadata.reservations.filter(
          (at) =>
            typeof at === 'number' && Number.isFinite(at) && at > now - 86400_000 && at <= now,
        ).length
      : count(metadata.rollingRequestCount);
    const nextRuns = [metadata.nextRunAt, metadata.nextRequestAt, metadata.retryAt].flatMap(
      (value) => {
        const parsed = instant(value);
        return parsed ? [Date.parse(parsed)] : [];
      },
    );
    const lastSuccessAt = dateToIso(
      definition.feedUrl ? (checkpoint?.lastSuccessAt ?? null) : (row?.lastSuccessAt ?? null),
    );
    const status =
      definition.policy.rightsStatus === 'UNKNOWN' ? 'UNCONFIGURED' : (row?.status ?? 'DISABLED');
    const cursor = recovery?.cursor;
    return {
      id: definition.id.toLowerCase(),
      name: definition.name,
      category: definition.connector === 'IR' ? 'OFFICIAL' : 'NEWS',
      status,
      rightsMode: definition.policy.rightsMode,
      enabled: metadata.enabled === true && status !== 'UNCONFIGURED',
      lastSuccessAt,
      lastErrorAt: dateToIso(row?.lastFailureAt ?? null),
      lastError:
        errorLabels[errorCategory] ??
        (code === 401
          ? '인증 오류'
          : code === 402
            ? '일일 호출 한도 대기'
            : code === 403
              ? '이용 권한 오류'
              : code === 429
                ? '호출 한도 대기'
                : code && code >= 500
                  ? '공급자 장애'
                  : row?.lastFailureAt
                    ? '최근 수집 실패'
                    : null),
      nextRunAt: nextRuns.length ? new Date(Math.max(...nextRuns)).toISOString() : null,
      dailyRequestCount:
        count(metadata.dailyRequestCount) ??
        Number(usage.find((item) => item.connector === definition.connector)?.requestCount ?? 0),
      dailyRequestBudget: count(metadata.dailyRequestBudget),
      rollingRequestCount,
      rollingRequestBudget: count(metadata.rollingRequestBudget),
      lastCursor: cursor
        ? (instant(cursor) ??
          `sha256:${createHash('sha256').update(cursor).digest('hex').slice(0, 16)}`)
        : null,
      rightsStatus: definition.policy.rightsStatus ?? 'UNKNOWN',
      entitlementStatus: ['CONFIRMED', 'UNKNOWN', 'DENIED', 'EXPIRED'].includes(
        String(metadata.entitlementStatus),
      )
        ? metadata.entitlementStatus
        : 'UNKNOWN',
      lagSeconds: lastSuccessAt
        ? Math.max(0, Math.floor((Date.now() - Date.parse(lastSuccessAt)) / 1000))
        : null,
      message:
        status === 'UNCONFIGURED'
          ? '권리·무료 이용·실제 응답 확인 전 비활성 상태입니다.'
          : '관리자 개인 뉴스 수집 상태입니다.',
    };
  });
}
