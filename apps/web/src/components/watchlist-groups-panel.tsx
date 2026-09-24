import { companyPath } from '../lib/company-path';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  ArrowLeftRight,
  ExternalLink,
  LayoutGrid,
  List,
  RefreshCw,
  Settings2,
  Share2,
} from 'lucide-react';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useLocation, useOutletContext, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { watchlistAccessDenied } from '../lib/watchlist-access';
import { watchlistGroupsQuery, watchlistRoomsQuery } from '../lib/watchlist-query';
import { formatDate, formatMoney, formatPercent } from '../lib/format';
import { useVisiblePanel } from '../lib/use-visible-panel';
import { useMouseDragScroll } from '../lib/use-mouse-drag-scroll';
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from '../lib/use-media-query';
import type { Session, WatchlistGroupItem, WatchlistGroupPage } from '../types';
import { CompanyAvatar } from './company-avatar';
import { Button, Card, EmptyState, ErrorState, LoadingState } from './ui';
import { moveEntry } from './watchlist-dialog';
import { ChangeError, CopyGroupDialog, watchActorKey } from './watchlist-group-editors';
import { RoomDirectoryDialog, RoomManageDialog } from './watchlist-room-dialogs';
import { GroupManagerDialog } from './group-manager-dialog';
import { useStockContentPreference } from '../lib/stock-content-preference';
import { WatchGroupTabs } from './watch-group-tabs';
import { useRecentCompanies } from '../lib/recent-companies';
import { openWatchlistPopout } from '../lib/watchlist-popout';
import { staleWatchlistPrice, useWatchlistQuotes } from '../lib/use-watchlist-quotes';
import { RecentStocks } from './recent-stocks';
import { WatchlistNewsFeed, type WatchlistNewsRefresh } from './watchlist-news-feed';
import { WatchlistModeFrame } from './watchlist-mode-frame';
import './watchlist-groups-panel.css';
export const movedIds = (ids: string[], index: number, direction: -1 | 1) =>
  moveEntry(ids, index, index + direction);
