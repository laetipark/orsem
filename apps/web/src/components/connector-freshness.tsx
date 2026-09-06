import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Activity, ArrowUpRight, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { naverBudgetAvailable } from '../lib/naver-news';
import { formatKst, formatLag } from '../lib/format';
import { RightsBadge } from './domain-badges';
import { Badge, Button, Card, CardContent, CardHeader, ErrorState, LoadingState } from './ui';
import type { SourceFreshness, NaverNewsStatus } from '../types';
import './connector-freshness.css';

const statusLabels: Record<SourceFreshness['status'], string> = {
  HEALTHY: '정상',
  DEGRADED: '지연',
  DISABLED: '비활성',
  UNCONFIGURED: '미설정',
  FAILED: '오류',
};

export function naverStatusLabel(status: NaverNewsStatus | undefined, failed: boolean): string {
  if (!status) return failed ? '연결 확인 실패' : '연결 확인 중';
  if (!status.configured) return '미설정';
  if (status.remainingToday === 0 || status.remainingMonth === 0) return '검색 한도 소진';
  return naverBudgetAvailable(status) ? '자동 수집 가능' : '검색 일시 중단';
}

type ConnectorGroup = SourceFreshness['category'] | 'OTHER';
const groupOrder: ConnectorGroup[] = ['OFFICIAL', 'MARKET', 'NEWS', 'OTHER'];
const categoryLabels: Record<ConnectorGroup, string> = {
  OFFICIAL: '공식 공시',
  NEWS: '뉴스',
  MARKET: '시장 데이터',
  OTHER: '기타',
};

function sourceGroup(source: SourceFreshness): ConnectorGroup {
  const id = source.id.toLowerCase();
  if (id === 'ai') return 'OTHER';
  if (id === 'ir' || id === 'news_rss' || id.startsWith('news_rss:')) return 'NEWS';
  return groupOrder.includes(source.category) ? source.category : 'OTHER';
}

function groupSources(items: SourceFreshness[]) {
  const grouped: Record<ConnectorGroup, SourceFreshness[]> = {
    OFFICIAL: [],
    MARKET: [],
    NEWS: [],
    OTHER: [],
  };
  for (const source of items) grouped[sourceGroup(source)].push(source);
  return groupOrder.flatMap((category) => {
    const sources = grouped[category];
    sources.sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id, 'en'));
    return sources.length ? [{ category, sources }] : [];
  });
}

export function ConnectorFreshness({ isAdmin }: { isAdmin: boolean }) {
  const sources = useQuery({
    queryKey: ['source-freshness'],
    queryFn: api.sourceFreshness,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const naver = useQuery({
    queryKey: ['naver-news-status', 'sources'],
    queryFn: ({ signal }) => api.naverNewsStatus(signal),
    enabled: sources.data?.items.some((source) => source.id.toLowerCase() === 'naver') ?? false,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const groups = useMemo(() => groupSources(sources.data?.items ?? []), [sources.data?.items]);
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
          onClick={() => {
            void sources.refetch();
            if (sources.data?.items.some((source) => source.id.toLowerCase() === 'naver'))
              void naver.refetch();
          }}
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
          <div className="connector-freshness__groups">
            {groups.map(({ category, sources: items }) => (
              <section
                key={category}
                className="connector-freshness__group"
                aria-label={categoryLabels[category]}
              >
                <h3 className="connector-freshness__group-title">
                  {categoryLabels[category]} <span>{items.length}개</span>
                </h3>
                <ul className="connector-freshness__grid">
                  {items.map((source) => (
                    <li key={source.id} className="connector-source">
                      <div className="connector-source__heading">
                        <div>
                          <span className="connector-source__category">
                            {categoryLabels[category]}
                          </span>
                          <h4>{source.name}</h4>
                        </div>
                        <Badge
                          tone={
                            source.id.toLowerCase() === 'naver'
                              ? naver.data && naverBudgetAvailable(naver.data)
                                ? 'teal'
                                : naver.data?.configured
                                  ? 'orange'
                                  : 'neutral'
                              : source.status === 'HEALTHY'
                                ? 'teal'
                                : source.status === 'FAILED'
                                  ? 'red'
                                  : source.status === 'DEGRADED'
                                    ? 'orange'
                                    : 'neutral'
                          }
                        >
                          {source.id.toLowerCase() === 'naver'
                            ? naverStatusLabel(naver.data, naver.isError)
                            : statusLabels[source.status]}
                        </Badge>
                      </div>
                      <dl>
                        <div>
                          <dt>마지막 성공</dt>
                          <dd>
                            {source.lastSuccessAt ? formatKst(source.lastSuccessAt) : '기록 없음'}
                          </dd>
                        </div>
                        <div>
                          <dt>성공 후 경과</dt>
                          <dd>{source.lagSeconds === null ? '—' : formatLag(source.lagSeconds)}</dd>
                        </div>
                      </dl>
                      {source.id.toLowerCase() === 'naver' ? (
                        <div className="connector-source__message">
                          <p>
                            {naver.data?.reason ??
                              (naver.data && naverBudgetAvailable(naver.data)
                                ? '기업 뉴스 영역에서 관련 기사를 자동으로 불러옵니다.'
                                : naver.isError
                                  ? '검색 연결 상태를 확인하지 못했습니다.'
                                  : naver.data
                                    ? '무료 검색 이용 조건을 확인해야 합니다.'
                                    : '검색 연결 상태를 확인 중입니다.')}
                          </p>
                          <Link className="text-link" to="/news">
                            시장 뉴스 <ArrowUpRight size={13} />
                          </Link>
                        </div>
                      ) : null}
                      {['sec', 'gdelt'].includes(source.id.toLowerCase()) &&
                      source.requestAttempted !== undefined &&
                      source.message ? (
                        <p className="connector-source__message">{source.message}</p>
                      ) : null}
                      {['sec', 'gdelt'].includes(source.id.toLowerCase()) && source.nextRetryAt ? (
                        <p className="connector-source__message">
                          다음 요청 가능 {formatKst(source.nextRetryAt)}
                        </p>
                      ) : null}
                      <RightsBadge status={source.rightsMode} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
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
