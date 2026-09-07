import { useCallback, useMemo, useSyncExternalStore } from 'react';

export const COMPACT_LAYOUT_QUERY = '(max-width: 900px), (hover: none) and (pointer: coarse)';

export function useMediaQuery(query: string): boolean {
  const media = useMemo(
    () => (typeof window === 'undefined' ? null : window.matchMedia(query)),
    [query],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      media?.addEventListener('change', onChange);
      return () => media?.removeEventListener('change', onChange);
    },
    [media],
  );
  const getSnapshot = useCallback(() => media?.matches ?? false, [media]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
