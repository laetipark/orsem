import { createHash } from 'node:crypto';
import type { DiscoveryCandidate } from './connector-adapters';
import type { DiscoveryBatch, RecoveryStore } from './discovery-recovery';

export interface GdeltWindow {
  start: string;
  end: string;
  depth: number;
}
export interface GdeltRecoveryOptions {
  overlapMinutes: number;
  maxDepth: number;
  maxRequests: number;
}
export const DEFAULT_GDELT_RECOVERY: GdeltRecoveryOptions = {
  overlapMinutes: 10,
  maxDepth: 4,
  maxRequests: 12,
};
export const gdeltTimestamp = (value: string): string =>
  new Date(value).toISOString().replace(/[-:T]/g, '').slice(0, 14);
function validWindow(value: unknown): value is GdeltWindow {
  if (!value || typeof value !== 'object') return false;
  const v = value as GdeltWindow;
  return (
    Number.isFinite(Date.parse(v.start)) &&
    Number.isFinite(Date.parse(v.end)) &&
    Date.parse(v.end) > Date.parse(v.start) &&
    Number.isInteger(v.depth) &&
    v.depth >= 0
  );
}

/** Left-to-right leaves are durable. Saturated leaves never advance the coverage watermark. */
export async function* recoverGdeltWindows(
  queries: readonly string[],
  store: RecoveryStore,
  search: (query: string, window: GdeltWindow) => Promise<readonly DiscoveryCandidate[]>,
  options: GdeltRecoveryOptions = DEFAULT_GDELT_RECOVERY,
  now = new Date(),
): AsyncGenerator<DiscoveryBatch> {
  let requests = 0;
  for (const query of queries) {
    const stream = `DOC_WINDOW:${createHash('sha256').update(query).digest('hex')}`;
    const checkpoint = await store.load('GDELT', stream);
    let revision = checkpoint.revision;
    const previous = checkpoint.metadata;
    const cursor =
      typeof previous.cursor === 'string' && Number.isFinite(Date.parse(previous.cursor))
        ? previous.cursor
        : null;
    const start = cursor
      ? Date.parse(cursor) - options.overlapMinutes * 60_000
      : now.getTime() - 86400_000;
    if (
      Array.isArray(previous.pendingWindows) &&
      previous.pendingWindows.some((window) => !validWindow(window))
    )
      throw new Error('Invalid stored GDELT recovery window');
    let pending = Array.isArray(previous.pendingWindows)
      ? previous.pendingWindows.filter(validWindow)
      : [];
    const newPlan = pending.length === 0;
    if (newPlan)
      pending = [
        {
          start: new Date(start).toISOString(),
          end: new Date(Math.min(now.getTime(), start + 86400_000)).toISOString(),
          depth: 0,
        },
      ];
    let metadata: Record<string, unknown> = {
      ...previous,
      provider: 'GDELT',
      capability: 'DOC_WINDOW_RECOVERY',
      checkpoint: stream,
      queryHash: stream.slice(11),
      incomplete: true,
      truncated: false,
    };
    if (newPlan) {
      const initial = pending[0]!;
      if (!validWindow(initial)) throw new Error('GDELT clock/window boundary invalid');
      // Persist the plan, not coverage: an initial HTTP failure must not move the lookback window.
      metadata = {
        ...metadata,
        pendingWindows: [...pending],
        lastWindowStart: initial.start,
        lastWindowEnd: initial.end,
      };
      yield {
        candidates: [],
        suppressAlerts: true,
        checkpoint: { stream, expected: revision++, metadata },
      };
    }
    while (pending.length) {
      const window = pending[0]!;
      metadata = {
        ...metadata,
        lastWindowStart: window.start,
        lastWindowEnd: window.end,
        pendingWindows: [...pending],
        requestsInRun: requests,
      };
      if (Date.parse(window.start) < now.getTime() - 89 * 86400_000) {
        yield {
          candidates: [],
          checkpoint: {
            stream,
            expected: revision++,
            metadata: {
              ...metadata,
              incomplete: true,
              coverageError: 'OUTSIDE_DOC_HISTORY_REQUIRES_RECONCILIATION',
            },
          },
        };
        break;
      }
      if (requests >= options.maxRequests) {
        yield {
          candidates: [],
          checkpoint: {
            stream,
            expected: revision++,
            metadata: { ...metadata, incomplete: true, coverageError: 'REQUEST_BUDGET' },
          },
        };
        return;
      }
      const candidates = await search(query, window);
      requests++;
      const saturated = candidates.length >= 250;
      if (
        saturated &&
        window.depth < options.maxDepth &&
        Date.parse(window.end) - Date.parse(window.start) >= 30 * 60_000
      ) {
        const midpoint = new Date(
          Math.floor((Date.parse(window.start) + Date.parse(window.end)) / 2000) * 1000,
        ).toISOString();
        pending = [
          { start: window.start, end: midpoint, depth: window.depth + 1 },
          { start: midpoint, end: window.end, depth: window.depth + 1 },
          ...pending.slice(1),
        ];
        continue;
      }
      if (!saturated) pending = pending.slice(1);
      const nextCursor = saturated
        ? (metadata.cursor ?? null)
        : new Date(Math.max(Date.parse(window.end), cursor ? Date.parse(cursor) : 0)).toISOString();
      metadata = {
        ...metadata,
        cursor: nextCursor,
        lastFetchedAt: new Date().toISOString(),
        pendingWindows: [...pending],
        incomplete: saturated || pending.length > 0,
        truncated: saturated,
        coverageError: saturated ? 'SATURATED_MINIMUM_WINDOW_OR_DEPTH' : null,
        lastItemCount: candidates.length,
        requestsInRun: requests,
        latestObservedAt:
          candidates
            .map((c) => c.metadata.observedBySourceAt)
            .filter((v): v is string => typeof v === 'string')
            .sort()
            .at(-1) ?? null,
      };
      yield {
        candidates,
        suppressAlerts: true,
        checkpoint: { stream, expected: revision++, metadata },
      };
      if (saturated) break;
    }
  }
}
