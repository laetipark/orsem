import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

const routeTitles: Array<[RegExp, string]> = [
  [/^\/$/, '오늘의 관측'],
  [/^\/settings\/notifications/, '알림 설정'],
  [/^\/sources$/, '데이터 출처·신선도'],
  [/^\/logo-sources$/, '로고 출처·이용 안내'],
  [/^\/markets/, '시장 지표'],
  [/^\/search/, '통합 검색'],
  [/^\/news$/, '시장 뉴스'],
  [/^\/news\//, '뉴스 상세'],
  [/^\/events\/[^/]+$/, '이벤트 근거'],
  [/^\/events/, '이벤트 탐색'],
  [/^\/analysis/, '공시 분석실'],
  [/^\/companies$/, '종목 탐색'],
  [/^\/companies\//, '종목 정보'],
  [/^\/watchlist/, '관심 종목'],
  [/^\/reviews/, '검토함'],
  [/^\/operations/, '수집 운영'],
];

export function usePageNavigation() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousPathname = useRef(location.pathname);
  const main = useRef<HTMLElement>(null);
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  const title = routeTitles.find(([pattern]) => pattern.test(pathname))?.[1] ?? '공시와 시장';

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} · 오르셈`;
    return () => {
      document.title = previousTitle;
    };
  }, [title]);

  useEffect(() => {
    if (previousPathname.current !== location.pathname && navigationType !== 'POP') {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      main.current?.focus({ preventScroll: true });
    }
    previousPathname.current = location.pathname;
  }, [location.pathname, navigationType]);

  return { main, pathname, title };
}
