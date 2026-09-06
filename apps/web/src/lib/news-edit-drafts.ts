/** Remove body-editing drafts left by an earlier application version. */
export function clearNewsEditDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('orsem-news-edit-v1:')) sessionStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; news navigation does not depend on it.
  }
}
