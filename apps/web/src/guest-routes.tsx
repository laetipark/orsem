import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { GuestShell } from './components/guest-shell';
import { RequireLoginRedirect } from './components/login-redirect';
import type { Session } from './types';

const Home = lazy(() => import('./pages/guest-pages').then((m) => ({ default: m.GuestHomePage })));
const Markets = lazy(() =>
  import('./pages/guest-pages').then((m) => ({ default: m.GuestMarketsPage })),
);
const Market = lazy(() =>
  import('./pages/guest-pages').then((m) => ({ default: m.GuestMarketDetailPage })),
);
const Companies = lazy(() =>
  import('./pages/guest-pages').then((m) => ({ default: m.GuestCompaniesPage })),
);
const Company = lazy(() =>
  import('./pages/guest-pages').then((m) => ({ default: m.GuestCompanyPage })),
);
const News = lazy(() => import('./pages/guest-pages').then((m) => ({ default: m.GuestNewsPage })));
const NewsDetail = lazy(() =>
  import('./pages/guest-pages').then((m) => ({ default: m.GuestNewsDetailPage })),
);
const Login = lazy(() => import('./pages/login-page').then((m) => ({ default: m.LoginPage })));
const AdminLogin = lazy(() =>
  import('./pages/admin-login-page').then((m) => ({ default: m.AdminLoginPage })),
);

export default function GuestRoutes({ session }: { session?: Session }) {
  return (
    <Routes>
      {session ? <Route path="/login" element={<Login session={session} />} /> : null}
      {session ? <Route path="/admin/login" element={<AdminLogin session={session} />} /> : null}
      <Route element={<GuestShell session={session} />}>
        <Route index element={<Home />} />
        <Route path="markets" element={<Markets />} />
        <Route path="markets/:id" element={<Market />} />
        <Route path="companies" element={<Companies />} />
        <Route path="companies/:id" element={<Company />} />
        <Route path="news" element={<News />} />
        <Route path="news/naver" element={<RequireLoginRedirect />} />
        <Route path="news/:id" element={<NewsDetail />} />
      </Route>
      <Route path="events/*" element={<RequireLoginRedirect />} />
      <Route path="analysis" element={<RequireLoginRedirect />} />
      <Route path="watchlist/*" element={<RequireLoginRedirect />} />
      <Route path="settings/*" element={<RequireLoginRedirect />} />
      <Route path="search" element={<RequireLoginRedirect />} />
      <Route path="sources" element={<RequireLoginRedirect />} />
      <Route path="reviews" element={<RequireLoginRedirect />} />
      <Route path="operations" element={<RequireLoginRedirect />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
