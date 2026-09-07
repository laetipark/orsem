import { useCallback, useSyncExternalStore } from 'react';

export type StockContent = 'stocks' | 'news';
const eventName = 'orsem-stock-content-changed';
const keyFor = (actor: string) => `orsem-stock-content-v1:${actor}`;
const fallback = new Map<string, StockContent>();

function read(actor: string): StockContent {
  if (!actor) return 'stocks';
  if (fallback.has(actor)) return fallback.get(actor)!;
  try {
    return localStorage.getItem(keyFor(actor)) === 'news' ? 'news' : 'stocks';
  } catch {
    return 'stocks';
  }
}

export function useStockContentPreference(actor: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const changed = () => notify();
      const storage = (event: StorageEvent) => {
        if (event.key === null || event.key === keyFor(actor)) {
          fallback.delete(actor);
          notify();
        }
      };
      window.addEventListener(eventName, changed);
      window.addEventListener('storage', storage);
      return () => {
        window.removeEventListener(eventName, changed);
        window.removeEventListener('storage', storage);
      };
    },
    [actor],
  );
  const get = useCallback(() => read(actor), [actor]);
  const content = useSyncExternalStore(subscribe, get, () => 'stocks' as const);
  const save = (value: StockContent) => {
    if (!actor) return;
    try {
      localStorage.setItem(keyFor(actor), value);
      fallback.delete(actor);
    } catch {
      fallback.set(actor, value);
    }
    window.dispatchEvent(new Event(eventName));
  };
  return { content, save };
}
