import { randomUUID } from 'node:crypto';
import { readSecAccessCode, safeSecAccessCode, type SecAccessCode } from './sec-access-diagnostics';
import { SourceCheckpointEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import type { FetchImplementation } from '../opendart/opendart.client';

const KEY = { connector: 'SEC', stream: 'ACCESS_COOLDOWN' };
const MINIMUM_COOLDOWN_MS = 10 * 60_000;
const SEC_HOSTS = new Set(['sec.gov', 'www.sec.gov', 'data.sec.gov']);
const SEC_REQUEST_INTERVAL_MS = 250;
const states = new WeakMap<DataSource, { tail: Promise<void>; nextAt: number }>();
type Cooldown = {
  retryAt: Date;
  providerStatus: 403 | 429;
  providerCode: SecAccessCode | null;
};

export class SecAccessCooldownError extends Error {
  readonly connector = 'SEC';
  readonly operation = 'access-cooldown';
  readonly httpStatus: 403 | 429;
  readonly status: 403 | 429;
  constructor(
    readonly retryAt: Date,
    readonly providerStatus: 403 | 429,
    readonly requestAttempted = false,
    readonly providerCode: SecAccessCode | null = null,
  ) {
    super(
      `${providerStatus === 403 ? 'SEC 접근이 거부되었습니다(403)' : 'SEC 요청 빈도 제한입니다(429)'}. ${requestAttempted ? '응답을 확인했습니다.' : '대기 중이므로 요청을 보내지 않았습니다.'}`,
    );
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
    providerCode: safeSecAccessCode(metadata.providerCode),
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
  const state = states.get(dataSource) ?? { tail: Promise.resolve(), nextAt: 0 };
  states.set(dataSource, state);
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
    const previous = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let cooldown: Cooldown | null;
      try {
        const checkpoint = await dataSource.getRepository(SourceCheckpointEntity).findOneBy(KEY);
        cooldown = later(localCooldown, savedCooldown(checkpoint?.metadataJson));
      } catch {
        if (localCooldown && localCooldown.retryAt.getTime() > Date.now())
          throw new SecAccessCooldownError(
            localCooldown.retryAt,
            localCooldown.providerStatus,
            false,
            localCooldown.providerCode,
          );
        throw new SecAccessPolicyError();
      }
      if (cooldown && cooldown.retryAt.getTime() > Date.now())
        throw new SecAccessCooldownError(
          cooldown.retryAt,
          cooldown.providerStatus,
          false,
          cooldown.providerCode,
        );

      // Reserve a slot in the shared DB, so independent worker processes share the same budget.
      let reservedAt: number;
      try {
        reservedAt = await dataSource.transaction(async (manager) => {
          const repository = manager.getRepository(SourceCheckpointEntity);
          await repository
            .createQueryBuilder()
            .insert()
            .values({ id: randomUUID(), ...KEY })
            .orIgnore()
            .execute();
          const row = await repository.findOne({ where: KEY, lock: { mode: 'pessimistic_write' } });
          if (!row) throw new SecAccessPolicyError();
          const cooling = savedCooldown(row.metadataJson);
          if (cooling && cooling.retryAt.getTime() > Date.now())
            throw new SecAccessCooldownError(
              cooling.retryAt,
              cooling.providerStatus,
              false,
              cooling.providerCode,
            );
          const saved = Date.parse(String(row.metadataJson?.nextRequestAt ?? ''));
          const slot = Math.max(Date.now(), Number.isFinite(saved) ? saved : 0, state.nextAt);
          // Refuse an unexpectedly long queue instead of sleeping inside an HTTP timeout.
          if (slot - Date.now() > 5000) throw new SecAccessPolicyError();
          row.metadataJson = {
            ...row.metadataJson,
            nextRequestAt: new Date(slot + SEC_REQUEST_INTERVAL_MS).toISOString(),
          };
          await repository.save(row);
          return slot;
        });
      } catch (error) {
        if (error instanceof SecAccessCooldownError) throw error;
        throw new SecAccessPolicyError();
      }
      const waitMs = Math.max(0, reservedAt - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      signal?.throwIfAborted();
      // Another worker may have received a denial while this request waited for its slot.
      try {
        const row = await dataSource.getRepository(SourceCheckpointEntity).findOneBy(KEY);
        const cooling = savedCooldown(row?.metadataJson);
        if (cooling && cooling.retryAt.getTime() > Date.now())
          throw new SecAccessCooldownError(
            cooling.retryAt,
            cooling.providerStatus,
            false,
            cooling.providerCode,
          );
      } catch (error) {
        if (error instanceof SecAccessCooldownError) throw error;
        throw new SecAccessPolicyError();
      }
      state.nextAt = Date.now() + SEC_REQUEST_INTERVAL_MS;
      const response = await fetchImpl(input, init);
      if (response.status !== 403 && response.status !== 429) return response;
      const now = Date.now();
      const retryAfter = response.headers.get('retry-after');
      const observed: Cooldown = {
        retryAt: retryTime(retryAfter, now),
        providerStatus: response.status,
        providerCode: response.status === 429 ? 'SEC_RATE_LIMIT' : null,
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
            providerCode: next.providerCode,
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
        void response.body?.cancel().catch(() => undefined);
        throw new SecAccessPolicyError();
      }
      // Persist the denial before inspecting its body, so other workers stop immediately.
      const providerCode = await readSecAccessCode(response);
      if (providerCode && providerCode !== observed.providerCode) {
        observed.providerCode = providerCode;
        try {
          await dataSource.transaction(async (manager) => {
            const repository = manager.getRepository(SourceCheckpointEntity);
            const row = await repository.findOne({
              where: KEY,
              lock: { mode: 'pessimistic_write' },
            });
            if (
              row?.metadataJson?.observedAt !== new Date(now).toISOString() ||
              row.metadataJson.retryAt !== observed.retryAt.toISOString() ||
              row.metadataJson.providerStatus !== observed.providerStatus ||
              row.metadataJson.provenanceUrl !== `${url.origin}${url.pathname}`
            )
              return;
            row.metadataJson = { ...row.metadataJson, providerCode };
            await repository.save(row);
          });
        } catch {
          // The cooldown was already committed. Optional diagnostics cannot shorten it.
        }
      }
      throw new SecAccessCooldownError(
        cooldown!.retryAt,
        cooldown!.providerStatus,
        true,
        cooldown!.providerCode,
      );
    } finally {
      release();
    }
  };
}
