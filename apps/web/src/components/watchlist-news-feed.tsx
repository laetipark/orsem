import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { watchlistAccessDenied } from '../lib/watchlist-access';
import { formatDate, formatKst } from '../lib/format';
import { newsItems } from '../lib/news-feed';
import type { RecentCompany } from '../lib/recent-companies';
import { MarketNewsList } from './market-news';
import { Button, EmptyState, ErrorState, LoadingState } from './ui';
import './watchlist-news-feed.css';

export function WatchlistNewsFeed({
  actor,
  groupId,
  roomId,
  recentCompanies,
  enabled,
  onAccessLost,
  filterHost,
  inlineTabs = false,
  externalCompanies = false,
}: {
  actor: string;
  groupId?: string;
  roomId?: string;
  recentCompanies?: readonly RecentCompany[];
  enabled: boolean;
  onAccessLost: () => void;
  filterHost: HTMLElement | null;
  inlineTabs?: boolean;
  externalCompanies?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const recent = recentCompanies !== undefined;
  const requestedCompany = params.get('watchCompany') || undefined;
  const companyId =
    recent && !recentCompanies.some((c) => c.id === requestedCompany)
      ? undefined
      : requestedCompany;
  const tab = !recent && params.get('watchNewsType') === 'filings' ? 'filings' : 'news';
  const ids = recentCompanies?.map((c) => c.id) ?? [];
  const ready = enabled && Boolean(actor) && (recent ? ids.length > 0 : Boolean(groupId));
  const news = useInfiniteQuery({
    queryKey: recent
      ? ['news', actor, 'recent-companies', ids, companyId]
      : ['watchlist-v2', actor, 'group-news', roomId ?? 'personal', groupId, companyId],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      recent
        ? api.news(
            {
              scope: 'company',
              ...(companyId ? { companyId } : { companyIds: ids }),
              limit: 20,
              cursor: pageParam,
            },
            signal,
          )
        : api.watchlistGroupNews(groupId!, { companyId, limit: 20, cursor: pageParam }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: ready && tab === 'news',
    refetchInterval: ready && tab === 'news' ? 60_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    gcTime: 0,
    retry: false,
  });
  const filings = useQuery({
    queryKey: ['watchlist-v2', actor, 'group-filings', roomId ?? 'personal', groupId, companyId],
    queryFn: ({ signal }) => api.watchlistGroupFilings(groupId!, companyId, signal),
    enabled: ready && tab === 'filings',
    refetchInterval: ready && tab === 'filings' ? 60_000 : false,
    refetchIntervalInBackground: false,
    gcTime: 0,
    retry: false,
  });
  const current = tab === 'news' ? news : filings;
  const denied = watchlistAccessDenied(current.error);
  useEffect(() => {
    if (denied && !recent) onAccessLost();
  }, [denied, recent, onAccessLost]);
  const first = news.data?.pages[0];
  const companies = recent
    ? recentCompanies
    : tab === 'filings'
      ? (filings.data?.companies ?? [])
      : first && 'companies' in first
        ? (first as Awaited<ReturnType<typeof api.watchlistGroupNews>>).companies
        : [];
  const update = (key: string, value?: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        next.delete('watchPage');
        return next;
      },
      { replace: true },
    );
  const items = news.data ? newsItems(news.data.pages) : [];
  const tabs = !recent ? (
    <div
      className="personal-news__tabs watch-news-feed__tabs"
      role="group"
      aria-label="관심 그룹 소식 종류"
    >
      <button type="button" aria-pressed={tab === 'news'} onClick={() => update('watchNewsType')}>
        뉴스
      </button>
      <button
        type="button"
        aria-pressed={tab === 'filings'}
        onClick={() => update('watchNewsType', 'filings')}
      >
        공시
      </button>
    </div>
  ) : null;
  return (
    <section className="watch-news-feed" aria-label={recent ? '시장 뉴스' : '관심 그룹 소식'}>
      {filterHost
        ? createPortal(
            <>
              {inlineTabs ? tabs : null}
              <label className="watch-news-feed__filter">
                <span>종목</span>
                <select
                  aria-label="소식 종목 필터"
                  value={companyId ?? ''}
                  onChange={(event) => update('watchCompany', event.target.value)}
                >
                  <option value="">전체</option>
                  {companyId && !companies.some((c) => c.id === companyId) ? (
                    <option value={companyId}>선택한 종목</option>
                  ) : null}
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.nameKo}
                    </option>
                  ))}
                </select>
              </label>
            </>,
            filterHost,
          )
        : null}
      {!inlineTabs || !filterHost ? tabs : null}
      {recent && !ids.length ? (
        <EmptyState
          title="최근 조회한 종목이 없습니다"
          description="종목 상세를 열면 관련 뉴스를 이곳에서 확인할 수 있습니다."
        />
      ) : current.isPending ? (
        <LoadingState label="종목 소식을 불러오는 중입니다." />
      ) : current.isError ? (
        <ErrorState
          message="소식을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."
          onRetry={() => void current.refetch()}
        />
      ) : tab === 'news' ? (
        <>
          {items.length ? (
            <MarketNewsList items={items} headlineOnly externalCompanies={externalCompanies} />
          ) : (
            <EmptyState
              title="아직 연결된 뉴스가 없습니다"
              description={first?.naver?.reason ?? '수집된 관련 뉴스가 있으면 이곳에 표시합니다.'}
            />
          )}
          {news.hasNextPage ? (
            <Button
              className="watch-news-feed__more"
              variant="secondary"
              disabled={news.isFetchingNextPage}
              onClick={() => void news.fetchNextPage()}
            >
              {news.isFetchingNextPage ? '불러오는 중…' : '소식 더 보기'}
            </Button>
          ) : null}
        </>
      ) : filings.data?.items.length ? (
        <ul className="personal-filings">
          {filings.data.items.map((item) => (
            <li key={item.id}>
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                <strong>{item.title}</strong>
                <small>
                  {item.relatedCompanies.map((c) => c.nameKo || c.nameEn || c.ticker).join(' · ')} ·{' '}
                  {item.source === 'SEC' ? 'SEC' : 'OpenDART'} ·{' '}
                  {item.filingDate
                    ? `접수 ${formatDate(item.filingDate)}`
                    : `수집 ${formatKst(item.firstObservedAt)}`}
                </small>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="아직 연결된 공시가 없습니다"
          description="선택한 종목의 원본 공시가 수집되면 표시합니다."
        />
      )}
    </section>
  );
}
