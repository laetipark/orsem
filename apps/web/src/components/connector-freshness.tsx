import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowUpRight, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatKst, formatLag } from '../lib/format';
import { RightsBadge } from './domain-badges';
import { Badge, Button, Card, CardContent, CardHeader, ErrorState, LoadingState } from './ui';
import type { SourceFreshness } from '../types';
import './connector-freshness.css';

const statusLabels: Record<SourceFreshness['status'], string> = {
  HEALTHY: '정상',
  DEGRADED: '지연',
  DISABLED: '비활성',
  UNCONFIGURED: '미설정',
  FAILED: '오류',
};

const categoryLabels: Record<SourceFreshness['category'], string> = {
  OFFICIAL: '공식 공시',
  NEWS: '뉴스',
  MARKET: '시장 데이터',
};

export function ConnectorFreshness({ isAdmin }: { isAdmin: boolean }) {
  const sources = useQuery({
    queryKey: ['source-freshness'],
    queryFn: api.sourceFreshness,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return (
    <Card className="connector-freshness" aria-labelledby="connector-freshness-title">
      <CardHeader>
        <div>
          <span className="section-kicker">FRESHNESS</span>
          <h2 id="connector-freshness-title">
            <Activity size={19} aria-hidden="true" /> 커넥터 신선도
          </h2>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void sources.refetch()}
          disabled={sources.isFetching}
        >
          <RefreshCw size={14} aria-hidden="true" /> 상태 새로고침
        </Button>
      </CardHeader>
      <CardContent>
        <div className="connector-freshness__intro">
          <p>저장된 수집 상태입니다. 시세·자료의 기준 시각은 각 화면에서 확인할 수 있습니다.</p>
          {sources.data ? <p>조회 기준 {formatKst(sources.data.asOf)}</p> : null}
        </div>
        {sources.isPending ? <LoadingState label="커넥터 신선도를 불러오는 중입니다." /> : null}
        {sources.isError ? (
          <ErrorState
            message={
              sources.data
                ? '최신 상태를 불러오지 못해 마지막으로 확인한 상태를 표시합니다.'
                : '수집 상태를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.'
            }
            onRetry={() => void sources.refetch()}
          />
        ) : null}
        {sources.data?.items.length ? (
          <ul className="connector-freshness__grid">
            {sources.data.items.map((source) => (
              <li key={source.id} className="connector-source">
                <div className="connector-source__heading">
                  <div>
                    <span className="connector-source__category">
                      {categoryLabels[source.category]}
                    </span>
                    <h3>{source.name}</h3>
                  </div>
                  <Badge
                    tone={
                      source.status === 'HEALTHY'
                        ? 'teal'
                        : source.status === 'FAILED'
                          ? 'red'
                          : source.status === 'DEGRADED'
                            ? 'orange'
                            : 'neutral'
                    }
                  >
                    {statusLabels[source.status]}
                  </Badge>
                </div>
                <dl>
                  <div>
                    <dt>마지막 성공</dt>
                    <dd>{source.lastSuccessAt ? formatKst(source.lastSuccessAt) : '기록 없음'}</dd>
                  </div>
                  <div>
                    <dt>성공 후 경과</dt>
                    <dd>{source.lagSeconds === null ? '—' : formatLag(source.lagSeconds)}</dd>
                  </div>
                </dl>
                <RightsBadge status={source.rightsMode} />
              </li>
            ))}
          </ul>
        ) : sources.data && !sources.isError ? (
          <p className="connector-freshness__empty">아직 기록된 수집 상태가 없습니다.</p>
        ) : null}
        {isAdmin ? (
          <Link className="connector-freshness__operations" to="/operations">
            운영 상세 보기 <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
