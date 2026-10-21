const storageKey = 'orsem-login-return-v1';
const maxAge = 30 * 60_000;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const destinationPattern = new RegExp(
  `^/(?:events(?:/${uuid})?|companies(?:/(?:[A-Z]+:)?[A-Z0-9][A-Z0-9.-]{0,63})?|news(?:/${uuid}|/naver)?|analysis|operations|settings/notifications|watchlist(?:/popout)?|reviews|markets(?:/[a-z0-9-]{1,32})?|search|sources)?$`,
  'i',
);

export function safeLoginReturn(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || !destinationPattern.test(parsed.pathname))
      return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function rememberLoginReturn(value: string) {
  const path = safeLoginReturn(value);
  if (!path || path === '/') return;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify({ path, createdAt: Date.now() }));
  } catch {
    /* A query parameter still preserves direct login navigation. */
  }
}

export function savedLoginReturn(): string | null {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') as {
      path?: string;
      createdAt?: number;
    } | null;
    if (
      !saved ||
      typeof saved.createdAt !== 'number' ||
      Date.now() - saved.createdAt > maxAge ||
      Date.now() < saved.createdAt
    )
      return null;
    return safeLoginReturn(saved.path);
  } catch {
    return null;
  }
}

export function clearLoginReturn() {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    /* Storage can be disabled. */
  }
}

export function loginUrl(base: '/login' | '/admin/login', value: string | null): string {
  const path = safeLoginReturn(value);
  return path && path !== '/' ? `${base}?${new URLSearchParams({ returnTo: path })}` : base;
}
