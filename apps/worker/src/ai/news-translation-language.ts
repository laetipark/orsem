const NONLINGUISTIC_LABEL = /^(?:PDF|HTML|XML|JSON|CSV|XLSX?|DOCX?|PPTX?|JPEG|JPG|PNG|GIF)$/u;

function withoutAddresses(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>]+/giu, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '');
}

function withoutPreservedNames(original: string, translated: string): string {
  // Multiword capitalized names copied from the original are normal in Korean
  // prose. Exclude them only from the Latin-prose ratio, not from other checks.
  const names = original.match(
    /\b[A-Z][A-Za-z0-9.'’-]*(?:\s+(?:(?:of|the|de|and)\s+)?[A-Z][A-Za-z0-9.'’-]*)+\b/g,
  );
  let prose = translated;
  for (const name of names ?? []) prose = prose.replaceAll(name, ' ');
  return prose;
}

/** Catch incomplete/mixed-language output; this is not a semantic accuracy score. */
export function validateTranslationLanguage(original: string, translated: string): void {
  const before = original.trim();
  const after = translated.trim();
  const originalProse = withoutAddresses(before);
  const translatedProse = withoutAddresses(after);
  if (before === after && (NONLINGUISTIC_LABEL.test(before) || !/\p{L}/u.test(originalProse))) {
    return;
  }

  const hangul = translatedProse.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  const han = translatedProse.match(/\p{Script=Han}/gu)?.length ?? 0;
  const originalHan = originalProse.match(/\p{Script=Han}/gu)?.length ?? 0;
  const otherScript =
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Cyrillic}]/u;
  if (
    hangul === 0 ||
    (han > originalHan && han >= Math.max(3, hangul / 3)) ||
    (otherScript.test(translatedProse) && !otherScript.test(originalProse))
  ) {
    throw new Error('Local content translation is not Korean.');
  }

  const unnamedProse = withoutPreservedNames(originalProse, translatedProse);
  const latinWords = unnamedProse.match(/[A-Za-z]+/gu) ?? [];
  const latinLetters = unnamedProse.match(/[A-Za-z]/gu)?.length ?? 0;
  // Long organization/product names are normal in Korean news. Reject dominant
  // untranslated prose, rather than imposing a blanket Latin-character limit.
  if (latinWords.length >= 10 && latinLetters > hangul * 2) {
    throw new Error('Local translation changed language coverage.');
  }

  const sourceLetters = originalProse.match(/\p{L}/gu)?.length ?? 0;
  const targetLetters = translatedProse.match(/\p{L}/gu)?.length ?? 0;
  if (sourceLetters >= 80 && targetLetters < Math.max(12, sourceLetters * 0.12)) {
    throw new Error('Local translation changed content coverage.');
  }
}
