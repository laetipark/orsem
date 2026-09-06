import { ArrowLeft, Search } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { naverBudgetAvailable } from '../lib/naver-news';
import { NaverNewsResults } from '../components/naver-news-results';
export { NaverHighlightedText } from '../components/naver-news-results';
import type { NaverNewsSearchResult, NaverNewsStatus } from '../types';
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

export function NaverNewsSearchPage() {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'date' | 'sim'>('date');
  const [result, setResult] = useState<NaverNewsSearchResult | null>(null);
  const [activeQuery, setActiveQuery] = useState('');
  const [activeSort, setActiveSort] = useState<'date' | 'sim'>('date');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<NaverNewsStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const refreshStatus = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    setStatusError(false);
    try {
      const latest = await api.naverNewsStatus(controller.signal);
      if (!controller.signal.aborted) setStatus(latest);
    } catch {
      if (!controller.signal.aborted) {
        setStatus(null);
        setStatusError(true);
      }
    }
  }, []);
  useEffect(() => {
    void refreshStatus();
    return () => {
      request.current?.abort();
      statusRequest.current?.abort();
    };
  }, [refreshStatus]);

  const search = async (q: string, start: number, selectedSort: 'date' | 'sim') => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setResult(null);
    setError(null);
    setLoading(true);
    try {
      const latest = await api.naverNewsStatus(controller.signal);
      if (controller.signal.aborted) return;
      setStatus(latest);
      if (!naverBudgetAvailable(latest)) {
        setError(latest.reason ?? '무료 검색 이용 조건을 확인해야 합니다.');
        return;
      }
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
          <p>네이버가 제공한 검색 결과를 원래 순서로 보여줍니다.</p>
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
            <Button type="submit" disabled={loading || !status || !naverBudgetAvailable(status)}>
              검색
            </Button>
          </form>
          {!status || !naverBudgetAvailable(status) ? (
            <p role="status">
              {status?.reason ??
                (statusError
                  ? '검색 연결 상태를 확인하지 못했습니다.'
                  : '무료 검색 이용 조건을 확인 중입니다.')}{' '}
              <button type="button" className="text-link" onClick={() => void refreshStatus()}>
                상태 다시 확인
              </button>
            </p>
          ) : null}
        </CardContent>
        {loading ? <LoadingState label="네이버 뉴스를 검색하는 중입니다." /> : null}
        {error ? (
          <ErrorState message={error} onRetry={() => void search(activeQuery, 1, activeSort)} />
        ) : null}
        {result?.items.length ? <NaverNewsResults result={result} /> : null}
        {result && !result.items.length ? (
          <EmptyState title="검색 결과가 없습니다" description="다른 검색어로 확인해 보세요." />
        ) : null}
        {result ? (
          <div className="naver-search__pagination">
            <Button
              variant="secondary"
              disabled={result.start <= 1 || loading || !status || !naverBudgetAvailable(status)}
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
              disabled={
                !result.items.length ||
                result.start + result.display > Math.min(result.total, 1000) ||
                loading ||
                !status ||
                !naverBudgetAvailable(status)
              }
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
