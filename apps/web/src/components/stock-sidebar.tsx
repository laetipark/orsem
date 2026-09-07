import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Clock3, Plus, Settings2, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { watchlistAccessDenied } from '../lib/watchlist-access';
import { companyPath } from '../lib/company-path';
import { formatDate, formatMoney, formatPercent } from '../lib/format';
import { recentCompanyPrice } from '../lib/recent-company-quotes';
import { useMediaQuery } from '../lib/use-media-query';
import { useMouseDragScroll } from '../lib/use-mouse-drag-scroll';
import { useRecentCompanies, type RecentCompany } from '../lib/recent-companies';
import type { CompanyQuote, Session, WatchlistGroupItem } from '../types';
import { CompanyAvatar } from './company-avatar';
import { GroupManagerDialog } from './group-manager-dialog';
import { StockEditor, watchActorKey } from './watchlist-group-editors';
import './stock-sidebar.css';

type SidebarTab = 'interests' | 'recent';
interface Preference {
  open: boolean;
  tab: SidebarTab;
  roomId: string;
  groupId: string;
}
const storageKey = (actor: string) => `orsem-stock-sidebar-v1:${actor}`;

function readPreference(actor: string): Preference {
  try {
    const value = JSON.parse(
      localStorage.getItem(storageKey(actor)) ?? '{}',
    ) as Partial<Preference>;
    return {
      open: value.open === true,
      tab: value.tab === 'recent' ? 'recent' : 'interests',
      roomId: typeof value.roomId === 'string' ? value.roomId : '',
      groupId: typeof value.groupId === 'string' ? value.groupId : '',
    };
  } catch {
    return { open: false, tab: 'interests', roomId: '', groupId: '' };
  }
}

