import type { ReactNode } from 'react';
import type { NewsContentBlock } from '../types';

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function MarkdownInline({ text, depth = 0 }: { text: string; depth?: number }) {
  if (depth > 4) return <>{text}</>;
  const pattern =
    /\\(?<escaped>[\\`*[\](){}#+.!_<>~0-9-])|`(?<code>[^`\n]+)`|\[(?<label>(?:\\.|[^\]\n])+)\]\((?<url>https?:\/\/[^\s)]+)\)|\*\*(?<bold>[^\n]+?)\*\*|\*(?<italic>[^*\n]+)\*/gu;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const token = match.groups!;
    nodes.push(text.slice(offset, index));
    const nested = (value: string) => <MarkdownInline text={value} depth={depth + 1} />;
    if (token.escaped) nodes.push(token.escaped);
    else if (token.code) nodes.push(<code key={index}>{token.code}</code>);
    else if (token.label && token.url) {
      const href = safeLink(token.url);
      nodes.push(
        href ? (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            {nested(token.label)}
          </a>
        ) : (
          match[0]
        ),
      );
    } else if (token.bold) nodes.push(<strong key={index}>{nested(token.bold)}</strong>);
    else if (token.italic) nodes.push(<em key={index}>{nested(token.italic)}</em>);
    offset = index + match[0].length;
  }
  nodes.push(text.slice(offset));
  return <>{nodes}</>;
}

export function NewsContentBlocks({
  blocks,
  language,
  markdown = false,
}: {
  blocks: NewsContentBlock[];
  language: string;
  markdown?: boolean;
}) {
  const copy = (text: string) => (markdown ? <MarkdownInline text={text} /> : text);
  return (
    <div className="news-detail__body" lang={language}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === 'HEADING') {
          const Heading = `h${[2, 3, 4, 5, 6].includes(block.level) ? block.level : 2}` as
            'h2' | 'h3' | 'h4' | 'h5' | 'h6';
          return <Heading key={key}>{copy(block.text)}</Heading>;
        }
        if (block.type === 'LIST') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>{copy(item)}</li>
              ))}
            </List>
          );
        }
        if (block.type === 'QUOTE') return <blockquote key={key}>{copy(block.text)}</blockquote>;
        return <p key={key}>{copy(block.text)}</p>;
      })}
    </div>
  );
}
