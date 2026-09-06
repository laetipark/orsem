import type { ReactNode } from 'react';
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&')
    .replace(/&nbsp;/giu, '\u00a0');
}

export function NaverHighlightedText({ value }: { value: string }) {
  let bold = false;
  const parts: ReactNode[] = [];
  for (const [index, part] of value.split(/(<\/?b>)/giu).entries()) {
    if (/^<b>$/iu.test(part)) {
      bold = true;
      continue;
    }
    if (/^<\/b>$/iu.test(part)) {
      bold = false;
      continue;
    }
    const text = decodeEntities(part);
    parts.push(bold ? <mark key={index}>{text}</mark> : text);
  }
  return <>{parts}</>;
}
