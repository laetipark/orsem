import { useQuery } from '@tanstack/react-query';
import { Plus, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import type { WatchlistGroup } from '../types';
import { Button, Input, LoadingState } from './ui';
import { WatchlistDialog } from './watchlist-dialog';
import { ChangeError, GroupEditor, StockEditor, useWatchChange } from './watchlist-group-editors';

export function GroupManagerDialog({
  actor,
  roomId,
  onClose,
}: {
  actor: string;
  roomId?: string;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [stockGroup, setStockGroup] = useState<WatchlistGroup | null>(null);
  const change = useWatchChange(actor);
  const groups = useQuery({
    queryKey: ['watchlist-v2', actor, 'groups', roomId ?? 'personal'],
    queryFn: ({ signal }) => api.watchlistGroups(signal, roomId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (editing && groups.data && !groups.isError)
    return (
      <GroupEditor
        actor={actor}
        roomId={roomId}
        groups={groups.data.items}
        revision={groups.data.revision}
        canStocks={groups.data.permissions.canManageStocks}
        onClose={() => setEditing(false)}
      />
    );
  if (stockGroup && !groups.isError)
    return <StockEditor actor={actor} group={stockGroup} onClose={() => setStockGroup(null)} />;
  return (
    <WatchlistDialog
      title="그룹 관리"
      onClose={onClose}
      closeDisabled={change.isPending}
      mobileSheet
    >
      <p className="watch-help">
        {roomId ? '공유방' : '개인'} 그룹과 관심 종목을 이곳에서 관리하세요.
      </p>
      {groups.isPending ? (
        <LoadingState label="그룹을 불러오는 중입니다." />
      ) : groups.isError ? (
        <>
          <ChangeError error={groups.error} />
          <Button variant="secondary" onClick={() => void groups.refetch()}>
            다시 불러오기
          </Button>
        </>
      ) : groups.data ? (
        <>
          {groups.data.permissions.canManageGroups ? (
            <form
              className="watch-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim() || change.isPending) return;
                change.mutate(async () => {
                  const created = await api.createWatchlistGroup(name.trim(), roomId);
                  setStockGroup(created);
                  setName('');
                });
              }}
            >
              <Input
                aria-label="새 그룹 이름"
                placeholder="새 그룹 이름"
                maxLength={80}
                value={name}
                disabled={change.isPending}
                onChange={(event) => setName(event.target.value)}
              />
              <Button
                type="submit"
                disabled={!name.trim() || change.isPending || groups.data.items.length >= 20}
              >
                <Plus size={15} /> 그룹 추가
              </Button>
            </form>
          ) : null}
          {groups.data.items.length ? (
            <>
              <ul className="watch-manager-list">
                {groups.data.items.map((group) => (
                  <li key={group.id}>
                    <span>
                      <strong>{group.name}</strong>
                      <small>{group.itemCount}종목</small>
                    </span>
                    {group.canManageStocks ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={change.isPending}
                        onClick={() => setStockGroup(group)}
                      >
                        종목 추가·삭제
                      </Button>
                    ) : (
                      <small>읽기 전용</small>
                    )}
                  </li>
                ))}
              </ul>
              {groups.data.permissions.canManageGroups ? (
                <Button
                  variant="secondary"
                  disabled={change.isPending || groups.isFetching}
                  onClick={() => setEditing(true)}
                >
                  <Settings2 size={15} /> 그룹 이름·순서·삭제
                </Button>
              ) : null}
            </>
          ) : (
            <p className="watch-help">아직 그룹이 없습니다. 그룹을 만든 다음 종목을 추가하세요.</p>
          )}
        </>
      ) : null}
      <ChangeError error={change.error} />
      <footer className="watch-dialog__footer">
        <Button variant="secondary" onClick={onClose} disabled={change.isPending}>
          완료
        </Button>
      </footer>
    </WatchlistDialog>
  );
}
