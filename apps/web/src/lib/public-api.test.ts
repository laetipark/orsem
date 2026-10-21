import { afterEach, expect, it, vi } from 'vitest';
import { publicApi, publicExternalUrl } from './public-api';
import { ApiError, setCsrfToken } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

it('uses only public GET endpoints and omits cookies and CSRF credentials', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ items: [], nextCursor: null }) });
  vi.stubGlobal('fetch', fetch);
  setCsrfToken('member-token-must-not-be-sent');
  const controller = new AbortController();
  await publicApi.companies({ q: '삼성 & AAPL', region: 'all', limit: 20 }, controller.signal);
  await publicApi.company('NASDAQ:AAPL');
  await publicApi.news({ q: '금리', cursor: 'next+page', companyId: 'company-id' });
  await publicApi.newsDetail('news-id');
  await publicApi.markets('all');
  await publicApi.marketHistory('us10y', '1y');
  expect(fetch).toHaveBeenCalledTimes(6);
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toMatch(/^\/api\/v1\/public\//u);
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    expect(init.headers).not.toHaveProperty('X-CSRF-Token');
    expect(init).not.toHaveProperty('body');
  }
  const first = new URL(fetch.mock.calls[0]![0], 'https://example.test');
  expect(first.searchParams.get('q')).toBe('삼성 & AAPL');
  expect(fetch.mock.calls[0]![1].signal).toBe(controller.signal);
  expect(fetch.mock.calls[1]![0]).toBe('/api/v1/public/companies/NASDAQ%3AAAPL');
});

it('reports unavailable public data without falling back to authenticated endpoints', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
  vi.stubGlobal('fetch', fetch);
  await expect(publicApi.company('unknown')).rejects.toMatchObject({
    statusCode: 404,
    message: '공개된 자료를 찾을 수 없습니다.',
  });
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(publicApi.news()).rejects.toBeInstanceOf(ApiError);
});

it('preserves aborts so obsolete requests cannot become successful public responses', async () => {
  const controller = new AbortController();
  controller.abort();
  const error = new DOMException('Aborted', 'AbortError');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
  await expect(publicApi.news({}, controller.signal)).rejects.toBe(error);
});

it.each([
  'javascript:alert(1)',
  '//evil.example',
  'https://name:password@example.com',
  '/api/v1/events',
  'http://example.com',
])('rejects unsafe source URLs: %s', (url) => {
  expect(publicExternalUrl(url)).toBeNull();
});
