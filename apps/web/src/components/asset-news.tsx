import { useQuery } from '@tanstack/react-query';
import { Newspaper } from 'lucide-react';
import { api } from '../lib/api';
import { newsItems } from '../lib/news-feed';
import { MarketNewsFreshness, MarketNewsList, NEWS_REFRESH_INTERVAL } from './market-news';
import { Card, CardHeader, EmptyState, ErrorState, LoadingState } from './ui';

const assetNames = {
  gold: '금',
  silver: '은',
  wti: 'WTI',
  btc: '비트코인',
  eth: '이더리움',
} as const;
export type NewsAsset = keyof typeof assetNames;
export function isNewsAsset(id: string): id is NewsAsset {
  return Object.hasOwn(assetNames, id);
}

export function AssetNews({ asset }: { asset: NewsAsset }) {
  const news = useQuery({
    queryKey: ['news', 'asset', asset],
    queryFn: ({ signal }) => api.news({ scope: 'market', asset, limit: 20 }, signal),
    staleTime: 30_000,
    gcTime: 0,
    refetchInterval: NEWS_REFRESH_INTERVAL,
  });
  const items = news.data ? newsItems([news.data], 20) : [];
  return (
    <Card className="market-news asset-news" aria-labelledby={`asset-news-${asset}`}>
      <CardHeader>
        <h2 id={`asset-news-${asset}`}>
          <Newspaper size={19} aria-hidden="true" /> {assetNames[asset]} 관련 뉴스
        </h2>
      </CardHeader>
      <MarketNewsFreshness providerOnly naver={news.data?.naver} />
      {news.isPending ? <LoadingState label="관련 뉴스를 불러오는 중입니다." /> : null}
      {news.isError ? (
        <ErrorState
          message="관련 뉴스를 불러오지 못했습니다."
          onRetry={() => void news.refetch()}
        />
      ) : null}
      {items.length ? (
        <MarketNewsList items={items} />
      ) : news.data && !news.isError ? (
        <EmptyState
          title="아직 관련 뉴스가 없습니다"
          description="해당 자산의 뉴스 검색 결과가 준비되면 제목과 요약을 표시합니다."
        />
      ) : null}
    </Card>
  );
}
