import { SearchInput } from './search-input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { Company, WatchRoom } from '@orsem/contracts';
import { api } from '../lib/api';
import type { CompanySummary, WatchlistGroup } from '../types';
import { Button, Input, LoadingState } from './ui';
import { WatchlistDialog, moveEntry } from './watchlist-dialog';
import { useGroupReorder } from '../lib/use-group-reorder';
import './stock-editor.css';
export const watchActorKey = (user: { id: string; role: string } | null | undefined) =>
  user ? `${user.role === 'ADMIN' ? 'ADMIN' : 'MEMBER'}:${user.id}` : '';
export function useWatchChange(actor: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (work: () => Promise<unknown>) => work(),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['watchlist-v2', actor] }),
        client.invalidateQueries({ queryKey: ['company-group-picker', actor] }),
      ]);
    },
  });
}
export function ChangeError({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="form-error">
      {error instanceof Error ? error.message : '변경하지 못했습니다.'}
    </p>
  ) : null;
}
export function GroupEditor({
  actor,
  roomId,
  groups,
  revision,
  canStocks,
  onClose,
}: {
  actor: string;
  roomId?: string;
  groups: WatchlistGroup[];
  revision: number;
  canStocks: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(groups.map((g) => ({ id: g.id, name: g.name }))),
    [baseRevision] = useState(revision),
    [baselineGroups] = useState(groups),
    change = useWatchChange(actor);
  return (
    <WatchlistDialog title="그룹 편집" onClose={onClose}>
      <p className="watch-help">
        이름과 순서를 바꿀 수 있습니다. 공유방의 변경은 모든 참여자에게 적용됩니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const removed = baselineGroups.filter((g) => !draft.some((d) => d.id === g.id));
          if (
            removed.some((g) => g.itemCount > 0) &&
            !window.confirm(
              `${removed.map((g) => `${g.name} (${g.itemCount}종목)`).join(', ')} 그룹을 삭제할까요?`,
            )
          )
            return;
          change.mutate(async () => {
            await api.saveWatchlistGroups({
              roomId,
              revision: baseRevision,
              groups: draft.map((g) => ({ ...g, name: g.name.trim() })),
            });
            onClose();
          });
        }}
      >
        <ol className="watch-edit-list">
          {draft.map((g, index) => (
            <li key={g.id}>
              <Input
                aria-label={`${index + 1}번 그룹 이름`}
                value={g.name}
                maxLength={80}
                onChange={(e) =>
                  setDraft(
                    draft.map((row) => (row.id === g.id ? { ...row, name: e.target.value } : row)),
                  )
                }
              />
              <OrderButtons
                name={g.name}
                index={index}
                count={draft.length}
                move={(to) => setDraft(moveEntry(draft, index, to))}
              />
              <button
                type="button"
                className="watch-icon-button"
                aria-label={`${g.name} 삭제`}
                disabled={!canStocks && (groups.find((row) => row.id === g.id)?.itemCount ?? 0) > 0}
                onClick={() => setDraft(draft.filter((row) => row.id !== g.id))}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ol>
        <ChangeError error={change.error} />
        <footer className="watch-dialog__footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" disabled={change.isPending || draft.some((g) => !g.name.trim())}>
            저장
          </Button>
        </footer>
      </form>
    </WatchlistDialog>
  );
}
export function OrderButtons({
  name,
  index,
  count,
  move,
}: {
  name: string;
  index: number;
  count: number;
  move: (to: number) => void;
}) {
  const [position, setPosition] = useState(String(index + 1));
  useEffect(() => setPosition(String(index + 1)), [index]);
  const commitPosition = () => {
    const n = Number(position);
    if (Number.isInteger(n) && n >= 1 && n <= count) move(n - 1);
    else setPosition(String(index + 1));
  };
  return (
    <span className="watch-order-controls">
      <button
        type="button"
        className="watch-icon-button"
        aria-label={`${name} 위로`}
        disabled={index === 0}
        onClick={() => move(index - 1)}
      >
        <ArrowUp size={14} />
      </button>
      <input
        type="number"
        aria-label={`${name} 위치`}
        min={1}
        max={count}
        value={position}
        onChange={(e) => setPosition(e.target.value)}
        onBlur={commitPosition}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitPosition();
          }
        }}
      />
      <button
        type="button"
        className="watch-icon-button"
        aria-label={`${name} 아래로`}
        disabled={index === count - 1}
        onClick={() => move(index + 1)}
      >
        <ArrowDown size={14} />
      </button>
    </span>
  );
}
export function StockEditor({
  actor,
  group,
  onClose,
}: {
  actor: string;
  group: WatchlistGroup;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['watchlist-v2', actor, 'edit-items', group.id],
    queryFn: ({ signal }) => api.editWatchlistGroup(group.id, signal),
    refetchOnWindowFocus: false,
    gcTime: 0,
    retry: false,
  });
  return (
    <WatchlistDialog title={`${group.name} · 종목 편집`} onClose={onClose} wide>
      {query.isPending ? (
        <LoadingState label="전체 종목을 불러오는 중입니다." />
      ) : query.isError ? (
        <ChangeError error={query.error} />
      ) : (
        <StockEditorForm
          key={`${group.id}:${query.data.revision}`}
          actor={actor}
          group={group}
          items={query.data.items}
          revision={query.data.revision}
          onClose={onClose}
        />
      )}
    </WatchlistDialog>
  );
}
function StockEditorForm({
  actor,
  group,
  items,
  revision,
  onClose,
}: {
  actor: string;
  group: WatchlistGroup;
  items: Company[];
  revision: number;
  onClose: () => void;
}) {
  const [draft, setDraft] =
      useState<Array<Pick<CompanySummary, 'id' | 'nameKo' | 'nameEn' | 'ticker' | 'stockCode'>>>(
        items,
      ),
    [q, setQ] = useState(''),
    [term, setTerm] = useState(''),
    change = useWatchChange(actor);
  const instructionId = useId();
  const reorder = useGroupReorder({
    ids: draft.map(({ id }) => id),
    disabled: change.isPending,
    onReorder: (ids) => setDraft((current) => ids.map((id) => current.find((c) => c.id === id)!)),
  });
  const search = useQuery({
    queryKey: ['company-group-picker', actor, 'search', term],
    queryFn: () => api.companies(term, 'all'),
    enabled: !!term,
    staleTime: 30000,
  });
  return (
    <>
      <form
        className="watch-inline-form stock-editor__search"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
        }}
      >
        <SearchInput
          value={q}
          onChange={setQ}
          label="추가할 종목 검색"
          placeholder="기업명·종목코드 검색"
          disabled={change.isPending}
          filters={{ kind: 'companies' }}
          contextKey={`${actor}:${group.id}`}
          onSelect={(item) => {
            const company = item.company;
            if (company && draft.length < 200 && !draft.some((c) => c.id === company.id))
              setDraft([...draft, company]);
            setQ('');
          }}
          onSubmit={() => setTerm(q.trim())}
        />
        <Button type="submit" size="sm" disabled={!q.trim() || change.isPending}>
          검색
        </Button>
      </form>
      <ChangeError error={search.error} />
      {search.data ? (
        <ul className="watch-search-results stock-editor__results">
          {search.data.items.map((c) => (
            <li key={c.id}>
              <span>
                <strong>{c.nameKo}</strong>
                <small>{c.stockCode ?? c.ticker}</small>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  change.isPending || draft.length >= 200 || draft.some((i) => i.id === c.id)
                }
                onClick={() => setDraft([...draft, c])}
              >
                <Plus size={14} />
                {draft.some((i) => i.id === c.id) ? '추가됨' : '추가'}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="watch-edit-caption">
        <span>{draft.length}/200종목 · 전체 목록 순서</span>
      </div>
      <p id={instructionId} className="sr-only">
        손잡이를 끌어 종목 순서를 바꾸세요. 방향키 또는 Home·End 키로도 이동할 수 있습니다. 순서
        변경과 삭제는 저장을 누르면 적용됩니다.
      </p>
      <ul
        ref={reorder.listRef}
        className="watch-edit-list watch-edit-list--stocks stock-editor__list"
        aria-label="편집할 종목"
      >
        {draft.map((c) => (
          <li
            key={c.id}
            data-sort-id={c.id}
            className={`stock-editor__row${reorder.draggedId === c.id ? ' is-dragging' : ''}${reorder.targetId === c.id && reorder.dropPosition ? ` is-drop-${reorder.dropPosition}` : ''}`}
          >
            <button
              type="button"
              className="stock-editor__handle"
              aria-label={`${c.nameKo} 순서 변경`}
              aria-describedby={instructionId}
              disabled={draft.length < 2}
              aria-disabled={change.isPending || draft.length < 2}
              tabIndex={change.isPending ? -1 : 0}
              {...reorder.getHandleProps(c.id)}
            >
              <GripVertical size={18} />
            </button>
            <span className="watch-edit-company">
              <strong>{c.nameKo}</strong>
              <small>{c.stockCode ?? c.ticker}</small>
            </span>
            <button
              type="button"
              className="stock-editor__delete"
              aria-label={`${c.nameKo} 삭제`}
              title="종목 삭제"
              disabled={change.isPending}
              onClick={() => setDraft((current) => current.filter((item) => item.id !== c.id))}
            >
              <Trash2 size={16} />
            </button>
            {reorder.targetId === c.id && reorder.dropPosition ? (
              <span className="stock-editor__drop-label" aria-hidden="true">
                {reorder.dropPosition === 'before' ? '위에 놓기' : '아래에 놓기'}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {!draft.length ? <p className="watch-help">검색해서 종목을 추가하세요.</p> : null}
      <ChangeError error={change.error} />
      <footer className="watch-dialog__footer">
        <Button variant="ghost" onClick={onClose} disabled={change.isPending}>
          취소
        </Button>
        <Button
          disabled={change.isPending}
          onClick={() =>
            change.mutate(async () => {
              await api.saveWatchlistGroupItems(
                group.id,
                revision,
                draft.map((i) => i.id),
              );
              onClose();
            })
          }
        >
          저장
        </Button>
      </footer>
    </>
  );
}
export function CopyGroupDialog({
  actor,
  group,
  rooms,
  onClose,
}: {
  actor: string;
  group: WatchlistGroup;
  rooms: WatchRoom[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [createdRooms, setCreatedRooms] = useState<WatchRoom[]>([]);
  const [roomId, setRoomId] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [createdRoomName, setCreatedRoomName] = useState<string | null>(null);
  const change = useWatchChange(actor);
  // Keep new rooms selectable while the parent refreshes. Once a room appears in
  // server data, only that data determines its permissions and continued access.
  useEffect(() => {
    setCreatedRooms((previous) => {
      const next = previous.filter((room) => !rooms.some((current) => current.id === room.id));
      return next.length === previous.length ? previous : next;
    });
  }, [rooms]);
  const targets = [
    ...rooms,
    ...createdRooms.filter((room) => !rooms.some((current) => current.id === room.id)),
  ].filter((room) => room.canManageGroups && room.canManageStocks);
  const selected = roomId ? targets.find((room) => room.id === roomId) : targets[0];
  const createRoom = useMutation({
    mutationFn: (input: { name: string; description: string }) =>
      api.createWatchlistRoom(input.name, input.description),
    onSuccess: (room) => {
      setCreatedRooms((previous) => [...previous.filter((item) => item.id !== room.id), room]);
      setRoomId(room.id);
      setCreatedRoomName(room.name);
      setCreating(false);
      setName('');
      setDescription('');
      change.reset();
      // Refresh independently: the successful creation is already sufficient to
      // select this room, even when a directory request is delayed or fails.
      void client.invalidateQueries({ queryKey: ['watchlist-v2', actor, 'rooms'] });
      void client.invalidateQueries({ queryKey: ['watchlist-v2', actor, 'directory'] });
    },
  });
  const busy = createRoom.isPending || change.isPending;
  return (
    <WatchlistDialog title="공유" onClose={onClose} closeDisabled={busy}>
      <p className="watch-help">
        {group.name} 그룹을 공유방에 복사합니다. 개인 그룹은 유지되며 복사한 뒤에는 서로 독립적으로
        관리합니다.
      </p>
      <select
        aria-label="복사할 공유방"
        value={selected?.id ?? ''}
        disabled={busy || !targets.length}
        onChange={(e) => {
          setRoomId(e.target.value);
          setCreatedRoomName(null);
          change.reset();
        }}
      >
        {!selected ? (
          <option value="" disabled>
            {roomId ? '공유방을 다시 선택해 주세요' : '공유방을 먼저 만들어 주세요'}
          </option>
        ) : null}
        {targets.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      {!targets.length ? <p>그룹·종목 관리 권한이 있는 공유방이 없습니다.</p> : null}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        aria-expanded={creating}
        disabled={busy}
        onClick={() => {
          setCreating(!creating);
          createRoom.reset();
        }}
      >
        새 공유방 만들기
      </Button>
      {creating ? (
        <form
          className="watch-room-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !name.trim()) return;
            createRoom.mutate({ name: name.trim(), description: description.trim() });
          }}
        >
          <label>
            방 이름
            <Input
              value={name}
              maxLength={80}
              required
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            소개
            <textarea
              value={description}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={!name.trim() || busy}>
            {createRoom.isPending ? '만드는 중…' : '만들기'}
          </Button>
        </form>
      ) : null}
      {createdRoomName && selected?.id === roomId ? (
        <p className="watch-help" role="status">
          {createdRoomName} 공유방을 만들었습니다. 복사를 누르면 이 방에 그룹이 추가됩니다.
        </p>
      ) : null}
      <ChangeError error={createRoom.error} />
      <ChangeError error={change.error} />
      <footer className="watch-dialog__footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          취소
        </Button>
        <Button
          disabled={!selected || busy || creating}
          onClick={() => {
            if (!selected || busy || creating) return;
            change.mutate(async () => {
              await api.copyWatchlistGroup(group.id, selected.id, group.revision ?? 0);
              onClose();
            });
          }}
        >
          복사
        </Button>
      </footer>
    </WatchlistDialog>
  );
}
