import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatKst } from '../lib/format';
import type { NaverNewsSearchResult } from '../types';
import '../pages/naver-news-search-page.css';

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

export function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function NaverNewsResults({ result }: { result: NaverNewsSearchResult }) {
  return (
    <ul className="naver-search__results">
      {result.items.map((item, index) => {
        const link = safeLink(item.originallink) ?? safeLink(item.link);
        return (
          <li key={`${item.link}:${index}`}>
            <div>
              <strong>
                <NaverHighlightedText value={item.title} />
              </strong>
              {item.description ? (
                <p>
                  <NaverHighlightedText value={item.description} />
                </p>
              ) : null}
              <time>
                {Number.isFinite(Date.parse(item.pubDate))
                  ? formatKst(item.pubDate)
                  : '발행시각 미제공'}
              </time>
            </div>
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer">
                원문 <ArrowUpRight size={14} />
                <span className="sr-only">새 창에서 보기</span>
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
