import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useGroupReorder } from '../lib/use-group-reorder';
import type { WatchlistGroup } from '../types';
import { Button, Input, LoadingState } from './ui';
import { WatchlistDialog } from './watchlist-dialog';
import { ChangeError, StockEditor, useWatchChange } from './watchlist-group-editors';
import './group-manager-dialog.css';

type GroupCollection = Awaited<ReturnType<typeof api.watchlistGroups>>;
type GroupDraft = {
  base: GroupCollection;
  ids: string[];
  names: Record<string, string>;
  deleted: string[];
};
const snapshot = (data: GroupCollection): GroupCollection => ({
  ...data,
  permissions: { ...data.permissions },
  items: data.items.map((group) => ({ ...group })),
});
const beginDraft = (base: GroupCollection): GroupDraft => ({
  base: snapshot(base),
  ids: base.items.map(({ id }) => id),
  names: {},
  deleted: [],
});
function draftRows(draft: GroupDraft): WatchlistGroup[] {
  return draft.ids.flatMap((id) => {
    const group = draft.base.items.find((item) => item.id === id);
    return group ? [{ ...group, name: draft.names[id] ?? group.name }] : [];
  });
}
const draftItems = (draft: GroupDraft) =>
  draftRows(draft)
    .filter((group) => !draft.deleted.includes(group.id))
    .map((group) => ({ ...group, name: group.name.trim() }));
const hasChanges = (draft: GroupDraft) => {
  const items = draftItems(draft);
  return (
    items.length !== draft.base.items.length ||
    items.some(
      (group, index) =>
        group.id !== draft.base.items[index]?.id || group.name !== draft.base.items[index]?.name,
    )
  );
};

