import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ChevronRight, Newspaper } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatKst } from '../lib/format';
import type { SourceFreshness, SourceItem } from '../types';
import { Card, CardHeader, EmptyState, ErrorState, LoadingState } from './ui';
import './market-news.css';

export const NEWS_REFRESH_INTERVAL = 60_000;

const statusLabels: Record<SourceFreshness['status'], string> = {
  HEALTHY: '정상',
  DEGRADED: '수집 지연',
  DISABLED: '수집 비활성',
  UNCONFIGURED: '수집 미설정',
  FAILED: '수집 오류',
};

export function MarketNewsFreshness() {
  const freshness = useQuery({
    queryKey: ['source-freshness'],
    queryFn: api.sourceFreshness,
    refetchInterval: NEWS_REFRESH_INTERVAL,
    staleTime: 30_000,
  });
  const source = freshness.data?.items.find((item) => item.id === 'news_rss');
  return (
    <div className="market-news__freshness">
      <span>RSS 30분마다 수집</span>
      {source ? (
        <>
          <span
            className={`market-news__status market-news__status--${source.status.toLowerCase()}`}
          >
            {statusLabels[source.status]}
          </span>
          <span>
            {source.lastSuccessAt
              ? `마지막 수집 ${formatKst(source.lastSuccessAt)}`
              : '수집 기록 없음'}
          </span>
        </>
      ) : null}
      {freshness.isError ? <span>수집 상태를 확인하지 못했습니다.</span> : null}
    </div>
  );
}

export function MarketNewsList({ items }: { items: SourceItem[] }) {
  return (
    <ul className="market-news__list">
      {items.map((item) => (
        <li className="market-news__item" key={item.id}>
          <a
            className="market-news__link"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="market-news__copy">
              <strong>{item.title}</strong>
              <span className="market-news__meta">
                <span className="market-news__publisher">{item.sourceName || '시장 뉴스 RSS'}</span>
                {item.publishedAt ? (
                  <time dateTime={item.publishedAt}>발행 {formatKst(item.publishedAt)}</time>
                ) : (
                  <>
                    <span>발행시각 미제공</span>
                    <time dateTime={item.firstObservedAt}>
                      최초 확인 {formatKst(item.firstObservedAt)}
                    </time>
                  </>
                )}
              </span>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
            <span className="sr-only">원문 새 창에서 보기</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function MarketNewsEmpty() {
  return (
    <EmptyState
      title="아직 수집된 시장 뉴스가 없습니다"
      description="새 기사가 수집되면 이곳에 표시됩니다. 원문은 각 언론사에서 확인할 수 있습니다."
    />
  );
}

export function DashboardNews() {
  const news = useQuery({
    queryKey: ['news', 'NEWS_RSS', 'latest', 6],
    queryFn: () => api.news({ limit: 6 }),
    refetchInterval: NEWS_REFRESH_INTERVAL,
    staleTime: 30_000,
  });

  return (
    <Card className="market-news market-news--compact" aria-labelledby="dashboard-news-title">
      <CardHeader>
        <h2 id="dashboard-news-title">
          <Newspaper size={19} aria-hidden="true" /> 시장 뉴스
        </h2>
        <Link className="text-link" to="/news">
          전체 보기 <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </CardHeader>
      <MarketNewsFreshness />
      {news.isPending ? <LoadingState label="시장 뉴스를 불러오는 중입니다." /> : null}
      {news.isError ? (
        <ErrorState
          message={
            news.data ? '새 목록을 불러오지 못해 이전 뉴스를 표시합니다.' : news.error.message
          }
          onRetry={() => void news.refetch()}
        />
      ) : null}
      {news.data?.items.length ? <MarketNewsList items={news.data.items} /> : null}
      {news.data && !news.data.items.length && !news.isError ? <MarketNewsEmpty /> : null}
    </Card>
  );
}
