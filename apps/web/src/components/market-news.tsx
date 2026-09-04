import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ChevronRight, Newspaper } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatKst } from '../lib/format';
import type { SourceFreshness, SourceItem } from '../types';
import { TranslatedText } from './translated-text';
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

const newsStatusPriority: SourceFreshness['status'][] = [
  'FAILED',
  'DEGRADED',
  'HEALTHY',
  'UNCONFIGURED',
  'DISABLED',
];

export function summarizeNewsFreshness(items: SourceFreshness[]) {
  const sources = items.filter(
    (item) =>
      (item.category === 'NEWS' || item.category === 'OFFICIAL') &&
      !item.id.toLowerCase().includes('naver'),
  );
  const latest = sources.reduce<string | null>(
    (value, item) =>
      !item.lastSuccessAt || (value && value >= item.lastSuccessAt) ? value : item.lastSuccessAt,
    null,
  );
  const status = newsStatusPriority.find((candidate) =>
    sources.some((item) => item.status === candidate),
  );
  return { latest, sources, status: status ?? null };
}

export function safeNewsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const regionLabels: Record<NonNullable<SourceItem['marketRegion']>, string> = {
  kr: '국내',
  us: '미국',
  global: '글로벌',
  unknown: '지역 미확인',
};

export function MarketNewsFreshness() {
  const freshness = useQuery({
    queryKey: ['source-freshness'],
    queryFn: api.sourceFreshness,
    refetchInterval: NEWS_REFRESH_INTERVAL,
    staleTime: 30_000,
  });
  const { latest, status } = summarizeNewsFreshness(freshness.data?.items ?? []);
  return (
    <div className="market-news__freshness">
      <span>뉴스·공식 소스별 15~30분마다 수집</span>
      {status ? (
        <>
          <span className={`market-news__status market-news__status--${status.toLowerCase()}`}>
            {statusLabels[status]}
          </span>
          <span>{latest ? `마지막 수집 ${formatKst(latest)}` : '수집 기록 없음'}</span>
        </>
      ) : null}
      {freshness.isError ? <span>수집 상태를 확인하지 못했습니다.</span> : null}
    </div>
  );
}

function newsSourceLinks(item: SourceItem) {
  const seen = new Set<string>();
  return (item.sources ?? []).flatMap((source) => {
    const url = safeNewsUrl(source.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ ...source, url }];
  });
}

function NewsCopy({ item }: { item: SourceItem }) {
  return (
    <span className="market-news__copy">
      <TranslatedText
        title={item.title}
        description={item.description}
        translation={item.translation}
      />
      <span className="market-news__meta">
        <span className="market-news__publisher">{item.sourceName || '뉴스 출처'}</span>
        {item.marketRegion ? <span>{regionLabels[item.marketRegion]}</span> : null}
        {(item.sourceCount ?? 1) > 1 ? <span>{item.sourceCount}개 출처에서 확인</span> : null}
        {item.publishedAt ? (
          <time dateTime={item.publishedAt}>발행 {formatKst(item.publishedAt)}</time>
        ) : (
          <>
            <span>발행시각 미제공</span>
            <time dateTime={item.firstObservedAt}>최초 확인 {formatKst(item.firstObservedAt)}</time>
          </>
        )}
      </span>
    </span>
  );
}

export function MarketNewsList({ items }: { items: SourceItem[] }) {
  return (
    <ul className="market-news__list">
      {items.map((item) => {
        const itemUrl = safeNewsUrl(item.url);
        const sources = newsSourceLinks(item);
        const hasAdditionalSources = sources.some((source) => source.url !== itemUrl);
        return (
          <li className="market-news__item" key={item.articleId ?? item.id}>
            {itemUrl ? (
              <a
                className="market-news__link"
                href={itemUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <NewsCopy item={item} />
                <ArrowUpRight size={16} aria-hidden="true" />
                <span className="sr-only">원문 새 창에서 보기</span>
              </a>
            ) : (
              <div className="market-news__link market-news__link--unavailable">
                <NewsCopy item={item} />
                <span className="sr-only">안전한 원문 링크가 없습니다.</span>
              </div>
            )}
            {hasAdditionalSources ? (
              <details className="market-news__sources">
                <summary>연결된 원문 출처 {sources.length}개</summary>
                <ul>
                  {sources.map((source) => (
                    <li key={`${source.id}:${source.url}`}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">
                        {source.sourceName || source.source}
                        <ArrowUpRight size={13} aria-hidden="true" />
                        <span className="sr-only">새 창에서 보기</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        );
      })}
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
    queryKey: ['news', 'latest', 6],
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
