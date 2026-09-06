import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchItem, SearchResults } from '../types';
import { HeaderSearch } from './search-autocomplete';

const mocks = vi.hoisted(() => ({ suggestions: vi.fn() }));
vi.mock('../lib/api', () => ({ api: mocks }));

function company(id = 'company-1', title = '삼성전자'): SearchItem {
  return {
    id,
    type: 'COMPANY',
    title,
    subtitle: 'KOSPI · 005930 · Samsung Electronics',
    url: `/companies/${id}`,
    external: false,
    companyId: id,
    source: null,
    rightsMode: null,
    publishedAt: null,
    rceptDate: null,
    firstObservedAt: null,
  };
}

function news(id = 'news-1', title = '삼성전자 신제품 발표'): SearchItem {
  return {
    ...company(id),
    type: 'NEWS',
    title: 'Original English headline',
    subtitle: 'Original source metadata',
    url: `/news/article-${id}`,
    source: 'NEWS_RSS',
    translation: {
      language: 'ko',
      title,
      description: '번역된 요약입니다.',
      translatedAt: '2026-09-05T00:00:00Z',
      provider: 'LOCAL',
      model: 'local',
    },
  };
}

function results(overrides: Partial<SearchResults> = {}): SearchResults {
  return {
    query: '삼성',
    companies: [company()],
    news: [news()],
    filings: [{ ...company('filing'), type: 'FILING', title: '공시 원문 제목' }],
    hasMore: { companies: false, news: false, filings: false },
    ...overrides,
  };
}

function LocationControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="location">{location.pathname + location.search}</div>
      <button onClick={() => void navigate('/markets?region=kr')}>국내 화면 이동</button>
      <input aria-label="다른 입력" />
    </>
  );
}

function show(path = '/markets?region=us') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HeaderSearch />
      <LocationControls />
    </MemoryRouter>,
  );
}

function type(value: string) {
  const input = screen.getByRole<HTMLInputElement>('combobox');
  act(() => input.focus());
  fireEvent.change(input, { target: { value } });
  return input;
}

