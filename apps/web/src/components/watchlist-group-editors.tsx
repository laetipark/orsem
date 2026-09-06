import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Company, WatchRoom } from '@orsem/contracts';
import { api } from '../lib/api';
import type { CompanySummary, WatchlistGroup } from '../types';
import { Button, Input, LoadingState } from './ui';
import { WatchlistDialog, moveEntry } from './watchlist-dialog';
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
    [selected, setSelected] = useState<string[]>([]),
    [q, setQ] = useState(''),
    [term, setTerm] = useState(''),
    change = useWatchChange(actor);
  const search = useQuery({
    queryKey: ['company-group-picker', actor, 'search', term],
    queryFn: () => api.companies(term, 'all'),
    enabled: !!term,
    staleTime: 30000,
  });
  return (
    <>
      <form
        className="watch-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
        }}
      >
        <Input
          autoFocus
          value={q}
          placeholder="기업명·종목코드 검색"
          aria-label="추가할 종목 검색"
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!q.trim()}>
          검색
        </Button>
      </form>
      <ChangeError error={search.error} />
      {search.data ? (
        <ul className="watch-search-results">
          {search.data.items.map((c) => (
            <li key={c.id}>
              <span>
                <strong>{c.nameKo}</strong>
                <small>{c.stockCode ?? c.ticker}</small>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={draft.length >= 200 || draft.some((i) => i.id === c.id)}
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
        <Button
          size="sm"
          variant="ghost"
          disabled={!selected.length}
          onClick={() => {
            setDraft(draft.filter((c) => !selected.includes(c.id)));
            setSelected([]);
          }}
        >
          선택 {selected.length}개 제거
        </Button>
      </div>
      <ol className="watch-edit-list watch-edit-list--stocks">
        {draft.map((c, index) => (
          <li key={c.id}>
            <input
              type="checkbox"
              aria-label={`${c.nameKo} 선택`}
              checked={selected.includes(c.id)}
              onChange={(e) =>
                setSelected(
                  e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id),
                )
              }
            />
            <span className="watch-edit-company">
              <strong>{c.nameKo}</strong>
              <small>{c.stockCode ?? c.ticker}</small>
            </span>
            <OrderButtons
              name={c.nameKo}
              index={index}
              count={draft.length}
              move={(to) => setDraft(moveEntry(draft, index, to))}
            />
          </li>
        ))}
      </ol>
      {!draft.length ? <p className="watch-help">검색해서 종목을 추가하세요.</p> : null}
      <ChangeError error={change.error} />
      <footer className="watch-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
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
  const targets = rooms.filter((r) => r.canManageGroups && r.canManageStocks),
    [roomId, setRoomId] = useState(targets[0]?.id ?? ''),
    change = useWatchChange(actor);
  return (
    <WatchlistDialog title="공유방에 복사" onClose={onClose}>
      <p className="watch-help">
        개인 그룹은 유지됩니다. 복사한 뒤에는 서로 독립적으로 관리합니다.
      </p>
      <select aria-label="복사할 공유방" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
        {targets.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      {!targets.length ? <p>그룹·종목 관리 권한이 있는 공유방이 없습니다.</p> : null}
      <ChangeError error={change.error} />
      <footer className="watch-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button
          disabled={!roomId || change.isPending}
          onClick={() =>
            change.mutate(async () => {
              await api.copyWatchlistGroup(group.id, roomId, group.revision ?? 0);
              onClose();
            })
          }
        >
          복사
        </Button>
      </footer>
    </WatchlistDialog>
  );
}
