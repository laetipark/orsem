import { randomUUID } from 'node:crypto';
import { SourceCheckpointEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import type { FetchImplementation } from '../opendart/opendart.client';

const KEY = { connector: 'SEC', stream: 'ACCESS_COOLDOWN' };
const MINIMUM_COOLDOWN_MS = 10 * 60_000;
const SEC_HOSTS = new Set(['sec.gov', 'www.sec.gov', 'data.sec.gov']);
type Cooldown = { retryAt: Date; providerStatus: 403 | 429 };

export class SecAccessCooldownError extends Error {
  readonly connector = 'SEC';
  readonly operation = 'access-cooldown';
  readonly httpStatus: 403 | 429;
  readonly status: 403 | 429;
  constructor(
    readonly retryAt: Date,
    readonly providerStatus: 403 | 429,
  ) {
    super('SEC 요청 제한으로 재시도 가능 시각까지 수집을 대기합니다.');
    this.name = 'SecAccessCooldownError';
    this.httpStatus = providerStatus;
    this.status = providerStatus;
  }
}

export class SecAccessPolicyError extends Error {
  readonly connector = 'SEC';
  readonly httpStatus = 0;
  constructor() {
    super('SEC 접근 대기 상태를 확인하거나 저장하지 못했습니다.');
    this.name = 'SecAccessPolicyError';
  }
}

function savedCooldown(metadata: Record<string, unknown> | null | undefined): Cooldown | null {
  if (typeof metadata?.retryAt !== 'string') return null;
  const timestamp = Date.parse(metadata.retryAt);
  if (!Number.isFinite(timestamp)) return null;
  return {
    retryAt: new Date(timestamp),
    providerStatus: metadata.providerStatus === 429 ? 429 : 403,
  };
}

function later(left: Cooldown | null, right: Cooldown | null): Cooldown | null {
  if (!left) return right;
  if (!right) return left;
  return left.retryAt >= right.retryAt ? left : right;
}

function retryTime(header: string | null, now: number): Date {
  const value = header?.trim() ?? '';
  const explicit = /^\d+$/.test(value)
    ? now + Number(value) * 1000
    : /^[A-Za-z]{3},/.test(value)
      ? Date.parse(value)
      : NaN;
  const valid = Number.isFinite(explicit) && explicit <= 8.64e15 ? explicit : 0;
  return new Date(Math.max(now + MINIMUM_COOLDOWN_MS, valid));
}

/** Leaves request headers, transport failures and every non-SEC request unchanged. */
export function createSecFetch(
  dataSource: DataSource,
  fetchImpl: FetchImplementation,
): FetchImplementation {
  let localCooldown: Cooldown | null = null;
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return fetchImpl(input, init);
    }
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (!SEC_HOSTS.has(url.hostname) || method !== 'GET') return fetchImpl(input, init);
    let cooldown: Cooldown | null;
    try {
      const checkpoint = await dataSource.getRepository(SourceCheckpointEntity).findOneBy(KEY);
      cooldown = later(localCooldown, savedCooldown(checkpoint?.metadataJson));
    } catch {
      if (localCooldown && localCooldown.retryAt.getTime() > Date.now())
        throw new SecAccessCooldownError(localCooldown.retryAt, localCooldown.providerStatus);
      throw new SecAccessPolicyError();
    }
    if (cooldown && cooldown.retryAt.getTime() > Date.now())
      throw new SecAccessCooldownError(cooldown.retryAt, cooldown.providerStatus);

    const response = await fetchImpl(input, init);
    if (response.status !== 403 && response.status !== 429) return response;
    const now = Date.now();
    const retryAfter = response.headers.get('retry-after');
    const observed: Cooldown = {
      retryAt: retryTime(retryAfter, now),
      providerStatus: response.status,
    };
    localCooldown = later(localCooldown, observed);
    try {
      cooldown = await dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(SourceCheckpointEntity);
        await repository
          .createQueryBuilder()
          .insert()
          .values({ id: randomUUID(), ...KEY })
          .orIgnore()
          .execute();
        const row = await repository.findOne({ where: KEY, lock: { mode: 'pessimistic_write' } });
        if (!row) throw new Error('SEC access checkpoint unavailable.');
        const next = later(savedCooldown(row.metadataJson), observed)!;
        row.metadataJson = {
          ...row.metadataJson,
          retryAt: next.retryAt.toISOString(),
          providerStatus: next.providerStatus,
          source: 'SEC',
          provenanceUrl:
            next === observed
              ? `${url.origin}${url.pathname}`
              : (row.metadataJson?.provenanceUrl ?? `${url.origin}${url.pathname}`),
          observedAt:
            next === observed
              ? new Date(now).toISOString()
              : (row.metadataJson?.observedAt ?? new Date(now).toISOString()),
          retryAfter:
            next === observed
              ? (retryAfter?.slice(0, 128) ?? null)
              : (row.metadataJson?.retryAfter ?? null),
        };
        await repository.save(row);
        return next;
      });
      localCooldown = later(localCooldown, cooldown);
    } catch {
      throw new SecAccessPolicyError();
    } finally {
      // Discard the response stream without retaining or parsing a provider error body.
      await response.body?.cancel().catch(() => undefined);
    }
    throw new SecAccessCooldownError(cooldown!.retryAt, cooldown!.providerStatus);
  };
}
