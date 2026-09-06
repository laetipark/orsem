import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { naverBudgetAvailable } from '../lib/naver-news';
export { naverBudgetAvailable } from '../lib/naver-news';
import { useVisiblePanel } from '../lib/use-visible-panel';
import type { NaverNewsSearchResult, NaverNewsStatus } from '../types';
import { NaverNewsResults } from './naver-news-results';
import { Button, Card, CardContent, CardHeader, EmptyState, LoadingState } from './ui';

/** Results live only in the mounted section; no query cache, storage or background fetch. */
export function CompanyNaverNews({
  companyId,
  companyName,
}: {
  companyId: string;
  companyName: string;
}) {
  const { ref, visible } = useVisiblePanel();
  const status = useQuery({
    queryKey: ['naver-news-status', companyId],
    queryFn: ({ signal }) => api.naverNewsStatus(signal),
    enabled: visible,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [currentStatus, setCurrentStatus] = useState<NaverNewsStatus | null>(null);
  const [result, setResult] = useState<NaverNewsSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [periodic, setPeriodic] = useState(false);
  const attempted = useRef(false);
  const active = useRef<AbortController | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const effectiveStatus = currentStatus ?? status.data;

  const search = useCallback(
    async (start: number, automatic: boolean) => {
      if (!visibleRef.current || active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setError(null);
      setLoading(true);
      setResult(null);
      try {
        const latest = await api.naverNewsStatus(controller.signal);
        if (controller.signal.aborted) return;
        setCurrentStatus(latest);
        if (!naverBudgetAvailable(latest) || (automatic && !latest.automaticAllowed)) {
          setError(latest.reason ?? '현재 검색을 사용할 수 없습니다.');
          return;
        }
        if (!visibleRef.current) return;
        const next = await api.naverNewsSearch(
          companyName,
          start,
          'date',
          controller.signal,
          automatic,
        );
        if (!controller.signal.aborted) setResult(next);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '네이버 뉴스를 검색하지 못했습니다.');
      } finally {
        if (active.current === controller) active.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [companyName],
  );

  useEffect(() => {
    if (!visible || !status.data || !naverBudgetAvailable(status.data) || attempted.current) return;
    let canceled = false;
    // Effect cleanup runs before this in StrictMode, so one visible entry sends one search.
    void Promise.resolve().then(() => {
      if (canceled || attempted.current) return;
      attempted.current = true;
      void search(1, true);
    });
    return () => {
      canceled = true;
    };
  }, [visible, status.data, search]);
  useEffect(() => {
    if (visible) return;
    active.current?.abort();
    active.current = null;
    setLoading(false);
  }, [visible]);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!periodic || !visible || !effectiveStatus || !naverBudgetAvailable(effectiveStatus)) return;
    const timer = window.setInterval(() => {
      void search(1, true);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [periodic, visible, effectiveStatus, search]);

  return (
    <div ref={ref}>
      <Card className="naver-search" aria-label={`${companyName} 네이버 뉴스`}>
        <CardHeader>
          <div>
            <span className="section-kicker">NAVER NEWS</span>
            <h2>
              <Search size={18} /> {companyName} 뉴스 원문 검색
            </h2>
          </div>
          <Link className="text-link" to="/news/naver">
            직접 검색
          </Link>
        </CardHeader>
        <CardContent>
          <p>네이버가 제공한 최신순 결과입니다. 수집 뉴스와 별도로 표시합니다.</p>
          <div className="naver-search__controls">
            <Button
              variant="secondary"
              size="sm"
              disabled={!effectiveStatus || !naverBudgetAvailable(effectiveStatus) || loading}
              onClick={() => void search(1, false)}
            >
              <RefreshCw size={14} /> 검색 새로고침
            </Button>
            <label className="check-control">
              <input
                type="checkbox"
                checked={periodic}
                disabled={!effectiveStatus || !naverBudgetAvailable(effectiveStatus)}
                onChange={(event) => setPeriodic(event.target.checked)}
              />
              보는 동안 1분마다 새로고침
            </label>
          </div>
          {effectiveStatus && !effectiveStatus.automaticAllowed ? (
            <p role="status">
              {effectiveStatus.reason ?? '무료 검색 이용 조건을 확인해야 합니다.'}
            </p>
          ) : null}
          {status.isError ? (
            <p role="alert">
              네이버 검색 연결 상태를 확인하지 못했습니다.{' '}
              <button className="text-link" type="button" onClick={() => void status.refetch()}>
                다시 확인
              </button>
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
        </CardContent>
        {loading ? <LoadingState label="네이버 뉴스를 검색하는 중입니다." /> : null}
        {result?.items.length ? <NaverNewsResults result={result} /> : null}
        {result && !result.items.length ? (
          <EmptyState
            title="네이버 검색 결과가 없습니다"
            description="직접 검색에서 다른 기업명이나 검색어를 사용할 수 있습니다."
          />
        ) : null}
        {result ? (
          <div className="naver-search__pagination">
            <Button
              variant="secondary"
              size="sm"
              disabled={result.start <= 1 || loading}
              onClick={() => void search(Math.max(1, result.start - 20), false)}
            >
              이전
            </Button>
            <span>
              {result.total
                ? `${result.start}–${Math.min(result.total, result.start + result.display - 1)} / ${result.total.toLocaleString()}`
                : '0건'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={
                result.start + result.display > Math.min(result.total, 1000) ||
                loading ||
                !result.items.length
              }
              onClick={() => void search(result.start + 20, false)}
            >
              다음
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
