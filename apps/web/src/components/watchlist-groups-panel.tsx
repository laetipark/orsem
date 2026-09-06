import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, LayoutGrid, List, Plus, RefreshCw, Settings2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useOutletContext, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDate, formatMoney, formatPercent } from '../lib/format';
import { useVisiblePanel } from '../lib/use-visible-panel';
import type { Session, WatchlistGroupItem } from '../types';
import { CompanyAvatar } from './company-avatar';
import { Button, Card, EmptyState, ErrorState, Input, LoadingState } from './ui';
import { WatchlistDialog, moveEntry } from './watchlist-dialog';
import {
  ChangeError,
  CopyGroupDialog,
  GroupEditor,
  StockEditor,
  useWatchChange,
  watchActorKey,
} from './watchlist-group-editors';
import { RoomDirectoryDialog, RoomManageDialog, RoomOrderDialog } from './watchlist-room-dialogs';
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
export function WatchlistGroupStock({ item }: { item: WatchlistGroupItem }) {
  const location = useLocation(),
    { company, displayPrice: price, recentActivity } = item;
  const basis = { LIVE: '실시간', STALE: '최근 체결', CLOSE: '종가', NONE: '시세 대기' };
  return (
    <Link
      to={`/companies/${encodeURIComponent(company.id)}`}
      state={{ watchlistReturn: location.pathname + location.search }}
      className="watch-group-stock"
      aria-label={`${company.nameKo} 종목 상세`}
    >
      <div className="watch-group-stock__company">
        <CompanyAvatar company={company} />
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
    </Link>
  );
}
export function WatchlistGroupsPanel({ compact = false }: { compact?: boolean }) {
  const session = useOutletContext<Session | undefined>(),
    actor = watchActorKey(session?.user),
    { ref, visible } = useVisiblePanel(),
    [params, setParams] = useSearchParams();
  const roomId = params.get('watchRoom') || undefined,
    view = params.get('watchView') === 'list' ? 'list' : 'grid';
  const client = useQueryClient();
  const [blockedScope, setBlockedScope] = useState<string | null>(null);
  const scopeKey = roomId ?? 'personal';
  const offset = Math.max(
    0,
    Math.min(189, Math.floor(Number(params.get('watchPage') || 0) || 0) * 21),
  );
  const [dialog, setDialog] = useState<
      'directory' | 'room' | 'roomOrder' | 'create' | 'groups' | 'stocks' | 'copy' | null
    >(null),
    [name, setName] = useState(''),
    change = useWatchChange(actor);
  const rooms = useQuery({
    queryKey: ['watchlist-v2', actor, 'rooms'],
    queryFn: ({ signal }) => api.watchlistRooms(signal),
    enabled: !!actor && visible,
    refetchInterval: visible ? 60000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const room = rooms.data?.items.find((r) => r.id === roomId),
    scopeReady = blockedScope !== scopeKey && (!roomId || Boolean(room && !rooms.isError));
  const groups = useQuery({
    queryKey: ['watchlist-v2', actor, 'groups', roomId ?? 'personal'],
    queryFn: ({ signal }) => api.watchlistGroups(signal, roomId),
    enabled: !!actor && visible && scopeReady,
    refetchInterval: visible ? 60000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const selected =
    groups.data?.items.find((g) => g.id === params.get('watchGroup')) ?? groups.data?.items[0];
  const page = useQuery({
    queryKey: ['watchlist-v2', actor, 'items', roomId ?? 'personal', selected?.id, offset],
    queryFn: ({ signal }) => api.watchlistGroupItems(selected!.id, offset, signal),
    enabled: !!actor && visible && scopeReady && !!selected && !groups.isError,
    refetchInterval: visible ? 60000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const accessLost =
    [rooms.error, groups.error, page.error].some(
      (error) => error instanceof ApiError && [401, 403, 404].includes(error.statusCode),
    ) || Boolean(roomId && rooms.isSuccess && !room);
  useEffect(() => {
    if (!accessLost || blockedScope === scopeKey) return;
    setBlockedScope(scopeKey);
    setDialog(null);
    client.removeQueries({
      predicate: (q) =>
        (q.queryKey[0] === 'watchlist-v2' || q.queryKey[0] === 'company-group-picker') &&
        q.queryKey[1] === actor &&
        q.queryKey[2] !== 'rooms',
    });
  }, [accessLost, actor, blockedScope, client, scopeKey]);
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
    updateParams({ watchRoom: id || null, watchGroup: null, watchPage: null });
    setDialog(null);
  };
  const editable = page.data?.group ?? selected,
    permissions = groups.data?.permissions;
  const close = () => setDialog(null);
  return (
    <div ref={ref}>
      <Card className="watch-groups" aria-label="관심종목 그룹">
        <header className="watch-groups__header">
          <h2>관심종목</h2>
          <div className="watch-groups__actions">
            <Button size="sm" variant="ghost" onClick={() => setDialog('directory')}>
              <Users size={15} />
              공유방 찾기·만들기
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="관심종목 새로고침"
              disabled={groups.isFetching || page.isFetching}
              onClick={() => {
                setBlockedScope(null);
                void rooms.refetch();
                if (scopeReady) {
                  void groups.refetch();
                  if (selected) void page.refetch();
                }
              }}
            >
              <RefreshCw size={15} />
            </Button>
          </div>
        </header>
        <div className="watch-groups__spaces">
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
            onChange={(e) => selectRoom(e.target.value)}
          >
            <option value="">공유방 선택</option>
            {rooms.data?.items.map((r) => (
              <option value={r.id} key={r.id}>
                {r.role === 'OWNER' ? '내 방 · ' : ''}
                {r.name}
              </option>
            ))}
          </select>
          {room ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog('room')}>
              <Settings2 size={14} />
              참여자·설정
            </Button>
          ) : null}
          {(rooms.data?.items.length ?? 0) > 1 ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog('roomOrder')}>
              방 순서
            </Button>
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
            message="공유방에 접근할 수 없습니다. 탈퇴·강퇴 또는 이용 승인 상태를 확인하세요."
            onRetry={() => {
              void rooms.refetch();
            }}
          />
        ) : null}
        {scopeReady ? (
          <>
            <div className="watch-groups__toolbar">
              <div className="watch-groups__tabs" role="tablist" aria-label="관심종목 그룹 선택">
                {groups.data?.items.map((g) => (
                  <button
                    key={g.id}
                    role="tab"
                    aria-selected={selected?.id === g.id}
                    tabIndex={selected?.id === g.id ? 0 : -1}
                    onClick={() => updateParams({ watchGroup: g.id, watchPage: null })}
                    onKeyDown={(e) => {
                      const list = groups.data.items,
                        index = list.findIndex((x) => x.id === g.id);
                      const target =
                        e.key === 'ArrowRight'
                          ? (index + 1) % list.length
                          : e.key === 'ArrowLeft'
                            ? (index + list.length - 1) % list.length
                            : e.key === 'Home'
                              ? 0
                              : e.key === 'End'
                                ? list.length - 1
                                : null;
                      if (target !== null) {
                        e.preventDefault();
                        updateParams({ watchGroup: list[target]!.id, watchPage: null });
                        const tabs =
                          e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            '[role=tab]',
                          );
                        tabs?.[target]?.focus();
                      }
                    }}
                  >
                    {g.name}
                    <small>{g.itemCount}</small>
                  </button>
                ))}
              </div>
              <div className="watch-groups__views" role="group" aria-label="관심종목 보기 방식">
                <button
                  aria-label="그리드 보기"
                  aria-pressed={view === 'grid'}
                  onClick={() => updateParams({ watchView: 'grid' })}
                >
                  <LayoutGrid size={17} />
                </button>
                <button
                  aria-label="목록 보기"
                  aria-pressed={view === 'list'}
                  onClick={() => updateParams({ watchView: 'list' })}
                >
                  <List size={17} />
                </button>
              </div>
            </div>
            <div className="watch-groups__tools">
              {permissions?.canManageGroups ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setName('');
                      setDialog('create');
                    }}
                  >
                    <Plus size={14} />
                    그룹 추가
                  </Button>
                  {groups.data?.items.length ? (
                    <Button size="sm" variant="ghost" onClick={() => setDialog('groups')}>
                      그룹 편집
                    </Button>
                  ) : null}
                </>
              ) : null}
              {editable?.canManageStocks ? (
                <Button size="sm" variant="ghost" onClick={() => setDialog('stocks')}>
                  종목 편집
                </Button>
              ) : null}
              {selected && !roomId ? (
                <Button size="sm" variant="ghost" onClick={() => setDialog('copy')}>
                  <Copy size={13} />
                  공유방에 복사
                </Button>
              ) : null}
              <small>
                {room
                  ? `${room.memberCount}명 · ${room.role === 'OWNER' ? '방장' : room.role === 'ADMIN' ? '방 관리자' : '참여 중'}`
                  : '나만 볼 수 있는 개인 공간'}
              </small>
            </div>
            <div className="watch-groups__content">
              {groups.isPending ? (
                <LoadingState label="그룹을 불러오는 중입니다." />
              ) : groups.isError ? (
                <ErrorState message={groups.error.message} onRetry={() => void groups.refetch()} />
              ) : !selected ? (
                <EmptyState
                  title="관심종목 그룹을 만들어 보세요"
                  description={
                    permissions?.canManageGroups
                      ? '그룹을 만들고 종목을 추가하세요.'
                      : '그룹 관리자가 그룹을 만들면 여기에 표시됩니다.'
                  }
                />
              ) : page.isPending ? (
                <LoadingState label="시세와 최근 소식을 불러오는 중입니다." />
              ) : page.isError ? (
                <ErrorState
                  message={page.error.message}
                  onRetry={() => {
                    void groups.refetch();
                    void page.refetch();
                  }}
                />
              ) : page.data ? (
                <>
                  <div className={`watch-groups__stocks watch-groups__stocks--${view}`}>
                    {page.data.items.map((item) => (
                      <WatchlistGroupStock key={item.company.id} item={item} />
                    ))}
                  </div>
                  {!page.data.items.length ? (
                    <EmptyState
                      title="아직 종목이 없습니다"
                      description={
                        editable?.canManageStocks
                          ? '종목 편집에서 관심종목을 추가하세요.'
                          : '종목 관리자가 등록하면 표시됩니다.'
                      }
                    />
                  ) : null}
                  <footer className="watch-groups__pagination">
                    <small>
                      {page.data.total}종목 · 최근 7일 {formatDate(page.data.windowStartDate)}–
                      {formatDate(page.data.windowEndDate)} KST
                    </small>
                    {page.data.total > 21 ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!offset}
                          onClick={() => updateParams({ watchPage: String(offset / 21 - 1) })}
                        >
                          이전
                        </Button>
                        <span>{offset / 21 + 1}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={page.data.nextOffset == null}
                          onClick={() => updateParams({ watchPage: String(offset / 21 + 1) })}
                        >
                          다음
                        </Button>
                      </>
                    ) : null}
                    {compact ? <Link to={`/watchlist?${params.toString()}`}>전체 관리</Link> : null}
                  </footer>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </Card>
      {dialog === 'directory' ? (
        <RoomDirectoryDialog actor={actor} onClose={close} onSelect={selectRoom} />
      ) : null}
      {dialog === 'room' && roomId ? (
        <RoomManageDialog
          actor={actor}
          roomId={roomId}
          onClose={close}
          onLeft={() => selectRoom('')}
        />
      ) : null}
      {dialog === 'roomOrder' ? (
        <RoomOrderDialog actor={actor} rooms={rooms.data?.items ?? []} onClose={close} />
      ) : null}
      {dialog === 'groups' && groups.data ? (
        <GroupEditor
          actor={actor}
          roomId={roomId}
          groups={groups.data.items}
          revision={groups.data.revision}
          canStocks={permissions?.canManageStocks ?? false}
          onClose={close}
        />
      ) : null}
      {dialog === 'stocks' && selected ? (
        <StockEditor actor={actor} group={selected} onClose={close} />
      ) : null}
      {dialog === 'copy' && selected ? (
        <CopyGroupDialog
          actor={actor}
          group={selected}
          rooms={rooms.data?.items ?? []}
          onClose={close}
        />
      ) : null}
      {dialog === 'create' ? (
        <WatchlistDialog title="그룹 추가" onClose={close}>
          <form
            className="watch-room-form"
            onSubmit={(e) => {
              e.preventDefault();
              change.mutate(async () => {
                const g = await api.createWatchlistGroup(name.trim(), roomId);
                updateParams({ watchGroup: g.id, watchPage: null });
                close();
              });
            }}
          >
            <label>
              그룹 이름
              <Input
                autoFocus
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <ChangeError error={change.error} />
            <footer className="watch-dialog__footer">
              <Button type="button" variant="ghost" onClick={close}>
                취소
              </Button>
              <Button type="submit" disabled={!name.trim() || change.isPending}>
                추가
              </Button>
            </footer>
          </form>
        </WatchlistDialog>
      ) : null}
    </div>
  );
}