export function GroupManagerDialog(props: { actor: string; roomId?: string; onClose: () => void }) {
  return <GroupManagerScope key={`${props.actor}:${props.roomId ?? 'personal'}`} {...props} />;
}
function GroupManagerScope({
  actor,
  roomId,
  onClose,
}: {
  actor: string;
  roomId?: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const instructionId = useId();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<GroupDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saved, setSaved] = useState<GroupCollection | null>(null);
  const [notice, setNotice] = useState('');
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [missingEdit, setMissingEdit] = useState(false);
  const [stockGroup, setStockGroup] = useState<WatchlistGroup | null>(null);
  const dragBase = useRef<GroupDraft | null>(null);
  const change = useWatchChange(actor);
  const queryKey = ['watchlist-v2', actor, 'groups', roomId ?? 'personal'];
  const groups = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.watchlistGroups(signal, roomId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  // A confirmed write must not be replaced by an older response already in flight.
  const current =
    saved && (!groups.data || groups.data.revision < saved.revision) ? saved : groups.data;
  const permissions = groups.data?.permissions ?? current?.permissions;
  const canManage = !!permissions?.canManageGroups && !groups.isError;
  const conflict = !!draft && change.error instanceof ApiError && change.error.statusCode === 409;
  const busy = change.isPending || groups.isFetching;
  const rows = draft ? draftRows(draft) : (current?.items ?? []);
  const pendingDeleteDenied = !!draft?.deleted.some(
    (id) =>
      !permissions?.canManageStocks &&
      (current?.items.find((group) => group.id === id)?.itemCount ?? 0) > 0,
  );
  const dirty = draft ? hasChanges(draft) : false;

  function applySaved(next: GroupCollection) {
    setSaved(next);
    client.setQueryData<GroupCollection>(queryKey, (cached) =>
      cached && cached.revision > next.revision ? cached : next,
    );
  }
  function close() {
    setDraft(null);
    setEditingId(null);
    onClose();
  }
  function updateDraft(next: GroupDraft) {
    setDraft(next);
    if (!conflict) {
      change.reset();
      setNotice('');
    }
  }
  async function refreshDraft(next: GroupDraft) {
    setNeedsRefresh(true);
    const result = await groups.refetch();
    if (result.isError || !result.data) {
      setRefreshError(new Error('최신 목록을 불러오지 못했습니다. 저장을 누르면 다시 확인합니다.'));
      return;
    }
    const base = snapshot(result.data);
    const retained = next.ids.filter((id) => base.items.some((group) => group.id === id));
    const added = base.items.filter((group) => !next.ids.includes(group.id)).map(({ id }) => id);
    const reordered = next.ids.some((id, index) => id !== next.base.items[index]?.id);
    const missing = Object.keys(next.names).filter(
      (id) => !base.items.some((group) => group.id === id),
    );
    setDraft({
      ...next,
      base,
      ids: reordered ? [...retained, ...added] : base.items.map(({ id }) => id),
      deleted: next.deleted.filter((id) => retained.includes(id)),
    });
    setMissingEdit(missing.length > 0);
    setNeedsRefresh(false);
    setRefreshError(null);
    setNotice(
      missing.length
        ? '수정 중인 그룹이 다른 곳에서 삭제되었습니다. 초안은 유지했지만 저장할 수 없습니다. 취소 후 목록을 확인해 주세요.'
        : !base.permissions.canManageGroups
          ? '최신 목록을 확인했습니다. 그룹 관리 권한이 없어 저장할 수 없습니다.'
          : '최신 목록과 추가된 그룹을 반영했습니다. 수정 내용을 확인한 뒤 저장을 다시 눌러 주세요.',
    );
  }
  function saveDraft() {
    if (!draft || busy) return;
    if (needsRefresh) {
      void refreshDraft(draft);
      return;
    }
    if (!canManage || missingEdit || pendingDeleteDenied || !dirty) return;
    const next = draft;
    const items = draftItems(next);
    if (items.some((group) => !group.name)) return;
    setNotice('');
    setRefreshError(null);
    change.mutate(async () => {
      try {
        await api.saveWatchlistGroups({
          roomId,
          revision: next.base.revision,
          groups: items.map(({ id, name: groupName }) => ({ id, name: groupName })),
        });
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 409) await refreshDraft(next);
        throw error;
      }
      applySaved({
        ...next.base,
        revision: next.base.revision + 1,
        items: items.map((group) => ({ ...group, revision: (group.revision ?? 0) + 1 })),
      });
      setDraft(null);
      setEditingId(null);
      setNotice('변경 사항을 저장했습니다.');
    });
  }
  const reorder = useGroupReorder({
    ids: rows.map(({ id }) => id),
    disabled: !canManage || busy || needsRefresh || missingEdit,
    onReorder: (ids) => {
      if (!current || !canManage || busy || needsRefresh || missingEdit) return;
      const next = dragBase.current ?? draft ?? beginDraft(current);
      dragBase.current = null;
      if (
        ids.length !== next.ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !next.ids.includes(id))
      )
        return;
      updateDraft({ ...next, ids });
    },
  });

  if (stockGroup && !groups.isError && permissions?.canManageStocks)
    return <StockEditor actor={actor} group={stockGroup} onClose={() => setStockGroup(null)} />;
  return (
    <WatchlistDialog title="그룹 관리" onClose={close} closeDisabled={change.isPending} mobileSheet>
      {groups.isPending ? (
        <LoadingState label="그룹을 불러오는 중입니다." />
      ) : current ? (
        <>
          {canManage ? (
            <form
              className="watch-inline-form group-manager__create"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim() || busy || draft) return;
                const base = snapshot(current);
                change.mutate(async () => {
                  const created = await api.createWatchlistGroup(name.trim(), roomId);
                  applySaved({
                    ...base,
                    revision: base.revision + 1,
                    items: [...base.items, created],
                  });
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
                disabled={busy || !!draft}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" disabled={!name.trim() || busy || !!draft || rows.length >= 20}>
                <Plus size={15} /> 그룹 추가
              </Button>
            </form>
          ) : null}
          {rows.length ? (
            <>
              <span id={instructionId} className="sr-only">
                손잡이를 끌거나 위아래 방향키로 그룹 순서를 바꿀 수 있습니다. Home은 처음, End는
                마지막으로 이동합니다. 변경한 순서는 하단 저장을 누르면 반영됩니다.
              </span>
              <ul ref={reorder.listRef} className="group-manager__list" aria-label="관심 그룹">
                {rows.map((group) => {
                  const renaming = editingId === group.id;
                  const deleting = !!draft?.deleted.includes(group.id);
                  const canDelete =
                    canManage && (permissions?.canManageStocks || group.itemCount === 0);
                  const handleProps = reorder.getHandleProps(group.id);
                  const dropClass =
                    reorder.targetId === group.id && reorder.dropPosition
                      ? ` is-drop-${reorder.dropPosition}`
                      : '';
                  return (
                    <li
                      key={group.id}
                      data-sort-id={group.id}
                      className={`group-manager__row${renaming ? ' is-editing' : ''}${deleting ? ' is-deleting' : ''}${reorder.draggedId === group.id ? ' is-dragging' : ''}${dropClass}`}
                    >
                      {canManage ? (
                        <button
                          type="button"
                          className="group-manager__handle"
                          aria-label={`${group.name} 순서 변경`}
                          aria-describedby={instructionId}
                          disabled={rows.length < 2}
                          aria-disabled={busy || needsRefresh || missingEdit || rows.length < 2}
                          tabIndex={busy || needsRefresh || missingEdit ? -1 : 0}
                          {...handleProps}
                          onPointerDown={(event) => {
                            dragBase.current = draft ?? beginDraft(current);
                            handleProps.onPointerDown(event);
                          }}
                          onKeyDown={(event) => {
                            dragBase.current = null;
                            handleProps.onKeyDown(event);
                          }}
                        >
                          <GripVertical size={18} />
                        </button>
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      <div className="group-manager__main">
                        {renaming ? (
                          <div className="group-manager__rename">
                            <Input
                              aria-label="그룹 이름"
                              autoFocus
                              maxLength={80}
                              value={draft?.names[group.id] ?? group.name}
                              disabled={busy || !canManage || needsRefresh || missingEdit}
                              onChange={(event) => {
                                const next = draft ?? beginDraft(current);
                                updateDraft({
                                  ...next,
                                  names: { ...next.names, [group.id]: event.target.value },
                                });
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  setEditingId(null);
                                }
                              }}
                            />
                          </div>
                        ) : (
                          <div className="group-manager__name">
                            <strong title={group.name}>{group.name}</strong>
                            {canManage ? (
                              <button
                                type="button"
                                className="group-manager__icon"
                                aria-label={`${group.name} 이름 수정`}
                                disabled={busy || deleting || needsRefresh || missingEdit}
                                onClick={() => {
                                  setEditingId(group.id);
                                  if (!draft) updateDraft(beginDraft(current));
                                }}
                              >
                                <Pencil size={14} />
                              </button>
                            ) : null}
                          </div>
                        )}
                        <small>{group.itemCount}종목</small>
                      </div>
                      <div className="group-manager__actions">
                        {permissions?.canManageStocks && group.canManageStocks ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy || !!draft}
                            onClick={() => setStockGroup(group)}
                          >
                            종목 설정
                          </Button>
                        ) : (
                          <small>읽기 전용</small>
                        )}
                        {canManage ? (
                          <button
                            type="button"
                            className="group-manager__icon group-manager__delete"
                            aria-label={`${group.name} ${deleting ? '삭제 취소' : '그룹 삭제'}`}
                            aria-pressed={deleting}
                            title={
                              canDelete
                                ? deleting
                                  ? '삭제 취소'
                                  : '그룹 삭제'
                                : '종목이 있는 그룹을 삭제하려면 종목 관리 권한이 필요합니다.'
                            }
                            disabled={
                              busy || needsRefresh || missingEdit || (!canDelete && !deleting)
                            }
                            onClick={() => {
                              const next = draft ?? beginDraft(current);
                              updateDraft({
                                ...next,
                                deleted: deleting
                                  ? next.deleted.filter((id) => id !== group.id)
                                  : [...next.deleted, group.id],
                              });
                              if (editingId === group.id) setEditingId(null);
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        ) : null}
                      </div>
                      {deleting ? (
                        <div
                          className="group-manager__confirmation"
                          role="group"
                          aria-label={`${group.name} 삭제 확인`}
                        >
                          <p>
                            <strong>{group.name}</strong> 그룹을 삭제할까요?
                            {group.itemCount > 0
                              ? ` 등록된 ${group.itemCount}종목도 이 그룹에서 제거됩니다.`
                              : ''}
                            {roomId ? ' 공유방의 모든 참여자에게 적용됩니다.' : ''} 하단 저장을
                            누르면 삭제됩니다.
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="watch-help">아직 그룹이 없습니다. 그룹을 만든 다음 종목을 추가하세요.</p>
          )}
        </>
      ) : null}
      {!needsRefresh ? <ChangeError error={groups.error} /> : null}
      {conflict ? (
        <p role="alert" className="form-error">
          다른 곳에서 그룹이 변경되었습니다. 초안은 유지했습니다.{' '}
          {notice || '최신 목록과 권한을 확인하고 있습니다.'}
        </p>
      ) : (
        <ChangeError error={change.error} />
      )}
      <ChangeError error={refreshError} />
      {pendingDeleteDenied ? (
        <p role="alert" className="form-error">
          종목 관리 권한이 없어 종목이 있는 그룹을 삭제할 수 없습니다. 삭제 선택을 취소해 주세요.
        </p>
      ) : null}
      {notice && !conflict ? (
        <p className="watch-help" role="status">
          {notice}
        </p>
      ) : null}
      <footer className="watch-dialog__footer">
        <Button variant="secondary" onClick={close} disabled={change.isPending}>
          취소
        </Button>
        <Button
          onClick={saveDraft}
          disabled={
            busy ||
            !draft ||
            (!needsRefresh &&
              (!canManage ||
                missingEdit ||
                pendingDeleteDenied ||
                !dirty ||
                draftItems(draft).some((group) => !group.name)))
          }
        >
          저장
        </Button>
      </footer>
    </WatchlistDialog>
  );
}
