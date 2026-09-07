import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMouseDragScroll } from './use-mouse-drag-scroll';

function ScrollStrip({ onSelect }: { onSelect: () => void }) {
  const { handlers, dragging, scrollable } = useMouseDragScroll();
  return (
    <div
      {...handlers}
      role="region"
      aria-label="관심 그룹"
      data-dragging={dragging}
      data-scrollable={scrollable}
    >
      <button type="button" onClick={onSelect}>
        기술주
      </button>
    </div>
  );
}

function setup({ clientWidth = 200, scrollWidth = 800, scrollLeft = 150 } = {}) {
  const onSelect = vi.fn();
  render(<ScrollStrip onSelect={onSelect} />);
  const strip = screen.getByRole('region', { name: '관심 그룹' });
  const button = screen.getByRole('button', { name: '기술주' });
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollLeft: { configurable: true, writable: true, value: scrollLeft },
    scrollTop: { configurable: true, writable: true, value: 45 },
  });
  const captured = new Set<number>();
  const setPointerCapture = vi.fn((id: number) => captured.add(id));
  const releasePointerCapture = vi.fn((id: number) => captured.delete(id));
  Object.defineProperties(strip, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { strip, button, onSelect, setPointerCapture, releasePointerCapture };
}

function pointer(
  target: HTMLElement,
  type: string,
  {
    clientX = 200,
    clientY = 50,
    pointerId = 7,
    pointerType = 'mouse',
    button = 0,
    buttons = type === 'pointerup' ? 0 : 1,
    isPrimary = true,
  } = {},
) {
  // jsdom does not implement PointerEvent; React reads these native event fields.
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button,
    buttons,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
    isPrimary: { value: isPrimary },
  });
  fireEvent(target, event);
  return event;
}

function click(button: HTMLElement, detail = 1) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail });
  fireEvent(button, event);
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('starts horizontal mouse scrolling after the threshold and clamps both edges without moving the page', () => {
  const { strip, button, setPointerCapture, releasePointerCapture, onSelect } = setup();
  strip.style.scrollBehavior = 'smooth';
  const pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  expect(pointer(button, 'pointerdown').defaultPrevented).toBe(false);
  expect(pointer(button, 'pointermove', { clientX: 198 }).defaultPrevented).toBe(false);
  expect(strip.scrollLeft).toBe(150);
  expect(strip).toHaveAttribute('data-dragging', 'false');
  expect(setPointerCapture).not.toHaveBeenCalled();

  expect(pointer(button, 'pointermove', { clientX: 195 }).defaultPrevented).toBe(true);
  expect(strip.scrollLeft).toBe(155);
  expect(strip).toHaveAttribute('data-dragging', 'true');
  expect(setPointerCapture).toHaveBeenCalledWith(7);
  expect(strip.style.scrollBehavior).toBe('auto');
  pointer(strip, 'pointermove', { clientX: 900 });
  expect(strip.scrollLeft).toBe(0);
  pointer(strip, 'pointermove', { clientX: -900 });
  expect(strip.scrollLeft).toBe(600);
  expect(strip.scrollTop).toBe(45);
  expect(pageScroll).not.toHaveBeenCalled();

  pointer(strip, 'pointerup', { clientX: -900 });
  expect(strip).toHaveAttribute('data-dragging', 'false');
  expect(releasePointerCapture).toHaveBeenCalledWith(7);
  expect(strip.style.scrollBehavior).toBe('smooth');
  expect(click(button).defaultPrevented).toBe(true);
  expect(onSelect).not.toHaveBeenCalled();
});

it.each([0, 4])('keeps ordinary tab selection when the mouse moves only %i pixels', (distance) => {
  const { strip, button, onSelect, setPointerCapture } = setup();
  pointer(button, 'pointerdown');
  pointer(button, 'pointermove', { clientX: 200 - distance });
  pointer(button, 'pointerup', { clientX: 200 - distance });
  expect(click(button).defaultPrevented).toBe(false);
  expect(onSelect).toHaveBeenCalledOnce();
  expect(strip.scrollLeft).toBe(150);
  expect(setPointerCapture).not.toHaveBeenCalled();
});

it.each([
  { name: 'touch', pointerType: 'touch', button: 0, isPrimary: true },
  { name: 'pen', pointerType: 'pen', button: 0, isPrimary: true },
  { name: 'right mouse button', pointerType: 'mouse', button: 2, isPrimary: true },
  { name: 'secondary mouse pointer', pointerType: 'mouse', button: 0, isPrimary: false },
])('leaves $name gestures to the browser', ({ pointerType, button: pointerButton, isPrimary }) => {
  const { strip, button, setPointerCapture } = setup();
  expect(
    pointer(button, 'pointerdown', { pointerType, button: pointerButton, isPrimary })
      .defaultPrevented,
  ).toBe(false);
  expect(
    pointer(button, 'pointermove', { pointerType, button: pointerButton, isPrimary, clientX: 80 })
      .defaultPrevented,
  ).toBe(false);
  expect(strip.scrollLeft).toBe(150);
  expect(strip).toHaveAttribute('data-dragging', 'false');
  expect(setPointerCapture).not.toHaveBeenCalled();
});

it('leaves a mostly vertical gesture unconsumed', () => {
  const { strip, button, setPointerCapture } = setup();
  pointer(button, 'pointerdown');
  expect(pointer(button, 'pointermove', { clientX: 170, clientY: 100 }).defaultPrevented).toBe(
    false,
  );
  expect(strip.scrollLeft).toBe(150);
  expect(strip).toHaveAttribute('data-dragging', 'false');
  expect(setPointerCapture).not.toHaveBeenCalled();
});

