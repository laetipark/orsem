import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchInput } from './search-input';
import type { SearchResults } from '../types';
const mocks = vi.hoisted(() => ({ suggestions: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mocks }));
const result = {
  companies: [
    {
      id: 'samsung',
      title: '삼성전자',
      type: 'COMPANY',
      subtitle: '005930',
      url: '/companies/samsung',
      external: false,
    },
  ],
  news: [],
} as unknown as SearchResults;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
function Form({
  contextKey = 'a',
  onSubmit = () => undefined,
}: {
  contextKey?: string;
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <SearchInput
        value={value}
        onChange={setValue}
        filters={{ kind: 'companies' }}
        contextKey={contextKey}
        label="종목"
      />
      <button type="submit">검색</button>
    </form>
  );
}
it('waits for Korean composition and blocks the committing Enter', async () => {
  vi.useFakeTimers();
  mocks.suggestions.mockResolvedValue(result);
  const submit = vi.fn();
  render(<Form onSubmit={submit} />);
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '삼성' } });
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(mocks.suggestions).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByRole('option')).toHaveTextContent('삼성전자');
  expect(submit).not.toHaveBeenCalled();
});
it('refreshes whitespace edits, cancels late responses and isolates actor changes', async () => {
  vi.useFakeTimers();
  mocks.suggestions.mockResolvedValue(result);
  const { rerender } = render(<Form />);
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '삼성' } });
  await act(() => vi.advanceTimersByTimeAsync(300));
  const firstSignal = mocks.suggestions.mock.calls[0]![2] as AbortSignal;
  fireEvent.change(input, { target: { value: '삼성 ' } });
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(firstSignal.aborted).toBe(true);
  expect(mocks.suggestions).toHaveBeenCalledTimes(2);
  rerender(<Form contextKey="b" />);
  expect(screen.queryByRole('option')).toBeNull();
  fireEvent.click(input);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByRole('option')).toHaveTextContent('삼성전자');
});
it('selecting an internal company never submits an external search', async () => {
  vi.useFakeTimers();
  mocks.suggestions.mockResolvedValue(result);
  const submit = vi.fn();
  render(<Form onSubmit={submit} />);
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '삼성' } });
  await act(() => vi.advanceTimersByTimeAsync(300));
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(submit).not.toHaveBeenCalled();
  expect(input).toHaveValue('삼성전자');
});
