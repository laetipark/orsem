import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CircleHelp, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import type { Session } from '../types';
import { api, ApiError } from '../lib/api';
import { watchActorKey } from './watchlist-group-editors';
import './company-notification-toggle.css';

const accessError = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.statusCode);

export function CompanyNotificationToggle({ companyId }: { companyId: string }) {
  const session = useOutletContext<Session | undefined>();
  const actor = watchActorKey(session?.user);
  return actor && session?.canAccess ? (
    <NotificationToggle key={`${actor}:${companyId}`} actor={actor} companyId={companyId} />
  ) : null;
}

function NotificationToggle({ actor, companyId }: { actor: string; companyId: string }) {
  const client = useQueryClient();
  const key = ['company-notifications', actor, companyId] as const;
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(true);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.companyNotificationSettings(companyId, signal),
    enabled: !blocked,
    retry: false,
    staleTime: 30_000,
    gcTime: 0,
  });
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void client.cancelQueries({ queryKey: ['company-notifications', actor, companyId] });
      client.removeQueries({ queryKey: ['company-notifications', actor, companyId] });
    };
  }, [actor, client, companyId]);
  useEffect(() => {
    if (!accessError(query.error)) return;
    setBlocked(true);
    client.removeQueries({ queryKey: ['company-notifications', actor, companyId] });
  }, [actor, client, companyId, query.error]);

  const data = query.data;
  const known = !!data && !query.isError && !blocked;
  const busy = query.isPending || saving;
  const label = blocked
    ? '종목 알림 접근 권한 확인 필요'
    : busy
      ? '종목 알림 확인 중'
      : !known
        ? '종목 알림 다시 확인'
        : data.enabled
          ? '이 종목 알림 끄기'
          : '이 종목 알림 켜기';
  const guidance =
    known && !data.globalEnabled
      ? '전체 알림이 꺼져 있습니다.'
      : known && !data.pushConfigured
        ? '푸시 알림 연결이 준비되지 않았습니다.'
        : known && !data.hasActiveSubscription
          ? '알림을 받을 기기를 연결해 주세요.'
          : null;

  async function toggle() {
    if (saving || blocked) return;
    if (!known) {
      await query.refetch();
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api.updateCompanyNotificationSettings(companyId, {
        enabled: !data.enabled,
      });
      if (active.current) client.setQueryData(key, saved);
    } catch (error) {
      if (!active.current) return;
      if (accessError(error)) {
        setBlocked(true);
        client.removeQueries({ queryKey: key });
        setNotice('접근 권한이 변경되었습니다. 다시 로그인해 주세요.');
      } else {
        // A lost response may hide a successful write. Reconcile without repeating PATCH.
        const reconciled = await query.refetch();
        if (active.current)
          setNotice(
            reconciled.isError
              ? '저장 결과를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.'
              : '저장 결과를 다시 확인했습니다. 현재 알림 상태를 확인해 주세요.',
          );
      }
    } finally {
      if (active.current) setSaving(false);
    }
  }

  return (
    <div className="company-notification">
      <button
        type="button"
        className={`company-notification__button${known && data.enabled ? ' company-notification__button--enabled' : ''}`}
        aria-label={label}
        title={[label, data?.inherited ? '전체 알림의 종목 범위 적용 중' : null, guidance]
          .filter(Boolean)
          .join(' · ')}
        aria-pressed={known ? data.enabled : undefined}
        disabled={busy || blocked}
        onClick={() => void toggle()}
      >
        {busy ? (
          <LoaderCircle size={18} className="company-group-spinner" aria-hidden="true" />
        ) : !known ? (
          <CircleHelp size={18} aria-hidden="true" />
        ) : data.enabled ? (
          <Bell size={18} fill="currentColor" aria-hidden="true" />
        ) : (
          <BellOff size={18} aria-hidden="true" />
        )}
      </button>
      {guidance || notice ? (
        <div className="company-notification__hint" role={notice ? 'status' : undefined}>
          {notice ? (
            <span>{notice}</span>
          ) : (
            <>
              <span>{guidance}</span> <Link to="/settings/notifications">알림 설정</Link>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
