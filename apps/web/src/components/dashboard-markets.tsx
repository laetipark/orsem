import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  marketSchedule,
  scheduledRegion,
  type ScheduledMarketRegion,
} from '../lib/market-schedule';
import { MarketOverview } from './market-overview';
import './region-tabs.css';

export function useDashboardMarketRegion() {
  const [params, setParams] = useSearchParams();
  const windowRef = useRef(marketSchedule().window);
  const region = scheduledRegion(params.get('region'));
  useEffect(() => {
    let timer: number;
    function checkBoundary() {
      const now = Date.now();
      const schedule = marketSchedule(now);
      const changed = schedule.window !== windowRef.current;
      windowRef.current = schedule.window;
      const value = params.get('region');
      if (changed || (value !== 'kr' && value !== 'us')) {
        setParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.set('region', schedule.region);
            next.delete('cursor');
            return next;
          },
          { replace: true },
        );
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(checkBoundary, Math.max(1, schedule.nextBoundary - now));
    }
    checkBoundary();
    window.addEventListener('focus', checkBoundary);
    document.addEventListener('visibilitychange', checkBoundary);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', checkBoundary);
      document.removeEventListener('visibilitychange', checkBoundary);
    };
  }, [params, setParams]);
  function selectRegion(value: ScheduledMarketRegion) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('region', value);
      next.delete('cursor');
      return next;
    });
  }
  return { region, selectRegion };
}

export function DashboardMarkets() {
  const { region, selectRegion } = useDashboardMarketRegion();
  return (
    <section className="dashboard-markets" aria-label="시간대별 시장 요약">
      <div className="dashboard-markets__toolbar">
        <div className="region-tabs" role="group" aria-label="메인 시장 선택">
          {(['kr', 'us'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={region === value}
              onClick={() => selectRegion(value)}
            >
              {value === 'kr' ? '국내' : '미국'}
            </button>
          ))}
        </div>
        <Link className="text-link" to="/markets">
          시장 전체 보기 <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
      <MarketOverview dashboard dashboardRegion={region} />
      <p className="dashboard-markets__schedule">한국 시간 06:00 국내 · 18:00 미국 자동 전환</p>
    </section>
  );
}
