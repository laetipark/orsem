import { newsContentBlockSchema, type NewsContentBlock } from './schemas';

/** A small Markdown subset that maps to the existing text-only article block contract. */
export function parseNewsMarkdown(markdown: string): NewsContentBlock[] {
  if (markdown.length > 100_000) throw new Error('본문은 100,000자 이내로 입력하세요.');
  if (/(^|[^\\])<\/?[A-Za-z!][^>]*>/u.test(markdown))
    throw new Error('HTML 태그는 지원하지 않습니다.');
  if (/(^|[^\\])!\[/u.test(markdown)) throw new Error('이미지는 지원하지 않습니다.');
  if (/^\s*(```|~~~)/mu.test(markdown)) throw new Error('코드 블록은 지원하지 않습니다.');
  for (const match of markdown.matchAll(/(?<!\\)\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)) {
    let url: URL;
    try {
      url = new URL(match[1]!);
    } catch {
      throw new Error('링크에는 전체 HTTP(S) 주소를 입력하세요.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('링크에는 HTTP(S) 주소만 사용할 수 있습니다.');
  }
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: NewsContentBlock[] = [];
  const push = (block: unknown) => {
    const parsed = newsContentBlockSchema.safeParse(block);
    if (!parsed.success) throw new Error('본문 문단·제목·목록의 길이 또는 형식을 확인하세요.');
    blocks.push(parsed.data);
    if (blocks.length > 2_000) throw new Error('본문 블록은 2,000개 이내로 입력하세요.');
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^#\s/u.test(line)) throw new Error('본문 제목은 ##부터 ######까지 사용할 수 있습니다.');
    const heading = /^(#{2,6})\s+(.+)$/u.exec(line);
    if (heading) {
      push({ type: 'HEADING', level: heading[1]!.length, text: heading[2] });
      index += 1;
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const text: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index]!))
        text.push(lines[index++]!.replace(/^>\s?/u, ''));
      push({ type: 'QUOTE', text: text.join('\n') });
      continue;
    }
    const list = /^(?:([-+*])|\d+[.)])\s+(.+)$/u.exec(line);
    if (list) {
      const ordered = !list[1];
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^(?:([-+*])|\d+[.)])\s+(.+)$/u.exec(lines[index]!);
        if (!item || !item[1] !== ordered) break;
        index += 1;
        let text = item[2]!;
        while (index < lines.length && /^ {2}/u.test(lines[index]!)) {
          if (/^\s+(?:[-+*]|\d+[.)])\s/u.test(lines[index]!))
            throw new Error('중첩 목록은 지원하지 않습니다.');
          text += `\n${lines[index++]!.slice(2)}`;
        }
        items.push(text);
      }
      push({ type: 'LIST', ordered, items });
      continue;
    }
    const text = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !/^(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s)/u.test(lines[index]!)
    )
      text.push(lines[index++]!);
    push({ type: 'PARAGRAPH', text: text.join('\n') });
  }
  if (!blocks.length) throw new Error('번역 본문을 입력하세요.');
  return blocks;
}

function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]<>]/gu, '\\$&').replace(/^(#{1,6}|[-+]|\d+[.)])(?=\s)/gmu, '\\$1');
}

export function newsBlocksToMarkdown(blocks: readonly NewsContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'HEADING') return `${'#'.repeat(block.level)} ${escapeInline(block.text)}`;
      if (block.type === 'QUOTE')
        return escapeInline(block.text)
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
      if (block.type === 'LIST')
        return block.items
          .map(
            (item, index) =>
              `${block.ordered ? `${index + 1}.` : '-'} ${escapeInline(item).replace(/\n/gu, '\n  ')}`,
          )
          .join('\n');
      return escapeInline(block.text);
    })
    .join('\n\n');
}
