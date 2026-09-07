import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import './mouse-drag-scroll.css';

interface Gesture {
  element: HTMLDivElement;
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  dragging: boolean;
  scrollBehavior: string;
}

export function useMouseDragScroll() {
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [scrollable, setScrollable] = useState(false);
  const canScroll = (element: HTMLDivElement) => element.scrollWidth - element.clientWidth > 1;
  const finish = () => {
    const current = gesture.current;
    gesture.current = null;
    if (current) {
      current.element.style.scrollBehavior = current.scrollBehavior;
      if (current.element.hasPointerCapture?.(current.pointerId))
        current.element.releasePointerCapture(current.pointerId);
    }
    setDragging(false);
  };
  useEffect(() => {
    const cancel = () => {
      const current = gesture.current;
      gesture.current = null;
      if (current) {
        current.element.style.scrollBehavior = current.scrollBehavior;
        if (current.element.hasPointerCapture?.(current.pointerId))
          current.element.releasePointerCapture(current.pointerId);
      }
      setDragging(false);
    };
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      const current = gesture.current;
      gesture.current = null;
      if (current) {
        current.element.style.scrollBehavior = current.scrollBehavior;
        if (current.element.hasPointerCapture?.(current.pointerId))
          current.element.releasePointerCapture(current.pointerId);
      }
    };
  }, []);
  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointerId === event.pointerId) finish();
  };
  return {
    dragging,
    scrollable,
    handlers: {
      onPointerEnter: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'mouse') setScrollable(canScroll(event.currentTarget));
      },
      onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (gesture.current?.pointerId === event.pointerId && !gesture.current.dragging) finish();
      },
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        suppressClick.current = false;
        if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
        const element = event.currentTarget;
        const overflowing = canScroll(element);
        setScrollable(overflowing);
        if (!overflowing) return;
        gesture.current = {
          element,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startLeft: element.scrollLeft,
          dragging: false,
          scrollBehavior: element.style.scrollBehavior,
        };
      },
      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (!(event.buttons & 1)) {
          finish();
          return;
        }
        const dx = event.clientX - current.startX;
        if (!current.dragging) {
          if (Math.abs(dx) < 5 || Math.abs(dx) <= Math.abs(event.clientY - current.startY)) return;
          current.dragging = true;
          suppressClick.current = true;
          current.element.style.scrollBehavior = 'auto';
          current.element.setPointerCapture?.(current.pointerId);
          setDragging(true);
        }
        event.preventDefault();
        current.element.scrollLeft = Math.max(
          0,
          Math.min(
            current.element.scrollWidth - current.element.clientWidth,
            current.startLeft - dx,
          ),
        );
      },
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onLostPointerCapture: endPointer,
      onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
        if (!suppressClick.current || event.detail === 0) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onDragStartCapture: (event: React.DragEvent<HTMLDivElement>) => {
        if (gesture.current) event.preventDefault();
      },
    },
  };
}
