import { useNewsCacheExpiry } from '../lib/news-cache';
import {
  Activity,
  Bell,
  Building2,
  ChartNoAxesCombined,
  FileSearch,
  LayoutDashboard,
  LogOut,
  Newspaper,
  ShieldCheck,
  Star,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { disconnectPushOnLogout } from '../lib/web-push';
import { clearNewsEditDrafts } from '../lib/news-edit-drafts';
import { api, isFixtureMode } from '../lib/api';
import { BrandLogo } from './brand-logo';
import orsemMark from '../assets/orsem-mark.svg';
import { HeaderSearch } from './search-autocomplete';
import { StockSidebar } from './stock-sidebar';
import { Badge, Button, LoadingState, cn } from './ui';
import { ThemeButton } from './theme-button';
import { usePageNavigation } from './page-navigation';
import type { Session } from '../types';
import './app-shell.css';

const navigation = [
  { to: '/', label: '오늘', icon: LayoutDashboard, end: true },
  { to: '/markets', label: '시장', icon: ChartNoAxesCombined },
  { to: '/companies', label: '종목', icon: Building2 },
  { to: '/events', label: '이벤트', icon: FileSearch },
  { to: '/analysis', label: '공시 분석실', icon: FileSearch },
  { to: '/news', label: '뉴스', icon: Newspaper },
  { to: '/watchlist', label: '관심 종목', icon: Star },
];
const administration = [
  { to: '/reviews', label: '검토함', icon: ShieldCheck },
  { to: '/operations', label: '운영', icon: Activity },
];
export function AppShell({ session }: { session: Session }) {
  useNewsCacheExpiry();
  const [stockSidebarExpanded, setStockSidebarExpanded] = useState(false);
  const navigate = useNavigate();
  const { main, pathname, title } = usePageNavigation();
  const navigationRef = useRef<HTMLElement>(null);
  const isAdmin = session.user?.role === 'ADMIN';
  const isCompanyDetailPage = /^\/companies\/[^/]+$/.test(pathname);
  const queryClient = useQueryClient();
  const audienceIdentity = `${session.user?.role ?? ''}:${session.user?.id ?? ''}`;
  const previousAudience = useRef(audienceIdentity);
  useLayoutEffect(() => {
    if (previousAudience.current !== audienceIdentity) {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session' && query.queryKey[0] !== 'public',
      });
      previousAudience.current = audienceIdentity;
    }
  }, [audienceIdentity, queryClient]);
  const logout = useMutation({
    mutationFn: async () => {
      await disconnectPushOnLogout(session.user?.id, api.unsubscribeNotifications);
      return api.logout();
    },
    onSuccess: async (nextSession) => {
      clearNewsEditDrafts();
      await queryClient.cancelQueries({ predicate: (query) => query.queryKey[0] !== 'public' });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session' && query.queryKey[0] !== 'public',
      });
      queryClient.setQueryData(['session'], nextSession);
      void navigate('/', { replace: true });
    },
  });
  useEffect(() => {
    const element = navigationRef.current;
    if (!element) return;
    const revealActiveLink = () => {
      const active = element.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active || element.scrollWidth <= element.clientWidth) return;
      const bounds = element.getBoundingClientRect();
      const activeBounds = active.getBoundingClientRect();
      if (activeBounds.left < bounds.left) element.scrollLeft += activeBounds.left - bounds.left;
      else if (activeBounds.right > bounds.right)
        element.scrollLeft += activeBounds.right - bounds.right;
    };
    revealActiveLink();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(revealActiveLink);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [pathname]);
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
          <nav ref={navigationRef} className="header-navigation" aria-label="주 메뉴">
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
      <main ref={main} id="main-content" className="main-content" tabIndex={-1}>
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
