import {
  Activity,
  Bell,
  ChartNoAxesCombined,
  FileSearch,
  LayoutDashboard,
  LogOut,
  Moon,
  Newspaper,
  Search,
  ShieldCheck,
  Star,
  Sun,
} from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { disconnectPushOnLogout } from '../lib/web-push';
import { api, isFixtureMode } from '../lib/api';
import { BrandLogo } from './brand-logo';
import { parseRegion } from './region-tabs';
import { useTheme } from '../theme';
import { Badge, Button, LoadingState, cn } from './ui';
import type { Session } from '../types';
import './app-shell.css';

const navigation = [
  { to: '/', label: '오늘', icon: LayoutDashboard, end: true },
  { to: '/markets', label: '시장', icon: ChartNoAxesCombined },
  { to: '/events', label: '이벤트', icon: FileSearch },
  { to: '/news', label: '뉴스', icon: Newspaper },
  { to: '/watchlist', label: '관심기업', icon: Star },
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
  [/^\/news\/naver$/, '네이버 뉴스 검색'],
  [/^\/news$/, '시장 뉴스'],
  [/^\/events\/[^/]+$/, '이벤트 근거'],
  [/^\/events/, '이벤트 탐색'],
  [/^\/companies\//, '기업 관측'],
  [/^\/watchlist/, '관심기업'],
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

function HeaderSearch() {
  const location = useLocation();
  const navigate = useNavigate();
  const [input, setInput] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (location.pathname === '/search')
      setInput(new URLSearchParams(location.search).get('q') ?? '');
  }, [location.pathname, location.search]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key !== '/' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))
      )
        return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    const query = input.trim();
    if (!query) {
      inputRef.current?.focus();
      return;
    }
    const params = new URLSearchParams({ q: query });
    const region = parseRegion(new URLSearchParams(location.search).get('region'));
    if (region !== 'all') params.set('region', region);
    void navigate(`/search?${params}`);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }
  return (
    <form
      className="header-search"
      role="search"
      aria-label="종목·뉴스·공시 통합 검색"
      onSubmit={submit}
    >
      <Search size={18} aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        aria-label="종목·뉴스·공시 검색어"
        placeholder="종목·뉴스·공시 검색"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        maxLength={120}
        autoComplete="off"
      />
      <button type="submit" aria-label="통합 검색 실행">
        검색
      </button>
    </form>
  );
}

export function AppShell({ session }: { session: Session }) {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const previousPathname = useRef(location.pathname);
  const isAdmin = session.user?.role === 'ADMIN';
  const queryClient = useQueryClient();
  const title = routeTitles.find(([pattern]) => pattern.test(location.pathname))?.[1] ?? 'ORSEM';
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
  useEffect(() => {
    if (previousPathname.current !== location.pathname && navigationType !== 'POP') {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
    previousPathname.current = location.pathname;
  }, [location.pathname, navigationType]);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <NavLink to="/" className="brand" aria-label="ORSEM 홈">
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
          <HeaderSearch />
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
        <div className="workspace-heading">
          <h1>{title}</h1>
          <div>
            {isFixtureMode ? <Badge tone="orange">개발용 모의 데이터</Badge> : null}
            <span className="workspace-access">
              <ShieldCheck size={14} aria-hidden="true" />
              {isAdmin ? '개인 관측' : '조회 전용'}
            </span>
          </div>
        </div>
        {logout.isError ? (
          <p className="form-error" role="alert">
            {logout.error.message || '로그아웃하지 못했습니다. 다시 시도해 주세요.'}
          </p>
        ) : null}
        <Suspense fallback={<LoadingState label="화면을 불러오는 중입니다." />}>
          <Outlet context={session} />
        </Suspense>
      </main>
      <footer className="site-footer">
        <div className="site-footer__inner">
          <span className="site-footer__brand">
            <img
              className="site-footer__logo"
              src="/favicon.svg"
              width="36"
              height="36"
              alt="ORSEM"
            />
            <span>한국 시간 기준</span>
          </span>
          <NavLink
            to="/sources"
            className={({ isActive }) => cn('site-footer__sources', isActive && 'is-active')}
          >
            <Activity size={16} aria-hidden="true" /> 데이터 출처·신선도
          </NavLink>
          {isAdmin ? (
            <nav aria-label="관리 메뉴">
              {administration.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} className={({ isActive }) => cn(isActive && 'is-active')}>
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </nav>
          ) : (
            <span>공시와 출처를 함께 확인하는 관측 공간</span>
          )}
        </div>
      </footer>
    </div>
  );
}
