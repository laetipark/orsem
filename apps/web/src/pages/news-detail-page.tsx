import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/ui';
import { safeNewsUrl } from '../components/market-news';
import { api } from '../lib/api';
import { replaceWithNewsOriginal } from '../lib/news-navigation';

/** Old bookmarks resolve using metadata only; article bodies are no longer served. */
export function NewsDetailPage() {
  const { id = '' } = useParams();
  const news = useQuery({
    queryKey: ['news-detail', id],
    queryFn: ({ signal }) => api.newsDetail(id, signal),
    enabled: Boolean(id),
    gcTime: 0,
  });
  const original = news.data ? safeNewsUrl(news.data.url) : null;
  const originalUrl =
    original &&
    !(
      new URL(original).origin === window.location.origin &&
      /^\/news(?:\/|$)/u.test(new URL(original).pathname)
    )
      ? original
      : null;
  useEffect(() => {
    if (originalUrl) replaceWithNewsOriginal(originalUrl);
  }, [originalUrl]);
  return (
    <div className="page-stack">
      <Link className="text-link" to="/news">
        <ArrowLeft size={15} aria-hidden="true" /> 뉴스 목록
      </Link>
      {news.isPending ? (
        <LoadingState label="기사 원문 링크를 확인하는 중입니다." />
      ) : news.isError ? (
        <ErrorState message={news.error.message} onRetry={() => void news.refetch()} />
      ) : originalUrl ? (
        <>
          <p role="status">기사 원문으로 이동합니다.</p>
          <a className="text-link" href={originalUrl} target="_blank" rel="noopener noreferrer">
            원문 새 창에서 보기 <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </>
      ) : (
        <ErrorState message="안전한 기사 원문 링크를 찾을 수 없습니다." />
      )}
    </div>
  );
}
