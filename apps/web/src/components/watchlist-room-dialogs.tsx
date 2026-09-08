import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { WatchRoom, WatchRoomDetail, WatchRoomMember } from '@orsem/contracts';
import { api } from '../lib/api';
import { Button, Input, LoadingState } from './ui';
import { WatchlistDialog, moveEntry } from './watchlist-dialog';
import { ChangeError, OrderButtons, useWatchChange } from './watchlist-group-editors';

export function RoomDirectoryDialog({
  actor,
  initialCreate = false,
  onClose,
  onSelect,
}: {
  actor: string;
  initialCreate?: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const client = useQueryClient();
  const [offset, setOffset] = useState(0),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [create, setCreate] = useState(initialCreate),
    change = useWatchChange(actor);
  const query = useQuery({
    queryKey: ['watchlist-v2', actor, 'directory', offset],
    queryFn: ({ signal }) => api.watchlistRoomDirectory(offset, signal),
    enabled: !initialCreate,
    retry: false,
  });
  return (
    <WatchlistDialog
      title={initialCreate ? '공유방 만들기' : '공유방 찾기·만들기'}
      onClose={onClose}
      closeDisabled={change.isPending}
    >
      {!initialCreate ? (
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={create}
          disabled={change.isPending}
          onClick={() => setCreate(!create)}
        >
          새 공유방 만들기
        </Button>
      ) : null}
      {create ? (
        <form
          className="watch-room-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (change.isPending || !name.trim()) return;
            change.mutate(async () => {
              const room = await api.createWatchlistRoom(name.trim(), description.trim());
              client.setQueryData<{ items: WatchRoom[] }>(
                ['watchlist-v2', actor, 'rooms'],
                (cached) => ({
                  items: [...(cached?.items ?? []).filter((item) => item.id !== room.id), room],
                }),
              );
              onSelect(room.id);
              onClose();
            });
          }}
        >
          <label>
            방 이름
            <Input
              value={name}
              maxLength={80}
              required
              disabled={change.isPending}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            소개
            <textarea
              value={description}
              maxLength={500}
              disabled={change.isPending}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={!name.trim() || change.isPending}>
            만들기
          </Button>
        </form>
      ) : null}
      <ChangeError error={change.error} />
      {!initialCreate ? (
        <>
          <p className="watch-help">참여 승인을 받은 뒤 종목과 참여자 목록을 볼 수 있습니다.</p>
          {query.isPending ? <LoadingState label="공유방을 불러오는 중입니다." /> : null}
          <ChangeError error={query.error} />
          <ul className="watch-room-directory">
            {query.data?.items.map((room) => (
              <li key={room.id}>
                <div>
                  <strong>{room.name}</strong>
                  <small>방장 {room.ownerLabel}</small>
                  {room.description ? <p>{room.description}</p> : null}
                </div>
                {room.requestStatus === 'ACTIVE' ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      onSelect(room.id);
                      onClose();
                    }}
                  >
                    입장
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={change.isPending}
                    onClick={() =>
                      change.mutate(() =>
                        api.roomAction(
                          room.id,
                          '/requests',
                          room.requestStatus === 'PENDING' ? 'DELETE' : 'POST',
                        ),
                      )
                    }
                  >
                    {room.requestStatus === 'PENDING' ? '신청 취소' : '참여 신청'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {query.data && !query.data.items.length ? (
            <p className="watch-help">표시할 공유방이 없습니다.</p>
          ) : null}
          <footer className="watch-dialog__footer">
            <Button
              variant="ghost"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 21))}
            >
              이전
            </Button>
            <Button
              variant="ghost"
              disabled={query.data?.nextOffset == null}
              onClick={() => setOffset(query.data!.nextOffset!)}
            >
              다음
            </Button>
          </footer>
        </>
      ) : null}
    </WatchlistDialog>
  );
}
export function RoomOrderDialog({
  actor,
  rooms,
  onClose,
}: {
  actor: string;
  rooms: WatchRoom[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(rooms),
    change = useWatchChange(actor);
  return (
    <WatchlistDialog title="내 공유방 순서" onClose={onClose}>
      <p className="watch-help">이 순서는 내 화면에만 적용됩니다.</p>
      <ol className="watch-edit-list">
        {draft.map((r, i) => (
          <li key={r.id}>
            <strong className="watch-edit-company">{r.name}</strong>
            <OrderButtons
              name={r.name}
              index={i}
              count={draft.length}
              move={(to) => setDraft(moveEntry(draft, i, to))}
            />
          </li>
        ))}
      </ol>
      <ChangeError error={change.error} />
      <footer className="watch-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button
          disabled={change.isPending}
          onClick={() =>
            change.mutate(async () => {
              await api.orderWatchlistRooms(draft.map((r) => r.id));
              onClose();
            })
          }
        >
          저장
        </Button>
      </footer>
    </WatchlistDialog>
  );
}
export function RoomManageDialog({
  actor,
  roomId,
  onClose,
  onLeft,
}: {
  actor: string;
  roomId: string;
  onClose: () => void;
  onLeft: () => void;
}) {
  const query = useQuery({
    queryKey: ['watchlist-v2', actor, 'room', roomId],
    queryFn: ({ signal }) => api.watchlistRoom(roomId, signal),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  return (
    <WatchlistDialog title="공유방 참여자·설정" onClose={onClose} wide>
      {query.isPending ? (
        <LoadingState label="공유방을 불러오는 중입니다." />
      ) : query.isError ? (
        <ChangeError error={query.error} />
      ) : (
        <RoomManageForm
          key={`${roomId}:${query.data.revision}`}
          actor={actor}
          room={query.data}
          onLeft={onLeft}
        />
      )}
    </WatchlistDialog>
  );
}
function RoomManageForm({
  actor,
  room,
  onLeft,
}: {
  actor: string;
  room: WatchRoomDetail;
  onLeft: () => void;
}) {
  const [name, setName] = useState(room.name),
    [description, setDescription] = useState(room.description),
    [target, setTarget] = useState(''),
    change = useWatchChange(actor);
  const run = (path: string, method: string, body: Record<string, unknown> = {}) =>
    change.mutate(() =>
      api.roomAction(room.id, path, method, { ...body, revision: room.revision }),
    );
  return (
    <>
      {room.canManageMembers ? (
        <form
          className="watch-room-form"
          onSubmit={(e) => {
            e.preventDefault();
            run('', 'PATCH', { name: name.trim(), description: description.trim() });
          }}
        >
          <label>
            방 이름
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            소개
            <textarea
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" disabled={!name.trim() || change.isPending}>
            설정 저장
          </Button>
        </form>
      ) : (
        <p>
          {room.name}
          {room.description ? ` · ${room.description}` : ''}
        </p>
      )}
      {room.canManageMembers && room.requests.length ? (
        <section>
          <h3>참여 신청 {room.requests.length}명</h3>
          <ul className="watch-member-list">
            {room.requests.map((req) => (
              <li key={req.actorKey}>
                <strong>{req.label}</strong>
                <span className="watch-member-actions">
                  <Button
                    size="sm"
                    disabled={change.isPending}
                    onClick={() =>
                      run(`/requests/${encodeURIComponent(req.actorKey)}/review`, 'POST', {
                        approve: true,
                      })
                    }
                  >
                    승인
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={change.isPending}
                    onClick={() =>
                      run(`/requests/${encodeURIComponent(req.actorKey)}/review`, 'POST', {
                        approve: false,
                      })
                    }
                  >
                    거절
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <h3>참여자 {room.members.length}명</h3>
      <p className="watch-help">그룹 관리와 종목 관리 권한은 방 안의 모든 그룹에 적용됩니다.</p>
      <ul className="watch-member-list">
        {room.members.map((member) => (
          <MemberEditor
            key={member.actorKey}
            actor={actor}
            member={member}
            room={room}
            busy={change.isPending}
            run={run}
          />
        ))}
      </ul>
      <ChangeError error={change.error} />
      {room.role === 'OWNER' ? (
        <section className="watch-room-danger">
          <h3>방장 관리</h3>
          <div className="watch-inline-form">
            <select aria-label="새 방장" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">이전할 참여자 선택</option>
              {room.members
                .filter((m) => m.role !== 'OWNER' && m.active)
                .map((m) => (
                  <option key={m.actorKey} value={m.actorKey}>
                    {m.label}
                  </option>
                ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              disabled={!target || change.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    '선택한 참여자에게 방장 권한을 이전할까요? 나는 방 관리자로 남습니다.',
                  )
                )
                  run('/transfer', 'POST', { actorKey: target });
              }}
            >
              방장 이전
            </Button>
          </div>
          <Button
            variant="danger"
            size="sm"
            disabled={change.isPending}
            onClick={() => {
              if (window.confirm(`“${room.name}” 방과 그 안의 모든 그룹·종목 목록을 삭제할까요?`))
                change.mutate(async () => {
                  await api.roomAction(room.id, '', 'DELETE', { revision: room.revision });
                  onLeft();
                });
            }}
          >
            공유방 삭제
          </Button>
        </section>
      ) : (
        <footer className="watch-dialog__footer">
          <Button
            variant="danger"
            size="sm"
            disabled={change.isPending}
            onClick={() => {
              if (window.confirm('이 공유방에서 나갈까요? 다시 참여하려면 승인이 필요합니다.'))
                change.mutate(async () => {
                  await api.roomAction(room.id, '/leave', 'POST', { revision: room.revision });
                  onLeft();
                });
            }}
          >
            공유방 나가기
          </Button>
        </footer>
      )}
    </>
  );
}
function MemberEditor({
  actor,
  member,
  room,
  busy,
  run,
}: {
  actor: string;
  member: WatchRoomMember;
  room: WatchRoomDetail;
  busy: boolean;
  run: (path: string, method: string, body?: Record<string, unknown>) => void;
}) {
  const [admin, setAdmin] = useState(member.role === 'ADMIN'),
    [groups, setGroups] = useState(member.canManageGroups),
    [stocks, setStocks] = useState(member.canManageStocks);
  const editable =
    room.canManageMembers &&
    member.role !== 'OWNER' &&
    (room.role === 'OWNER' || member.role !== 'ADMIN');
  return (
    <li>
      <div>
        <strong>
          {member.label}
          {member.actorKey === actor ? ' (나)' : ''}
        </strong>
        <small>
          {member.role === 'OWNER'
            ? '방장'
            : member.role === 'ADMIN'
              ? '방 관리자'
              : member.canManageGroups && member.canManageStocks
                ? '그룹·종목 편집'
                : member.canManageGroups
                  ? '그룹 편집'
                  : member.canManageStocks
                    ? '종목 편집'
                    : '조회'}
          {!member.active ? ' · 이용 승인 중지' : ''}
        </small>
      </div>
      {editable ? (
        <div className="watch-member-actions">
          {room.role === 'OWNER' ? (
            <label>
              <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
              관리자
            </label>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={admin || groups}
              disabled={admin}
              onChange={(e) => setGroups(e.target.checked)}
            />
            그룹 관리
          </label>
          <label>
            <input
              type="checkbox"
              checked={admin || stocks}
              disabled={admin}
              onChange={(e) => setStocks(e.target.checked)}
            />
            종목 관리
          </label>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run(`/members/${encodeURIComponent(member.actorKey)}`, 'PATCH', {
                role: admin ? 'ADMIN' : 'MEMBER',
                canManageGroups: groups,
                canManageStocks: stocks,
              })
            }
          >
            권한 저장
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`${member.label} 님을 방에서 내보낼까요?`))
                run(`/members/${encodeURIComponent(member.actorKey)}`, 'DELETE');
            }}
          >
            내보내기
          </Button>
        </div>
      ) : null}
    </li>
  );
}
