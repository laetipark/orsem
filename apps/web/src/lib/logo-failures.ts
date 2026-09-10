// Browser image errors do not expose HTTP status. This is a short, in-memory
// load-failure record, never a permanent 'logo missing' or identity verdict.
export const LOGO_FAILURE_TTL_MS = 60_000;
const failures = new Map<string, number>();
const listeners = new Set<() => void>();

export function logoRecentlyFailed(url: string, now = Date.now()) {
  const expires = failures.get(url);
  if (expires !== undefined && expires <= now) failures.delete(url);
  return expires !== undefined && expires > now;
}

export function recordLogoFailure(url: string, now = Date.now()) {
  for (const [key, expires] of failures) if (expires <= now) failures.delete(key);
  if (failures.size >= 1024) failures.delete(failures.keys().next().value!);
  failures.set(url, now + LOGO_FAILURE_TTL_MS);
  listeners.forEach((listener) => listener());
}

export function subscribeLogoFailures(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearLogoFailures() {
  failures.clear();
  listeners.forEach((listener) => listener());
}
