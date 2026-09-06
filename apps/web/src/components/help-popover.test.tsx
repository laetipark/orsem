import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HelpPopover } from './help-popover';

const initialWidth = window.innerWidth;
const initialShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const initialClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth });
  for (const [name, descriptor] of [
    ['showModal', initialShowModal],
    ['close', initialClose],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

function show() {
  return render(
    <HelpPopover label="날짜 기준 도움말">
      <p>공시일과 실제 거래일은 다를 수 있습니다.</p>
      <a href="https://example.com/source">출처 안내</a>
    </HelpPopover>,
  );
}

it('keeps copy hidden until tapped and restores focus when closed', async () => {
  const user = userEvent.setup();
  show();
  const trigger = screen.getByRole('button', { name: '날짜 기준 도움말' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('공시일과 실제 거래일은 다를 수 있습니다.')).toBeNull();
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '날짜 기준 도움말' });
  expect(dialog).toBeVisible();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(trigger).toHaveAttribute('aria-controls', dialog.id);
  await user.click(screen.getByRole('button', { name: '도움말 닫기' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
});

it.each(['{Enter}', ' '])('opens with %s and closes with Escape', async (key) => {
  const user = userEvent.setup();
  show();
  const trigger = screen.getByRole('button', { name: '날짜 기준 도움말' });
  trigger.focus();
  await user.keyboard(key);
  expect(screen.getByRole('dialog')).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
});

it('supports focusable help links and returns focus after an outside pointer press', async () => {
  const user = userEvent.setup();
  show();
  const trigger = screen.getByRole('button', { name: '날짜 기준 도움말' });
  await user.click(trigger);
  const close = screen.getByRole('button', { name: '도움말 닫기' });
  expect(close).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('link', { name: '출처 안내' })).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
});

it('uses the native modal when available and handles its cancel event', async () => {
  const modal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  const close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: modal,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: close,
  });
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole('button', { name: '날짜 기준 도움말' }));
  expect(modal).toHaveBeenCalledOnce();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});

it('clamps the panel to the mobile viewport beside a right-edge trigger', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
  vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 288,
    y: 50,
    width: 32,
    height: 44,
    top: 50,
    right: 320,
    bottom: 94,
    left: 288,
    toJSON: () => ({}),
  });
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole('button', { name: '날짜 기준 도움말' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveStyle({ left: '12px', width: '296px' });
});
