import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it('NAVER manual search keeps the user query out of the request URL', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      provider: 'NAVER',
      lastBuildDate: 'Sat, 05 Sep 2026 15:00:00 +0900',
      total: 0,
      start: 21,
      display: 0,
      items: [],
    }),
  );
  vi.stubGlobal('fetch', fetchMock);

  await api.naverNewsSearch('삼성전자 & NVIDIA', 21, 'sim');

  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toMatch(/\/news-search\/naver$/u);
  expect(url).not.toContain('삼성');
  const headers = new Headers(init.headers);
  expect(headers.get('X-Orsem-News-Query')).toBe(encodeURIComponent('삼성전자 & NVIDIA'));
  expect(headers.get('X-Orsem-News-Start')).toBe('21');
  expect(headers.get('X-Orsem-News-Sort')).toBe('sim');
  expect(init.cache).toBe('no-store');
});
