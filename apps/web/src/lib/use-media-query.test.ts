import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mockMediaQuery } from '../test/media-query';
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from './use-media-query';

afterEach(() => vi.restoreAllMocks());

it('tracks breakpoint changes, keeps one subscription and releases it on unmount', () => {
  const { resize, media, listenerCount } = mockMediaQuery(true);
  const { result, rerender, unmount } = renderHook(() => useMediaQuery(COMPACT_LAYOUT_QUERY));
  expect(result.current).toBe(true);
  expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 900px)');
  act(() => resize(false));
  expect(result.current).toBe(false);
  rerender();
  expect(media.addEventListener).toHaveBeenCalledTimes(1);
  expect(listenerCount()).toBe(1);
  unmount();
  expect(media.removeEventListener).toHaveBeenCalledTimes(1);
  expect(listenerCount()).toBe(0);
});
