import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import type { Session } from '../types';
import { AppShell } from './app-shell';
import { GuestShell } from './guest-shell';

vi.mock('./stock-sidebar', () => ({ StockSidebar: () => null }));
vi.mock('./search-autocomplete', () => ({ HeaderSearch: () => null }));
vi.mock('../lib/news-cache', () => ({ useNewsCacheExpiry: () => undefined }));
vi.mock('../lib/api', () => ({ api: {}, isFixtureMode: false }));

const member: Session = {
  authenticated: true,
  canAccess: true,
  csrfToken: 'test',
  setupRequired: false,
  user: {
    id: 'member',
    email: null,
    displayName: '회원',
    provider: 'KAKAO',
    role: 'VIEWER',
    status: 'APPROVED',
    totpEnabled: false,
  },
};

function Page() {
  const navigate = useNavigate();
  return (
    <>
      <h2>화면 내용</h2>
      <button onClick={() => void navigate('?q=삼성')}>필터 변경</button>
      <button onClick={() => void navigate(-1)}>뒤로</button>
    </>
  );
}

function show(audience: 'member' | 'guest', path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={audience === 'member' ? <AppShell session={member} /> : <GuestShell />}>
              <Route path="*" element={<Page />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

beforeEach(() => {
  document.title = '오르셈 · 공시와 시장';
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['member', 'guest'] as const)(
  '%s navigation names the tab and focuses the new page while preserving filters and history',
  (audience) => {
    const { client, unmount } = show(audience, '/news/');
    expect(document.title).toBe('시장 뉴스 · 오르셈');
    const main = screen.getByRole('main');
    expect(main).not.toHaveFocus();
    expect(window.scrollTo).not.toHaveBeenCalled();

    const navigation = screen.getByRole('navigation', {
      name: audience === 'member' ? '주 메뉴' : '공개 메뉴',
    });
    const companyLink = within(navigation).getByRole('link', { name: '종목' });
    companyLink.focus();
    fireEvent.click(companyLink);
    expect(document.title).toBe('종목 탐색 · 오르셈');
    expect(main).toHaveFocus();
    expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: 0,
      left: 0,
      behavior: 'instant',
    });

    vi.mocked(window.scrollTo).mockClear();
    const filter = screen.getByRole('button', { name: '필터 변경' });
    filter.focus();
    fireEvent.click(filter);
    expect(filter).toHaveFocus();
    expect(window.scrollTo).not.toHaveBeenCalled();

    const back = screen.getByRole('button', { name: '뒤로' });
    back.focus();
    fireEvent.click(back);
    fireEvent.click(back);
    expect(document.title).toBe('시장 뉴스 · 오르셈');
    expect(back).toHaveFocus();
    expect(window.scrollTo).not.toHaveBeenCalled();

    unmount();
    expect(document.title).toBe('오르셈 · 공시와 시장');
    client.clear();
  },
);

it('reveals the current member menu item inside an overflowing navigation row', () => {
  const { client } = show('member');
  const navigation = screen.getByRole('navigation', { name: '주 메뉴' });
  const watchlist = within(navigation).getByRole('link', { name: '관심 종목' });
  Object.defineProperties(navigation, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 500 },
  });
  vi.spyOn(navigation, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 300 } as DOMRect);
  vi.spyOn(watchlist, 'getBoundingClientRect').mockReturnValue({
    left: 420,
    right: 500,
  } as DOMRect);

  fireEvent.click(watchlist);

  expect(watchlist).toHaveAttribute('aria-current', 'page');
  expect(navigation.scrollLeft).toBe(200);
  client.clear();
});
