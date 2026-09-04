import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isFixtureMode } from '../lib/api';
import { formatKst } from '../lib/format';
import type { Member } from '../types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
} from './ui';

const statusLabels = { PENDING: '승인 대기', APPROVED: '승인됨', REJECTED: '이용 제한' } as const;

export function MemberApproval() {
  const [status, setStatus] = useState<Member['status']>('PENDING');
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ['members', status],
    queryFn: () => api.members(status),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const review = useMutation({
    mutationFn: ({ id, nextStatus }: { id: string; nextStatus: 'APPROVED' | 'REJECTED' }) =>
      api.reviewMember(id, nextStatus),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members'] }),
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <span className="section-kicker">MEMBERS</span>
          <h2>회원 가입 승인</h2>
        </div>
        <Badge>{members.data?.items.length ?? '—'}명</Badge>
      </CardHeader>
      <CardContent className="member-approval">
        <p className="member-approval__description">
          카카오 가입 신청을 확인하고 조회 권한을 부여합니다. 승인된 회원도 관심기업 변경이나 수집
          운영에는 접근할 수 없습니다.
        </p>
        <div className="member-filters" aria-label="회원 승인 상태">
          {(Object.keys(statusLabels) as Array<Member['status']>).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={status === value ? 'primary' : 'secondary'}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {statusLabels[value]}
            </Button>
          ))}
        </div>
        {members.isPending ? <LoadingState label="회원 목록을 확인하고 있습니다." /> : null}
        {members.isError ? (
          <ErrorState message={members.error.message} onRetry={() => void members.refetch()} />
        ) : null}
        {review.isError ? (
          <p className="form-error" role="alert">
            회원 상태를 변경하지 못했습니다. 다시 시도해 주세요.
          </p>
        ) : null}
        {members.data?.items.length === 0 ? (
          <EmptyState
            title={`${statusLabels[status]} 회원이 없습니다`}
            description={
              isFixtureMode
                ? '개발 예시 화면에서는 실제 카카오 가입이나 승인 작업을 하지 않습니다.'
                : '새로운 가입 신청이 접수되면 이곳에서 확인할 수 있습니다.'
            }
          />
        ) : null}
        <div className="member-list">
          {members.data?.items.map((member) => (
            <article className="member-row" key={member.id}>
              <div>
                <strong>{member.displayName || '카카오 회원'}</strong>
                <span className="member-reference">
                  회원 번호 <code title={member.id}>{member.id.slice(0, 8)}</code> · 카카오
                </span>
                <span>
                  가입 {formatKst(member.createdAt)} · 최근 로그인 {formatKst(member.lastLoginAt)}
                </span>
              </div>
              <div className="member-row__actions">
                {member.status !== 'APPROVED' ? (
                  <Button
                    size="sm"
                    disabled={review.isPending}
                    onClick={() => review.mutate({ id: member.id, nextStatus: 'APPROVED' })}
                  >
                    조회 권한 승인
                  </Button>
                ) : null}
                {member.status !== 'REJECTED' ? (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={review.isPending}
                    onClick={() => review.mutate({ id: member.id, nextStatus: 'REJECTED' })}
                  >
                    {member.status === 'APPROVED' ? '이용 중지' : '승인 거절'}
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
