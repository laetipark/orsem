import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStockContentPreference } from './stock-content-preference';

const keyFor = (actor: string) => `orsem-stock-content-v1:${actor}`;

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('defaults to stocks, shares a choice on this page and restores it after remounting', () => {
  const actor = 'MEMBER:preference-persist';
  const first = renderHook(() => useStockContentPreference(actor));
  const second = renderHook(() => useStockContentPreference(actor));
  expect(first.result.current.content).toBe('stocks');
  act(() => first.result.current.save('news'));
  expect(second.result.current.content).toBe('news');
  expect(localStorage.getItem(keyFor(actor))).toBe('news');
  first.unmount();
  second.unmount();
  const restored = renderHook(() => useStockContentPreference(actor));
  expect(restored.result.current.content).toBe('news');
  act(() => restored.result.current.save('stocks'));
  expect(localStorage.getItem(keyFor(actor))).toBe('stocks');
});

it('keeps actor roles and accounts separate, including an account switch in one mounted view', () => {
  const member = 'MEMBER:preference-account';
  const admin = 'ADMIN:preference-account';
  localStorage.setItem(keyFor(member), 'news');
  const hook = renderHook(({ actor }) => useStockContentPreference(actor), {
    initialProps: { actor: member },
  });
  expect(hook.result.current.content).toBe('news');
  hook.rerender({ actor: admin });
  expect(hook.result.current.content).toBe('stocks');
  act(() => hook.result.current.save('news'));
  hook.rerender({ actor: 'MEMBER:another-preference-account' });
  expect(hook.result.current.content).toBe('stocks');
  hook.rerender({ actor: member });
  expect(hook.result.current.content).toBe('news');
  act(() => hook.result.current.save('stocks'));
  expect(localStorage.getItem(keyFor(admin))).toBe('news');
});

it('accepts another tab’s preference changes and returns to stocks after that tab clears storage', () => {
  const actor = 'MEMBER:preference-cross-tab';
  const hook = renderHook(() => useStockContentPreference(actor));
  act(() => {
    localStorage.setItem(keyFor(actor), 'news');
    window.dispatchEvent(new StorageEvent('storage', { key: keyFor(actor), newValue: 'news' }));
  });
  expect(hook.result.current.content).toBe('news');
  act(() => {
    localStorage.setItem(keyFor('ADMIN:other-tab'), 'stocks');
    window.dispatchEvent(new StorageEvent('storage', { key: keyFor('ADMIN:other-tab') }));
  });
  expect(hook.result.current.content).toBe('news');
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(hook.result.current.content).toBe('stocks');
});

it('retains a usable in-memory choice when reads and writes throw, then honors a storage clear', () => {
  const actor = 'MEMBER:preference-storage-error';
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Storage is unavailable', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage is unavailable', 'QuotaExceededError');
  });
  const first = renderHook(() => useStockContentPreference(actor));
  const second = renderHook(() => useStockContentPreference(actor));
  expect(first.result.current.content).toBe('stocks');
  act(() => first.result.current.save('news'));
  expect(first.result.current.content).toBe('news');
  expect(second.result.current.content).toBe('news');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
  expect(first.result.current.content).toBe('stocks');
  expect(second.result.current.content).toBe('stocks');
});

it('ignores invalid saved values and refuses to persist an anonymous preference', () => {
  localStorage.setItem(keyFor('MEMBER:preference-invalid'), 'unsupported');
  const invalid = renderHook(() => useStockContentPreference('MEMBER:preference-invalid'));
  expect(invalid.result.current.content).toBe('stocks');
  const anonymous = renderHook(() => useStockContentPreference(''));
  const save = vi.spyOn(Storage.prototype, 'setItem');
  act(() => anonymous.result.current.save('news'));
  expect(anonymous.result.current.content).toBe('stocks');
  expect(save).not.toHaveBeenCalled();
});
