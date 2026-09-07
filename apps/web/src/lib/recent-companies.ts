import { useCallback, useSyncExternalStore } from 'react';
import type { CompanySummary } from '../types';
import { companyPath } from './company-path';

export interface RecentCompany {
  id: string;
  nameKo: string;
  nameEn?: string | null;
  stockCode: string | null;
  ticker: string | null;
  market: string;
  canonicalPath: string;
  viewedAt: string;
}

const prefix = 'orsem-recent-companies-v1:';
const changedEvent = 'orsem-recent-companies-changed';
const empty: readonly RecentCompany[] = [];
const snapshots = new Map<string, { raw: string | null; items: readonly RecentCompany[] }>();
const memory = new Map<string, string>();
const memoryOverrides = new Set<string>();

function parse(raw: string | null): readonly RecentCompany[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return empty;
    const seen = new Set<string>();
    return value
      .filter((item): item is RecentCompany => {
        if (!item || typeof item !== 'object') return false;
        const row = item as Record<string, unknown>;
        if (
          typeof row.id !== 'string' ||
          !row.id ||
          seen.has(row.id) ||
          typeof row.nameKo !== 'string' ||
          typeof row.market !== 'string' ||
          !(row.stockCode === null || typeof row.stockCode === 'string') ||
          !(row.ticker === null || typeof row.ticker === 'string') ||
          !(row.nameEn == null || typeof row.nameEn === 'string') ||
          typeof row.canonicalPath !== 'string' ||
          !/^\/companies\/[^/?#]+$/.test(row.canonicalPath) ||
          typeof row.viewedAt !== 'string' ||
          !Number.isFinite(Date.parse(row.viewedAt))
        )
          return false;
        seen.add(row.id);
        return true;
      })
      .slice(0, 20);
  } catch {
    return empty;
  }
}

function snapshot(actor: string): readonly RecentCompany[] {
  if (!actor || typeof window === 'undefined') return empty;
  const key = prefix + actor;
  let raw: string | null;
  try {
    raw = memoryOverrides.has(key) ? (memory.get(key) ?? null) : localStorage.getItem(key);
  } catch {
    raw = memory.get(key) ?? null;
  }
  const cached = snapshots.get(key);
  if (cached?.raw === raw) return cached.items;
  const items = parse(raw);
  snapshots.set(key, { raw, items });
  return items;
}

/** This browser's account-scoped history. Quotes and private group contents are never persisted. */
export function recordRecentCompany(
  actor: string,
  company: Pick<CompanySummary, 'id' | 'nameKo' | 'nameEn' | 'stockCode' | 'ticker' | 'market'> & {
    canonicalPath?: string;
  },
) {
  if (!actor || !company.id || typeof window === 'undefined') return;
  const item: RecentCompany = {
    id: company.id,
    nameKo: company.nameKo,
    nameEn: company.nameEn,
    stockCode: company.stockCode ?? null,
    ticker: company.ticker ?? null,
    market: company.market,
    canonicalPath: companyPath(company),
    viewedAt: new Date().toISOString(),
  };
  const items = [item, ...snapshot(actor).filter((row) => row.id !== item.id)].slice(0, 20);
  const key = prefix + actor;
  const raw = JSON.stringify(items);
  memory.set(key, raw);
  try {
    localStorage.setItem(key, raw);
    memoryOverrides.delete(key);
  } catch {
    // Private browsing or quota restrictions retain a usable in-memory history.
    memoryOverrides.add(key);
  }
  snapshots.set(key, { raw, items });
  window.dispatchEvent(new CustomEvent(changedEvent, { detail: actor }));
}

export function useRecentCompanies(actor: string): readonly RecentCompany[] {
  const subscribe = useCallback(
    (notify: () => void) => {
      const localChanged = (event: Event) => {
        if ((event as CustomEvent<string>).detail === actor) notify();
      };
      const otherTabChanged = (event: StorageEvent) => {
        if (event.key === null || event.key === prefix + actor) {
          memoryOverrides.delete(prefix + actor);
          memory.delete(prefix + actor);
          notify();
        }
      };
      window.addEventListener(changedEvent, localChanged);
      window.addEventListener('storage', otherTabChanged);
      return () => {
        window.removeEventListener(changedEvent, localChanged);
        window.removeEventListener('storage', otherTabChanged);
      };
    },
    [actor],
  );
  const getSnapshot = useCallback(() => snapshot(actor), [actor]);
  return useSyncExternalStore(subscribe, getSnapshot, () => empty);
}
