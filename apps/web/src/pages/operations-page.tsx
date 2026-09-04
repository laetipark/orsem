import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Activity, Clock3, DatabaseZap, RefreshCw, ServerCog } from 'lucide-react';
import { api } from '../lib/api';
import { formatKst, formatLag, formatNumber } from '../lib/format';
import type { OperationRun } from '../types';
import { DataTable } from '../components/data-table';
import { RightsBadge } from '../components/domain-badges';
import { MemberApproval } from '../components/member-approval';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  LoadingState,
  Progress,
  cn,
} from '../components/ui';

const runStatusLabel = {
  RUNNING: '실행 중',
  SUCCEEDED: '성공',
  FAILED: '실패',
  SKIPPED: '건너뜀',
} as const;

export function OperationsPage() {
  const sources = useQuery({
    queryKey: ['operation-sources'],
    queryFn: api.operationSources,
    refetchInterval: 30_000,
  });
  const runs = useQuery({
    queryKey: ['operation-runs'],
    queryFn: api.operationRuns,
    refetchInterval: 30_000,
  });
  const queues = useQuery({
    queryKey: ['operation-queues'],
    queryFn: api.operationQueues,
    refetchInterval: 15_000,
  });

  async function refetchAll() {
    await Promise.all([sources.refetch(), runs.refetch(), queues.refetch()]);
  }

  const runColumns = useMemo<Array<ColumnDef<OperationRun>>>(
    () => [
      {
        id: 'job',
        header: '작업',
        cell: ({ row }) => (
          <div className="table-job">
            <strong>{row.original.job}</strong>
            <span>{row.original.source}</span>
          </div>
        ),
      },
      {
        id: 'status',
        header: '상태',
        cell: ({ row }) => (
          <Badge
            tone={
              row.original.status === 'SUCCEEDED'
                ? 'teal'
                : row.original.status === 'FAILED'
                  ? 'red'
                  : row.original.status === 'RUNNING'
                    ? 'blue'
                    : 'neutral'
            }
          >
            {runStatusLabel[row.original.status]}
          </Badge>
        ),
      },
      {
        id: 'time',
        header: '시작 / 완료',
        cell: ({ row }) => (
          <div className="cell-dates">
            <span>{formatKst(row.original.startedAt)}</span>
            <small>{formatKst(row.original.finishedAt)}</small>
          </div>
        ),
      },
      {
        id: 'result',
        header: '처리',
        cell: ({ row }) => (
          <div className="run-result">
            <strong>{formatNumber(row.original.processed)}</strong>
            <span className={row.original.failed ? 'negative' : ''}>
              실패 {row.original.failed}
            </span>
          </div>
        ),
      },
      {
        id: 'message',
        header: '메시지',
        cell: ({ row }) => (
          <span className="run-message">{row.original.message ?? '정상 완료'}</span>
        ),
      },
    ],
    [],
  );

  const isPending = sources.isPending || runs.isPending || queues.isPending;
  const firstError = sources.error ?? runs.error ?? queues.error;

  return (
    <div className="page-stack operations-page">
      <div className="page-lead">
        <div>
          <p>소스 권리 정책, 마지막 성공 시각, 큐 적체와 실패를 운영 관점에서 확인합니다.</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void refetchAll()}
          disabled={sources.isFetching || runs.isFetching || queues.isFetching}
        >
          <RefreshCw
            size={15}
            className={sources.isFetching || runs.isFetching || queues.isFetching ? 'spin' : ''}
          />{' '}
          상태 갱신
        </Button>
      </div>
      <MemberApproval />
      {isPending ? <LoadingState label="수집기와 큐 상태를 확인하는 중입니다." /> : null}
      {firstError ? (
        <ErrorState message={firstError.message} onRetry={() => void refetchAll()} />
      ) : null}

      {sources.data ? (
        <section className="source-health-grid" aria-label="소스 상태">
          {sources.data.items.map((source) => (
            <Card
              key={source.id}
              className={cn(
                'source-health-card',
                source.status === 'FAILED' && 'source-health-card--failed',
              )}
            >
              <CardHeader>
                <span
                  className={cn(
                    'source-health-icon',
                    `source-health-icon--${source.status.toLowerCase()}`,
                  )}
                >
                  <ServerCog size={18} />
                </span>
                <Badge
                  tone={
                    source.status === 'HEALTHY'
                      ? 'teal'
                      : source.status === 'FAILED'
                        ? 'red'
                        : 'orange'
                  }
                >
                  {source.status}
                </Badge>
              </CardHeader>
              <CardContent>
                <h2>{source.name}</h2>
                <p>{source.message}</p>
                <div className="source-health-meta">
                  <span>
                    <Clock3 size={14} /> {formatKst(source.lastSuccessAt)}
                  </span>
                  <span>지연 {formatLag(source.lagSeconds)}</span>
                </div>
                <RightsBadge status={source.rightsMode} />
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}

      {queues.data ? (
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">BULLMQ</span>
              <h2>작업 큐</h2>
            </div>
            <Badge>{queues.data.items.length}개 큐</Badge>
          </CardHeader>
          <CardContent className="queue-grid">
            {queues.data.items.map((queue) => {
              const total = queue.waiting + queue.active + queue.delayed + queue.failed;
              const pressure = Math.min(100, total * 4);
              return (
                <article className="queue-card" key={queue.name}>
                  <div className="queue-card__head">
                    <span>
                      <DatabaseZap size={17} />
                    </span>
                    <strong>{queue.name}</strong>
                    <Badge tone={queue.failed ? 'red' : queue.waiting > 10 ? 'orange' : 'teal'}>
                      {queue.failed ? '실패 있음' : '정상'}
                    </Badge>
                  </div>
                  <Progress value={pressure} label={`${queue.name} 큐 적체도`} />
                  <dl>
                    <div>
                      <dt>대기</dt>
                      <dd>{queue.waiting}</dd>
                    </div>
                    <div>
                      <dt>실행</dt>
                      <dd>{queue.active}</dd>
                    </div>
                    <div>
                      <dt>지연</dt>
                      <dd>{queue.delayed}</dd>
                    </div>
                    <div>
                      <dt>실패</dt>
                      <dd className={queue.failed ? 'negative' : ''}>{queue.failed}</dd>
                    </div>
                  </dl>
                  <p>가장 오래된 대기 {formatKst(queue.oldestWaitingAt)}</p>
                </article>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {runs.data ? (
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">RECENT RUNS</span>
              <h2>최근 수집 실행</h2>
            </div>
            <span className="live-chip">
              <i /> 30초 갱신
            </span>
          </CardHeader>
          <CardContent>
            <DataTable data={runs.data.items} columns={runColumns} />
          </CardContent>
        </Card>
      ) : null}

      <div className="operational-note">
        <Activity size={17} />
        <span>
          커넥터 자격증명이 없으면 해당 소스만 비활성화됩니다. 다른 공식 소스와 저장된 데이터 조회는
          계속 동작합니다.
        </span>
      </div>
    </div>
  );
}
