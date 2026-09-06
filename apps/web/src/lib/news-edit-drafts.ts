import type { NewsTranslationEdit, NewsTranslationEditInput } from '../types';

const PREFIX = 'orsem-news-edit-v1:';
const TTL = 30 * 60_000;
export type NewsEditDraft = NewsTranslationEditInput & { savedAt: number };
const keyFor = (userId: string, sourceId: string) =>
  `${PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(sourceId)}`;

export function clearNewsEditDrafts() {
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch {
    /* Storage can be disabled by the browser. */
  }
}
export function removeNewsEditDraft(userId: string, sourceId: string) {
  try {
    sessionStorage.removeItem(keyFor(userId, sourceId));
  } catch {
    /* The current editor still works without storage. */
  }
}
export function readNewsEditDraft(userId: string, sourceId: string): NewsEditDraft | null {
  try {
    const raw = sessionStorage.getItem(keyFor(userId, sourceId));
    if (!raw) return null;
    if (raw.length > 250_000) {
      removeNewsEditDraft(userId, sourceId);
      return null;
    }
    const value = JSON.parse(raw) as Partial<NewsEditDraft>;
    if (
      typeof value.savedAt !== 'number' ||
      Date.now() - value.savedAt > TTL ||
      typeof value.revision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.revision) ||
      typeof value.title !== 'string' ||
      value.title.length > 2000 ||
      !(value.description === null || typeof value.description === 'string') ||
      (value.description?.length ?? 0) > 20000 ||
      typeof value.markdown !== 'string' ||
      value.markdown.length > 100000
    ) {
      removeNewsEditDraft(userId, sourceId);
      return null;
    }
    return value as NewsEditDraft;
  } catch {
    return null;
  }
}
export function saveNewsEditDraft(
  userId: string,
  sourceId: string,
  draft: NewsTranslationEditInput,
): boolean {
  try {
    const key = keyFor(userId, sourceId);
    const existing = Object.keys(sessionStorage).filter(
      (entry) => entry.startsWith(PREFIX) && entry !== key,
    );
    for (const entry of existing.slice(0, Math.max(0, existing.length - 4)))
      sessionStorage.removeItem(entry);
    sessionStorage.setItem(key, JSON.stringify({ ...draft, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
export function editInput(edit: NewsTranslationEdit): NewsTranslationEditInput {
  return { revision: edit.revision, ...edit.translation };
}
