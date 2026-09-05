const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_BLOCKS = 600;
const MAX_BLOCK_CHARACTERS = 3_500;
const MAX_TOTAL_CHARACTERS = 500_000;
const MAX_LIST_ITEMS = 200;

export type NewsContentBlock =
  | Readonly<{ type: 'PARAGRAPH'; text: string }>
  | Readonly<{ type: 'HEADING'; level: 2 | 3 | 4 | 5 | 6; text: string }>
  | Readonly<{ type: 'LIST'; ordered: boolean; items: readonly string[] }>
  | Readonly<{ type: 'QUOTE'; text: string }>;

export interface ArticleRootSelector {
  readonly tag?: string;
  readonly id?: string;
  readonly className?: string;
}

const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'form',
  'button',
  'nav',
  'header',
  'footer',
  'aside',
]);
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote']);

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|lsquo|rsquo|ldquo|rdquo);/gi,
    (entity, code: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        ndash: '–',
        mdash: '—',
        hellip: '…',
        lsquo: '‘',
        rsquo: '’',
        ldquo: '“',
        rdquo: '”',
      };
      if (!code.startsWith('#')) return named[code.toLowerCase()] ?? ' ';
      const point =
        code[1]?.toLowerCase() === 'x'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : ' ';
    },
  );
}

function normalizeText(value: string): string {
  const printable = [...decodeEntities(value)]
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127;
    })
    .join('');
  return printable
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tagInfo(token: string): {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  id: string | null;
  classes: readonly string[];
} | null {
  const match = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)([\s\S]*?)\/?\s*>$/u.exec(token);
  if (!match) return null;
  const attributes = match[3] ?? '';
  const readAttribute = (name: string): string | null => {
    const found = new RegExp(
      `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`,
      'iu',
    ).exec(attributes);
    return found ? (found[1] ?? found[2] ?? found[3] ?? '') : null;
  };
  return {
    name: match[2]!.toLowerCase(),
    closing: Boolean(match[1]),
    selfClosing: /\/\s*>$/u.test(token) || /^(?:br|hr|img|meta|link|input)$/iu.test(match[2]!),
    id: readAttribute('id'),
    classes: Object.freeze((readAttribute('class') ?? '').split(/\s+/u).filter(Boolean)),
  };
}

function matchesRoot(
  tag: NonNullable<ReturnType<typeof tagInfo>>,
  selectors: readonly ArticleRootSelector[],
): boolean {
  return selectors.some(
    (selector) =>
      (!selector.tag || selector.tag.toLowerCase() === tag.name) &&
      (!selector.id || selector.id === tag.id) &&
      (!selector.className || tag.classes.includes(selector.className)),
  );
}

/**
 * Converts a trusted-profile HTML document or RSS HTML fragment into bounded text blocks.
 * Attributes, links, images and the input HTML itself are intentionally never returned.
 */
export function htmlToNewsContentBlocks(
  html: string,
  options: Readonly<{ roots?: readonly ArticleRootSelector[] }> = {},
): readonly NewsContentBlock[] {
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES)
    throw new Error('Article HTML exceeded its size limit.');
  const roots = options.roots ?? [];
  const tokens =
    html.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]{0,8192}>|[^<]+|</gu) ?? [];
  const stack: string[] = [];
  let rootDepth: number | null = roots.length === 0 ? 0 : null;
  let droppedDepth = 0;
  let active: { tag: string; text: string; ordered?: boolean } | null = null;
  const blocks: NewsContentBlock[] = [];
  let totalCharacters = 0;

  const addTextBlock = (tag: string, raw: string, ordered?: boolean) => {
    const text = normalizeText(raw);
    if (!text) return;
    if (text.length > MAX_BLOCK_CHARACTERS)
      throw new Error('Article content block exceeded its size limit.');
    if (blocks.length >= MAX_BLOCKS || totalCharacters + text.length > MAX_TOTAL_CHARACTERS)
      throw new Error('Article content exceeded its structural size limit.');
    totalCharacters += text.length;
    if (tag === 'li') {
      const last = blocks.at(-1);
      if (
        last?.type === 'LIST' &&
        last.ordered === Boolean(ordered) &&
        last.items.length < MAX_LIST_ITEMS &&
        last.items.reduce((size, item) => size + item.length, 0) + text.length <= 3_500
      ) {
        blocks[blocks.length - 1] = Object.freeze({
          ...last,
          items: Object.freeze([...last.items, text]),
        });
      } else {
        blocks.push(
          Object.freeze({ type: 'LIST', ordered: Boolean(ordered), items: Object.freeze([text]) }),
        );
      }
    } else if (tag === 'blockquote') {
      blocks.push(Object.freeze({ type: 'QUOTE', text }));
    } else if (/^h[1-6]$/u.test(tag)) {
      const level = Math.max(2, Number(tag[1])) as 2 | 3 | 4 | 5 | 6;
      blocks.push(Object.freeze({ type: 'HEADING', level, text }));
    } else {
      blocks.push(Object.freeze({ type: 'PARAGRAPH', text }));
    }
  };

  for (const token of tokens) {
    if (token.startsWith('<!--') || /^<!DOCTYPE/iu.test(token)) continue;
    if (token.startsWith('<![CDATA[')) {
      if (rootDepth !== null && droppedDepth === 0 && active) active.text += token.slice(9, -3);
      continue;
    }
    if (!token.startsWith('<')) {
      if (rootDepth !== null && droppedDepth === 0) {
        if (active) active.text += ` ${token}`;
        else if (normalizeText(token)) addTextBlock('p', token);
      }
      continue;
    }
    if (token === '<') throw new Error('Article HTML contains an oversized or malformed tag.');
    const tag = tagInfo(token);
    if (!tag) continue;
    if (!tag.closing) {
      stack.push(tag.name);
      if (rootDepth === null && matchesRoot(tag, roots)) rootDepth = stack.length;
      if (rootDepth !== null && DROP_WITH_CONTENT.has(tag.name)) droppedDepth += 1;
      if (rootDepth !== null && droppedDepth === 0) {
        if (tag.name === 'br' && active) active.text += '\n';
        if (BLOCK_TAGS.has(tag.name)) {
          if (active) addTextBlock(active.tag, active.text, active.ordered);
          const listParent = [...stack].reverse().find((name) => name === 'ol' || name === 'ul');
          active = { tag: tag.name, text: '', ordered: listParent === 'ol' };
        }
      }
      if (tag.selfClosing) {
        if (rootDepth !== null && DROP_WITH_CONTENT.has(tag.name)) droppedDepth -= 1;
        stack.pop();
      }
      continue;
    }
    const openingIndex = stack.lastIndexOf(tag.name);
    const depthBeforeClose = stack.length;
    if (rootDepth !== null && droppedDepth === 0 && active?.tag === tag.name) {
      addTextBlock(active.tag, active.text, active.ordered);
      active = null;
    }
    if (rootDepth !== null && DROP_WITH_CONTENT.has(tag.name) && droppedDepth > 0)
      droppedDepth -= 1;
    if (openingIndex >= 0) stack.splice(openingIndex);
    if (rootDepth !== null && roots.length > 0 && depthBeforeClose === rootDepth) rootDepth = null;
  }
  if (active && droppedDepth === 0 && rootDepth !== null)
    addTextBlock(active.tag, active.text, active.ordered);
  if (roots.length > 0 && blocks.length === 0)
    throw new Error('Official article body was not found.');
  return Object.freeze(blocks);
}

export function newsContentPlainText(blocks: readonly NewsContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'LIST' ? block.items : [block.text]))
    .join('\n\n');
}