export function StockSparkline({ points }: { points: WatchlistGroupItem['sparkline'] }) {
  const values = points.slice(-20).filter((p) => Number.isFinite(p.close) && p.close > 0);
  if (values.length < 2) return <span className="watch-group__chart-empty">종가 기록 부족</span>;
  const min = Math.min(...values.map((p) => p.close)),
    max = Math.max(...values.map((p) => p.close));
  return (
    <svg
      className="watch-group__sparkline"
      viewBox="0 0 160 40"
      role="img"
      aria-label={`최근 ${values.length}거래일 종가 추이 · ${values[0]!.sessionDate}부터 ${values.at(-1)!.sessionDate}까지`}
    >
      <polyline
        points={values
          .map(
            (p, i) =>
              `${(i * 160) / (values.length - 1)},${max === min ? 20 : 36 - ((p.close - min) / (max - min)) * 32}`,
          )
          .join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
export function WatchlistGroupStock({
  item,
  measurement = false,
  external = false,
}: {
  item: WatchlistGroupItem;
  measurement?: boolean;
  external?: boolean;
}) {
  const location = useLocation(),
    { company, displayPrice: price, recentActivity } = item;
  const basis = { LIVE: '실시간', STALE: '최근 체결', CLOSE: '종가', NONE: '시세 대기' };
  const contents = (
    <>
      <div className="watch-group-stock__company">
        {measurement ? <span className="company-avatar" /> : <CompanyAvatar company={company} />}
        <span>
          <strong>{company.nameKo}</strong>
          <small>
            {company.stockCode ?? company.ticker} · {company.market}
          </small>
        </span>
      </div>
      <div className="watch-group-stock__quote">
        <strong>{price.price === null ? '—' : formatMoney(price.price, price.currency)}</strong>
        <span className="watch-group-stock__basis">
          {price.sessionDate ? `${formatDate(price.sessionDate)} ` : ''}
          {basis[price.basis]}
        </span>
        <div
          className="watch-group-stock__change"
          data-direction={
            price.changePercent == null || price.changePercent === 0
              ? 'flat'
              : price.changePercent > 0
                ? 'up'
                : 'down'
          }
        >
          <b>
            {price.change == null
              ? '—'
              : `${price.change > 0 ? '+' : ''}${formatMoney(price.change, price.currency)}`}
          </b>
          <b>{formatPercent(price.changePercent)}</b>
        </div>
      </div>
      <div className="watch-group-stock__chart">
        <StockSparkline points={item.sparkline} />
      </div>
      <div className="watch-group-stock__activity">
        <span>최근 7일</span>
        <b>공시 {recentActivity.filingCount}</b>
        <b>이벤트 {recentActivity.eventCount}</b>
      </div>
    </>
  );
  // The hidden sizing grid has no links, IDs, image requests or interaction handlers.
  if (measurement) return <div className="watch-group-stock">{contents}</div>;
  return (
    <Link
      to={companyPath(company)}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      state={{ watchlistReturn: location.pathname + location.search }}
      className="watch-group-stock"
      aria-label={`${company.nameKo} 종목 상세`}
    >
      {contents}
    </Link>
  );
}
export function WatchlistGroupsPanel({
  compact = false,
  floating = false,
  headerActions,
}: {
  compact?: boolean;
  floating?: boolean;
  headerActions?: ReactNode;
}) {
  const session = useOutletContext<Session | undefined>(),
    actor = watchActorKey(session?.user),
    { ref, visible } = useVisiblePanel(),
    [params, setParams] = useSearchParams();
  const stacked = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const touchOnly = useMediaQuery('(hover: none) and (pointer: coarse)');
  const recentCompanies = useRecentCompanies(actor);
  const panelId = useId();
  const [filterHost, setFilterHost] = useState<HTMLDivElement | null>(null);
  const [newsRefresh, setNewsRefresh] = useState<WatchlistNewsRefresh | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const contentPreference = useStockContentPreference(actor);
  const spaceScroll = useMouseDragScroll();
  const showNews = (params.get('watchContent') ?? contentPreference.content) === 'news';
  const roomId = params.get('watchRoom') || undefined,
    view = params.has('watchView')
      ? params.get('watchView') === 'list'
        ? 'list'
        : 'grid'
      : stacked
        ? 'list'
        : 'grid';
  const recentSelected =
    ((compact || floating) && params.get('watchGroup') === 'recent') ||
    (compact && !params.has('watchGroup') && !roomId);
  const client = useQueryClient();
  const pageSize = stacked ? 3 : 6;
  const [blockedScope, setBlockedScope] = useState<string | null>(null);
  const scopeKey = `${actor}:${roomId ?? 'personal'}`;
  const [dialog, setDialog] = useState<
    'directory' | 'createRoom' | 'room' | 'groups' | 'copy' | null
  >(null);
  const rooms = useQuery({
    ...watchlistRoomsQuery(actor),
    enabled: !!actor && !!session?.canAccess && visible,
    refetchInterval: visible ? 60000 : false,
  });
  const room = rooms.data?.items.find((r) => r.id === roomId),
    scopeReady =
      !!actor &&
      !!session?.canAccess &&
      blockedScope !== scopeKey &&
      (!roomId || Boolean(room && !rooms.isError));
  const groups = useQuery({
    ...watchlistGroupsQuery(actor, roomId),
    enabled: !!actor && visible && scopeReady,
    refetchInterval: visible ? 60000 : false,
  });
  const selected = recentSelected
    ? undefined
    : (groups.data?.items.find((g) => g.id === params.get('watchGroup')) ?? groups.data?.items[0]);
  const tabs = [
    ...(compact || floating
      ? [{ id: 'recent', name: '최근조회', itemCount: recentCompanies.length }]
      : []),
    ...(groups.data?.items ?? []),
  ];
  const activeGroup = recentSelected ? 'recent' : selected?.id;
  const pageIndex = Math.max(
    0,
    Math.min(
      // Group metadata may lag behind the items response. Only cap at the 200-stock limit here.
      Math.floor(199 / pageSize),
      Math.floor(Number(params.get('watchPage')) || 0),
    ),
  );
  const offset = pageIndex * pageSize;
  const page = useQuery({
    queryKey: [
      'watchlist-v2',
      actor,
      'items',
      roomId ?? 'personal',
      selected?.id,
      offset,
      pageSize,
    ],
    queryFn: ({ signal }) => api.watchlistGroupItems(selected!.id, offset, signal, pageSize),
    enabled: compact && !!actor && visible && scopeReady && !!selected && !groups.isError,
    refetchInterval: visible ? 60000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const fullPage = useInfiniteQuery({
    queryKey: ['watchlist-v2', actor, 'full-items', roomId ?? 'personal', selected?.id, 20],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api.watchlistGroupItems(selected!.id, pageParam, signal, 20),
    getNextPageParam: (last, _pages, previousOffset) =>
      last.nextOffset !== null &&
      last.nextOffset > previousOffset &&
      last.nextOffset < Math.min(last.total, 200)
        ? last.nextOffset
        : undefined,
    enabled:
      !compact && !!actor && visible && scopeReady && !!selected && !groups.isError && !showNews,
    refetchInterval: visible && !showNews ? 60000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (compact || !selected) return;
    const key = ['watchlist-v2', actor, 'full-items', roomId ?? 'personal', selected.id, 20];
    // Returning to a group begins at its first batch; no other group's rows or scroll position carry over.
    return () => {
      client.setQueryData<InfiniteData<WatchlistGroupPage, number>>(key, (cached) =>
        cached
          ? { pages: cached.pages.slice(0, 1), pageParams: cached.pageParams.slice(0, 1) }
          : undefined,
      );
    };
  }, [actor, client, compact, roomId, selected?.id]);
  const fullLatest = fullPage.data?.pages.at(-1);
  const stockData = compact
    ? page.data
    : fullLatest
      ? {
          ...fullLatest,
          items: [
            ...new Map(
              fullPage
                .data!.pages.flatMap((batch) => batch.items)
                .map((item) => [item.company.id, item] as const),
            ).values(),
          ].slice(0, 200),
        }
      : undefined;
  const stockQuery = compact ? page : fullPage;
  const quotes = useWatchlistQuotes({
    actor,
    roomId,
    groupId: selected?.id,
    companyIds: stockData?.items.map((item) => item.company.id),
    fallbackItems: stockData?.items.map((item) => ({
      companyId: item.company.id,
      displayPrice: item.displayPrice,
    })),
    recentIds: recentSelected ? recentCompanies.map((company) => company.id) : undefined,
    enabled:
      floating &&
      visible &&
      scopeReady &&
      !showNews &&
      !groups.isError &&
      (recentSelected ? recentCompanies.length > 0 : Boolean(stockData?.items.length)),
  });
  const quotePrices = new Map(
    quotes.data?.items.map((item) => [item.companyId, item.displayPrice]),
  );
  const displayedStocks =
    stockData?.items.map((item) => ({
      ...item,
      displayPrice: floating
        ? staleWatchlistPrice(
            quotePrices.get(item.company.id) ?? item.displayPrice,
            quotes.isError || Boolean(quotes.data && !quotePrices.has(item.company.id)),
            quotes.data && quotePrices.has(item.company.id)
              ? { asOf: quotes.data.asOf, elapsedMs: quotes.elapsedSinceFetchMs }
              : {
                  asOf: stockData.asOf,
                  elapsedMs: Math.max(0, Date.now() - stockQuery.dataUpdatedAt),
                },
          )
        : item.displayPrice,
    })) ?? [];
  const loadMoreStocks = () => {
    if (
      !compact &&
      visible &&
      scopeReady &&
      !showNews &&
      !fullPage.isFetching &&
      fullPage.hasNextPage
    )
      void fullPage.fetchNextPage({ cancelRefetch: false });
  };
  const currentTotal = compact && !showNews && !recentSelected ? page.data?.total : undefined;
  useEffect(() => {
    if (currentTotal === undefined || offset === 0 || offset < currentTotal) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('watchPage', String(Math.max(0, Math.ceil(currentTotal / pageSize) - 1)));
        return next;
      },
      { replace: true },
    );
  }, [currentTotal, offset, pageSize, setParams]);
  const accessLost =
    [rooms.error, groups.error, page.error, fullPage.error, quotes.error].some(
      watchlistAccessDenied,
    ) || Boolean(roomId && rooms.isSuccess && !room);
  const blockAccess = useCallback(() => {
    setBlockedScope(scopeKey);
    setDialog(null);
    client.removeQueries({
      predicate: (q) =>
        (q.queryKey[0] === 'watchlist-v2' ||
          q.queryKey[0] === 'company-group-picker' ||
          (floating && q.queryKey[0] === 'company-quotes')) &&
        q.queryKey[1] === actor &&
        q.queryKey[2] !== 'rooms',
    });
  }, [actor, client, floating, scopeKey]);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const key = event.query.queryKey;
        const error = event.query.state.error;
        if (
          key[0] === 'watchlist-v2' &&
          key[1] === actor &&
          (key[2] === 'rooms' || key[3] === (roomId ?? 'personal')) &&
          watchlistAccessDenied(error)
        ) {
          blockAccess();
        }
      }),
    [actor, blockAccess, client, roomId],
  );
  useEffect(() => {
    if (accessLost) blockAccess();
  }, [accessLost, blockAccess]);
  const updateParams = (values: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [k, v] of Object.entries(values)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  const selectRoom = (id: string) => {
    setBlockedScope(null);
    updateParams({
      watchRoom: id || null,
      watchGroup: null,
      watchPage: null,
      watchCompany: null,
      watchNewsType: null,
    });
    setDialog(null);
  };
  const editable = stockData?.group ?? selected,
    permissions = groups.data?.permissions;
  const close = () => setDialog(null);
  const openPopout = () => {
    const selection = new URLSearchParams(params);
    if (activeGroup) selection.set('watchGroup', activeGroup);
    selection.set('watchView', view);
    selection.set('watchContent', showNews ? 'news' : 'stocks');
    setPopupBlocked(!openWatchlistPopout(selection));
  };
  return (
    <div ref={ref}>
      <Card
        className={`watch-groups observation-card${compact ? '' : ' watch-groups--full'}`}
        aria-label="관심 종목 그룹"
      >
        <header className="watch-groups__header observation-card__header">
          <div className="observation-card__heading">
            <h2>{compact ? '내 종목' : '관심 종목'}</h2>
            <span className="observation-card__count">
              {recentSelected
                ? recentCompanies.length
                : (stockData?.total ?? selected?.itemCount ?? 0)}
              종목
            </span>
          </div>
          <div className="watch-groups__actions">
            <Button
              size="sm"
              variant="ghost"
              aria-label="관심 종목 새로고침"
              title="관심 종목 새로고침"
              disabled={
                groups.isFetching ||
                stockQuery.isFetching ||
                Boolean(showNews && newsRefresh?.isFetching)
              }
              aria-busy={
                groups.isFetching ||
                stockQuery.isFetching ||
                Boolean(showNews && newsRefresh?.isFetching)
              }
              onClick={() => {
                setBlockedScope(null);
                void rooms.refetch();
                if (scopeReady) {
                  void groups.refetch();
                  if (showNews) void newsRefresh?.refresh();
                  void client.invalidateQueries({
                    queryKey: ['watchlist-v2', actor],
                    predicate: (query) =>
                      !showNews ||
                      !['group-news', 'group-filings'].includes(String(query.queryKey[2])),
                  });
                  if (recentSelected) {
                    void client.invalidateQueries({ queryKey: ['company-quotes', actor] });
                    if (!showNews) {
                      void client.invalidateQueries({
                        queryKey: ['news', actor, 'recent-companies'],
                      });
                    }
                  }
                }
              }}
            >
              <RefreshCw
                size={15}
                className={
                  groups.isFetching ||
                  stockQuery.isFetching ||
                  (showNews && newsRefresh?.isFetching)
                    ? 'spin'
                    : undefined
                }
                aria-hidden="true"
              />
            </Button>
            {!floating && !touchOnly ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="관심 종목 새창으로 열기"
                title="관심 종목 새창으로 열기"
                onClick={openPopout}
              >
                <ExternalLink size={15} aria-hidden="true" />
              </Button>
            ) : null}
            {headerActions}
          </div>
        </header>
        {popupBlocked ? (
          <p className="watch-groups__quote-status" role="alert">
            새창이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤{' '}
            <button className="text-link" onClick={openPopout}>
              다시 열기
            </button>
            를 눌러 주세요.
          </p>
        ) : null}
        {floating && scopeReady && !accessLost ? (
          <div className="watch-groups__quote-status">
            <span>{showNews ? '소식 보기 중 · 시세 확인 일시 중지' : '2초마다 시세 확인'}</span>
            {quotes.data ? (
              <time dateTime={quotes.data.asOf}>
                마지막 확인{' '}
                {new Intl.DateTimeFormat('ko-KR', {
                  timeZone: 'Asia/Seoul',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                }).format(new Date(quotes.data.asOf))}{' '}
                KST
              </time>
            ) : (
              <span>시세 확인 대기</span>
            )}
          </div>
        ) : null}
        <div
          className={`watch-groups__spaces mouse-drag-scroll${spaceScroll.dragging ? ' is-dragging' : ''}`}
          data-mouse-scrollable={spaceScroll.scrollable}
          {...spaceScroll.handlers}
        >
          <button
            className={!roomId ? 'is-active' : ''}
            aria-pressed={!roomId}
            onClick={() => selectRoom('')}
          >
            개인
          </button>
          <select
            aria-label="공유방 선택"
            value={roomId ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              if (value === 'action:create-room') setDialog('createRoom');
              else if (value === 'action:find-room') setDialog('directory');
              else selectRoom(value);
            }}
          >
            <option value="">공유방 선택</option>
            {rooms.data?.items.map((r) => (
              <option value={r.id} key={r.id}>
                {r.role === 'OWNER' ? '내 방 · ' : ''}
                {r.name}
              </option>
            ))}
            <option value="action:find-room">공유방 찾기</option>
            <option value="action:create-room">새 공유방 만들기</option>
          </select>
          {room ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog('room')}>
              <Settings2 size={14} />
              참여자·설정
            </Button>
          ) : null}
          {scopeReady && !accessLost ? (
            <div className="watch-groups__management">
              {permissions?.canManageGroups || editable?.canManageStocks ? (
                <Button size="sm" variant="ghost" onClick={() => setDialog('groups')}>
                  <Settings2 size={14} /> 그룹 관리
                </Button>
              ) : null}
              {selected && !roomId ? (
                <Button size="sm" variant="ghost" onClick={() => setDialog('copy')}>
                  <Share2 size={13} /> 공유
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {rooms.isError ? <ChangeError error={rooms.error} /> : null}
        {blockedScope === scopeKey ? (
          <p role="alert">
            접근 권한이 변경되어 목록을 비웠습니다. 공간을 다시 선택하거나 새로고침해 주세요.
          </p>
        ) : null}
        {!scopeReady && !rooms.isPending ? (
          <ErrorState
            message={
              roomId
                ? '공유방에 접근할 수 없습니다. 탈퇴·강퇴 또는 이용 승인 상태를 확인하세요.'
                : '개인 공간에 접근할 수 없습니다. 로그인 및 이용 승인 상태를 확인하세요.'
            }
            onRetry={() => {
              setBlockedScope(null);
              void rooms.refetch();
            }}
          />
        ) : null}
        {scopeReady && !accessLost ? (
          <>
            <div className="watch-groups__toolbar">
              <WatchGroupTabs
                tabs={tabs}
                selected={activeGroup}
                panelId={panelId}
                onSelect={(id) =>
                  updateParams({
                    watchGroup: id,
                    watchPage: null,
                    watchCompany: null,
                    watchNewsType: null,
                  })
                }
              />
              <button
                className="watch-groups__content-switch"
                type="button"
                aria-label={showNews ? '종목으로 전환' : '소식으로 전환'}
                title={showNews ? '종목으로 전환' : '소식으로 전환'}
                aria-controls={panelId}
                onClick={() => {
                  const value = showNews ? 'stocks' : 'news';
                  contentPreference.save(value);
                  updateParams({ watchContent: value });
                }}
              >
                <ArrowLeftRight size={14} aria-hidden="true" />
                {showNews ? '소식' : '종목'}
              </button>
            </div>
            <div className="watch-groups__tools">
              <div
                className="watch-groups__views"
                hidden={showNews}
                role="group"
                aria-label="관심 종목 보기 방식"
              >
                <button
                  type="button"
                  aria-label="그리드 보기"
                  title="그리드 보기"
                  aria-pressed={view === 'grid'}
                  onClick={() => updateParams({ watchView: 'grid' })}
                >
                  <LayoutGrid size={17} aria-hidden="true" />
                  그리드
                </button>
                <button
                  type="button"
                  aria-label="목록 보기"
                  title="목록 보기"
                  aria-pressed={view === 'list'}
                  onClick={() => updateParams({ watchView: 'list' })}
                >
                  <List size={17} aria-hidden="true" />
                  목록
                </button>
              </div>
              <div
                className={`watch-groups__news-filter${compact ? '' : ' watch-groups__news-controls'}`}
                ref={setFilterHost}
                hidden={!showNews}
              />
            </div>
            <div
              className="watch-groups__content"
              id={panelId}
              role={activeGroup ? 'tabpanel' : undefined}
              aria-labelledby={activeGroup ? `${panelId}-${activeGroup}` : undefined}
            >
              <WatchlistModeFrame
                compact={compact}
                newsKey={`${scopeKey}:${activeGroup}:${params.get('watchCompany') ?? ''}:${params.get('watchNewsType') ?? 'news'}`}
                showNews={showNews && (recentSelected || Boolean(selected))}
                news={
                  recentSelected ? (
                    <WatchlistNewsFeed
                      onRefreshChange={setNewsRefresh}
                      filterHost={filterHost}
                      inlineTabs={!compact}
                      externalCompanies={floating}
                      actor={actor}
                      recentCompanies={recentCompanies}
                      enabled={visible && !!session?.canAccess}
                      onAccessLost={blockAccess}
                    />
                  ) : selected ? (
                    <WatchlistNewsFeed
                      onRefreshChange={setNewsRefresh}
                      filterHost={filterHost}
                      inlineTabs={!compact}
                      externalCompanies={floating}
                      key={`${actor}:${roomId ?? 'personal'}:${selected.id}`}
                      actor={actor}
                      groupId={selected.id}
                      roomId={roomId}
                      enabled={visible && !!session?.canAccess && !accessLost}
                      onAccessLost={blockAccess}
                    />
                  ) : null
                }
                stocks={
                  recentSelected ? (
                    <RecentStocks
                      actor={actor}
                      companies={recentCompanies}
                      view={view}
                      visible={visible && !!session?.canAccess}
                      pageSize={floating ? 20 : pageSize}
                      floatingQuotes={floating ? quotes : undefined}
                    />
                  ) : groups.isPending ? (
                    <LoadingState label="그룹을 불러오는 중입니다." />
                  ) : groups.isError ? (
                    <ErrorState
                      message={groups.error.message}
                      onRetry={() => void groups.refetch()}
                    />
                  ) : !selected ? (
                    <EmptyState
                      title="관심 종목 그룹을 만들어 보세요"
                      description={
                        permissions?.canManageGroups
                          ? '그룹을 만들고 종목을 추가하세요.'
                          : '그룹 관리자가 그룹을 만들면 여기에 표시됩니다.'
                      }
                    />
                  ) : stockQuery.isPending ? (
                    <LoadingState label="시세와 최근 소식을 불러오는 중입니다." />
                  ) : stockQuery.isError && (compact || !stockData) ? (
                    <ErrorState
                      message={stockQuery.error.message}
                      onRetry={() => {
                        void groups.refetch();
                        void stockQuery.refetch();
                      }}
                    />
                  ) : stockData ? (
                    <>
                      <div
                        key={`${scopeKey}:${selected.id}`}
                        className={`watch-groups__stock-viewport${compact ? '' : ' watch-groups__stock-viewport--full'}`}
                        data-view={view}
                        role={compact ? undefined : 'region'}
                        aria-label={compact ? undefined : '관심 종목 전체 목록'}
                      >
                        {compact ? (
                          <div
                            className="watch-groups__stocks watch-groups__stocks--grid watch-groups__grid-measure"
                            aria-hidden="true"
                            inert
                          >
                            {stockData.items.map((item) => (
                              <WatchlistGroupStock key={item.company.id} item={item} measurement />
                            ))}
                          </div>
                        ) : null}
                        <div
                          className={`watch-groups__stocks watch-groups__stocks--${view} watch-groups__stocks--display`}
                        >
                          {displayedStocks.map((item) => (
                            <WatchlistGroupStock
                              key={item.company.id}
                              item={item}
                              external={floating}
                            />
                          ))}
                        </div>
                      </div>
                      {!stockData.items.length ? (
                        <EmptyState
                          title="아직 종목이 없습니다"
                          description={
                            editable?.canManageStocks
                              ? '그룹 관리에서 관심 종목을 추가하세요.'
                              : '종목 관리자가 등록하면 표시됩니다.'
                          }
                        />
                      ) : null}
                      {compact ? (
                        <footer className="watch-groups__pagination observation-card__pagination">
                          <small>
                            {stockData.total
                              ? `${offset + 1}–${offset + stockData.items.length} / ${stockData.total}종목`
                              : '0종목'}
                          </small>
                          {stockData.total > pageSize ? (
                            <div role="group" aria-label="관심 종목 페이지">
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label="이전 관심 종목"
                                disabled={!offset}
                                onClick={() => updateParams({ watchPage: String(pageIndex - 1) })}
                              >
                                이전
                              </Button>
                              <span aria-live="polite">
                                {pageIndex + 1} / {Math.ceil(stockData.total / pageSize)}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label="다음 관심 종목"
                                disabled={stockData.nextOffset == null}
                                onClick={() => updateParams({ watchPage: String(pageIndex + 1) })}
                              >
                                다음
                              </Button>
                            </div>
                          ) : null}
                          <Link to={`/watchlist?${params.toString()}`}>전체 관리</Link>
                        </footer>
                      ) : (
                        <div className="watch-groups__full-status">
                          <small aria-live="polite">
                            {stockData.items.length} / {stockData.total}종목
                          </small>
                          {fullPage.hasNextPage ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={fullPage.isFetching || !visible}
                              onClick={loadMoreStocks}
                            >
                              {fullPage.isFetchingNextPage ? '종목을 불러오는 중…' : '종목 더 보기'}
                            </Button>
                          ) : null}
                          {fullPage.isError ? (
                            <ErrorState
                              message="추가 종목을 불러오지 못했습니다."
                              onRetry={loadMoreStocks}
                            />
                          ) : null}
                        </div>
                      )}
                      <p className="watch-groups__period">
                        활동 기준 · {formatDate(stockData.windowStartDate)}–
                        {formatDate(stockData.windowEndDate)} KST
                      </p>
                    </>
                  ) : null
                }
              />
            </div>
          </>
        ) : null}
      </Card>
      {dialog === 'directory' || dialog === 'createRoom' ? (
        <RoomDirectoryDialog
          key={dialog}
          actor={actor}
          initialCreate={dialog === 'createRoom'}
          onClose={close}
          onSelect={selectRoom}
        />
      ) : null}
      {dialog === 'room' && roomId ? (
        <RoomManageDialog
          actor={actor}
          roomId={roomId}
          onClose={close}
          onLeft={() => selectRoom('')}
        />
      ) : null}
      {dialog === 'groups' ? (
        <GroupManagerDialog actor={actor} roomId={roomId} onClose={close} />
      ) : null}
      {dialog === 'copy' && selected ? (
        <CopyGroupDialog
          actor={actor}
          group={selected}
          rooms={rooms.data?.items ?? []}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
