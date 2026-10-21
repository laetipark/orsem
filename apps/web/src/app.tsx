import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useLayoutEffect, useMemo, useRef } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, isTemporaryApiError } from './lib/api';
import { sessionQueryOptions } from './lib/session-query';
import { postWatchlistPopoutMessage, watchlistPictureInPictureOwner } from './lib/watchlist-popout';
import { AppShell } from './components/app-shell';
import { Button, ErrorState, LoadingState } from './components/ui';
import './app-session.css';

const GuestRoutes = lazy(() => import('./guest-routes'));

const LoginPage = lazy(() =>
  import('./pages/login-page').then((module) => ({ default: module.LoginPage })),
);
const AdminLoginPage = lazy(() =>
  import('./pages/admin-login-page').then((module) => ({ default: module.AdminLoginPage })),
);
const DashboardPage = lazy(() =>
  import('./pages/dashboard-page').then((module) => ({ default: module.DashboardPage })),
);
const EventsPage = lazy(() =>
  import('./pages/events-page').then((module) => ({ default: module.EventsPage })),
);
const EventDetailPage = lazy(() =>
  import('./pages/event-detail-page').then((module) => ({ default: module.EventDetailPage })),
);
const CompaniesPage = lazy(() =>
  import('./pages/companies-page').then((module) => ({ default: module.CompaniesPage })),
);
const CompanyPage = lazy(() =>
  import('./pages/company-page').then((module) => ({ default: module.CompanyPage })),
);
const DisclosureAnalysisPage = lazy(() =>
  import('./pages/disclosure-analysis-page').then((module) => ({
    default: module.DisclosureAnalysisPage,
  })),
);
const WatchlistPage = lazy(() =>
  import('./pages/watchlist-page').then((module) => ({ default: module.WatchlistPage })),
);
const WatchlistPopoutPage = lazy(() =>
  import('./pages/watchlist-popout-page').then((module) => ({
    default: module.WatchlistPopoutPage,
  })),
);
const ReviewsPage = lazy(() =>
  import('./pages/reviews-page').then((module) => ({ default: module.ReviewsPage })),
);
const OperationsPage = lazy(() =>
  import('./pages/operations-page').then((module) => ({ default: module.OperationsPage })),
);
const SearchPage = lazy(() =>
  import('./pages/search-page').then((module) => ({ default: module.SearchPage })),
);
const NewsPage = lazy(() =>
  import('./pages/news-page').then((module) => ({ default: module.NewsPage })),
);
const NewsDetailPage = lazy(() =>
  import('./pages/news-detail-page').then((module) => ({ default: module.NewsDetailPage })),
);
const MarketsPage = lazy(() =>
  import('./pages/markets-page').then((module) => ({ default: module.MarketsPage })),
);
const MarketDetailPage = lazy(() =>
  import('./pages/markets-page').then((module) => ({ default: module.MarketDetailPage })),
);

const NotificationsPage = lazy(() =>
  import('./pages/notifications-page').then((module) => ({ default: module.NotificationsPage })),
);
const SourcesPage = lazy(() =>
  import('./pages/sources-page').then((module) => ({ default: module.SourcesPage })),
);
const LogoSourcesPage = lazy(() =>
  import('./pages/logo-sources-page').then((module) => ({ default: module.LogoSourcesPage })),
);

export function App() {
  return (
    <Suspense fallback={<LoadingState label="화면을 불러오는 중입니다." />}>
      <Routes>
        <Route path="/logo-sources" element={<LogoSourcesPage />} />
        <Route path="*" element={<SessionApp />} />
      </Routes>
    </Suspense>
  );
}

