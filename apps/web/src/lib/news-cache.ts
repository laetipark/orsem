import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
export function expireNews(value: unknown, now: number): unknown {
  if (Array.isArray(value)) {
    const filtered = value.filter(
      (item) =>
        !(
          item &&
          typeof item === 'object' &&
          'expiresAt' in item &&
          typeof item.expiresAt === 'string' &&
          Date.parse(item.expiresAt) <= now
        ),
    );
    const next = filtered.map((item) => expireNews(item, now));
    return next.length === value.length && next.every((item, i) => item === value[i])
      ? value
      : next;
  }
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value),
    next = entries.map(([key, item]) => [key, expireNews(item, now)] as const);
  return next.every(([, item], i) => item === entries[i]?.[1]) ? value : Object.fromEntries(next);
}
export function useNewsCacheExpiry() {
  const client = useQueryClient();
  useEffect(() => {
    let timer: number | undefined;
    let updating = false;
    const matches = (key: readonly unknown[]) =>
      key[0] === 'news' || key.includes('personal-news') || key.includes('group-news');
    const nextExpiry = (value: unknown, now: number): number => {
      if (!value || typeof value !== 'object') return Infinity;
      const own =
        'expiresAt' in value && typeof value.expiresAt === 'string'
          ? Date.parse(value.expiresAt)
          : Infinity;
      return Math.min(
        Number.isFinite(own) && own > now ? own : Infinity,
        ...Object.values(value).map((item) => nextExpiry(item, now)),
      );
    };
    const expire = () => {
      if (updating) return;
      updating = true;
      if (timer !== undefined) window.clearTimeout(timer);
      let nextAt = Infinity;
      const now = Date.now();
      for (const query of client.getQueryCache().findAll({
        predicate: (query) => matches(query.queryKey),
      })) {
        const data = query.state.data,
          next = expireNews(data, now);
        // Removing expired provider results is not a successful server refresh.
        if (data !== next)
          client.setQueryData(query.queryKey, next, { updatedAt: query.state.dataUpdatedAt });
        nextAt = Math.min(nextAt, nextExpiry(next, now));
      }
      updating = false;
      if (Number.isFinite(nextAt))
        timer = window.setTimeout(
          expire,
          Math.max(0, Math.min(2_147_483_647, nextAt - Date.now())),
        );
    };
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (!matches(event.query.queryKey)) return;
      // Fetch/retry/invalidation transitions leave the payload and its expiry unchanged.
      if (
        event.type === 'added' ||
        event.type === 'removed' ||
        (event.type === 'updated' &&
          (event.action.type === 'success' || event.action.type === 'setState'))
      )
        expire();
    });
    expire();
    window.addEventListener('focus', expire);
    document.addEventListener('visibilitychange', expire);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', expire);
      document.removeEventListener('visibilitychange', expire);
    };
  }, [client]);
}
