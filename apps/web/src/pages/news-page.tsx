import { SearchInput } from '../components/search-input';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Newspaper, RefreshCw, Search } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { newsItems } from '../lib/news-feed';
import { api } from '../lib/api';
import type { NewsSourceKind } from '../types';
import {
  MarketNewsEmpty,
  MarketNewsFreshness,
  MarketNewsList,
  NEWS_REFRESH_INTERVAL,
} from '../components/market-news';
import { RegionTabs, parseRegion } from '../components/region-tabs';
import { Button, Card, CardHeader, ErrorState, LoadingState } from '../components/ui';
import './news-page.css';

const sourceKinds: Array<[NewsSourceKind | '', string]> = [
  ['', '모든 출처 유형'],
  ['OFFICIAL_RELEASE', '공식 기관 발표'],
  ['COMPANY_IR', '기업 IR'],
  ['PRESS_RELEASE', '보도자료'],
  ['AGGREGATOR', '집계 API'],
  ['INDEPENDENT_MEDIA', '독립 언론 · 원문 링크'],
];
const newsSourceKindValues = new Set<NewsSourceKind>(
  sourceKinds.flatMap(([value]) => (value ? [value] : [])),
);

export function parseNewsSourceKind(value: string | null): NewsSourceKind | undefined {
  return value && newsSourceKindValues.has(value as NewsSourceKind)
    ? (value as NewsSourceKind)
    : undefined;
}
const publishers = [
  ['', '모든 제공자'],
  ['samsung-global-newsroom', 'Samsung Global Newsroom'],
  ['federal-reserve', 'Federal Reserve'],
  ['bls', 'Bureau of Labor Statistics'],
  ['eia', 'U.S. Energy Information Administration'],
];

export function NewsPage() {
  const [filtersOpen, setFiltersOpen] = useState(
    () => window.matchMedia('(min-width: 768px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const change = () => setFiltersOpen(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(params.get('q') ?? '');
  const filters = {
    scope: (['market', 'company'].includes(params.get('scope') ?? '')
      ? params.get('scope')
      : 'all') as 'all' | 'market' | 'company',
    region: parseRegion(params.get('region')),
    sourceKind: parseNewsSourceKind(params.get('sourceKind')),
    publisher: params.get('publisher') || undefined,
    q: params.get('q') || undefined,
    companyId: params.get('companyId') || undefined,
  };
  const news = useInfiniteQuery({
    queryKey: ['news', filters],
    queryFn: ({ pageParam, signal }) =>
      api.news({ ...filters, limit: 20, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: NEWS_REFRESH_INTERVAL,
    staleTime: 30_000,
    gcTime: 0,
  });
  const items = newsItems(news.data?.pages ?? []);
  const setFilter = (name: string, value: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(name, value);
      else next.delete(name);
      next.delete('cursor');
      return next;
    });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFilter('q', draft.trim());
  };

  return (
    <div className="page-stack news-page">
      <div className="page-lead">
        <p>
          시장 공통 소식과 기업 관련 뉴스를 구분해 확인합니다. 모든 기사는 원문 링크로 제공합니다.
        </p>
        <div className="news-page__actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void news.refetch()}
            disabled={news.isFetching}
          >
            <RefreshCw size={15} className={news.isFetching ? 'spin' : ''} aria-hidden="true" />{' '}
            새로고침
          </Button>
        </div>
      </div>
      <details
        className="responsive-filters"
        open={filtersOpen}
        onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
      >
        <summary>뉴스 검색·필터</summary>
        <form className="news-page__filters" onSubmit={submit} aria-label="뉴스 필터">
          <RegionTabs />
          <select
            aria-label="뉴스 범위"
            value={filters.scope}
            onChange={(event) => setFilter('scope', event.target.value)}
          >
            <option value="all">전체 뉴스</option>
            <option value="market">시장 공통</option>
            <option value="company">기업 관련</option>
          </select>
          <select
            aria-label="출처 유형"
            value={filters.sourceKind ?? ''}
            onChange={(event) => setFilter('sourceKind', event.target.value)}
          >
            {sourceKinds.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="제공자"
            value={filters.publisher ?? ''}
            onChange={(event) => setFilter('publisher', event.target.value)}
          >
            {publishers.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label className="news-page__search">
            <span className="sr-only">뉴스 제목 검색</span>
            <Search size={15} aria-hidden="true" />
            <SearchInput
              value={draft}
              onChange={setDraft}
              label="뉴스 제목 검색"
              placeholder="뉴스 제목 검색"
              filters={{
                kind: 'news',
                region: filters.region,
                scope: filters.scope,
                sourceKind: filters.sourceKind,
                publisher: filters.publisher,
                companyId: filters.companyId,
              }}
              contextKey={params.toString()}
              onSelect={(item) => setFilter('q', item.translation?.title ?? item.title)}
              onSubmit={() => setFilter('q', draft.trim())}
            />
          </label>
          <Button type="submit" variant="secondary" size="sm">
            적용
          </Button>
          {filters.companyId ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setFilter('companyId', '')}
            >
              기업 필터 해제
            </Button>
          ) : null}
        </form>
      </details>
      <Card className="market-news" aria-labelledby="news-list-title">
        <CardHeader>
          <h2 id="news-list-title">
            <Newspaper size={19} aria-hidden="true" /> 최신 뉴스
          </h2>
          <span className="market-news__refresh-note">목록 1분마다 갱신</span>
        </CardHeader>
        <div className="news-page__info" aria-label="뉴스 범위와 수집 상태">
          <p className="market-news__scope">
            <span className="news-page__scope-label">
              {filters.scope === 'market'
                ? '시장 공통'
                : filters.scope === 'company'
                  ? '기업 관련'
                  : '전체 뉴스'}
            </span>
            <span>
              {filters.scope === 'market'
                ? '증시 · 금리 · 환율'
                : filters.scope === 'company'
                  ? '기업별 소식 · 산업 동향'
                  : '시장 공통 소식 · 기업 관련 뉴스'}
            </span>
          </p>
          <MarketNewsFreshness naver={news.data?.pages[0]?.naver} />
        </div>
        {news.isPending ? <LoadingState label="뉴스를 불러오는 중입니다." /> : null}
        {news.isError ? (
          <ErrorState
            message={
              news.isFetchNextPageError
                ? '이전 뉴스를 더 불러오지 못했습니다.'
                : news.data
                  ? '새 목록을 불러오지 못해 이전 뉴스를 표시합니다.'
                  : news.error.message
            }
            onRetry={() => void (news.isFetchNextPageError ? news.fetchNextPage() : news.refetch())}
          />
        ) : null}
        {items.length ? <MarketNewsList items={items} /> : null}
        {news.data && !items.length && !news.isError ? <MarketNewsEmpty /> : null}
        {news.hasNextPage ? (
          <div className="market-news__more">
            <Button
              variant="secondary"
              onClick={() => void news.fetchNextPage()}
              disabled={news.isFetching}
            >
              {news.isFetchingNextPage ? '불러오는 중…' : '뉴스 더 보기'}
            </Button>
          </div>
        ) : items.length ? (
          <p className="market-news__end">조건에 맞는 뉴스를 모두 확인했습니다.</p>
        ) : null}
      </Card>
    </div>
  );
}
