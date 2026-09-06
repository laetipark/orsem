import { useEffect, useRef, useState } from 'react';

/** No polling or provider requests for a hidden tab or an offscreen panel. */
export function useVisiblePanel() {
  const ref = useRef<HTMLDivElement>(null);
  const [intersects, setIntersects] = useState(typeof IntersectionObserver === 'undefined');
  const [foreground, setForeground] = useState(document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setForeground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) =>
            setIntersects(entries.some((entry) => entry.isIntersecting)),
          );
    if (ref.current) observer?.observe(ref.current);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', changed);
    };
  }, []);
  return { ref, visible: foreground && intersects };
}
