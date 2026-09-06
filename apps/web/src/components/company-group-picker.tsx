import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompanyWatchlistMembership, SaveCompanyWatchlistMemberships } from '@orsem/contracts';
import { CircleHelp, LoaderCircle, LockKeyhole, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import type { Session } from '../types';
import { api, ApiError } from '../lib/api';
import { Button } from './ui';
import { WatchlistDialog } from './watchlist-dialog';
import { watchActorKey } from './watchlist-group-editors';
import './watchlist-groups-panel.css';
import './company-group-picker.css';

const isAccessError = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.statusCode);

export function CompanyGroupPicker({ companyId }: { companyId: string }) {
  const session = useOutletContext<Session | undefined>();
  const actor = watchActorKey(session?.user);
  return actor && session?.canAccess ? (
    <MembershipPicker key={`${actor}:${companyId}`} actor={actor} companyId={companyId} />
  ) : null;
}

function MembershipPicker({ actor, companyId }: { actor: string; companyId: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'refreshing' | 'unverified'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void client.cancelQueries({ queryKey: ['company-group-picker', actor, companyId] });
      client.removeQueries({ queryKey: ['company-group-picker', actor, companyId] });
    };
  }, [actor, client, companyId]);
  const memberships = useQuery({
    queryKey: ['company-group-picker', actor, companyId],
    queryFn: ({ signal }) => api.companyWatchlistMemberships(companyId, signal),
    enabled: !blocked,
    retry: false,
    staleTime: 30_000,
    gcTime: 0,
    refetchOnWindowFocus: !open,
  });
  const accessLost = blocked || isAccessError(memberships.error);
  const clearAccess = () => {
    setBlocked(true);
    setPhase('idle');
    setNotice('접근 권한이 변경되었습니다. 다시 확인해 주세요.');
    client.removeQueries({
      predicate: (q) =>
        ['watchlist-v2', 'company-group-picker'].includes(String(q.queryKey[0])) &&
        q.queryKey[1] === actor,
    });
  };
  useEffect(() => {
    if (!isAccessError(memberships.error)) return;
    setBlocked(true);
    client.removeQueries({
      predicate: (q) =>
        ['watchlist-v2', 'company-group-picker'].includes(String(q.queryKey[0])) &&
        q.queryKey[1] === actor,
    });
  }, [actor, client, memberships.error]);

  const busy = phase === 'saving' || phase === 'refreshing';
  const known = !!memberships.data && !memberships.isError && !accessLost && phase !== 'unverified';
  const count = known ? memberships.data!.items.filter((g) => g.selected).length : null;
  const label =
    count === null
      ? (!accessLost && memberships.isPending) || busy
        ? '관심그룹 확인 중'
        : '관심그룹 상태 확인 필요'
      : count > 0
        ? `관심그룹 ${count}`
        : '관심그룹 추가';

  async function refresh(message?: string) {
    setPhase('refreshing');
    setNotice(message ?? null);
    try {
      const result = await memberships.refetch({ throwOnError: true });
      if (!active.current) return false;
      if (!result.data) throw new Error('No membership response');
      setBlocked(false);
      setEditorVersion((v) => v + 1);
      setPhase('idle');
      return true;
    } catch (error) {
      if (!active.current) return false;
      if (isAccessError(error)) clearAccess();
      else {
        setPhase('unverified');
        setNotice('그룹 상태를 확인하지 못했습니다. 다시 확인해 주세요.');
      }
      return false;
    }
  }

  async function save(changes: SaveCompanyWatchlistMemberships['changes']) {
    if (busy || !known) return;
    setPhase('saving');
    setNotice(null);
    try {
      await api.saveCompanyWatchlistMemberships(companyId, { changes });
    } catch (error) {
      if (!active.current) return;
      if (isAccessError(error)) {
        clearAccess();
      } else if (error instanceof ApiError && error.statusCode === 409) {
        await refresh('그룹이 변경되었습니다. 최신 선택을 확인한 뒤 다시 저장해 주세요.');
      } else if (error instanceof ApiError && error.statusCode < 500) {
        setNotice(error.message);
        setPhase('idle');
      } else {
        // A missing response does not prove the PUT failed. Never retry the write automatically.
        if (await refresh('저장 응답을 받지 못했습니다. 현재 등록 상태를 다시 확인해 주세요.')) {
          await client.invalidateQueries({ queryKey: ['watchlist-v2', actor] });
        }
      }
      return;
    }
    if (!active.current) return;
    await client.invalidateQueries({ queryKey: ['watchlist-v2', actor] });
    await client.invalidateQueries({
      queryKey: ['company-group-picker', actor],
      refetchType: 'none',
    });
    if (!active.current) return;
    if (await refresh('저장한 그룹 상태를 확인하고 있습니다.')) {
      setNotice(null);
      setOpen(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={`company-group-trigger${count ? ' company-group-trigger--selected' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
      >
        {count === null ? (
          (!accessLost && memberships.isPending) || busy ? (
            <LoaderCircle size={18} className="company-group-spinner" aria-hidden="true" />
          ) : (
            <CircleHelp size={18} aria-hidden="true" />
          )
        ) : (
          <Star size={18} fill={count > 0 ? 'currentColor' : 'none'} aria-hidden="true" />
        )}
        <span className="company-group-trigger__label">{label}</span>
        {count !== null && count > 0 ? (
          <span className="company-group-trigger__count" aria-hidden="true">
            {count}
          </span>
        ) : null}
      </Button>
      {open ? (
        <WatchlistDialog
          title="관심그룹 설정"
          mobileSheet
          closeDisabled={phase === 'saving'}
          onClose={() => {
            if (phase !== 'saving') setOpen(false);
          }}
        >
          {notice || accessLost || memberships.isError ? (
            <p className="company-group-notice" role="alert">
              {notice ??
                (accessLost
                  ? '접근 권한이 변경되었습니다. 다시 확인해 주세요.'
                  : '그룹 목록을 불러오지 못했습니다.')}
            </p>
          ) : null}
          {phase === 'refreshing' || (!accessLost && memberships.isPending) ? (
            <p className="company-group-loading" role="status">
              <LoaderCircle size={18} className="company-group-spinner" aria-hidden="true" />
              관심그룹 확인 중
            </p>
          ) : !known ? (
            <Button type="button" variant="secondary" onClick={() => void refresh()}>
              다시 확인
            </Button>
          ) : (
            <MembershipEditor
              key={editorVersion}
              items={memberships.data!.items}
              saving={phase === 'saving'}
              onSave={save}
              onClose={() => setOpen(false)}
            />
          )}
        </WatchlistDialog>
      ) : null}
    </>
  );
}

function MembershipEditor({
  items,
  saving,
  onSave,
  onClose,
}: {
  items: CompanyWatchlistMembership[];
  saving: boolean;
  onSave: (changes: SaveCompanyWatchlistMemberships['changes']) => Promise<void>;
  onClose: () => void;
}) {
  // Keep the revision and selection snapshot together until save, cancel or an explicit reload.
  const [baseline] = useState(items);
  const [selected, setSelected] = useState(
    new Set(items.filter((g) => g.selected).map((g) => g.id)),
  );
  const sections = new Map<string, { name: string; groups: CompanyWatchlistMembership[] }>();
  for (const group of baseline) {
    const key = group.kind === 'PERSONAL' ? 'personal' : `room:${group.roomId}`;
    const section = sections.get(key) ?? {
      name: group.kind === 'PERSONAL' ? '개인' : (group.roomName ?? '공유방'),
      groups: [],
    };
    section.groups.push(group);
    sections.set(key, section);
  }
  const changes = baseline
    .filter((g) => g.canManageStocks && selected.has(g.id) !== g.selected)
    .map((g) => ({ groupId: g.id, revision: g.revision, selected: selected.has(g.id) }));

  return (
    <form
      className="company-group-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (changes.length && !saving) void onSave(changes);
      }}
    >
      {baseline.length ? (
        [...sections.entries()].map(([key, section]) => (
          <fieldset key={key} className="company-group-section" disabled={saving}>
            <legend>{section.name}</legend>
            {section.groups.map((group) => (
              <label className="company-group-option" key={group.id}>
                <input
                  type="checkbox"
                  checked={selected.has(group.id)}
                  disabled={!group.canManageStocks || saving}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(group.id);
                      else next.delete(group.id);
                      return next;
                    });
                  }}
                />
                <span className="company-group-option__name">{group.name}</span>
                <small>{group.itemCount}종목</small>
                {!group.canManageStocks ? (
                  <span className="company-group-option__lock">
                    <LockKeyhole size={14} aria-hidden="true" />
                    <span className="sr-only">읽기 전용</span>
                  </span>
                ) : null}
              </label>
            ))}
          </fieldset>
        ))
      ) : (
        <div className="company-group-empty">
          <Star size={26} aria-hidden="true" />
          <p>아직 관심그룹이 없습니다.</p>
          <Link to="/watchlist">관심기업에서 그룹 만들기</Link>
        </div>
      )}
      <footer className="watch-dialog__footer company-group-footer">
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          취소
        </Button>
        <Button type="submit" disabled={!changes.length || saving}>
          {saving ? '저장 중' : '저장'}
        </Button>
      </footer>
    </form>
  );
}
