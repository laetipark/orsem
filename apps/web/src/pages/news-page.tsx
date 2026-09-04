import { useInfiniteQuery } from '@tanstack/react-query';
import { Newspaper, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import {
  MarketNewsEmpty,
  MarketNewsFreshness,
  MarketNewsList,
  NEWS_REFRESH_INTERVAL,
} from '../components/market-news';
import { Button, Card, CardHeader, ErrorState, LoadingState } from '../components/ui';

export function NewsPage() {
  const news = useInfiniteQuery({
    queryKey: ['news', 'NEWS_RSS', 'list'],
    queryFn: ({ pageParam }) => api.news({ limit: 20, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: NEWS_REFRESH_INTERVAL,
    staleTime: 30_000,
  });
  const items = Array.from(
    new Map(news.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item])).values(),
  );

  return (
    <div className="page-stack news-page">
      <div className="page-lead">
        <p>수집된 최신 뉴스입니다. 제목을 누르면 언론사 원문으로 이동합니다.</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void news.refetch()}
          disabled={news.isFetching}
        >
          <RefreshCw size={15} className={news.isFetching ? 'spin' : ''} aria-hidden="true" />
          새로고침
        </Button>
      </div>
      <Card className="market-news" aria-labelledby="news-list-title">
        <CardHeader>
          <h2 id="news-list-title">
            <Newspaper size={19} aria-hidden="true" /> 최신 뉴스
          </h2>
          <span className="market-news__refresh-note">목록 1분마다 갱신</span>
        </CardHeader>
        <MarketNewsFreshness />
        {news.isPending ? <LoadingState label="시장 뉴스를 불러오는 중입니다." /> : null}
        {news.isError ? (
          <ErrorState
            message={
              news.isFetchNextPageError
                ? '이전 뉴스를 더 불러오지 못했습니다. 다시 시도해 주세요.'
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
          <p className="market-news__end">수집된 뉴스를 모두 확인했습니다.</p>
        ) : null}
      </Card>
    </div>
  );
}
