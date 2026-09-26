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
    const nextExpiry = (value: unknown): number => {
      if (!value || typeof value !== 'object') return Infinity;
      const own =
        'expiresAt' in value && typeof value.expiresAt === 'string'
          ? Date.parse(value.expiresAt)
          : Infinity;
      return Math.min(
        Number.isFinite(own) && own > Date.now() ? own : Infinity,
        ...Object.values(value).map(nextExpiry),
      );
    };
    const expire = () => {
      if (updating) return;
      updating = true;
      if (timer !== undefined) window.clearTimeout(timer);
      let nextAt = Infinity;
      for (const query of client.getQueryCache().findAll({
        predicate: (query) => matches(query.queryKey),
      })) {
        const data = query.state.data,
          next = expireNews(data, Date.now());
        if (data !== next) client.setQueryData(query.queryKey, next);
        nextAt = Math.min(nextAt, nextExpiry(next));
      }
      updating = false;
      if (Number.isFinite(nextAt))
        timer = window.setTimeout(
          expire,
          Math.max(0, Math.min(2_147_483_647, nextAt - Date.now())),
        );
    };
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (matches(event.query.queryKey) && ['added', 'updated', 'removed'].includes(event.type))
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
