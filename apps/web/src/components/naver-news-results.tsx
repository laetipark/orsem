import type { NaverNewsResultSet } from '../types';
import { formatKst } from '../lib/format';
import { NaverHighlightedText } from './naver-highlighted-text';
import './naver-news-results.css';

function safeLink(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const statuses: Record<string, string> = {
  AVAILABLE: '검색 완료',
  PENDING: '검색 대기',
  UNAVAILABLE: '연결 지연',
  UNCONFIGURED: '미설정',
  LIMIT_REACHED: '호출 한도 대기',
  PAUSED: '검색 중단',
};

/** Provider text/order are unchanged; company badges and other sources stay outside these lists. */
export function NaverNewsResults({ sets = [] }: { sets?: NaverNewsResultSet[] }) {
  const visible = sets.filter((set) => !set.expiresAt || Date.parse(set.expiresAt) > Date.now());
  if (!visible.length) return null;
  return (
    <section className="naver-news-results" aria-label="네이버 뉴스 검색결과">
      <h3>네이버 뉴스 검색결과</h3>
      {visible.map((set) => (
        <details key={set.queryId} open={visible.length === 1}>
          <summary>
            <strong>{set.queryLabel}</strong>
            <span>
              {statuses[set.status] ?? '상태 확인 중'} · {set.items.length}건
            </span>
          </summary>
          <div className="naver-news-results__status">
            {set.fetchedAt ? <span>검색 {formatKst(set.fetchedAt)}</span> : null}
            {set.reason ? <span>{set.reason}</span> : null}
            {set.status === 'AVAILABLE' && !set.items.length ? (
              <span>검색 결과가 없습니다.</span>
            ) : null}
          </div>
          <ol start={set.start ?? 1}>
            {set.items.map((item, index) => {
              const original = safeLink(item.originallink);
              const naver = safeLink(item.link);
              const href = original ?? naver;
              const headline = <NaverHighlightedText value={item.title} />;
              return (
                <li key={`${set.queryId}:${index}`}>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {headline}
                    </a>
                  ) : (
                    <strong>{headline}</strong>
                  )}
                  <p>
                    <NaverHighlightedText value={item.description} />
                  </p>
                  <div className="naver-news-results__meta">
                    {original ? <span>{new URL(original).hostname}</span> : null}
                    {Number.isFinite(Date.parse(item.pubDate)) ? (
                      <time>{formatKst(item.pubDate)}</time>
                    ) : null}
                    {naver ? (
                      <a href={naver} target="_blank" rel="noopener noreferrer">
                        네이버 검색 제공
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </details>
      ))}
    </section>
  );
}