export function StockSidebar({
  session,
  onExpandedChange,
}: {
  session: Session;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const desktop = useMediaQuery('(min-width: 1200px)');
  const actor = watchActorKey(session.user);
  useEffect(() => {
    if (!desktop) onExpandedChange(false);
  }, [desktop, onExpandedChange]);
  return desktop && actor ? (
    <SidebarWorkspace key={actor} actor={actor} onExpandedChange={onExpandedChange} />
  ) : null;
}

function SidebarWorkspace({
  actor,
  onExpandedChange,
}: {
  actor: string;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [preference, setPreference] = useState(() => readPreference(actor));
  const [foreground, setForeground] = useState(document.visibilityState !== 'hidden');
  const [blocked, setBlocked] = useState(false);
  const [dialog, setDialog] = useState<'stocks' | 'groups' | null>(null);
  const client = useQueryClient();
  const recent = useRecentCompanies(actor);
  const { handlers, dragging, scrollable } = useMouseDragScroll();
  const { open, tab, roomId, groupId } = preference;
  const active = open && foreground;
  const interestsActive = active && tab === 'interests' && !blocked;
  const scope = roomId || 'personal';
  useEffect(() => {
    onExpandedChange(open);
    try {
      localStorage.setItem(storageKey(actor), JSON.stringify(preference));
    } catch {
      /* private mode */
    }
  }, [actor, open, preference, onExpandedChange]);
  useEffect(() => () => onExpandedChange(false), [onExpandedChange]);
  useEffect(() => {
    const update = () => setForeground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const key = event.query.queryKey;
        if (
          key[0] === 'watchlist-v2' &&
          key[1] === actor &&
          watchlistAccessDenied(event.query.state.error)
        ) {
          setBlocked(true);
          setDialog(null);
        }
      }),
    [actor, client],
  );
  const rooms = useQuery({
    queryKey: ['watchlist-v2', actor, 'rooms'],
    queryFn: ({ signal }) => api.watchlistRooms(signal),
    enabled: interestsActive,
    refetchInterval: interestsActive ? 60_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const room = rooms.data?.items.find((item) => item.id === roomId);
  const scopeReady = !blocked && (!roomId || Boolean(room && !rooms.isError));
  const groups = useQuery({
    queryKey: ['watchlist-v2', actor, 'groups', scope],
    queryFn: ({ signal }) => api.watchlistGroups(signal, roomId || undefined),
    enabled: interestsActive && scopeReady,
    refetchInterval: interestsActive && scopeReady ? 60_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const selected = groups.data?.items.find((item) => item.id === groupId) ?? groups.data?.items[0];
  const stocks = useInfiniteQuery({
    queryKey: ['watchlist-v2', actor, 'sidebar-items', scope, selected?.id, 20],
    queryFn: ({ signal, pageParam }) =>
      api.watchlistGroupItems(selected!.id, pageParam, signal, 20),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: interestsActive && scopeReady && !!selected && !groups.isError,
    refetchInterval: interestsActive && scopeReady && !!selected ? 60_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const ids = recent.map((company) => company.id);
  const quotes = useQuery({
    queryKey: ['company-quotes', actor, ids],
    queryFn: ({ signal }) => api.companyQuotes(ids, signal),
    enabled: active && tab === 'recent' && ids.length > 0,
    refetchInterval: active && tab === 'recent' && ids.length > 0 ? 60_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const accessLost =
    blocked ||
    [rooms.error, groups.error, stocks.error].some(watchlistAccessDenied) ||
    Boolean(roomId && rooms.isSuccess && !room);
  useEffect(() => {
    if (!accessLost) return;
    setBlocked(true);
    setDialog(null);
    client.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === 'watchlist-v2' &&
        query.queryKey[1] === actor &&
        query.queryKey[2] !== 'rooms',
    });
  }, [accessLost, actor, client]);
  const selectTab = (next: SidebarTab) =>
    setPreference((value) => ({
      ...value,
      tab: next,
      open: value.tab !== next || !value.open,
    }));
  const items = accessLost ? [] : (stocks.data?.pages.flatMap((page) => page.items) ?? []);
  const error = rooms.error ?? groups.error ?? stocks.error;
  return (
    <aside className={`stock-sidebar${open ? ' is-open' : ''}`} aria-label="관심·최근 조회 종목">
      {open ? (
        <section
          className="stock-sidebar__panel"
          id="stock-sidebar-panel"
          aria-label={tab === 'recent' ? '최근 조회 목록' : '관심 종목 목록'}
        >
          <header className="stock-sidebar__header">
            <h2>{tab === 'recent' ? '최근 본 종목' : '관심 종목'}</h2>
            <Link to="/watchlist">
              관심 종목 <ChevronRight size={14} />
            </Link>
          </header>
          {tab === 'interests' ? (
            <>
              <div className="stock-sidebar__selectors">
                <label className="sr-only" htmlFor="sidebar-room">
                  사이드바 개인·공유방
                </label>
                <select
                  id="sidebar-room"
                  value={roomId}
                  onChange={(event) => {
                    setBlocked(false);
                    setDialog(null);
                    setPreference((value) => ({
                      ...value,
                      roomId: event.target.value,
                      groupId: '',
                    }));
                  }}
                >
                  <option value="">개인</option>
                  {rooms.data?.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                {!accessLost ? (
                  <div
                    className={`stock-sidebar__groups mouse-drag-scroll${dragging ? ' is-dragging' : ''}`}
                    data-mouse-scrollable={scrollable}
                    aria-label="사이드바 그룹 선택"
                    {...handlers}
                  >
                    {groups.data?.items.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={item.id === selected?.id}
                        onClick={() => setPreference((value) => ({ ...value, groupId: item.id }))}
                      >
                        {item.name} <small>{item.itemCount}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="stock-sidebar__body">
                {accessLost ? (
                  <p role="alert">
                    접근 권한이 변경되어 목록을 비웠습니다. 개인 공간을 선택하거나 다시 확인해
                    주세요.
                  </p>
                ) : error ? (
                  <p role="alert">종목을 불러오지 못했습니다.</p>
                ) : groups.isPending || (selected && stocks.isPending) ? (
                  <p role="status">종목을 불러오는 중입니다.</p>
                ) : !items.length ? (
                  <p>등록된 종목이 없습니다. 그룹에 종목을 추가해 보세요.</p>
                ) : (
                  <ul className="stock-sidebar__list">
                    {items.map((item) => (
                      <StockRow
                        key={item.company.id}
                        company={item.company}
                        displayPrice={item.displayPrice}
                      />
                    ))}
                  </ul>
                )}
                {accessLost || error ? (
                  <button
                    className="stock-sidebar__action"
                    onClick={() => {
                      setBlocked(false);
                      void rooms.refetch();
                      if (!roomId || room) void groups.refetch();
                    }}
                  >
                    다시 확인
                  </button>
                ) : null}
                {!accessLost && stocks.hasNextPage ? (
                  <button
                    className="stock-sidebar__action"
                    disabled={stocks.isFetchingNextPage}
                    onClick={() => void stocks.fetchNextPage()}
                  >
                    {stocks.isFetchingNextPage ? '불러오는 중' : '종목 더 보기'}
                  </button>
                ) : null}
                {!accessLost && selected?.canManageStocks ? (
                  <button className="stock-sidebar__action" onClick={() => setDialog('stocks')}>
                    <Plus size={17} /> 종목 추가·삭제
                  </button>
                ) : null}
                {!accessLost && groups.data?.permissions.canManageGroups ? (
                  <button className="stock-sidebar__action" onClick={() => setDialog('groups')}>
                    <Settings2 size={16} /> 그룹 관리
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="stock-sidebar__body">
              <p className="stock-sidebar__hint">이 브라우저에서 최근 조회한 20종목</p>
              {!recent.length ? (
                <p>종목을 조회하면 여기에 표시됩니다.</p>
              ) : (
                <ul className="stock-sidebar__list">
                  {recent.map((company) => (
                    <RecentStockRow
                      key={company.id}
                      company={company}
                      quote={quotes.data?.items.find((item) => item.companyId === company.id)}
                      unavailable={quotes.isError}
                    />
                  ))}
                </ul>
              )}
              {quotes.isError ? <p role="status">시세를 확인하지 못했습니다.</p> : null}
            </div>
          )}
        </section>
      ) : null}
      <nav className="stock-sidebar__rail" aria-label="종목 빠른 메뉴">
        <button
          type="button"
          aria-label={open ? '종목 사이드바 접기' : '종목 사이드바 펼치기'}
          aria-expanded={open}
          aria-controls={open ? 'stock-sidebar-panel' : undefined}
          onClick={() => setPreference((value) => ({ ...value, open: !value.open }))}
        >
          {open ? <ChevronRight size={21} /> : <ChevronLeft size={21} />}
        </button>
        <button
          type="button"
          aria-label="관심 종목 사이드바"
          aria-pressed={open && tab === 'interests'}
          onClick={() => selectTab('interests')}
        >
          <Star size={20} />
          <span>관심</span>
        </button>
        <button
          type="button"
          aria-label="최근 본 종목 사이드바"
          aria-pressed={open && tab === 'recent'}
          onClick={() => selectTab('recent')}
        >
          <Clock3 size={20} />
          <span>최근 본</span>
        </button>
      </nav>
      {open && !accessLost && dialog === 'stocks' && selected ? (
        <StockEditor actor={actor} group={selected} onClose={() => setDialog(null)} />
      ) : null}
      {open && !accessLost && dialog === 'groups' ? (
        <GroupManagerDialog
          actor={actor}
          roomId={roomId || undefined}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </aside>
  );
}

function StockRow({
  company,
  displayPrice,
}: {
  company: WatchlistGroupItem['company'];
  displayPrice: WatchlistGroupItem['displayPrice'];
}) {
  return (
    <li>
      <Link className="stock-sidebar__stock" to={companyPath(company)}>
        <CompanyAvatar company={company} />
        <span className="stock-sidebar__company">
          <strong>{company.nameKo}</strong>
          <small>
            {company.stockCode ?? company.ticker} · {company.market}
          </small>
        </span>
        <span className="stock-sidebar__quote">
          <strong>{formatMoney(displayPrice.price, displayPrice.currency)}</strong>
          <small
            data-direction={
              displayPrice.changePercent == null || displayPrice.changePercent === 0
                ? 'flat'
                : displayPrice.changePercent > 0
                  ? 'up'
                  : 'down'
            }
          >
            {formatPercent(displayPrice.changePercent)}
          </small>
          <em>
            {displayPrice.basis === 'LIVE'
              ? '실시간'
              : displayPrice.basis === 'CLOSE'
                ? `${formatDate(displayPrice.sessionDate)} 종가`
                : displayPrice.basis === 'STALE'
                  ? '최근 체결'
                  : '시세 대기'}
          </em>
        </span>
      </Link>
    </li>
  );
}

function RecentStockRow({
  company,
  quote,
  unavailable,
}: {
  company: RecentCompany;
  quote?: CompanyQuote;
  unavailable: boolean;
}) {
  const displayPrice =
    !unavailable && quote
      ? quote.displayPrice
      : recentCompanyPrice(undefined, company.market, unavailable);
  return (
    <StockRow company={{ ...company, nameEn: company.nameEn ?? '' }} displayPrice={displayPrice} />
  );
}
