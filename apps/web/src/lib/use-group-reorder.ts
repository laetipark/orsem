import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

interface Gesture {
  id: string;
  ids: string[];
  idsKey: string;
  handle: HTMLButtonElement;
  pointerId: number;
  startX: number;
  startY: number;
  clientY: number;
  dragging: boolean;
  frame: number | null;
  scroller: HTMLElement | null;
  scrollBehavior: string;
}

function releaseGesture(current: Gesture | null) {
  if (!current) return;
  if (current.frame !== null) cancelAnimationFrame(current.frame);
  if (current.dragging && current.scroller)
    current.scroller.style.scrollBehavior = current.scrollBehavior;
  if (current.handle.hasPointerCapture?.(current.pointerId))
    current.handle.releasePointerCapture(current.pointerId);
}

function scrollParent(list: HTMLUListElement) {
  for (let element: HTMLElement | null = list; element; element = element.parentElement) {
    if (
      element.scrollHeight > element.clientHeight &&
      /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)
    )
      return element;
  }
  return null;
}

interface DropTarget {
  id: string;
  position: 'before' | 'after';
  index: number;
}

function insertionTarget(list: HTMLUListElement | null, current: Gesture): DropTarget | null {
  let closest: { id: string; middle: number } | null = null;
  let distance = Infinity;
  for (const row of list?.children ?? []) {
    const id = row.getAttribute('data-sort-id');
    if (!id || !current.ids.includes(id)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const nextDistance = Math.max(rect.top - current.clientY, current.clientY - rect.bottom, 0);
    if (nextDistance < distance) {
      distance = nextDistance;
      closest = { id, middle: rect.top + rect.height / 2 };
    }
  }
  if (!closest || closest.id === current.id) return null;
  const position = current.clientY < closest.middle ? 'before' : 'after';
  const from = current.ids.indexOf(current.id);
  const boundary = current.ids.indexOf(closest.id) + (position === 'after' ? 1 : 0);
  const index = boundary - (from < boundary ? 1 : 0);
  // Removing the dragged row shifts later insertion boundaries by one.
  // Adjacent boundaries that preserve the order need no insertion indicator.
  return from === index ? null : { id: closest.id, position, index };
}

function reordered(ids: string[], from: number, to: number) {
  const next = [...ids];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

export function useGroupReorder({
  ids,
  disabled,
  onReorder,
}: {
  ids: string[];
  disabled: boolean;
  onReorder: (ids: string[]) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // Parents may derive a new array each render; only a changed order cancels the gesture.
  const idsKey = JSON.stringify(ids);
  const cancel = useCallback(() => {
    const current = gesture.current;
    gesture.current = null;
    releaseGesture(current);
    setDraggedId(null);
    setDropTarget(null);
  }, []);

  useLayoutEffect(() => {
    cancel();
  }, [idsKey, disabled, cancel]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape, true);
      const current = gesture.current;
      gesture.current = null;
      releaseGesture(current);
    };
  }, [cancel]);

  const updateTarget = (current: Gesture) => {
    const next = insertionTarget(listRef.current, current);
    setDropTarget((previous) =>
      previous?.id === next?.id && previous?.position === next?.position ? previous : next,
    );
  };
  const autoScroll = (current: Gesture) => {
    if (!current.scroller || current.frame !== null) return;
    const step = () => {
      current.frame = null;
      if (gesture.current !== current || !current.dragging || !current.scroller) return;
      const element = current.scroller;
      const rect = element.getBoundingClientRect();
      const edge = Math.min(40, rect.height / 3);
      if (edge <= 0) return;
      const delta =
        current.clientY < rect.top + edge
          ? -16 * Math.min(1, (rect.top + edge - current.clientY) / edge)
          : current.clientY > rect.bottom - edge
            ? 16 * Math.min(1, (current.clientY - rect.bottom + edge) / edge)
            : 0;
      const before = element.scrollTop;
      element.scrollTop = Math.max(
        0,
        Math.min(element.scrollHeight - element.clientHeight, before + delta),
      );
      if (element.scrollTop === before) return;
      updateTarget(current);
      current.frame = requestAnimationFrame(step);
    };
    current.frame = requestAnimationFrame(step);
  };
  const cancelPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.pointerId === event.pointerId) cancel();
  };

  return {
    listRef,
    draggedId,
    targetId: dropTarget?.id ?? null,
    dropPosition: dropTarget?.position ?? null,
    getHandleProps: (id: string) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (
          disabled ||
          gesture.current ||
          !ids.includes(id) ||
          !listRef.current ||
          event.button !== 0 ||
          !event.isPrimary ||
          !['mouse', 'touch', 'pen'].includes(event.pointerType)
        )
          return;
        suppressClick.current = false;
        const scroller = scrollParent(listRef.current);
        gesture.current = {
          id,
          ids: [...ids],
          idsKey,
          handle: event.currentTarget,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          clientY: event.clientY,
          dragging: false,
          frame: null,
          scroller,
          scrollBehavior: scroller?.style.scrollBehavior ?? '',
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (disabled || current.idsKey !== idsKey || !(event.buttons & 1)) {
          cancel();
          return;
        }
        current.clientY = event.clientY;
        if (!current.dragging) {
          if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6)
            return;
          current.dragging = true;
          suppressClick.current = true;
          if (current.scroller) current.scroller.style.scrollBehavior = 'auto';
          setDraggedId(current.id);
        }
        event.preventDefault();
        updateTarget(current);
        autoScroll(current);
      },
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        current.clientY = event.clientY;
        const from = current.ids.indexOf(current.id);
        const target = insertionTarget(listRef.current, current);
        const shouldSave = current.dragging && !disabled && current.idsKey === idsKey;
        cancel();
        if (shouldSave && target) onReorder(reordered(current.ids, from, target.index));
      },
      onPointerCancel: cancelPointer,
      onLostPointerCapture: cancelPointer,
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (disabled || gesture.current || event.altKey || event.ctrlKey || event.metaKey) return;
        const from = ids.indexOf(id);
        if (from < 0) return;
        const to =
          event.key === 'ArrowUp'
            ? Math.max(0, from - 1)
            : event.key === 'ArrowDown'
              ? Math.min(ids.length - 1, from + 1)
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? ids.length - 1
                  : null;
        if (to === null) return;
        event.preventDefault();
        if (from !== to) onReorder(reordered(ids, from, to));
      },
      onClickCapture: (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!suppressClick.current || event.detail === 0) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onDragStart: (event: React.DragEvent<HTMLButtonElement>) => {
        if (gesture.current) event.preventDefault();
      },
    }),
  };
}
