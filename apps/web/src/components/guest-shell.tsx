import { ArrowRight, ChartNoAxesCombined, Building2, Newspaper } from 'lucide-react';
import { Suspense } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import type { Session } from '../types';
import { loginUrl } from '../lib/login-return';
import { BrandLogo } from './brand-logo';
import { LoadingState, cn } from './ui';
import { ThemeButton } from './theme-button';
import { usePageNavigation } from './page-navigation';
import './guest-shell.css';

export function GuestShell({ session }: { session?: Session }) {
  const location = useLocation();
  const { main } = usePageNavigation();
  const login = loginUrl('/login', `${location.pathname}${location.search}`);
  return (
    <div className="guest-shell">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header className="guest-header">
        <div className="guest-header__inner">
          <Link to="/" className="brand" aria-label="오르셈 홈">
            <BrandLogo />
          </Link>
          <nav aria-label="공개 메뉴" className="guest-navigation">
            {[
              { to: '/markets', label: '시장', icon: ChartNoAxesCombined },
              { to: '/companies', label: '종목', icon: Building2 },
              { to: '/news', label: '뉴스', icon: Newspaper },
            ].map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => cn('guest-navigation__link', isActive && 'is-active')}
              >
                <Icon size={17} aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="guest-header__actions">
            <ThemeButton />
            <Link className="button button--primary button--sm" to={login}>
              {session?.authenticated ? '계정 상태' : '로그인'}
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>
      <main ref={main} id="main-content" className="guest-main" tabIndex={-1}>
        {session?.authenticated && !session.canAccess ? (
          <p className="guest-account-notice" role="status">
            공개 차트와 뉴스는 계속 볼 수 있습니다. <Link to={login}>회원 이용 상태 확인</Link>
          </p>
        ) : null}
        <Suspense fallback={<LoadingState label="공개 화면을 불러오는 중입니다." />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="guest-footer">
        <span>오르셈 · 시장과 기업을 관찰하는 공간</span>
        <span>표시 시각은 한국 시간(KST)입니다.</span>
        <Link to="/logo-sources">로고 출처·이용 안내</Link>
      </footer>
    </div>
  );
}
