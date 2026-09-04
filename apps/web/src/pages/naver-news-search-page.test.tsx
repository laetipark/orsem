import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { NaverNewsSearchPage } from './naver-news-search-page';

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { naverNewsSearch: mocks.search } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('네이버 검색은 사용자 동작으로만 호출하고 제공자 순서·안전한 강조·페이지를 유지한다', async () => {
  mocks.search.mockResolvedValue({
    provider: 'NAVER',
    lastBuildDate: 'Sat, 05 Sep 2026 15:00:00 +0900',
    total: 40,
    start: 1,
    display: 20,
    items: [
      {
        title: '첫 <b>뉴스</b>',
        description: '&lt;script&gt;alert(1)&lt;/script&gt;',
        originallink: 'javascript:alert(1)',
        link: 'https://news.naver.com/1',
        pubDate: 'Sat, 05 Sep 2026 14:00:00 +0900',
      },
      {
        title: '두 번째 뉴스',
        description: '',
        originallink: 'https://publisher.example/2',
        link: 'https://news.naver.com/2',
        pubDate: 'Sat, 05 Sep 2026 13:00:00 +0900',
      },
    ],
  });
  const { container } = render(
    <MemoryRouter>
      <NaverNewsSearchPage />
    </MemoryRouter>,
  );
  expect(mocks.search).not.toHaveBeenCalled();
  fireEvent.change(screen.getByPlaceholderText('회사명·종목명 검색'), {
    target: { value: ' 삼성전자 ' },
  });
  fireEvent.change(screen.getByLabelText('정렬'), { target: { value: 'sim' } });
  fireEvent.click(screen.getByRole('button', { name: '검색' }));
  await waitFor(() =>
    expect(mocks.search).toHaveBeenCalledWith('삼성전자', 1, 'sim', expect.any(AbortSignal)),
  );
  expect(
    (await screen.findAllByRole('listitem')).map((item) => item.textContent?.slice(0, 1)),
  ).toEqual(['첫', '두']);
  expect(screen.getByText('뉴스').tagName).toBe('MARK');
  expect(screen.getByText('<script>alert(1)</script>')).toBeVisible();
  expect(container.querySelector('script')).toBeNull();
  expect(screen.getAllByRole('link', { name: /원문/ })[0]).toHaveAttribute(
    'href',
    'https://news.naver.com/1',
  );
  fireEvent.click(screen.getByRole('button', { name: '다음' }));
  await waitFor(() =>
    expect(mocks.search).toHaveBeenLastCalledWith('삼성전자', 21, 'sim', expect.any(AbortSignal)),
  );
});
