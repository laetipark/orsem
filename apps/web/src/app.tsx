import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { RequireLoginRedirect } from './components/login-redirect';
import { AppShell } from './components/app-shell';
import { ErrorState, LoadingState } from './components/ui';

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
const CompanyPage = lazy(() =>
  import('./pages/company-page').then((module) => ({ default: module.CompanyPage })),
);
const WatchlistPage = lazy(() =>
  import('./pages/watchlist-page').then((module) => ({ default: module.WatchlistPage })),
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
const NaverNewsSearchPage = lazy(() =>
  import('./pages/naver-news-search-page').then((module) => ({
    default: module.NaverNewsSearchPage,
  })),
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

export function App() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: api.session,
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  if (session.isPending)
    return (
      <div className="fullscreen-state">
        <LoadingState label="보안 세션을 확인하는 중입니다." />
      </div>
    );
  if (session.isError)
    return (
      <div className="fullscreen-state">
        <ErrorState message={session.error.message} onRetry={() => void session.refetch()} />
      </div>
    );

  const value = session.data;
  if (!value.authenticated || !value.canAccess) {
    return (
      <Suspense
        fallback={
          <div className="fullscreen-state">
            <LoadingState label="로그인 화면을 준비하는 중입니다." />
          </div>
        }
      >
        <Routes>
          <Route path="/login" element={<LoginPage session={value} />} />
          <Route path="/admin/login" element={<AdminLoginPage session={value} />} />
          <Route path="*" element={<RequireLoginRedirect />} />
        </Routes>
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
      <Routes>
        <Route path="/login" element={<LoginPage session={value} />} />
        <Route path="/admin/login" element={<AdminLoginPage session={value} />} />
        <Route element={<AppShell session={value} />}>
          <Route index element={<DashboardPage />} />
          <Route path="markets" element={<MarketsPage />} />
          <Route path="markets/:id" element={<MarketDetailPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="news" element={<NewsPage />} />
          <Route path="news/naver" element={<NaverNewsSearchPage />} />
          <Route path="news/:id" element={<NewsDetailPage />} />
          <Route path="events/:id" element={<EventDetailPage />} />
          <Route path="companies/:id" element={<CompanyPage />} />
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
