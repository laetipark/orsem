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
    const expire = () => {
      for (const query of client.getQueryCache().findAll({
        predicate: (query) =>
          query.queryKey[0] === 'news' || query.queryKey.includes('personal-news'),
      })) {
        const data = query.state.data,
          next = expireNews(data, Date.now());
        if (data !== next) client.setQueryData(query.queryKey, next);
      }
    };
    const timer = window.setInterval(expire, 1000);
    window.addEventListener('focus', expire);
    document.addEventListener('visibilitychange', expire);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', expire);
      document.removeEventListener('visibilitychange', expire);
    };
  }, [client]);
}
