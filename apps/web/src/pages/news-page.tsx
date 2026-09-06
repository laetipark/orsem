import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Newspaper, RefreshCw, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CompanyNaverNews } from '../components/company-naver-news';
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
];

export function NewsPage() {
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
  const company = useQuery({
    queryKey: ['company', filters.companyId],
    queryFn: ({ signal }) => api.company(filters.companyId!, signal),
    enabled: !!filters.companyId,
    staleTime: 30_000,
  });
  const news = useInfiniteQuery({
    queryKey: ['news', filters],
    queryFn: ({ pageParam, signal }) =>
      api.news({ ...filters, limit: 20, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: NEWS_REFRESH_INTERVAL,
    staleTime: 30_000,
  });
  const items = Array.from(
    new Map(
      news.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.articleId ?? item.id, item]),
    ).values(),
  );
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
          시장 공통 소식과 기업 관련 뉴스를 구분해 확인합니다. 언론 기사는 원문 링크로 제공합니다.
        </p>
        <div className="news-page__actions">
          <Link className="button button--secondary button--sm" to="/news/naver">
            네이버 직접 검색
          </Link>
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
      <form className="news-page__filters" onSubmit={submit} aria-label="뉴스 필터">
        <select
          aria-label="뉴스 범위"
          value={filters.scope}
          onChange={(event) => setFilter('scope', event.target.value)}
        >
          <option value="all">전체 뉴스</option>
          <option value="market">시장 공통</option>
          <option value="company">기업 관련</option>
        </select>
        <RegionTabs />
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
          <input
            value={draft}
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="뉴스 제목 검색"
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
      <Card className="market-news" aria-labelledby="news-list-title">
        <CardHeader>
          <h2 id="news-list-title">
            <Newspaper size={19} aria-hidden="true" /> 최신 뉴스
          </h2>
          <span className="market-news__refresh-note">목록 1분마다 갱신</span>
        </CardHeader>
        <MarketNewsFreshness />
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
      {company.data ? (
        <CompanyNaverNews
          key={company.data.id}
          companyId={company.data.id}
          companyName={
            company.data.nameKo ||
            company.data.nameEn ||
            company.data.ticker ||
            company.data.stockCode ||
            ''
          }
        />
      ) : null}
    </div>
  );
}