it('does not consume a mouse gesture when all groups fit', () => {
  const { strip, button, onSelect, setPointerCapture } = setup({
    clientWidth: 800,
    scrollWidth: 800,
    scrollLeft: 0,
  });
  pointer(button, 'pointerdown');
  expect(pointer(button, 'pointermove', { clientX: 80 }).defaultPrevented).toBe(false);
  pointer(button, 'pointerup', { clientX: 80 });
  expect(click(button).defaultPrevented).toBe(false);
  expect(onSelect).toHaveBeenCalledOnce();
  expect(strip.scrollLeft).toBe(0);
  expect(setPointerCapture).not.toHaveBeenCalled();
});

it('allows keyboard activation immediately after a mouse drag', () => {
  const { strip, button, onSelect } = setup();
  pointer(button, 'pointerdown');
  pointer(button, 'pointermove', { clientX: 100 });
  pointer(strip, 'pointerup', { clientX: 100 });
  expect(click(button, 0).defaultPrevented).toBe(false);
  expect(onSelect).toHaveBeenCalledOnce();
});

it('allows a new intentional mouse click after suppressing the drag click', () => {
  const { strip, button, onSelect } = setup();
  pointer(button, 'pointerdown');
  pointer(button, 'pointermove', { clientX: 100 });
  pointer(strip, 'pointerup', { clientX: 100 });
  click(button);
  expect(onSelect).not.toHaveBeenCalled();
  pointer(button, 'pointerdown');
  pointer(button, 'pointerup');
  expect(click(button).defaultPrevented).toBe(false);
  expect(onSelect).toHaveBeenCalledOnce();
});

it.each(['pointercancel', 'lostpointercapture'])('stops dragging after %s', (type) => {
  const { strip, button } = setup();
  pointer(button, 'pointerdown');
  pointer(button, 'pointermove', { clientX: 100 });
  expect(strip.scrollLeft).toBe(250);
  pointer(strip, type, { clientX: 100 });
  expect(strip).toHaveAttribute('data-dragging', 'false');
  pointer(strip, 'pointermove', { clientX: 0 });
  expect(strip.scrollLeft).toBe(250);
});

it('stops dragging when the browser window loses focus', () => {
  const { strip, button } = setup();
  pointer(button, 'pointerdown');
  pointer(button, 'pointermove', { clientX: 100 });
  fireEvent(window, new Event('blur'));
  expect(strip).toHaveAttribute('data-dragging', 'false');
  pointer(strip, 'pointermove', { clientX: 0 });
  expect(strip.scrollLeft).toBe(250);
});

it('ends a gesture when the mouse returns with its button released elsewhere', () => {
  const { strip, button, releasePointerCapture } = setup();
  pointer(button, 'pointerdown');
  pointer(button, 'pointermove', { clientX: 100 });
  expect(pointer(strip, 'pointermove', { clientX: 0, buttons: 0 }).defaultPrevented).toBe(false);
  expect(strip).toHaveAttribute('data-dragging', 'false');
  expect(releasePointerCapture).toHaveBeenCalledWith(7);
  expect(strip.scrollLeft).toBe(250);
});

it('abandons an unstarted drag on leave so reentering with a pressed mouse cannot jump the list', () => {
  const { strip, button, setPointerCapture } = setup();
  pointer(button, 'pointerdown');
  pointer(button, 'pointermove', { clientX: 196 });
  // React derives pointerleave/enter from the native pointerout/over events.
  pointer(strip, 'pointerout', { clientX: 196 });
  pointer(strip, 'pointerover', { clientX: 50 });
  expect(pointer(strip, 'pointermove', { clientX: 40, buttons: 1 }).defaultPrevented).toBe(false);
  expect(strip.scrollLeft).toBe(150);
  expect(strip).toHaveAttribute('data-dragging', 'false');
  expect(setPointerCapture).not.toHaveBeenCalled();
});

it('continues an already captured drag after the mouse leaves the strip', () => {
  const { strip, button, releasePointerCapture } = setup();
  pointer(button, 'pointerdown');
  pointer(button, 'pointermove', { clientX: 100 });
  pointer(strip, 'pointerout', { clientX: 100 });
  expect(strip).toHaveAttribute('data-dragging', 'true');
  expect(releasePointerCapture).not.toHaveBeenCalled();
  expect(pointer(strip, 'pointermove', { clientX: 80 }).defaultPrevented).toBe(true);
  expect(strip.scrollLeft).toBe(270);
  pointer(strip, 'pointerup', { clientX: 80 });
  expect(strip).toHaveAttribute('data-dragging', 'false');
  expect(releasePointerCapture).toHaveBeenCalledWith(7);
});

it('prevents native item dragging only during a pending mouse gesture', () => {
  const { strip, button } = setup();
  const before = new Event('dragstart', { bubbles: true, cancelable: true });
  fireEvent(button, before);
  expect(before.defaultPrevented).toBe(false);
  pointer(button, 'pointerdown');
  const during = new Event('dragstart', { bubbles: true, cancelable: true });
  fireEvent(button, during);
  expect(during.defaultPrevented).toBe(true);
  pointer(strip, 'pointercancel');
  const after = new Event('dragstart', { bubbles: true, cancelable: true });
  fireEvent(button, after);
  expect(after.defaultPrevented).toBe(false);
});
