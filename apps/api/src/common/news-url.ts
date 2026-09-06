export function publicSourceUrl(value: string): string | null {
  try {
    if (
      !/^https?:\/\//iu.test(value) ||
      value.includes('\\') ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return null;
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
