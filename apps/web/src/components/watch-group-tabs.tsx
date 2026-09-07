import { ChevronLeft, ChevronRight, History } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMouseDragScroll } from '../lib/use-mouse-drag-scroll';

export function WatchGroupTabs({
  tabs,
  selected,
  panelId,
  onSelect,
}: {
  tabs: Array<{ id: string; name: string; itemCount: number }>;
  selected?: string;
  panelId: string;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mouseScroll = useMouseDragScroll();
  const [edges, setEdges] = useState({ left: false, right: false });
  const contents = tabs.map((tab) => `${tab.id}:${tab.name}:${tab.itemCount}`).join('|');
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
    setEdges((old) => (old.left === left && old.right === right ? old : { left, right }));
  };
  useEffect(() => {
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (ref.current) observer?.observe(ref.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [contents]);
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !active || !el.scrollTo) return;
    const listRect = el.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.left < listRect.left)
      el.scrollTo({ left: el.scrollLeft + activeRect.left - listRect.left, behavior: 'smooth' });
    else if (activeRect.right > listRect.right)
      el.scrollTo({ left: el.scrollLeft + activeRect.right - listRect.right, behavior: 'smooth' });
  }, [selected, contents]);
  const scroll = (direction: number) => {
    const el = ref.current;
    if (el)
      el.scrollBy({ left: direction * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' });
  };
  return (
    <div className="watch-groups__tab-scroll" data-overflow={edges.left || edges.right}>
      <button
        type="button"
        className="watch-groups__scroll-arrow"
        aria-label="이전 관심 그룹 보기"
        disabled={!edges.left}
        onClick={() => scroll(-1)}
      >
        <ChevronLeft size={15} />
      </button>
      <div
        ref={ref}
        className={`watch-groups__tabs mouse-drag-scroll${mouseScroll.dragging ? ' is-dragging' : ''}`}
        data-mouse-scrollable={mouseScroll.scrollable}
        {...mouseScroll.handlers}
        role="tablist"
        aria-label="관심 종목 그룹 선택"
        onScroll={measure}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${panelId}-${tab.id}`}
            aria-selected={selected === tab.id}
            aria-controls={panelId}
            tabIndex={selected === tab.id ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              const target =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : null;
              if (target !== null) {
                event.preventDefault();
                onSelect(tabs[target]!.id);
                ref.current
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [target]?.focus({ preventScroll: true });
              }
            }}
          >
            {tab.id === 'recent' ? <History size={14} aria-hidden="true" /> : null}
            {tab.name}
            <small>{tab.itemCount}</small>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="watch-groups__scroll-arrow"
        aria-label="다음 관심 그룹 보기"
        disabled={!edges.right}
        onClick={() => scroll(1)}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}
