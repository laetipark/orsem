import { afterEach, expect, it, vi } from 'vitest';
import { api, setCsrfToken } from './api';

afterEach(() => {
  vi.restoreAllMocks();
  setCsrfToken(null);
});
it('saves a revisioned translation through the protected JSON mutation path', async () => {
  const input = {
    revision: 'a'.repeat(64),
    title: '수정 제목',
    description: null,
    markdown: '## 제목\n\n본문',
  };
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ sourceItemId: 'source/one' }), { status: 200 }),
    );
  setCsrfToken('test-csrf');
  await api.saveNewsTranslation('source/one', input);
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/v1/news/source%2Fone/translation-edit');
  expect(options).toMatchObject({ method: 'PATCH', credentials: 'include' });
  expect(new Headers(options!.headers).get('X-CSRF-Token')).toBe('test-csrf');
  expect(JSON.parse(String(options!.body))).toEqual(input);
});
