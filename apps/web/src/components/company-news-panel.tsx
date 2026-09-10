import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useVisiblePanel } from '../lib/use-visible-panel';
import { newsItems } from '../lib/news-feed';
import { MarketNewsList } from './market-news';

const tabs = [
  { id: 'activity', label: '공시·이벤트' },
  { id: 'news', label: '관련 뉴스' },
] as const;
type NewsTab = (typeof tabs)[number]['id'];
const pageSize = 5;

function PanelPagination({
  page,
  previous,
  next,
  hasNext,
  busy = false,
}: {
  page: number;
  previous: () => void;
  next: () => void;
  hasNext: boolean;
  busy?: boolean;
}) {
  return (
    <nav className="company-news-pagination" aria-label="종목 소식 페이지">
      <button type="button" onClick={previous} disabled={page === 0 || busy}>
        이전 5개
      </button>
      <span aria-live="polite">{page + 1}페이지</span>
      <button type="button" onClick={next} disabled={!hasNext || busy}>
        {busy ? '불러오는 중…' : '다음 5개'}
      </button>
    </nav>
  );
}

function PanelState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="company-news-state" role={retry ? 'alert' : 'status'}>
      <p>{message}</p>
      {retry ? (
        <button className="text-link" onClick={retry}>
          다시 불러오기
        </button>
      ) : null}
    </div>
  );
}

function RecentActivity({ companyId, visible }: { companyId: string; visible: boolean }) {
  const [requestedPage, setPage] = useState(0);
  const query = useQuery({
    queryKey: ['company-recent-activity', companyId, 20],
    queryFn: ({ signal }) => api.companyRecentActivity(companyId, signal, 20),
    enabled: visible,
    refetchInterval: visible ? 60_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const page = Math.min(
    requestedPage,
    Math.max(0, Math.ceil((query.data?.items.length ?? 0) / pageSize) - 1),
  );
  return (
    <>
      <div className="company-news-summary">
        <strong>최근 공시·이벤트</strong>
        <Link className="text-link" to={`/events?companyId=${encodeURIComponent(companyId)}`}>
          전체 보기
        </Link>
      </div>
      <div className="company-news-window">
        <strong>최근 7일</strong>
        {query.data ? (
          <span>
            공시 {query.data.filingCount} · 이벤트 {query.data.eventCount}
          </span>
        ) : null}
        {query.data?.windowStartDate ? (
          <small>
            {formatDate(query.data.windowStartDate)}–{formatDate(query.data.windowEndDate)} KST
          </small>
        ) : null}
      </div>
      {query.isPending ? <PanelState message="최근 공시·이벤트를 불러오는 중입니다." /> : null}
      {query.isError ? (
        <PanelState message="최근 소식을 불러오지 못했습니다." retry={() => void query.refetch()} />
      ) : null}
      {query.data ? (
        <ul className="company-activity-list">
          {query.data.items.slice(page * pageSize, (page + 1) * pageSize).map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <div className="company-activity-meta">
                <span className={`company-activity-kind is-${item.kind.toLowerCase()}`}>
                  {item.kind === 'FILING' ? '공시' : '이벤트'}
                </span>
                <small>접수·발표 {formatDate(item.date)}</small>
              </div>
              {item.url.startsWith('/') ? (
                <Link to={item.url} title={item.title}>
                  {item.title}
                </Link>
              ) : (
                <a href={item.url} title={item.title} target="_blank" rel="noopener noreferrer">
                  {item.title}
                  <span className="sr-only"> 원문 새 창에서 보기</span>
                </a>
              )}
              {item.eventDate && item.eventDate !== item.date ? (
                <small>실제 발생 {formatDate(item.eventDate)}</small>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {query.data && query.data.items.length > pageSize ? (
        <PanelPagination
          page={page}
          previous={() => setPage(page - 1)}
          next={() => setPage(page + 1)}
          hasNext={(page + 1) * pageSize < query.data.items.length}
        />
      ) : null}
      {query.data && !query.data.items.length ? (
        <PanelState message="최근 7일 공시·이벤트가 없습니다." />
      ) : null}
    </>
  );
}

function RelatedNews({ companyId, visible }: { companyId: string; visible: boolean }) {
  const [requestedPage, setPage] = useState(0);
  const query = useInfiniteQuery({
    queryKey: ['news', 'company-panel', companyId, 20],
    queryFn: ({ signal, pageParam }) =>
      api.news({ companyId, limit: 20, scope: 'company', cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: visible,
    refetchInterval: visible ? 60_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    gcTime: 0,
    retry: false,
  });
  const items = newsItems(query.data?.pages ?? []);
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(items.length / pageSize) - 1));
  const next = async () => {
    if ((page + 1) * pageSize < items.length) setPage(page + 1);
    else if (query.hasNextPage) {
      const result = await query.fetchNextPage();
      if (newsItems(result.data?.pages ?? []).length > (page + 1) * pageSize) setPage(page + 1);
    }
  };
  return (
    <>
      <div className="company-news-summary">
        <strong>최근 관련 뉴스</strong>
        <Link
          className="text-link"
          to={`/news?companyId=${encodeURIComponent(companyId)}&scope=company`}
        >
          전체 보기
        </Link>
      </div>
      {query.isPending ? <PanelState message="관련 뉴스를 불러오는 중입니다." /> : null}
      {query.isError ? (
        <PanelState message="관련 뉴스를 불러오지 못했습니다." retry={() => void query.refetch()} />
      ) : null}
      {items.length ? (
        <MarketNewsList items={items.slice(page * pageSize, (page + 1) * pageSize)} companyDetail />
      ) : null}
      {items.length > pageSize || query.hasNextPage ? (
        <PanelPagination
          page={page}
          previous={() => setPage(page - 1)}
          next={() => void next()}
          hasNext={(page + 1) * pageSize < items.length || Boolean(query.hasNextPage)}
          busy={query.isFetchingNextPage}
        />
      ) : null}
      {query.data && !items.length ? (
        <PanelState message="아직 연결된 기업 뉴스가 없습니다." />
      ) : null}
    </>
  );
}

export function CompanyNewsPanel({ companyId }: { companyId: string; companyName: string }) {
  const [selected, setSelected] = useState<NewsTab>('activity');
  const { ref, visible } = useVisiblePanel();
  const prefix = useId();
  return (
    <aside className="company-news-panel" aria-label="종목 공시·뉴스" ref={ref}>
      <div className="company-news-tabs" role="tablist" aria-label="종목 소식 종류">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`${prefix}-${tab.id}`}
            role="tab"
            aria-selected={selected === tab.id}
            aria-controls={`${prefix}-panel`}
            tabIndex={selected === tab.id ? 0 : -1}
            onClick={() => setSelected(tab.id)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              const target = tabs[next];
              if (!target) return;
              setSelected(target.id);
              document.getElementById(`${prefix}-${target.id}`)?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        className="company-news-body"
        id={`${prefix}-panel`}
        role="tabpanel"
        aria-labelledby={`${prefix}-${selected}`}
        tabIndex={0}
        key={selected}
      >
        {selected === 'activity' ? (
          <RecentActivity companyId={companyId} visible={visible} />
        ) : null}
        {selected === 'news' ? (
          <>
            <RelatedNews companyId={companyId} visible={visible} />
          </>
        ) : null}
      </div>
    </aside>
  );
}
