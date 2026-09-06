import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import type { NaverNewsStatus } from '../types';
import { CompanyNaverNews, naverBudgetAvailable } from './company-naver-news';

const available: NaverNewsStatus = {
  configured: true,
  automaticAllowed: true,
  mode: 'ON_DEMAND',
  freeUntil: '2026-09-30T00:00:00Z',
  dailyLimit: 100,
  monthlyLimit: 2000,
  remainingToday: 100,
  remainingMonth: 2000,
  reason: null,
};
const result = {
  provider: 'NAVER' as const,
  total: 40,
  start: 1,
  display: 20,
  lastBuildDate: '',
  items: [
    {
      title: '삼성전자 <b>새 소식</b>',
      description: '&lt;img src=x onerror=alert(1)&gt;',
      originallink: 'https://publisher.example/news',
      link: 'https://naver.example/news',
      pubDate: '2026-09-05T10:00:00Z',
    },
  ],
};
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, 'naverNewsStatus').mockResolvedValue(available);
  vi.spyOn(api, 'naverNewsSearch').mockResolvedValue(result);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function show() {
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CompanyNaverNews key="samsung" companyId="samsung" companyName="삼성전자" />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

it('searches once for a visible company entry, keeps provider output safe and caches no result', async () => {
  const { container, unmount } = show();
  await screen.findByText('새 소식');
  expect(api.naverNewsSearch).toHaveBeenCalledTimes(1);
  expect(api.naverNewsSearch).toHaveBeenCalledWith(
    '삼성전자',
    1,
    'date',
    expect.any(AbortSignal),
    true,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  expect(
    client
      .getQueryCache()
      .getAll()
      .some((query) => query.state.data === result),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  await waitFor(() =>
    expect(api.naverNewsSearch).toHaveBeenLastCalledWith(
      '삼성전자',
      21,
      'date',
      expect.any(AbortSignal),
      false,
    ),
  );
  unmount();
  show();
  await waitFor(() => expect(api.naverNewsSearch).toHaveBeenCalledTimes(3));
});

it('blocks both automatic and manual queries when the free allowance is unknown', async () => {
  vi.mocked(api.naverNewsStatus).mockResolvedValue({
    ...available,
    automaticAllowed: false,
    freeUntil: null,
    remainingToday: null,
    remainingMonth: null,
    reason: '이번 달 무료 이용 조건과 호출 가능량 확인이 필요합니다.',
  });
  show();
  await screen.findByText('이번 달 무료 이용 조건과 호출 가능량 확인이 필요합니다.');
  expect(api.naverNewsSearch).not.toHaveBeenCalled();
  expect(screen.getByLabelText('보는 동안 1분마다 새로고침')).toBeDisabled();
  expect(screen.getByRole('button', { name: '검색 새로고침' })).toBeDisabled();
});

it('rechecks the budget before sending a query and stops when the last allowance is consumed elsewhere', async () => {
  vi.mocked(api.naverNewsStatus)
    .mockResolvedValueOnce(available)
    .mockResolvedValue({
      ...available,
      remainingToday: 0,
      automaticAllowed: false,
      reason: '오늘 검색 한도를 사용했습니다.',
    });
  show();
  await screen.findAllByText('오늘 검색 한도를 사용했습니다.');
  expect(api.naverNewsSearch).not.toHaveBeenCalled();
  expect(naverBudgetAvailable({ ...available, remainingMonth: 0 })).toBe(false);
  expect(screen.getByRole('button', { name: '검색 새로고침' })).toBeDisabled();
});

it('waits until intersection is visible and does not repeat automatic search when scrolling back', async () => {
  let intersection: IntersectionObserverCallback = () => undefined;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersection = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  show();
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.naverNewsStatus).not.toHaveBeenCalled();
  expect(api.naverNewsSearch).not.toHaveBeenCalled();
  act(() =>
    intersection(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  await screen.findByText('새 소식');
  act(() =>
    intersection(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  act(() =>
    intersection(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.naverNewsSearch).toHaveBeenCalledTimes(1);
});

it('aborts a provider request when the company section unmounts', async () => {
  let requestSignal: AbortSignal | undefined;
  vi.mocked(api.naverNewsSearch).mockImplementation(async (_q, _start, _sort, signal) => {
    requestSignal = signal;
    return await new Promise(() => undefined);
  });
  const { unmount } = show();
  await waitFor(() => expect(requestSignal).toBeDefined());
  unmount();
  expect(requestSignal?.aborted).toBe(true);
});

it('only repeats at 60 seconds after opt-in and pauses when the browser tab is hidden', async () => {
  vi.useFakeTimers();
  try {
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(api.naverNewsSearch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.naverNewsSearch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('보는 동안 1분마다 새로고침'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.naverNewsSearch).toHaveBeenCalledTimes(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(api.naverNewsSearch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
