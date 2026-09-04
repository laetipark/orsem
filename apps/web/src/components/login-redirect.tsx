import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  clearLoginReturn,
  loginUrl,
  rememberLoginReturn,
  safeLoginReturn,
} from '../lib/login-return';
import { LoadingState } from './ui';

export function RequireLoginRedirect() {
  const location = useLocation();
  const path = safeLoginReturn(`${location.pathname}${location.search}`);
  useEffect(() => {
    if (path) rememberLoginReturn(path);
  }, [path]);
  return <Navigate to={loginUrl('/login', path)} replace />;
}

export function LoginSuccessRedirect({
  destination,
  isAdmin,
}: {
  destination: string | null;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();
  const path = safeLoginReturn(destination) ?? '/';
  const target = !isAdmin && /^\/(operations|reviews)(?:\?|$)/.test(path) ? '/' : path;
  useEffect(() => {
    clearLoginReturn();
    void navigate(target, { replace: true });
  }, [navigate, target]);
  return <LoadingState label="요청한 화면으로 이동하는 중입니다." />;
}
