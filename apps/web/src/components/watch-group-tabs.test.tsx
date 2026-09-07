import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WatchGroupTabs } from './watch-group-tabs';

const tabs = [
  { id: 'recent', name: '최근조회', itemCount: 20 },
  { id: 'tech', name: '기술주', itemCount: 6 },
  { id: 'value', name: '가치주', itemCount: 3 },
];

function Selection({ onSelect = () => undefined }: { onSelect?: (id: string) => void }) {
  const [selected, select] = useState('recent');
  return (
    <WatchGroupTabs
      tabs={tabs}
      selected={selected}
      panelId="stock-panel"
      onSelect={(id) => {
        select(id);
        onSelect(id);
      }}
    />
  );
}

function dimensions(list: HTMLElement, clientWidth: number, scrollWidth: number) {
  Object.defineProperties(list, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
}

function rect(left: number, right: number): DOMRect {
  return {
    x: left,
    y: 10,
    left,
    right,
    top: 10,
    bottom: 40,
    width: right - left,
    height: 30,
    toJSON: () => ({ left, right }),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('keeps recent first and moves selection and focus with arrow keys, Home and End', async () => {
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(<Selection onSelect={onSelect} />);
  const [recent, tech, value] = screen.getAllByRole('tab');
  expect(recent).toHaveAccessibleName('최근조회 20');
  expect(recent).toHaveAttribute('aria-controls', 'stock-panel');
  expect(recent).toHaveAttribute('tabindex', '0');
  expect(tech).toHaveAttribute('tabindex', '-1');
  await user.click(recent!);
  await user.keyboard('{ArrowRight}');
  expect(tech).toHaveFocus();
  expect(tech).toHaveAttribute('aria-selected', 'true');
  expect(tech).toHaveAttribute('tabindex', '0');
  expect(recent).toHaveAttribute('tabindex', '-1');
  await user.keyboard('{End}');
  expect(value).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(recent).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(value).toHaveFocus();
  await user.keyboard('{Home}');
  expect(recent).toHaveFocus();
  expect(onSelect.mock.calls.map(([id]) => id)).toEqual([
    'recent',
    'tech',
    'value',
    'recent',
    'value',
    'recent',
  ]);
  const event = new KeyboardEvent('keydown', {
    key: 'ArrowRight',
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    recent!.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(tech).toHaveFocus();
});

it('disables overflow arrows at each edge and moves only the horizontal list when clicked', () => {
  render(<Selection />);
  const list = screen.getByRole('tablist', { name: '관심 종목 그룹 선택' });
  dimensions(list, 300, 900);
  const pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const scrollBy = vi.fn((options: ScrollToOptions) => {
    list.scrollLeft = Math.min(600, Math.max(0, list.scrollLeft + (options.left ?? 0)));
    fireEvent.scroll(list);
  });
  Object.defineProperty(list, 'scrollBy', { configurable: true, value: scrollBy });
  fireEvent(window, new Event('resize'));
  const previous = screen.getByRole('button', { name: '이전 관심 그룹 보기' });
  const next = screen.getByRole('button', { name: '다음 관심 그룹 보기' });
  expect(previous).toBeDisabled();
  expect(next).toBeEnabled();
  fireEvent.click(next);
  expect(list.scrollLeft).toBeGreaterThan(0);
  expect(previous).toBeEnabled();
  expect(scrollBy.mock.calls[0]?.[0]).toMatchObject({
    left: expect.any(Number),
    behavior: 'smooth',
  });
  expect(scrollBy.mock.calls[0]?.[0].top).toBeUndefined();
  fireEvent.click(next);
  fireEvent.click(next);
  expect(list.scrollLeft).toBe(600);
  expect(next).toBeDisabled();
  fireEvent.click(previous);
  expect(next).toBeEnabled();
  expect(list.scrollLeft).toBeLessThan(600);
  expect(pageScroll).not.toHaveBeenCalled();
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('최근조회');
});

it('removes overflow controls after the available width grows to fit all tabs', () => {
  render(<Selection />);
  const list = screen.getByRole('tablist');
  dimensions(list, 180, 600);
  fireEvent(window, new Event('resize'));
  expect(screen.getByRole('button', { name: '다음 관심 그룹 보기' })).toBeEnabled();
  expect(list.parentElement).toHaveAttribute('data-overflow', 'true');
  dimensions(list, 700, 600);
  fireEvent(window, new Event('resize'));
  expect(screen.getByRole('button', { name: '다음 관심 그룹 보기' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '이전 관심 그룹 보기' })).toBeDisabled();
  expect(list.parentElement).toHaveAttribute('data-overflow', 'false');
});

it('reveals a selected offscreen group by scrolling the tab list without scrolling the page', () => {
  render(<Selection />);
  const list = screen.getByRole('tablist');
  dimensions(list, 300, 900);
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(100, 400));
  const value = screen.getByRole('tab', { name: '가치주 3' });
  vi.spyOn(value, 'getBoundingClientRect').mockReturnValue(rect(760, 850));
  const scrollTo = vi.fn();
  Object.defineProperty(list, 'scrollTo', { configurable: true, value: scrollTo });
  const pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  fireEvent.click(value);
  expect(value).toHaveAttribute('aria-selected', 'true');
  expect(scrollTo).toHaveBeenCalledWith({ left: 450, behavior: 'smooth' });
  expect(pageScroll).not.toHaveBeenCalled();
});
