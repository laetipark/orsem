import { useNewsCacheExpiry } from '../lib/news-cache';
import {
  Activity,
  Bell,
  Building2,
  ChartNoAxesCombined,
  FileSearch,
  LayoutDashboard,
  LogOut,
  Moon,
  Newspaper,
  ShieldCheck,
  Star,
  Sun,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { disconnectPushOnLogout } from '../lib/web-push';
import { clearNewsEditDrafts } from '../lib/news-edit-drafts';
import { api, isFixtureMode } from '../lib/api';
import { BrandLogo } from './brand-logo';
import orsemMark from '../assets/orsem-mark.svg';
import { HeaderSearch } from './search-autocomplete';
import { StockSidebar } from './stock-sidebar';
import { useTheme } from '../theme';
import { Badge, Button, LoadingState, cn } from './ui';
import type { Session } from '../types';
import './app-shell.css';

const navigation = [
  { to: '/', label: '오늘', icon: LayoutDashboard, end: true },
  { to: '/markets', label: '시장', icon: ChartNoAxesCombined },
  { to: '/companies', label: '종목', icon: Building2 },
  { to: '/events', label: '이벤트', icon: FileSearch },
  { to: '/news', label: '뉴스', icon: Newspaper },
  { to: '/watchlist', label: '관심 종목', icon: Star },
];
const administration = [
  { to: '/reviews', label: '검토함', icon: ShieldCheck },
  { to: '/operations', label: '운영', icon: Activity },
];
const routeTitles: Array<[RegExp, string]> = [
  [/^\/$/, '오늘의 관측'],
  [/^\/settings\/notifications/, '알림 설정'],
  [/^\/sources$/, '데이터 출처·신선도'],
  [/^\/markets/, '시장 지표'],
  [/^\/search/, '통합 검색'],
  [/^\/news$/, '시장 뉴스'],
  [/^\/news\//, '뉴스 상세'],
  [/^\/events\/[^/]+$/, '이벤트 근거'],
  [/^\/events/, '이벤트 탐색'],
  [/^\/companies$/, '종목 탐색'],
  [/^\/companies\//, '종목 정보'],
  [/^\/watchlist/, '관심 종목'],
  [/^\/reviews/, '검토함'],
  [/^\/operations/, '수집 운영'],
];

export function ThemeButton() {
  const { theme, toggle } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      title={theme === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환'}
      aria-label={theme === 'dark' ? '밝은 테마로 전환' : '어두운 테마로 전환'}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </Button>
  );
}

export function AppShell({ session }: { session: Session }) {
  useNewsCacheExpiry();
  const [stockSidebarExpanded, setStockSidebarExpanded] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const previousPathname = useRef(location.pathname);
  const isAdmin = session.user?.role === 'ADMIN';
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  const isCompanyDetailPage = /^\/companies\/[^/]+$/.test(pathname);
  const queryClient = useQueryClient();
  const audienceIdentity = `${session.user?.role ?? ''}:${session.user?.id ?? ''}`;
  const previousAudience = useRef(audienceIdentity);
  useLayoutEffect(() => {
    if (previousAudience.current !== audienceIdentity) {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      previousAudience.current = audienceIdentity;
    }
  }, [audienceIdentity, queryClient]);
  const title = routeTitles.find(([pattern]) => pattern.test(pathname))?.[1] ?? '오르셈';
  const logout = useMutation({
    mutationFn: async () => {
      await disconnectPushOnLogout(session.user?.id, api.unsubscribeNotifications);
      return api.logout();
    },
    onSuccess: async (nextSession) => {
      clearNewsEditDrafts();
      await queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      queryClient.setQueryData(['session'], nextSession);
      void navigate('/login', { replace: true });
    },
  });
  useEffect(() => {
    if (previousPathname.current !== location.pathname && navigationType !== 'POP') {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
    previousPathname.current = location.pathname;
  }, [location.pathname, navigationType]);
  return (
    <div className="app-shell" data-stock-sidebar={stockSidebarExpanded ? 'expanded' : 'collapsed'}>
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <NavLink to="/" className="brand" aria-label="오르셈 홈">
            <BrandLogo />
          </NavLink>
          <nav className="header-navigation" aria-label="주 메뉴">
            {navigation.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => cn('header-navigation__link', isActive && 'is-active')}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <HeaderSearch actorKey={session.user?.id ?? ''} />
          <div className="site-header__actions">
            <NavLink
              to="/settings/notifications"
              className="header-notification-link"
              aria-label="알림 설정"
              title="알림 설정"
            >
              <Bell size={18} />
            </NavLink>
            <ThemeButton />
            <Button
              variant="ghost"
              size="sm"
              aria-label="로그아웃"
              title="로그아웃"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut size={17} aria-hidden="true" />
              <span className="logout-label">로그아웃</span>
            </Button>
          </div>
        </div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {!isCompanyDetailPage ? (
          <div className="workspace-heading">
            <h1>{title}</h1>
            <div>
              {isFixtureMode ? <Badge tone="orange">개발용 모의 데이터</Badge> : null}
              <span className="workspace-access">
                <ShieldCheck size={14} aria-hidden="true" />
                {isAdmin ? '관리자' : '회원'}
              </span>
            </div>
          </div>
        ) : isFixtureMode ? (
          <Badge tone="orange">개발용 모의 데이터</Badge>
        ) : null}
        {logout.isError ? (
          <p className="form-error" role="alert">
            {logout.error.message || '로그아웃하지 못했습니다. 다시 시도해 주세요.'}
          </p>
        ) : null}
        <Suspense fallback={<LoadingState label="화면을 불러오는 중입니다." />}>
          <Outlet context={session} />
        </Suspense>
      </main>
      <StockSidebar session={session} onExpandedChange={setStockSidebarExpanded} />
      <footer className="site-footer">
        <div className="site-footer__inner">
          <span className="site-footer__brand">
            <img
              className="site-footer__logo"
              src={orsemMark}
              width="36"
              height="36"
              alt="오르셈"
            />
            <span>오르셈</span>
          </span>
          <NavLink
            to="/sources"
            aria-label="데이터 출처·신선도"
            className={({ isActive }) => cn('site-footer__sources', isActive && 'is-active')}
          >
            <Activity size={16} aria-hidden="true" />
            <span className="site-footer__source-label">데이터 출처·신선도</span>
            <span className="site-footer__source-short" aria-hidden="true">
              출처
            </span>
          </NavLink>
          <NavLink to="/logo-sources" className="site-footer__logo-credit">
            로고 출처·이용 안내
          </NavLink>
          {isAdmin ? (
            <nav aria-label="관리 메뉴">
              {administration.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  aria-label={label}
                  title={label}
                  className={({ isActive }) => cn(isActive && 'is-active')}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </nav>
          ) : (
            <span className="site-footer__tagline">공시와 출처를 함께 확인하는 관측 공간</span>
          )}
        </div>
      </footer>
    </div>
  );
}
