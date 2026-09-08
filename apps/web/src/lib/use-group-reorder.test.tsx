import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useGroupReorder } from './use-group-reorder';

interface ListProps {
  ids: string[];
  disabled?: boolean;
  onReorder: (ids: string[]) => void;
  onClick?: () => void;
}

function GroupList({ ids, disabled = false, onReorder, onClick }: ListProps) {
  const { listRef, draggedId, targetId, dropPosition, getHandleProps } = useGroupReorder({
    ids,
    disabled,
    onReorder,
  });
  return (
    <div className="watch-dialog__body" data-testid="scroller" style={{ overflowY: 'auto' }}>
      <ul
        ref={listRef}
        aria-label="그룹"
        data-dragged-id={draggedId ?? ''}
        data-target-id={targetId ?? ''}
        data-drop-position={dropPosition ?? ''}
      >
        {ids.map((id) => (
          <li key={id} data-sort-id={id}>
            <button type="button" {...getHandleProps(id)} onClick={onClick}>
              {id}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function rect(top: number, height: number) {
  return { top, bottom: top + height, height, width: 200, x: 0, y: top, left: 0, right: 200 };
}

function setup({ ids = ['a', 'b', 'c'], disabled = false, scrolling = false } = {}) {
  const onReorder = vi.fn();
  const onClick = vi.fn();
  const view = render(
    <GroupList ids={ids} disabled={disabled} onReorder={onReorder} onClick={onClick} />,
  );
  const list = screen.getByRole('list', { name: '그룹' });
  const scroller = screen.getByTestId('scroller');
  const captured = new Map<HTMLElement, Set<number>>();
  const setPointerCapture = vi.fn(function (this: HTMLElement, id: number) {
    const pointers = captured.get(this) ?? new Set<number>();
    pointers.add(id);
    captured.set(this, pointers);
  });
  const releasePointerCapture = vi.fn(function (this: HTMLElement, id: number) {
    captured.get(this)?.delete(id);
  });
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 120 },
    scrollHeight: { configurable: true, value: scrolling ? ids.length * 40 : 120 },
  });
  vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => rect(0, 120) as DOMRect);
  for (const [index, row] of [...list.children].entries()) {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(
      () => rect(index * 40 - scroller.scrollTop, 40) as DOMRect,
    );
    const handle = row.querySelector('button')!;
    Object.defineProperties(handle, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: {
        configurable: true,
        value: (id: number) => captured.get(handle)?.has(id) ?? false,
      },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    });
  }
  return {
    ...view,
    list,
    scroller,
    onReorder,
    onClick,
    setPointerCapture,
    releasePointerCapture,
    handle: (id = 'a') => screen.getByRole('button', { name: id }),
    rerenderList: (next: Partial<ListProps>) =>
      view.rerender(
        <GroupList
          ids={ids}
          disabled={disabled}
          onReorder={onReorder}
          onClick={onClick}
          {...next}
        />,
      ),
  };
}

