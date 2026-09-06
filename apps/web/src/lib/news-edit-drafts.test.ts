import { afterEach, expect, it } from 'vitest';
import { clearNewsEditDrafts } from './news-edit-drafts';
afterEach(() => sessionStorage.clear());
it('purges every legacy body-editing draft without deleting unrelated app storage', () => {
  sessionStorage.setItem(
    'orsem-news-edit-v1:user:source1',
    JSON.stringify({ markdown: 'stored body' }),
  );
  sessionStorage.setItem('orsem-news-edit-v1:other:source2', 'other body');
  sessionStorage.setItem('theme', 'dark');
  clearNewsEditDrafts();
  clearNewsEditDrafts();
  expect(Object.keys(sessionStorage)).toEqual(['theme']);
  expect(sessionStorage.getItem('theme')).toBe('dark');
});
