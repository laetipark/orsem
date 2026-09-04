import { ArrowLeft, ArrowUpRight, Search } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatKst } from '../lib/format';
import type { NaverNewsSearchResult } from '../types';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/ui';
import './naver-news-search-page.css';

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

export function NaverNewsSearchPage() {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'date' | 'sim'>('date');
  const [result, setResult] = useState<NaverNewsSearchResult | null>(null);
  const [activeQuery, setActiveQuery] = useState('');
  const [activeSort, setActiveSort] = useState<'date' | 'sim'>('date');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const search = async (q: string, start: number, selectedSort: 'date' | 'sim') => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResult(null);
    setError(null);
    setLoading(true);
    try {
      const next = await api.naverNewsSearch(q, start, selectedSort, controller.signal);
      if (!controller.signal.aborted) setResult(next);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '검색하지 못했습니다.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setActiveQuery(q);
    setActiveSort(sort);
    void search(q, 1, sort);
  };

  return (
    <div className="page-stack naver-search">
      <div className="page-lead">
        <div>
          <Link className="text-link" to="/news">
            <ArrowLeft size={14} /> 수집 뉴스로 돌아가기
          </Link>
          <p>네이버 결과는 이 화면에서만 보여주며 수집 목록·저장·AI 처리에 사용하지 않습니다.</p>
        </div>
      </div>
      <Card>
        <CardHeader>
          <h2>
            <Search size={19} /> 네이버 뉴스 직접 검색
          </h2>
        </CardHeader>
        <CardContent>
          <form className="naver-search__form" onSubmit={submit}>
            <label>
              <span className="sr-only">검색어</span>
              <input
                required
                maxLength={120}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="회사명·종목명 검색"
              />
            </label>
            <select
              aria-label="정렬"
              value={sort}
              onChange={(event) => setSort(event.target.value as 'date' | 'sim')}
            >
              <option value="date">최신순</option>
              <option value="sim">정확도순</option>
            </select>
            <Button type="submit" disabled={loading}>
              검색
            </Button>
          </form>
        </CardContent>
        {loading ? <LoadingState label="네이버 뉴스를 검색하는 중입니다." /> : null}
        {error ? (
          <ErrorState message={error} onRetry={() => void search(activeQuery, 1, activeSort)} />
        ) : null}
        {result?.items.length ? (
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
                    <time>{formatKst(item.pubDate)}</time>
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
        ) : null}
        {result && !result.items.length ? (
          <EmptyState title="검색 결과가 없습니다" description="다른 검색어로 확인해 보세요." />
        ) : null}
        {result ? (
          <div className="naver-search__pagination">
            <Button
              variant="secondary"
              disabled={result.start <= 1 || loading}
              onClick={() => void search(activeQuery, Math.max(1, result.start - 20), activeSort)}
            >
              이전
            </Button>
            <span>
              {result.start.toLocaleString()}–
              {Math.min(result.total, result.start + result.display - 1).toLocaleString()} /{' '}
              {result.total.toLocaleString()}
            </span>
            <Button
              variant="secondary"
              disabled={result.start + result.display > Math.min(result.total, 1000) || loading}
              onClick={() => void search(activeQuery, result.start + 20, activeSort)}
            >
              다음
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