function pointer(
  target: HTMLElement,
  type: string,
  {
    clientX = 20,
    clientY = 20,
    pointerId = 7,
    pointerType = 'mouse',
    button = 0,
    buttons = type === 'pointerup' ? 0 : 1,
    isPrimary = true,
  } = {},
) {
  // jsdom does not implement PointerEvent; React reads these native fields.
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

function frames() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => callbacks.delete(id));
  return {
    callbacks,
    step: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      act(() => pending.forEach((callback) => callback(16)));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['mouse', 'touch', 'pen'])(
  'captures a primary %s drag and saves once on drop without changing DOM order during the drag',
  (pointerType) => {
    const { handle, list, onReorder, setPointerCapture, releasePointerCapture } = setup();
    pointer(handle(), 'pointerdown', { pointerType });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(list).toHaveAttribute('data-dragged-id', '');
    expect(pointer(handle(), 'pointermove', { pointerType, clientY: 62 }).defaultPrevented).toBe(
      true,
    );
    expect(list).toHaveAttribute('data-dragged-id', 'a');
    expect(list).toHaveAttribute('data-target-id', 'b');
    expect(list).toHaveAttribute('data-drop-position', 'after');
    pointer(handle(), 'pointermove', { pointerType, clientY: 105 });
    expect(list).toHaveAttribute('data-target-id', 'c');
    expect([...list.children].map((row) => row.getAttribute('data-sort-id'))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(onReorder).not.toHaveBeenCalled();
    pointer(handle(), 'pointerup', { pointerType, clientY: 105 });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a']);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(list).toHaveAttribute('data-dragged-id', '');
    expect(list).toHaveAttribute('data-target-id', '');
    expect(list).toHaveAttribute('data-drop-position', '');
    pointer(handle(), 'pointerup', { pointerType, clientY: 105 });
    expect(onReorder).toHaveBeenCalledOnce();
  },
);

it.each([0, 5])('does not reorder or block a click below the threshold (%i px)', (distance) => {
  const { handle, list, onReorder, onClick } = setup();
  pointer(handle(), 'pointerdown');
  expect(pointer(handle(), 'pointermove', { clientY: 20 + distance }).defaultPrevented).toBe(false);
  pointer(handle(), 'pointerup', { clientY: 20 + distance });
  fireEvent.click(handle(), { detail: 1 });
  expect(list).toHaveAttribute('data-dragged-id', '');
  expect(onReorder).not.toHaveBeenCalled();
  expect(onClick).toHaveBeenCalledOnce();
});

it.each([
  { id: 'a', start: 20, y: 85, target: 'c', position: 'before', expected: ['b', 'a', 'c'] },
  { id: 'a', start: 20, y: 105, target: 'c', position: 'after', expected: ['b', 'c', 'a'] },
  { id: 'c', start: 100, y: 15, target: 'a', position: 'before', expected: ['c', 'a', 'b'] },
  { id: 'c', start: 100, y: 35, target: 'a', position: 'after', expected: ['a', 'c', 'b'] },
  { id: 'b', start: 60, y: -10, target: 'a', position: 'before', expected: ['b', 'a', 'c'] },
  { id: 'b', start: 60, y: 150, target: 'c', position: 'after', expected: ['a', 'c', 'b'] },
])(
  'inserts $id $position $target exactly at the indicated boundary',
  ({ id, start, y, target, position, expected }) => {
    const { handle, list, onReorder } = setup();
    pointer(handle(id), 'pointerdown', { clientY: start });
    pointer(handle(id), 'pointermove', { clientY: y });
    expect(list).toHaveAttribute('data-target-id', target);
    expect(list).toHaveAttribute('data-drop-position', position);
    expect([...list.children].map((row) => row.getAttribute('data-sort-id'))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(onReorder).not.toHaveBeenCalled();
    pointer(handle(id), 'pointerup', { clientY: y });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(expected);
    expect(list).toHaveAttribute('data-target-id', '');
    expect(list).toHaveAttribute('data-drop-position', '');
  },
);

it.each([
  { id: 'a', start: 20, y: 45 },
  { id: 'b', start: 60, y: 35 },
  { id: 'b', start: 60, y: 85 },
  { id: 'c', start: 100, y: 75 },
  { id: 'b', start: 60, y: 70 },
])('hides insertion lines for unchanged adjacent or self drops: $id at $y', ({ id, start, y }) => {
  const { handle, list, onReorder } = setup();
  pointer(handle(id), 'pointerdown', { clientY: start });
  pointer(handle(id), 'pointermove', { clientY: y });
  expect(list).toHaveAttribute('data-dragged-id', id);
  expect(list).toHaveAttribute('data-target-id', '');
  expect(list).toHaveAttribute('data-drop-position', '');
  pointer(handle(id), 'pointerup', { clientY: y });
  expect(onReorder).not.toHaveBeenCalled();
});

it('changes the insertion side when crossing the target midpoint', () => {
  const { handle, list, onReorder } = setup();
  pointer(handle(), 'pointerdown');
  pointer(handle(), 'pointermove', { clientY: 99 });
  expect(list).toHaveAttribute('data-target-id', 'c');
  expect(list).toHaveAttribute('data-drop-position', 'before');
  pointer(handle(), 'pointermove', { clientY: 100 });
  expect(list).toHaveAttribute('data-drop-position', 'after');
  pointer(handle(), 'pointerup', { clientY: 100 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a']);
});

it('targets the row under the pointer even when a neighboring row has a nearer center', () => {
  const { handle, list, onReorder } = setup();
  const dimensions = [
    [0, 100],
    [110, 20],
    [140, 20],
  ];
  [...list.children].forEach((row, index) => {
    vi.mocked(row.getBoundingClientRect).mockReturnValue(
      rect(...(dimensions[index]! as [number, number])) as DOMRect,
    );
  });
  pointer(handle('c'), 'pointerdown', { clientY: 150 });
  pointer(handle('c'), 'pointermove', { clientY: 95 });
  expect(list).toHaveAttribute('data-target-id', 'a');
  expect(list).toHaveAttribute('data-drop-position', 'after');
  pointer(handle('c'), 'pointerup', { clientY: 95 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith(['a', 'c', 'b']);
});

it('starts at six pixels, skips an unchanged drop, and suppresses only the drag click', () => {
  const { handle, list, onReorder, onClick } = setup();
  pointer(handle(), 'pointerdown');
  pointer(handle(), 'pointermove', { clientY: 26 });
  expect(list).toHaveAttribute('data-dragged-id', 'a');
  pointer(handle(), 'pointerup', { clientY: 26 });
  fireEvent.click(handle(), { detail: 1 });
  expect(onReorder).not.toHaveBeenCalled();
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(handle(), { detail: 0 });
  expect(onClick).toHaveBeenCalledOnce();
});

it.each([
  { button: 2, isPrimary: true, pointerType: 'mouse' },
  { button: 0, isPrimary: false, pointerType: 'touch' },
  { button: 0, isPrimary: true, pointerType: 'unknown' },
])('ignores unsupported initiation %j', (options) => {
  const { handle, list, onReorder, setPointerCapture } = setup();
  pointer(handle(), 'pointerdown', options);
  pointer(handle(), 'pointermove', { ...options, clientY: 100 });
  pointer(handle(), 'pointerup', { ...options, clientY: 100 });
  expect(setPointerCapture).not.toHaveBeenCalled();
  expect(list).toHaveAttribute('data-dragged-id', '');
  expect(onReorder).not.toHaveBeenCalled();
});

it('ignores other pointers during a captured gesture', () => {
  const { handle, list, onReorder, setPointerCapture } = setup();
  pointer(handle(), 'pointerdown');
  pointer(handle('b'), 'pointerdown', { pointerId: 8, clientY: 60 });
  pointer(handle(), 'pointermove', { pointerId: 8, clientY: 100 });
  pointer(handle(), 'pointercancel', { pointerId: 8 });
  pointer(handle(), 'pointerup', { pointerId: 8, clientY: 100 });
  expect(list).toHaveAttribute('data-dragged-id', '');
  expect(onReorder).not.toHaveBeenCalled();
  expect(setPointerCapture).toHaveBeenCalledOnce();
  pointer(handle(), 'pointermove', { clientY: 100 });
  pointer(handle(), 'pointerup', { clientY: 100 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a']);
});

it.each(['pointercancel', 'lostpointercapture', 'blur', 'Escape', 'released buttons'])(
  'cancels without saving on %s',
  (reason) => {
    const { handle, list, onReorder, releasePointerCapture } = setup();
    pointer(handle(), 'pointerdown');
    pointer(handle(), 'pointermove', { clientY: 100 });
    if (reason === 'blur') fireEvent(window, new Event('blur'));
    else if (reason === 'Escape') {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      fireEvent(handle(), event);
      expect(event.defaultPrevented).toBe(true);
    } else if (reason === 'released buttons')
      pointer(handle(), 'pointermove', { clientY: 100, buttons: 0 });
    else pointer(handle(), reason, { clientY: 100 });
    expect(list).toHaveAttribute('data-dragged-id', '');
    expect(list).toHaveAttribute('data-target-id', '');
    expect(list).toHaveAttribute('data-drop-position', '');
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    pointer(handle(), 'pointerup', { clientY: 100 });
    expect(onReorder).not.toHaveBeenCalled();
  },
);

it('cancels when disabled and ignores further pointer and keyboard input', () => {
  const { handle, list, onReorder, rerenderList } = setup();
  pointer(handle(), 'pointerdown');
  pointer(handle(), 'pointermove', { clientY: 100 });
  rerenderList({ disabled: true });
  expect(list).toHaveAttribute('data-dragged-id', '');
  pointer(handle(), 'pointerup', { clientY: 100 });
  pointer(handle(), 'pointerdown');
  pointer(handle(), 'pointermove', { clientY: 100 });
  pointer(handle(), 'pointerup', { clientY: 100 });
  fireEvent.keyDown(handle(), { key: 'End' });
  expect(onReorder).not.toHaveBeenCalled();
});

it.each([
  ['a', 'c'],
  ['b', 'a', 'c'],
])('cancels when the IDs or their order change (%j)', (...ids) => {
  const { handle, list, onReorder, rerenderList } = setup();
  pointer(handle(), 'pointerdown');
  pointer(handle(), 'pointermove', { clientY: 100 });
  rerenderList({ ids });
  expect(list).toHaveAttribute('data-dragged-id', '');
  pointer(handle(), 'pointerup', { clientY: 100 });
  expect(onReorder).not.toHaveBeenCalled();
});

it('continues when a render recreates the same ID array', () => {
  const { handle, list, onReorder, rerenderList } = setup();
  pointer(handle(), 'pointerdown');
  pointer(handle(), 'pointermove', { clientY: 100 });
  rerenderList({ ids: ['a', 'b', 'c'] });
  expect(list).toHaveAttribute('data-dragged-id', 'a');
  pointer(handle(), 'pointerup', { clientY: 100 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a']);
});

it.each([
  { id: 'b', key: 'ArrowUp', expected: ['b', 'a', 'c'] },
  { id: 'b', key: 'ArrowDown', expected: ['a', 'c', 'b'] },
  { id: 'c', key: 'Home', expected: ['c', 'a', 'b'] },
  { id: 'a', key: 'End', expected: ['b', 'c', 'a'] },
])('reorders $id with $key and preserves handle focus', ({ id, key, expected }) => {
  const { handle, onReorder } = setup();
  handle(id).focus();
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  fireEvent(handle(id), event);
  expect(event.defaultPrevented).toBe(true);
  expect(onReorder).toHaveBeenCalledExactlyOnceWith(expected);
  expect(handle(id)).toHaveFocus();
});

it('does not save keyboard boundary moves, ordinary keys, or modified shortcuts', () => {
  const { handle, onReorder } = setup();
  fireEvent.keyDown(handle(), { key: 'ArrowUp' });
  fireEvent.keyDown(handle(), { key: 'Home' });
  fireEvent.keyDown(handle('c'), { key: 'ArrowDown' });
  fireEvent.keyDown(handle('c'), { key: 'End' });
  fireEvent.keyDown(handle(), { key: 'Enter' });
  fireEvent.keyDown(handle(), { key: 'End', ctrlKey: true });
  fireEvent.keyDown(handle(), { key: 'ArrowDown', altKey: true });
  expect(onReorder).not.toHaveBeenCalled();
});

it('scrolls the closest overflowing container and updates the target beneath a stationary pointer', () => {
  const animation = frames();
  const { handle, list, scroller, onReorder } = setup({
    ids: ['a', 'b', 'c', 'd', 'e'],
    scrolling: true,
  });
  scroller.style.scrollBehavior = 'smooth';
  pointer(handle('b'), 'pointerdown', { clientY: 60 });
  pointer(handle('b'), 'pointermove', { clientY: 115 });
  expect(list).toHaveAttribute('data-target-id', 'c');
  expect(scroller.style.scrollBehavior).toBe('auto');
  animation.step();
  animation.step();
  expect(scroller.scrollTop).toBe(28);
  expect(list).toHaveAttribute('data-target-id', 'd');
  expect(onReorder).not.toHaveBeenCalled();
  pointer(handle('b'), 'pointerup', { clientY: 115 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith(['a', 'c', 'd', 'b', 'e']);
  expect(scroller.style.scrollBehavior).toBe('smooth');
  expect(animation.callbacks.size).toBe(0);
});

it('clamps edge scrolling and cancels pending animation on unmount without saving', () => {
  const animation = frames();
  const { handle, scroller, onReorder, releasePointerCapture, unmount } = setup({
    ids: ['a', 'b', 'c', 'd', 'e'],
    scrolling: true,
  });
  scroller.scrollTop = 10;
  scroller.style.scrollBehavior = 'smooth';
  pointer(handle('b'), 'pointerdown', { clientY: 50 });
  pointer(handle('b'), 'pointermove', { clientY: -10 });
  animation.step();
  expect(scroller.scrollTop).toBe(0);
  animation.step();
  expect(animation.callbacks.size).toBe(0);
  pointer(handle('b'), 'pointermove', { clientY: 130 });
  expect(animation.callbacks.size).toBe(1);
  unmount();
  expect(animation.callbacks.size).toBe(0);
  expect(scroller.style.scrollBehavior).toBe('smooth');
  expect(releasePointerCapture).toHaveBeenCalledWith(7);
  expect(onReorder).not.toHaveBeenCalled();
});

it('scrolls the list itself before an overflowing ancestor and keeps the insertion boundary aligned', () => {
  const animation = frames();
  const { handle, list, scroller, onReorder } = setup({
    ids: ['a', 'b', 'c', 'd', 'e'],
    scrolling: true,
  });
  list.style.overflowY = 'auto';
  list.style.scrollBehavior = 'smooth';
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 120 },
    scrollHeight: { configurable: true, value: 200 },
  });
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(0, 120) as DOMRect);
  [...list.children].forEach((row, index) => {
    vi.mocked(row.getBoundingClientRect).mockImplementation(
      () => rect(index * 40 - list.scrollTop, 40) as DOMRect,
    );
  });
  pointer(handle('b'), 'pointerdown', { clientY: 60 });
  pointer(handle('b'), 'pointermove', { clientY: 115 });
  expect(list).toHaveAttribute('data-target-id', 'c');
  expect(list).toHaveAttribute('data-drop-position', 'after');
  animation.step();
  animation.step();
  expect(list.scrollTop).toBe(28);
  expect(scroller.scrollTop).toBe(0);
  expect(list).toHaveAttribute('data-target-id', 'd');
  expect(list).toHaveAttribute('data-drop-position', 'after');
  pointer(handle('b'), 'pointerup', { clientY: 115 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith(['a', 'c', 'd', 'b', 'e']);
  expect(list.style.scrollBehavior).toBe('smooth');
  expect(animation.callbacks.size).toBe(0);
});
