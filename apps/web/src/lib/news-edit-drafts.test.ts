import { afterEach, expect, it, vi } from 'vitest';
import { clearNewsEditDrafts, readNewsEditDraft, saveNewsEditDraft } from './news-edit-drafts';
const draft = { revision: 'a'.repeat(64), title: '제목', description: null, markdown: '본문' };
afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('isolates temporary edits by account and article and expires them after 30 minutes', () => {
  vi.useFakeTimers();
  saveNewsEditDraft('admin', 'article', draft);
  expect(readNewsEditDraft('admin', 'article')).toMatchObject(draft);
  expect(readNewsEditDraft('other', 'article')).toBeNull();
  expect(readNewsEditDraft('admin', 'other')).toBeNull();
  vi.advanceTimersByTime(30 * 60_000 + 1);
  expect(readNewsEditDraft('admin', 'article')).toBeNull();
});
it('clears only translation drafts on account changes and survives unavailable storage', () => {
  saveNewsEditDraft('admin', 'article', draft);
  sessionStorage.setItem('other-setting', 'value');
  clearNewsEditDrafts();
  expect(readNewsEditDraft('admin', 'article')).toBeNull();
  expect(sessionStorage.getItem('other-setting')).toBe('value');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(saveNewsEditDraft('admin', 'article', draft)).toBe(false);
});
