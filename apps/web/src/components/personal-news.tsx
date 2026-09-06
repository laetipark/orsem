import { newsItems } from '../lib/news-feed';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate, formatKst } from '../lib/format';
import type { Session } from '../types';
import { watchActorKey } from './watchlist-group-editors';
import { Card, CardHeader, EmptyState, LoadingState, ErrorState } from './ui';
import { MarketNewsList } from './market-news';

export function PersonalNews() {
  const session = useOutletContext<Session | undefined>();
  const actor = watchActorKey(session?.user);
  const id = useId();
  const [tab, setTab] = useState<'news' | 'filings'>('news');
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
    ? newsItems([{ items: news.data.news, providerGroups: news.data.providerGroups }], 20)
    : [];
  const empty = tab === 'news' ? !items.length : !filings.data?.items.length;
  return (
    <Card className="personal-news">
      <CardHeader>
        <h2>내 관심 종목 소식</h2>
        <span className="muted">{count}종목</span>
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
            {tab === 'news' && items.length ? <MarketNewsList items={items} headlineOnly /> : null}
            {tab === 'filings' && filings.data?.items.length ? (
              <ul className="personal-filings">
                {filings.data.items.map((item) => (
                  <li key={item.id}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      <strong>{item.title}</strong>
                      <small>
                        {item.relatedCompanies
                          .map((c) => c.nameKo || c.nameEn || c.ticker)
                          .join(' · ')}{' '}
                        · {item.source === 'SEC' ? 'SEC' : 'OpenDART'} ·{' '}
                        {item.filingDate
                          ? `접수 ${formatDate(item.filingDate)}`
                          : `수집 ${formatKst(item.firstObservedAt)}`}
                      </small>
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            {empty ? (
              <EmptyState
                title={count ? '아직 연결된 소식이 없습니다' : '개인 관심 종목을 추가해 보세요'}
                description={
                  count
                    ? '새 뉴스와 원본 공시가 수집되면 표시됩니다.'
                    : '그룹 관리에서 종목을 담으면 여기에 소식을 모아 드립니다.'
                }
              />
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
