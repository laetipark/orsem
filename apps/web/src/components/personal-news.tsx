import { chronologicalNewsItems } from '../lib/news-feed';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../lib/api';
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from '../lib/use-media-query';
import type { Session } from '../types';
import { watchActorKey } from './watchlist-group-editors';
import { Button, Card, CardHeader, EmptyState, LoadingState, ErrorState } from './ui';
import { MarketNewsList } from './market-news';
import { FilingFeedList } from './filing-feed-list';

export function PersonalNews() {
  const session = useOutletContext<Session | undefined>();
  const actor = watchActorKey(session?.user);
  const id = useId();
  const [tab, setTab] = useState<'news' | 'filings'>('news');
  const pageSize = useMediaQuery(COMPACT_LAYOUT_QUERY) ? 4 : 6;
  const pageScope = `${actor}:${tab}:${pageSize}`;
  const [pagination, setPagination] = useState({ scope: pageScope, page: 0 });
  const enabled = !!actor && !!session?.canAccess;
  const news = useQuery({
    queryKey: ['watchlist-v2', actor, 'personal-news'],
    queryFn: ({ signal }) => api.personalNews(signal),
    enabled: enabled && tab === 'news',
    refetchInterval: 60_000,
    gcTime: 0,
    retry: false,
  });
  const filings = useQuery({
    queryKey: ['watchlist-v2', actor, 'personal-filings'],
    queryFn: ({ signal }) => api.personalFilings(signal),
    enabled: enabled && tab === 'filings',
    refetchInterval: 60_000,
    gcTime: 0,
    retry: false,
  });
  const current = tab === 'news' ? news : filings;
  const count = enabled ? (current.data?.companyCount ?? 0) : 0;
  const items = news.data
    ? chronologicalNewsItems([{ ...news.data, items: news.data.news }], 20)
    : [];
  const filingItems = filings.data?.items ?? [];
  const total = enabled ? (tab === 'news' ? items.length : filingItems.length) : 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = pagination.scope === pageScope ? Math.min(pagination.page, pageCount - 1) : 0;
  const offset = page * pageSize;
  useEffect(() => {
    setPagination((previous) =>
      previous.scope === pageScope && previous.page === page
        ? previous
        : { scope: pageScope, page },
    );
  }, [pageScope, page]);
  return (
    <Card className="personal-news observation-card">
      <CardHeader className="observation-card__header">
        <h2>내 관심 종목 소식</h2>
        <span className="observation-card__count">{count}종목</span>
      </CardHeader>
      <div className="personal-news__tabs" role="tablist" aria-label="개인 관심 종목 소식 종류">
        {(['news', 'filings'] as const).map((key) => (
          <button
            key={key}
            id={`${id}-${key}`}
            type="button"
            role="tab"
            aria-selected={tab === key}
            aria-controls={`${id}-panel`}
            onClick={() => setTab(key)}
          >
            {key === 'news' ? '뉴스' : '공시'}
          </button>
        ))}
      </div>
      <div
        className="personal-news__body"
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${tab}`}
        tabIndex={0}
      >
        {enabled && current.isPending ? (
          <LoadingState label="관심 종목 소식을 불러오는 중입니다." />
        ) : null}
        {current.isError ? (
          <ErrorState
            message="관심 종목 소식을 불러오지 못했습니다."
            onRetry={() => void current.refetch()}
          />
        ) : enabled && current.data ? (
          <>
            {tab === 'news' && total ? (
              <MarketNewsList items={items.slice(offset, offset + pageSize)} headlineOnly />
            ) : null}
            {tab === 'filings' && total ? (
              <FilingFeedList items={filingItems.slice(offset, offset + pageSize)} />
            ) : null}
            {!total ? (
              <EmptyState
                title={count ? '아직 연결된 소식이 없습니다' : '개인 관심 종목을 추가해 보세요'}
                description={
                  count
                    ? '새 뉴스와 확정된 공시가 있으면 표시됩니다.'
                    : '그룹 관리에서 종목을 담으면 여기에 소식을 모아 드립니다.'
                }
              />
            ) : null}
          </>
        ) : null}
      </div>
      {enabled && current.data && !current.isError && total > 0 ? (
        <footer className="observation-card__pagination">
          <small>
            총 {total}건 · {offset + 1}–{Math.min(offset + pageSize, total)}건
          </small>
          <div role="group" aria-label="관심 소식 페이지">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label="이전 소식"
              disabled={page === 0}
              onClick={() => setPagination({ scope: pageScope, page: page - 1 })}
            >
              이전
            </Button>
            <span aria-live="polite">
              {page + 1} / {pageCount}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label="다음 소식"
              disabled={page + 1 >= pageCount}
              onClick={() => setPagination({ scope: pageScope, page: page + 1 })}
            >
              다음
            </Button>
          </div>
        </footer>
      ) : null}
    </Card>
  );
}
