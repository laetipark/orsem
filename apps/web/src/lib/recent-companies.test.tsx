import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordRecentCompany, useRecentCompanies } from './recent-companies';

const company = (id: string) => ({
  id,
  nameKo: `종목 ${id}`,
  nameEn: null,
  market: 'KRX',
  stockCode: '005930',
  ticker: null,
  canonicalPath: `/companies/${id}`,
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('keeps twenty deduplicated visits in newest-first order without mixing accounts', () => {
  const hook = renderHook(() => useRecentCompanies('MEMBER:history'));
  act(() => {
    for (let index = 0; index < 22; index++)
      recordRecentCompany('MEMBER:history', company(String(index)));
    recordRecentCompany('ADMIN:history', company('admin-only'));
    recordRecentCompany('MEMBER:history', company('5'));
  });
  expect(hook.result.current).toHaveLength(20);
  expect(hook.result.current.slice(0, 3).map((item) => item.id)).toEqual(['5', '21', '20']);
  expect(hook.result.current.some((item) => ['0', '1', 'admin-only'].includes(item.id))).toBe(
    false,
  );
  expect(hook.result.current[0]?.canonicalPath).toBe('/companies/5');
});

it('updates subscribers in this page and another tab, including clearing history', () => {
  const actor = 'MEMBER:tabs';
  const first = renderHook(() => useRecentCompanies(actor));
  const second = renderHook(() => useRecentCompanies(actor));
  act(() => recordRecentCompany(actor, company('one')));
  expect(first.result.current).toBe(second.result.current);
  const key = `orsem-recent-companies-v1:${actor}`;
  act(() => {
    localStorage.setItem(
      key,
      JSON.stringify([{ ...company('two'), viewedAt: new Date().toISOString() }]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
  expect(first.result.current[0]?.id).toBe('two');
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(first.result.current).toEqual([]);
});

it('ignores malformed storage and never records without an actor', () => {
  localStorage.setItem('orsem-recent-companies-v1:MEMBER:invalid', '{broken');
  const hook = renderHook(() => useRecentCompanies('MEMBER:invalid'));
  expect(hook.result.current).toEqual([]);
  act(() => recordRecentCompany('', company('private')));
  expect(localStorage.getItem('orsem-recent-companies-v1:')).toBeNull();
});

it('retains visits when only writing storage fails and honors a later storage clear', () => {
  const actor = 'MEMBER:quota';
  const hook = renderHook(() => useRecentCompanies(actor));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded');
  });
  act(() => recordRecentCompany(actor, company('one')));
  act(() => recordRecentCompany(actor, company('two')));
  expect(hook.result.current.map((item) => item.id)).toEqual(['two', 'one']);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
  expect(hook.result.current).toEqual([]);
});

it('switches actors without showing the previous account history', () => {
  recordRecentCompany('MEMBER:first', company('one'));
  recordRecentCompany('MEMBER:second', company('two'));
  const hook = renderHook(({ actor }) => useRecentCompanies(actor), {
    initialProps: { actor: 'MEMBER:first' },
  });
  expect(hook.result.current[0]?.id).toBe('one');
  hook.rerender({ actor: 'MEMBER:second' });
  expect(hook.result.current.map((item) => item.id)).toEqual(['two']);
});
