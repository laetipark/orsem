import type { TossCandlesJob } from '../queues/job-data';

interface ViewFetchScope {
  readonly region: 'kr' | 'us';
  readonly symbol: string;
}

export interface TossViewFetchPlan {
  readonly input: TossCandlesJob;
  readonly historyPolicy: Record<string, unknown> | null;
  readonly hydratedAt: string | null;
}

/** Decide coverage before fetching; only a successfully persisted fetch may advance its dates. */
export function planTossViewFetch(
  scope: ViewFetchScope,
  input: TossCandlesJob,
  metadata: Record<string, unknown> | null | undefined,
  now: number,
): TossViewFetchPlan {
  const fullPages = input.interval === '1d' ? 3 : 6;
  // 정기·제한·과거 수집 요청만으로는 VIEW 이력이 완전히 수집되었다고 판단하지 않습니다.
  if (input.reason !== 'VIEW' || input.before || (input.maxPages ?? fullPages) < fullPages)
    return { input, historyPolicy: null, hydratedAt: null };
  const historyPolicy = {
    version: 1,
    source: scope.region === 'kr' ? 'TOSS_KR' : 'TOSS_US',
    symbol: scope.symbol,
    interval: input.interval,
    adjusted: false,
    lookbackDays: input.lookbackDays ?? (input.interval === '1d' ? 366 : 7),
    maximumBars: input.interval === '1d' ? 400 : 1000,
  };
  const previous = metadata?.viewHistory;
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    const history = previous as Record<string, unknown>;
    const hydrated = typeof history.hydratedAt === 'string' ? Date.parse(history.hydratedAt) : NaN;
    const refreshed =
      typeof history.refreshedAt === 'string' ? Date.parse(history.refreshedAt) : NaN;
    const elapsed = now - refreshed;
    // 한 페이지는 200개 봉을 담습니다. 오랜 공백 뒤에는 저장 이력과 최신 페이지 사이가
    // 누락되지 않도록 전체 범위를 다시 수집하며, 정기 갱신으로 이 유효 기간을 늘리지 않습니다.
    const maximumGap = 180 * (input.interval === '1d' ? 86_400_000 : 60_000);
    if (
      Object.entries(historyPolicy).every(([key, value]) => history[key] === value) &&
      Number.isFinite(hydrated) &&
      hydrated <= refreshed &&
      elapsed >= 0 &&
      elapsed < maximumGap
    ) {
      return {
        input: { ...input, maxPages: 1 },
        historyPolicy,
        hydratedAt: history.hydratedAt as string,
      };
    }
  }
  return {
    input: { ...input, maxPages: input.maxPages ?? fullPages },
    historyPolicy,
    hydratedAt: null,
  };
}
