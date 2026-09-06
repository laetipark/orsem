import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LoginSuccessRedirect } from '../components/login-redirect';
import {
  loginUrl,
  rememberLoginReturn,
  safeLoginReturn,
  savedLoginReturn,
} from '../lib/login-return';
import { disconnectPushOnLogout } from '../lib/web-push';
import { api } from '../lib/api';
import type { Session } from '../types';
import { LoginLayout } from '../components/login-layout';
import { Badge, Button } from '../components/ui';

export function LoginPage({ session }: { session: Session }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const destination = safeLoginReturn(searchParams.get('returnTo')) ?? savedLoginReturn();
  const kakao = useQuery({
    queryKey: ['kakao-config'],
    queryFn: api.kakaoConfig,
    retry: false,
    enabled: !session.authenticated,
  });
  const refreshSession = useMutation({
    mutationFn: api.session,
    onSuccess: (nextSession) => queryClient.setQueryData(['session'], nextSession),
  });
  const logout = useMutation({
    mutationFn: async () => {
      await disconnectPushOnLogout(session.user?.id, api.unsubscribeNotifications);
      return api.logout();
    },
    onSuccess: async (nextSession) => {
      await queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      queryClient.setQueryData(['session'], nextSession);
      void navigate('/login', { replace: true });
    },
  });
  if (session.authenticated && session.canAccess)
    return (
      <LoginSuccessRedirect destination={destination} isAdmin={session.user?.role === 'ADMIN'} />
    );

  const awaitingAccess = session.authenticated && !session.canAccess;
  const rejected = session.user?.status === 'REJECTED';
  const kakaoEnabled = kakao.data?.enabled === true && Boolean(kakao.data.startUrl);

  function startKakao() {
    if (!kakaoEnabled || !kakao.data?.startUrl) return;
    if (destination) rememberLoginReturn(destination);
    const start = new URL(kakao.data.startUrl, window.location.origin);
    if (start.origin === window.location.origin) window.location.assign(start.href);
  }

  return (
    <LoginLayout
      title={awaitingAccess ? '이용 안내' : '오르셈에 오신 것을 환영해요'}
      description="시장과 기업의 소식을 한곳에서 확인하세요."
    >
      {awaitingAccess ? (
        <div className="login-options account-status" role="status">
          <Badge tone={rejected ? 'red' : 'orange'}>{rejected ? '이용 제한' : '승인 대기'}</Badge>
          <h2>{rejected ? '현재 관측 화면을 이용할 수 없습니다' : '가입 신청이 접수되었습니다'}</h2>
          <p>
            {rejected
              ? '관리자가 계정의 이용을 승인하지 않았습니다. 계정 상태는 관리자에게 확인해 주세요.'
              : '관리자가 확인하면 공시와 기업 정보를 조회할 수 있습니다. 승인이 완료되면 아래 버튼으로 다시 확인해 주세요.'}
          </p>
          <div className="account-reference">
            <strong>{session.user?.displayName || '카카오 회원'}</strong>
            <span>회원 번호 {session.user?.id.slice(0, 8)}</span>
          </div>
          {refreshSession.isError || logout.isError ? (
            <p className="form-error" role="alert">
              {logout.error?.message || '계정 상태를 확인하지 못했습니다. 다시 시도해 주세요.'}
            </p>
          ) : null}
          <Button onClick={() => refreshSession.mutate()} disabled={refreshSession.isPending}>
            {refreshSession.isPending ? '확인 중…' : '승인 상태 확인'}
          </Button>
          <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
            로그아웃
          </Button>
          <div className="login-switch">
            <Link to={loginUrl('/admin/login', destination)}>관리자 로그인</Link>
          </div>
        </div>
      ) : (
        <div className="login-options">
          <section className="kakao-signin" aria-labelledby="kakao-signin-title">
            <h2 id="kakao-signin-title">로그인 · 회원가입</h2>
            <p>카카오 계정으로 간편하게 시작하세요.</p>
            <button
              type="button"
              className="kakao-login-button"
              onClick={startKakao}
              disabled={!kakaoEnabled}
              aria-describedby="kakao-availability"
            >
              카카오 로그인
            </button>
            <p id="kakao-availability" className="login-help">
              {kakao.isPending
                ? '카카오 연결 상태를 확인하고 있습니다.'
                : kakao.isError
                  ? '카카오 연결 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'
                  : kakaoEnabled
                    ? '처음 가입하면 관리자 승인 후 이용할 수 있습니다.'
                    : '카카오 로그인은 연결 준비 중입니다. 연결이 완료되면 카카오 계정으로 시작할 수 있습니다.'}
            </p>
            {kakao.isError ? (
              <Button variant="ghost" size="sm" onClick={() => void kakao.refetch()}>
                연결 상태 다시 확인
              </Button>
            ) : null}
            {searchParams.get('kakao') === 'error' ? (
              <p className="form-error" role="alert">
                카카오 로그인을 완료하지 못했습니다. 다시 시도해 주세요.
              </p>
            ) : null}
          </section>
          <div className="login-switch">
            <Link to={loginUrl('/admin/login', destination)}>관리자 로그인</Link>
          </div>
        </div>
      )}
    </LoginLayout>
  );
}