async function waitForDebounce(ms = 250) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.suggestions.mockReset();
  mocks.suggestions.mockResolvedValue(results());
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HeaderSearch', () => {
  it('debounces typing and carries the existing region and cancellation signal', async () => {
    show();
    const input = type('S');
    await waitForDebounce(100);
    fireEvent.change(input, { target: { value: 'Sam' } });
    await waitForDebounce(100);
    fireEvent.change(input, { target: { value: ' Samsung ' } });
    await waitForDebounce(249);
    expect(mocks.suggestions).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('검색 중입니다.');
    await waitForDebounce(1);
    expect(mocks.suggestions).toHaveBeenCalledExactlyOnceWith(
      'Samsung',
      { region: 'us' },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'false');
  });

  it('shows separate bounded company/news groups and only translated news copy', async () => {
    mocks.suggestions.mockResolvedValue(
      results({
        companies: Array.from({ length: 7 }, (_, i) => company(`company-${i}`, `종목 ${i}`)),
        news: Array.from({ length: 7 }, (_, i) => news(`news-${i}`, `번역 뉴스 ${i}`)),
      }),
    );
    show();
    type('삼성');
    await waitForDebounce();
    expect(
      within(screen.getByRole('group', { name: '종목 5' })).getAllByRole('option'),
    ).toHaveLength(5);
    expect(
      within(screen.getByRole('group', { name: '뉴스 5' })).getAllByRole('option'),
    ).toHaveLength(5);
    expect(screen.queryByText('Original English headline')).not.toBeInTheDocument();
    expect(screen.queryByText('Original source metadata')).not.toBeInTheDocument();
    expect(screen.queryByText('공시 원문 제목')).not.toBeInTheDocument();
    expect(screen.getAllByText('번역된 요약입니다.')).toHaveLength(5);
    expect(screen.queryByText('번역 뉴스 5')).not.toBeInTheDocument();
  });

  it('preserves original headlines and permits safe external news while rejecting unsafe URLs', async () => {
    const noSummary = news('no-summary');
    noSummary.translation!.description = null;
    const english = { ...news('english'), translation: null };
    const korean = { ...news('korean'), title: '한국어 원문 뉴스', translation: null };
    const external = {
      ...news('external', '외부 링크 뉴스'),
      external: true,
      url: 'https://example.test',
    };
    mocks.suggestions.mockResolvedValue(
      results({
        news: [
          noSummary,
          english,
          korean,
          external,
          { ...news('unsafe'), url: 'javascript:alert(1)' },
        ],
      }),
    );
    show();
    type('삼성');
    await waitForDebounce();
    expect(screen.getByText('삼성전자 신제품 발표')).toBeVisible();
    expect(screen.getByText('한국어 원문 뉴스')).toBeVisible();
    expect(screen.getAllByText('번역된 요약입니다.')).toHaveLength(1);
    expect(screen.getByText('Original English headline')).toBeVisible();
    expect(screen.queryByText('Original source metadata')).not.toBeInTheDocument();
    expect(screen.getByText('외부 링크 뉴스')).toBeVisible();
  });

  it('prevents composing requests and Enter, then searches the committed Korean input', async () => {
    show();
    const input = screen.getByRole<HTMLInputElement>('combobox');
    act(() => input.focus());
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '삼' } });
    await waitForDebounce(500);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.submit(screen.getByRole('search'));
    expect(mocks.suggestions).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/markets?region=us');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/markets?region=us');
    await waitForDebounce();
    expect(mocks.suggestions).toHaveBeenCalledExactlyOnceWith(
      '삼성',
      { region: 'us' },
      expect.any(AbortSignal),
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/search?${new URLSearchParams({ q: '삼성', region: 'us' })}`,
    );
  });

  it('aborts superseded requests and ignores stale results even when the server still resolves', async () => {
    const first = deferred<SearchResults>();
    const second = deferred<SearchResults>();
    mocks.suggestions.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    show();
    const input = type('first');
    await waitForDebounce();
    const signal = mocks.suggestions.mock.calls[0]![2] as AbortSignal;
    fireEvent.change(input, { target: { value: 'second' } });
    expect(signal.aborted).toBe(true);
    await waitForDebounce();
    await act(async () =>
      second.resolve(results({ companies: [company('second', '새 결과')], news: [] })),
    );
    await act(async () =>
      first.resolve(results({ companies: [company('first', '오래된 결과')], news: [] })),
    );
    expect(screen.getByText('새 결과')).toBeVisible();
    expect(screen.queryByText('오래된 결과')).not.toBeInTheDocument();
  });

  it('restarts debounce for whitespace changes without leaving the panel loading forever', async () => {
    show();
    const input = type('Samsung');
    await waitForDebounce();
    fireEvent.change(input, { target: { value: ' Samsung ' } });
    await waitForDebounce();
    expect(screen.getByText('삼성전자')).toBeVisible();
    expect(mocks.suggestions).toHaveBeenLastCalledWith(
      'Samsung',
      { region: 'us' },
      expect.any(AbortSignal),
    );
  });

  it('moves across groups with arrow keys and opens the selected existing news URL', async () => {
    show();
    const input = type('삼성');
    await waitForDebounce();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: /삼성전자 KOSPI/ }).id,
    );
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const selected = screen.getByRole('option', { selected: true });
    expect(selected).toHaveTextContent('삼성전자 신제품 발표');
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/news/article-news-1');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('wraps ArrowUp to the last suggestion and opens a clicked company', async () => {
    show();
    const input = type('삼성');
    await waitForDebounce();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent(
      '삼성전자 신제품 발표',
    );
    fireEvent.click(screen.getByRole('option', { name: /삼성전자 KOSPI/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/companies/company-1');
  });

  it('uses Enter for all results when no option is selected and preserves the region', () => {
    show('/news?region=kr');
    const input = type('  005930  ');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/search?q=005930&region=kr');
    expect(input).toHaveValue('005930');
  });

  it('keeps the full-search button independent of the highlighted suggestion', async () => {
    show('/news?region=unknown');
    const input = type('삼성');
    await waitForDebounce();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: '‘삼성’ 검색' }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/search?${new URLSearchParams({ q: '삼성' })}`,
    );
  });

  it('closes and aborts on Escape, outside pointer, clearing and unmount', async () => {
    mocks.suggestions.mockImplementation(() => new Promise(() => undefined));
    const { unmount } = show();
    const input = type('삼성');
    await waitForDebounce();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((mocks.suggestions.mock.calls[0]![2] as AbortSignal).aborted).toBe(true);
    expect(input).toHaveValue('삼성');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(input);
    await waitForDebounce();
    fireEvent.pointerDown(screen.getByLabelText('다른 입력'));
    expect((mocks.suggestions.mock.calls[1]![2] as AbortSignal).aborted).toBe(true);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(input);
    await waitForDebounce();
    fireEvent.change(input, { target: { value: ' ' } });
    expect((mocks.suggestions.mock.calls[2]![2] as AbortSignal).aborted).toBe(true);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '삼성' } });
    await waitForDebounce();
    unmount();
    expect((mocks.suggestions.mock.calls[3]![2] as AbortSignal).aborted).toBe(true);
  });

  it('closes on route changes and queries the newly selected region on reopening', async () => {
    show();
    const input = type('삼성');
    await waitForDebounce();
    fireEvent.click(screen.getByRole('button', { name: '국내 화면 이동' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(input);
    await waitForDebounce();
    expect(mocks.suggestions).toHaveBeenLastCalledWith(
      '삼성',
      { region: 'kr' },
      expect.any(AbortSignal),
    );
  });

  it('shows empty and error states while keeping whole-search available', async () => {
    mocks.suggestions
      .mockResolvedValueOnce(results({ companies: [], news: [] }))
      .mockRejectedValueOnce(new Error('private server detail'));
    show();
    const input = type('없는 결과');
    await waitForDebounce();
    expect(screen.getByText('일치하는 검색 후보가 없습니다.')).toBeVisible();
    fireEvent.change(input, { target: { value: '실패' } });
    await waitForDebounce();
    expect(screen.getByRole('status')).toHaveTextContent('검색 후보를 불러오지 못했습니다.');
    expect(screen.queryByText('private server detail')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/search?${new URLSearchParams({ q: '실패', region: 'us' })}`,
    );
  });

  it('preserves slash focus, avoids typing targets, and closes when focus leaves the form', async () => {
    show();
    fireEvent.keyDown(window, { key: '/' });
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();
    type('삼성');
    await waitForDebounce();
    const outside = screen.getByLabelText('다른 입력');
    act(() => outside.focus());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(outside, { key: '/' });
    expect(outside).toHaveFocus();
  });
});
