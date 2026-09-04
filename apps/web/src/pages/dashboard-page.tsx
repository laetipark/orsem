import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon,
  BellOff,
  ChevronRight,
  FileWarning,
  RefreshCw,
  ShieldQuestion,
} from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../lib/api';
import { formatKst } from '../lib/format';
import { disclosureDescriptions, disclosureLabels, priorityLabels } from '../lib/domain-labels';
import { DashboardMarkets } from '../components/dashboard-markets';
import { DashboardNews } from '../components/market-news';
import { ParseIntegritySummary } from '../components/parse-integrity-summary';
import { EventCompactRow } from '../components/event-row';
import { ObservationDisclaimer } from '../components/disclaimer';
import { Button, Card, CardContent, CardHeader, ErrorState, LoadingState } from '../components/ui';
import type { Session } from '../types';
import './dashboard-page.css';

const disclosureTypes = ['D001', 'D002', 'D005'] as const;

export function DashboardPage() {
  const session = useOutletContext<Session>();
  const isAdmin = session?.user?.role === 'ADMIN';
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: api.dashboard,
    refetchInterval: 60_000,
  });

  if (dashboard.isPending)
    return <LoadingState label="오늘 공시와 우선순위 큐를 불러오는 중입니다." />;
  if (dashboard.isError)
    return (
      <ErrorState message={dashboard.error.message} onRetry={() => void dashboard.refetch()} />
    );
  const data = dashboard.data;

  return (
    <div className="page-stack dashboard-page">
      <div className="page-lead">
        <div>
          <p>공시 제출을 감지한 시각과 실제 사건일을 분리해 표시합니다.</p>
          <span className="as-of">기준 {formatKst(data.asOf)}</span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void dashboard.refetch()}
          disabled={dashboard.isFetching}
        >
          <RefreshCw className={dashboard.isFetching ? 'spin' : ''} size={15} aria-hidden="true" />{' '}
          새로고침
        </Button>
      </div>

      <DashboardMarkets />

      <DashboardNews />

      <section className="priority-grid" aria-label="우선순위 이벤트">
        <Card>
          <CardHeader className="priority-card__header">
            <h2>
              <span className="priority-card__dot priority-card__dot--focus" aria-hidden="true" />
              {priorityLabels.P1}
            </h2>
            <Link className="text-link" to="/events?priority=P1">
              전체 보기 <ChevronRight size={14} />
            </Link>
          </CardHeader>
          <CardContent className="event-list">
            {data.priorities.P1.map((event) => (
              <EventCompactRow key={event.id} event={event} />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="priority-card__header">
            <h2>
              <span className="priority-card__dot" aria-hidden="true" />
              {priorityLabels.P2}
            </h2>
            <Link className="text-link" to="/events?priority=P2">
              전체 보기 <ChevronRight size={14} />
            </Link>
          </CardHeader>
          <CardContent className="event-list">
            {data.priorities.P2.map((event) => (
              <EventCompactRow key={event.id} event={event} />
            ))}
          </CardContent>
        </Card>
      </section>

      {isAdmin ? (
        <section className="dashboard-controls">
          <Card>
            <CardHeader>
              <div>
                <span className="section-kicker">CONTROL</span>
                <h2>확인 필요한 항목</h2>
              </div>
            </CardHeader>
            <CardContent className="issue-grid">
              <Link to="/reviews" className="issue-tile">
                <span className="issue-tile__icon issue-tile__icon--orange">
                  <ShieldQuestion size={18} />
                </span>
                <div>
                  <strong>{data.integrity?.currentReviewSubjects ?? data.reviewPending}</strong>
                  <span>현재 검토 대상</span>
                </div>
                <ChevronRight size={16} />
              </Link>
              <Link to="/operations" className="issue-tile">
                <span className="issue-tile__icon issue-tile__icon--red">
                  <FileWarning size={18} />
                </span>
                <div>
                  <strong>{data.integrity?.currentFailedFilings ?? data.parserFailures}</strong>
                  <span>파싱 실패 공시</span>
                </div>
                <ChevronRight size={16} />
              </Link>
              <Link to="/operations" className="issue-tile">
                <span className="issue-tile__icon issue-tile__icon--red">
                  <BellOff size={18} />
                </span>
                <div>
                  <strong>{data.alertFailures}</strong>
                  <span>알림 실패</span>
                </div>
                <ChevronRight size={16} />
              </Link>
            </CardContent>
            {data.integrity ? (
              <CardContent>
                <ParseIntegritySummary data={data.integrity} />
              </CardContent>
            ) : null}
          </Card>
        </section>
      ) : null}

      {isAdmin &&
      ((data.integrity?.currentFailedFilings ?? data.parserFailures) > 0 ||
        data.alertFailures > 0) ? (
        <div className="operational-note">
          <AlertOctagon size={17} />
          <span>
            일부 후처리 작업이 실패했습니다. 원본 공시 감지는 유지되며 실패 건은 운영 화면에서
            재처리 상태를 확인할 수 있습니다.
          </span>
        </div>
      ) : null}
      <section className="disclosure-strip" aria-label="오늘의 OpenDART 공시 건수">
        {disclosureTypes.map((type) => (
          <Link
            key={type}
            to={`/events?detailType=${type}`}
            className={`disclosure-stat disclosure-stat--${type.toLowerCase()}`}
          >
            <div className="disclosure-stat__copy">
              <b>{disclosureLabels[type]}</b>
              <small>{disclosureDescriptions[type]}</small>
            </div>
            <strong>
              {data.todayCounts[type]}
              <span>건</span>
            </strong>
            <ChevronRight size={18} aria-hidden="true" />
          </Link>
        ))}
      </section>
      <ObservationDisclaimer compact />
    </div>
  );
}
