import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';

export const NAVER_ROLLING_INTERVAL_MS = 15 * 60_000;
export const NAVER_ROLLING_LIMIT = 10;
export const NAVER_FREE_VERIFICATION_MAX_MS = 30 * 24 * 60 * 60_000;
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60_000;
const BUDGET_STREAM = 'SEARCH_BUDGET';
type BudgetQuery = (sql: string, parameters: unknown[]) => Promise<unknown>;

export function naverUsagePeriod(now: Date) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return { day, month: day.slice(0, 7), firstDay: `${day.slice(0, 7)}-01` };
}

export interface NaverSearchStatus {
  configured: boolean;
  automaticAllowed: boolean;
  mode: 'ON_DEMAND';
  freeUntil: string | null;
  freeVerifiedAt: string | null;
  freePeriodStatus: 'UNVERIFIED' | 'VALID' | 'EXPIRING' | 'EXPIRED' | 'INVALID';
  warning: string | null;
  reasonCode: string | null;
  dailyLimit: number;
  monthlyLimit: number;
  remainingToday: number | null;
  remainingMonth: number | null;
  rollingLimit: number;
  remainingWindow: number | null;
  nextRequestAt: string | null;
  reason: string | null;
}

@Injectable()
export class NaverNewsBudgetService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
  ) {}

  private policy(now: Date): NaverSearchStatus {
    const configured = Boolean(this.config.naverClientId && this.config.naverClientSecret);
    const { month } = naverUsagePeriod(now);
    const until = Date.parse(this.config.naverNewsFreeUntil ?? '');
    const verifiedAt = Date.parse(this.config.naverNewsFreeVerifiedAt ?? '');
    const hasVerification = Boolean(this.config.naverNewsFreeVerifiedAt);
    // Explicit verification is bounded independently of calendar-month counter resets.
    // Old installations retain their existing, stricter same-month approval until upgraded.
    const invalid =
      hasVerification &&
      (!Number.isFinite(verifiedAt) ||
        !Number.isFinite(until) ||
        verifiedAt > now.getTime() ||
        until <= verifiedAt ||
        until - verifiedAt > NAVER_FREE_VERIFICATION_MAX_MS);
    const expired = Number.isFinite(until) && until <= now.getTime();
    const free =
      !invalid &&
      !expired &&
      Number.isFinite(until) &&
      (hasVerification || this.config.naverNewsFreeMonth === month) &&
      this.config.naverNewsFreeRequests > 0;
    const expiring = free && until - now.getTime() <= EXPIRY_WARNING_MS;
    const freePeriodStatus: NaverSearchStatus['freePeriodStatus'] = invalid
      ? 'INVALID'
      : expired
        ? 'EXPIRED'
        : free
          ? expiring
            ? 'EXPIRING'
            : 'VALID'
          : 'UNVERIFIED';
    return {
      configured,
      automaticAllowed: configured && free,
      mode: 'ON_DEMAND',
      freeUntil: this.config.naverNewsFreeUntil ?? null,
      freeVerifiedAt: this.config.naverNewsFreeVerifiedAt ?? null,
      freePeriodStatus,
      warning: expiring
        ? 'NAVER 뉴스 검색의 무료 이용 확인 기간이 7일 이내에 만료됩니다. 무료 이용 조건을 다시 확인해 주세요.'
        : null,
      reasonCode: !configured ? 'UNCONFIGURED' : free ? null : `FREE_${freePeriodStatus}`,
      dailyLimit: this.config.naverNewsDailyLimit,
      monthlyLimit: Math.min(this.config.naverNewsMonthlyLimit, this.config.naverNewsFreeRequests),
      remainingToday: null,
      remainingMonth: null,
      rollingLimit: NAVER_ROLLING_LIMIT,
      remainingWindow: null,
      nextRequestAt: null,
      reason: !configured
        ? 'NAVER 뉴스 검색 인증이 설정되지 않았습니다.'
        : invalid
          ? 'NAVER 무료 이용 확인 시각과 만료 시각을 확인해 주세요. 확인 기간은 최대 30일입니다.'
          : expired
            ? 'NAVER 뉴스 검색의 무료 이용 확인 기간이 만료되어 검색을 중단했습니다. 운영자가 무료 이용 조건과 호출 가능량을 다시 확인해야 합니다.'
            : !free
              ? '이번 달 무료 이용 조건과 호출 가능량 확인이 필요합니다.'
              : null,
    };
  }

  private connector() {
    // Key identity, never the credential itself, scopes the durable counters.
    return `NAVER_NEWS:${createHash('sha256')
      .update(`${this.config.naverApiProvider}:${this.config.naverClientId ?? ''}`)
      .digest('hex')
      .slice(0, 24)}`;
  }

  private async reservations(value: unknown, now: Date, query: BudgetQuery): Promise<number[]> {
    const metadata = typeof value === 'string' ? JSON.parse(value) : value;
    const cutoff = now.getTime() - NAVER_ROLLING_INTERVAL_MS;
    if (metadata == null) {
      // Older versions only retained the latest request time. Until that time expires,
      // reserve all slots conservatively instead of granting a fresh burst after rollout.
      const history = (await query(
        `SELECT DATE_FORMAT(MAX(last_request_at), '%Y-%m-%dT%H:%i:%s.%fZ') AS lastRequestAt
         FROM api_usage_counters WHERE connector=?`,
        [this.connector()],
      )) as Array<{ lastRequestAt: string | null }>;
      if (!history[0]?.lastRequestAt) return [];
      const last = Date.parse(history[0].lastRequestAt);
      if (!Number.isFinite(last)) throw new Error('Invalid reservation history');
      return last > cutoff ? Array<number>(NAVER_ROLLING_LIMIT).fill(last) : [];
    }
    if (
      typeof metadata !== 'object' ||
      !('version' in metadata) ||
      metadata.version !== 1 ||
      !('reservations' in metadata) ||
      !Array.isArray(metadata.reservations) ||
      metadata.reservations.length > NAVER_ROLLING_LIMIT ||
      !metadata.reservations.every(
        (time: unknown) => Number.isSafeInteger(time) && Number(time) >= 0,
      )
    )
      throw new Error('Invalid reservation window');
    // Future timestamps remain reserved if an instance's clock moves backwards.
    return (metadata.reservations as number[])
      .filter((time) => time > cutoff)
      .sort((a, b) => a - b);
  }

  async status(now = new Date()): Promise<NaverSearchStatus> {
    const result = this.policy(now);
    if (!result.automaticAllowed) return result;
    try {
      const { day, firstDay } = naverUsagePeriod(now);
      const source = this.database.requireDataSource();
      const rows: Array<{ daily: string; monthly: string }> = await source.query(
        `SELECT COALESCE(SUM(CASE WHEN usage_date = ? THEN request_count ELSE 0 END),0) AS daily,
          COALESCE(SUM(request_count),0) AS monthly FROM api_usage_counters
          WHERE connector = ? AND usage_date >= ? AND usage_date <= ?`,
        [day, this.connector(), firstDay, day],
      );
      const checkpoints: Array<{ metadataJson: unknown }> = await source.query(
        'SELECT metadata_json AS metadataJson FROM source_checkpoints WHERE connector=? AND stream=?',
        [this.connector(), BUDGET_STREAM],
      );
      const reservations = await this.reservations(checkpoints[0]?.metadataJson, now, (sql, args) =>
        source.query(sql, args),
      );
      const remainingToday = Math.max(0, result.dailyLimit - Number(rows[0]?.daily ?? 0));
      const remainingMonth = Math.max(0, result.monthlyLimit - Number(rows[0]?.monthly ?? 0));
      const remainingWindow = NAVER_ROLLING_LIMIT - reservations.length;
      return {
        ...result,
        remainingToday,
        remainingMonth,
        remainingWindow,
        nextRequestAt:
          remainingWindow === 0 && remainingToday > 0 && remainingMonth > 0
            ? new Date(reservations[0]! + NAVER_ROLLING_INTERVAL_MS).toISOString()
            : null,
        automaticAllowed: remainingToday > 0 && remainingMonth > 0 && remainingWindow > 0,
        reasonCode:
          remainingToday === 0 || remainingMonth === 0
            ? 'BUDGET_EXHAUSTED'
            : remainingWindow === 0
              ? 'RATE_LIMITED'
              : null,
        reason:
          remainingToday === 0 || remainingMonth === 0
            ? 'NAVER 뉴스 검색의 무료 호출 한도에 도달했습니다.'
            : remainingWindow === 0
              ? 'NAVER 뉴스 검색은 전체 15분당 최대 10회까지 가능합니다.'
              : null,
      };
    } catch {
      return {
        ...result,
        automaticAllowed: false,
        reasonCode: 'USAGE_UNAVAILABLE',
        reason: '뉴스 검색 사용량을 확인하지 못했습니다.',
      };
    }
  }

  async reserve(now?: Date): Promise<void> {
    const initialPolicy = this.policy(now ?? new Date());
    if (!initialPolicy.automaticAllowed)
      throw new ServiceUnavailableException({
        code: initialPolicy.reasonCode,
        message: initialPolicy.reason!,
      });
    const connector = this.connector();
    try {
      await this.database.requireDataSource().transaction(async (manager) => {
        // One stable row serializes scheduled/on-demand requests across instances and months.
        await manager.query(
          `INSERT INTO source_checkpoints
          (id,connector,stream,created_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))
          ON DUPLICATE KEY UPDATE id=id`,
          [randomUUID(), connector, BUDGET_STREAM],
        );
        const checkpoints: Array<{ metadataJson: unknown }> = await manager.query(
          'SELECT metadata_json AS metadataJson FROM source_checkpoints WHERE connector=? AND stream=? FOR UPDATE',
          [connector, BUDGET_STREAM],
        );
        if (!checkpoints.length) throw new Error('Reservation lock missing');
        const reservedAt = now ?? new Date();
        const policy = this.policy(reservedAt);
        if (!policy.automaticAllowed)
          throw new ServiceUnavailableException({
            code: policy.reasonCode,
            message: policy.reason!,
          });
        const { day, firstDay } = naverUsagePeriod(reservedAt);
        const reservations = await this.reservations(
          checkpoints[0]?.metadataJson,
          reservedAt,
          (sql, args) => manager.query(sql, args),
        );
        if (reservations.length >= NAVER_ROLLING_LIMIT)
          throw new HttpException(
            {
              message: 'NAVER 뉴스 검색은 전체 15분당 최대 10회까지 가능합니다.',
              nextRequestAt: new Date(reservations[0]! + NAVER_ROLLING_INTERVAL_MS).toISOString(),
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        const rows: Array<{ daily: string; monthly: string }> = await manager.query(
          `SELECT COALESCE(SUM(CASE WHEN usage_date=? THEN request_count ELSE 0 END),0) AS daily,
            COALESCE(SUM(request_count),0) AS monthly FROM api_usage_counters
            WHERE connector=? AND usage_date >= ? AND usage_date <= ?`,
          [day, connector, firstDay, day],
        );
        if (
          Number(rows[0]?.daily ?? 0) >= policy.dailyLimit ||
          Number(rows[0]?.monthly ?? 0) >= policy.monthlyLimit
        ) {
          throw new HttpException(
            'NAVER 뉴스 검색의 무료 호출 한도에 도달했습니다.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        await manager.query(
          `INSERT INTO api_usage_counters
          (id,connector,usage_date,request_count,item_count,last_request_at,created_at,updated_at)
          VALUES (?,?,?,1,0,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))
          ON DUPLICATE KEY UPDATE request_count=request_count+1,last_request_at=VALUES(last_request_at),updated_at=UTC_TIMESTAMP(6)`,
          [randomUUID(), connector, day, reservedAt],
        );
        await manager.query(
          `UPDATE source_checkpoints SET metadata_json=?,updated_at=UTC_TIMESTAMP(6)
           WHERE connector=? AND stream=?`,
          [
            JSON.stringify({ version: 1, reservations: [...reservations, reservedAt.getTime()] }),
            connector,
            BUDGET_STREAM,
          ],
        );
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        code: 'USAGE_UNAVAILABLE',
        message: '뉴스 검색 사용량을 확인하지 못해 요청을 중단했습니다.',
      });
    }
    // Failed or lost requests remain counted. No search terms or provider results are stored.
  }
}
