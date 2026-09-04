import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, KeyRound, LockKeyhole } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LoginSuccessRedirect } from '../components/login-redirect';
import { loginUrl, safeLoginReturn, savedLoginReturn } from '../lib/login-return';
import { disconnectPushOnLogout } from '../lib/web-push';
import { api, isFixtureMode } from '../lib/api';
import type { Session } from '../types';
import { LoginLayout } from '../components/login-layout';
import { Badge, Button, Input } from '../components/ui';

export function AdminLoginPage({ session }: { session: Session }) {
  const [searchParams] = useSearchParams();
  const destination = safeLoginReturn(searchParams.get('returnTo')) ?? savedLoginReturn();
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [email, setEmail] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const queryClient = useQueryClient();
  const login = useMutation({
    mutationFn: async () => {
      if (session.authenticated)
        await disconnectPushOnLogout(session.user?.id, api.unsubscribeNotifications);
      return api.login({
        email,
        password,
        ...(useRecoveryCode ? { recoveryCode } : { totpCode }),
      });
    },
    onSuccess: async (nextSession) => {
      await queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      queryClient.setQueryData(['session'], nextSession);
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });

  if (session.authenticated && session.canAccess && session.user?.role === 'ADMIN')
    return <LoginSuccessRedirect destination={destination} isAdmin />;

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate();
  }

  return (
    <LoginLayout
      eyebrow="ADMINISTRATOR ACCESS"
      title="관리자 로그인"
      description="관리자 계정으로 공시 수집과 회원 승인을 관리합니다. 이메일, 비밀번호와 인증 코드를 입력해 주세요."
    >
      <div className="login-options">
        <h2>관리자 계정 인증</h2>
        <p>인증 앱의 6자리 코드 또는 발급받은 복구 코드를 사용합니다.</p>
        <form onSubmit={submit} className="login-form">
          <label>
            <span>관리자 이메일</span>
            <span className="input-with-icon">
              <AtSign size={17} />
              <Input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@example.com"
                required
              />
            </span>
          </label>
          <label>
            <span>비밀번호</span>
            <span className="input-with-icon">
              <LockKeyhole size={17} />
              <Input
                type="password"
                autoComplete="current-password"
                minLength={10}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </span>
          </label>
          {useRecoveryCode ? (
            <label>
              <span>복구 코드</span>
              <span className="input-with-icon">
                <KeyRound size={17} />
                <Input
                  autoComplete="one-time-code"
                  minLength={8}
                  maxLength={64}
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  placeholder="발급된 복구 코드"
                  required={!isFixtureMode}
                />
              </span>
            </label>
          ) : (
            <label>
              <span>인증 코드</span>
              <span className="input-with-icon">
                <KeyRound size={17} />
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="6자리 TOTP"
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))}
                  required={!isFixtureMode}
                />
              </span>
            </label>
          )}
          <button
            type="button"
            className="login-code-toggle"
            onClick={() => setUseRecoveryCode((value) => !value)}
          >
            {useRecoveryCode ? 'TOTP 인증 코드 사용' : '복구 코드 사용'}
          </button>
          {login.isError ? (
            <p className="form-error" role="alert">
              {login.error.message}
            </p>
          ) : null}
          <Button type="submit" disabled={login.isPending || !email || !password}>
            {login.isPending ? '확인 중…' : '관리자 로그인'}
          </Button>
          {isFixtureMode ? (
            <Badge tone="orange">개발 fixture에서는 임의의 비밀번호로 확인할 수 있습니다.</Badge>
          ) : null}
        </form>
        <div className="login-switch">
          <Link to={loginUrl('/login', destination)}>회원 로그인으로 돌아가기</Link>
        </div>
      </div>
    </LoginLayout>
  );
}
