export type ScheduledMarketRegion = 'kr' | 'us';
const halfDay = 12 * 60 * 60_000;
const offset = 3 * 60 * 60_000; // KST offset (9h) minus the domestic start (6h).

export function marketSchedule(now: number = Date.now()) {
  const window = Math.floor((now + offset) / halfDay);
  return {
    window,
    region: (window % 2 === 0 ? 'kr' : 'us') as ScheduledMarketRegion,
    nextBoundary: (window + 1) * halfDay - offset,
  };
}

export function scheduledRegion(value: string | null, now: number = Date.now()) {
  return value === 'kr' || value === 'us' ? value : marketSchedule(now).region;
}