function SessionApp() {
  const location = useLocation();
  const publicPath =
    /^(?:\/(?:markets|companies|news)(?:\/[^/]+)?|\/)\/?$/.test(location.pathname) &&
    location.pathname.replace(/\/+$/, '') !== '/news/naver';
  const queryClient = useQueryClient();
  const options = useMemo(sessionQueryOptions, []);
  const session = useQuery(options);
  const transientSessionError = session.isError && isTemporaryApiError(session.error);
  const sessionRejected = useRef(false);
  const authorizationError =
    session.isError &&
    session.error instanceof ApiError &&
    (session.error.statusCode === 401 || session.error.statusCode === 403);
  useLayoutEffect(() => {
    if (authorizationError) sessionRejected.current = true;
    else if (session.isSuccess) sessionRejected.current = false;
  }, [authorizationError, session.isSuccess]);
  const sessionUsable =
    Boolean(session.data) &&
    (!session.isError || (transientSessionError && !sessionRejected.current));
  const audience =
    sessionUsable && session.data
      ? `${session.data.authenticated}:${session.data.canAccess}:${session.data.user?.role ?? ''}:${session.data.user?.id ?? ''}`
      : session.isPending
        ? null
        : 'unconfirmed';
  const previousAudience = useRef(audience);
  const hasAccess = sessionUsable && session.data?.authenticated && session.data.canAccess;
  useLayoutEffect(() => {
    if (audience === null) return;
    if (previousAudience.current !== null && previousAudience.current !== audience) {
      // Standalone authenticated routes need the same account isolation as AppShell.
      const privateQueries = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          query.queryKey[0] !== 'session' && query.queryKey[0] !== 'public',
      };
      void queryClient.cancelQueries(privateQueries);
      queryClient.removeQueries(privateQueries);
    }
    previousAudience.current = audience;
    if (!hasAccess) {
      const owner = watchlistPictureInPictureOwner();
      if (owner)
        postWatchlistPopoutMessage(
          owner,
          'session-ended',
          new URLSearchParams(window.location.search),
        );
    }
  }, [audience, hasAccess, queryClient]);

  const connectionFailed = useRef(false);
  useLayoutEffect(() => {
    if (transientSessionError) connectionFailed.current = true;
    else if (session.isSuccess && connectionFailed.current) {
      connectionFailed.current = false;
      // Resume visible data that failed during the same outage, after account isolation above.
      void queryClient.refetchQueries(
        {
          type: 'active',
          predicate: (query) =>
            query.queryKey[0] !== 'session' &&
            query.state.status === 'error' &&
            isTemporaryApiError(query.state.error),
        },
        { cancelRefetch: false },
      );
    }
  }, [transientSessionError, session.isSuccess, queryClient]);

  if (session.isPending && publicPath) return <GuestRoutes />;
  if (session.isPending)
    return (
      <div className="fullscreen-state">
        <LoadingState label="보안 세션을 확인하는 중입니다." />
      </div>
    );
  // A failed background check does not invalidate a previously confirmed session.
  // Explicit authorization errors must still hide the authenticated application.
  if (!sessionUsable) {
    if (publicPath)
      return (
        <>
          <div role="status" className="session-connection-notice">
            <span>
              {transientSessionError
                ? '로그인 상태를 확인하지 못했습니다. 공개 차트와 뉴스는 계속 이용할 수 있습니다.'
                : (session.error?.message ?? '로그인 상태를 확인하지 못했습니다.')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={session.isFetching}
              onClick={() => void session.refetch()}
            >
              연결 다시 확인
            </Button>
          </div>
          <GuestRoutes />
        </>
      );
    return (
      <div className="fullscreen-state">
        {transientSessionError ? (
          <section className="session-unavailable" role="status" aria-live="polite">
            <h1>서버에 잠시 연결할 수 없습니다</h1>
            <p>서버가 다시 시작 중이거나 연결이 지연되고 있습니다.</p>
            <p>잠시 후 자동으로 다시 연결합니다.</p>
            <Button disabled={session.isFetching} onClick={() => void session.refetch()}>
              {session.isFetching ? '연결 확인 중…' : '다시 연결'}
            </Button>
          </section>
        ) : (
          <ErrorState
            message={session.error?.message ?? '로그인 상태를 확인하지 못했습니다.'}
            onRetry={() => void session.refetch()}
          />
        )}
      </div>
    );
  }

  const connectionNotice = transientSessionError ? (
    <div role="status" aria-live="polite" className="session-connection-notice">
      <span>서버 연결이 원활하지 않습니다. 잠시 후 자동으로 다시 연결합니다.</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={session.isFetching}
        onClick={() => void session.refetch()}
      >
        연결 다시 확인
      </Button>
    </div>
  ) : null;
  const value = session.data!;
  if (!value.authenticated || !value.canAccess) {
    return (
      <Suspense
        fallback={
          <div className="fullscreen-state">
            <LoadingState label="화면을 준비하는 중입니다." />
          </div>
        }
      >
        {connectionNotice}
        <GuestRoutes session={value} />
      </Suspense>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="fullscreen-state">
          <LoadingState label="화면을 불러오는 중입니다." />
        </div>
      }
    >
      {connectionNotice}
      <Routes>
        <Route path="/login" element={<LoginPage session={value} />} />
        <Route path="/admin/login" element={<AdminLoginPage session={value} />} />
        <Route element={<Outlet context={value} />}>
          <Route path="watchlist/popout" element={<WatchlistPopoutPage />} />
        </Route>
        <Route element={<AppShell session={value} />}>
          <Route index element={<DashboardPage />} />
          <Route path="markets" element={<MarketsPage />} />
          <Route path="markets/:id" element={<MarketDetailPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="news" element={<NewsPage />} />
          <Route path="news/naver" element={<Navigate to="/news" replace />} />
          <Route path="news/:id" element={<NewsDetailPage />} />
          <Route path="events/:id" element={<EventDetailPage />} />
          <Route path="companies" element={<CompaniesPage />} />
          <Route path="companies/:id" element={<CompanyPage />} />
          <Route path="analysis" element={<DisclosureAnalysisPage />} />
          <Route path="settings/notifications" element={<NotificationsPage />} />
          <Route path="sources" element={<SourcesPage />} />
          <Route path="watchlist" element={<WatchlistPage />} />
          <Route
            path="reviews"
            element={value.user?.role === 'ADMIN' ? <ReviewsPage /> : <Navigate to="/" replace />}
          />
          <Route
            path="operations"
            element={
              value.user?.role === 'ADMIN' ? <OperationsPage /> : <Navigate to="/" replace />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
