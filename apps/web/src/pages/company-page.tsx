import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, CalendarDays, Star, StarOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import type { Session } from '../types';
import { api } from '../lib/api';
import { hasChartCandles } from '../lib/chart-prices';
import { effectiveLiveStatus } from '../lib/live-price';
import { formatDate, formatKst, formatMoney, formatPercent } from '../lib/format';
import { disclosureLabels, displayDomainText } from '../lib/domain-labels';
import { CompanyChart } from '../components/company-chart';
import { CompanyAvatar } from '../components/company-avatar';
import { EventCompactRow } from '../components/event-row';
import { EvidenceBadge, PriorityBadge, RightsBadge } from '../components/domain-badges';
import { ObservationDisclaimer } from '../components/disclaimer';
import { MarketNewsEmpty, MarketNewsList } from '../components/market-news';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ChartLoadingSkeleton,
  CompanyPageSkeleton,
  EmptyState,
  ErrorState,
  LoadingState,
  cn,
} from '../components/ui';

const rangeOptions = ['1M', '3M', '1Y'] as const;
const marketRefreshInterval = 2_000;

function RelatedCompanyNews({ companyId }: { companyId: string }) {
  const news = useQuery({
    queryKey: ['news', 'company', companyId],
    queryFn: () => api.news({ companyId, limit: 6 }),
    enabled: Boolean(companyId),
    staleTime: 30_000,
  });
  return (
    <Card className="market-news">
      <CardHeader>
        <div>
          <span className="section-kicker">RELATED NEWS</span>
          <h2>관련 뉴스</h2>
        </div>
        <Link className="text-link" to={`/news?companyId=${encodeURIComponent(companyId)}`}>
          전체 보기
        </Link>
      </CardHeader>
      {news.isPending ? <LoadingState label="관련 뉴스를 불러오는 중입니다." /> : null}
      {news.isError ? (
        <ErrorState
          message="관련 뉴스를 불러오지 못했습니다."
          onRetry={() => void news.refetch()}
        />
      ) : null}
      {news.data?.items.length ? <MarketNewsList items={news.data.items} /> : null}
      {news.data && !news.data.items.length && !news.isError ? <MarketNewsEmpty /> : null}
    </Card>
  );
}

export function CompanyPage() {
  const session = useOutletContext<Session | undefined>();
  const canEdit = session?.user?.role === 'ADMIN';
  const { id = '' } = useParams();
  const [range, setRange] = useState<(typeof rangeOptions)[number]>('3M');
  const [interval, setInterval] = useState<'1d' | '1m'>('1d');
  const [clockNow, setClockNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), marketRefreshInterval);
    return () => window.clearInterval(timer);
  }, []);
  const queryClient = useQueryClient();
  const company = useQuery({
    queryKey: ['company', id],
    queryFn: () => api.company(id),
    enabled: Boolean(id),
  });
  const timeline = useQuery({
    queryKey: ['company-timeline', id, range, interval],
    queryFn: () => api.companyTimeline(id, range, interval),
    enabled: Boolean(id),
    refetchInterval: marketRefreshInterval,
    refetchIntervalInBackground: false,
  });
  const dailyTimeline = useQuery({
    queryKey: ['company-timeline', id, range, '1d'],
    queryFn: () => api.companyTimeline(id, range, '1d'),
    enabled: Boolean(id) && interval === '1m',
    refetchInterval: interval === '1m' ? marketRefreshInterval : false,
    refetchIntervalInBackground: false,
  });
  const livePrice = useQuery({
    queryKey: ['company-live-price', id],
    queryFn: () => api.companyLivePrice(id),
    enabled: Boolean(id),
    refetchInterval: marketRefreshInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const watchlist = useMutation({
    mutationFn: async () => {
      if (!company.data) throw new Error('기업 정보가 없습니다.');
      return company.data.isWatchlisted
        ? api.removeWatchlist(company.data.id)
        : api.addWatchlist({
            companyId: company.data.id,
            priority: 'P2',
            realtimeAlerts: true,
            digestAlerts: false,
          });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['company', id] }),
        queryClient.invalidateQueries({ queryKey: ['watchlist'] }),
      ]);
    },
  });

  if (company.isPending) return <CompanyPageSkeleton />;
  if (company.isError)
    return <ErrorState message={company.error.message} onRetry={() => void company.refetch()} />;
  const data = company.data;
  const hasCandles = timeline.data ? hasChartCandles(timeline.data.prices) : false;
  const hasNoTradePrices = Boolean(timeline.data?.prices.length) && !hasCandles;
  const notConfigured = timeline.data?.status === 'NOT_CONFIGURED';
  const liveStatus = effectiveLiveStatus(
    livePrice.data,
    livePrice.isError || livePrice.isPaused,
    clockNow - livePrice.dataUpdatedAt,
  );
  const liveLabels = {
    NOT_CONFIGURED: '토스 연결 필요',
    WAITING: '체결 수신 대기',
    LIVE: '실시간 수신',
    STALE: '최근 체결 · 수신 대기',
    UNAVAILABLE: '시세 연결 확인 필요',
  };
  const quote = livePrice.data?.quote;
  const eventTimeline = interval === '1m' ? dailyTimeline.data : timeline.data;

  return (
    <div className="page-stack company-page">
      <Link className="back-link" to="/events">
        <ArrowLeft size={15} /> 이벤트로 돌아가기
      </Link>
      <section className="company-heading">
        <CompanyAvatar company={data} className="company-heading__icon" />
        <div className="company-heading__main">
          <div>
            <h2>{data.nameKo}</h2>
            {data.nameEn ? <span>{data.nameEn}</span> : null}
          </div>
          <p>
            {data.market} · <span className="mono">{data.stockCode ?? data.ticker}</span> ·{' '}
            {data.sector}
          </p>
          <div className="company-heading__badges">
            {data.priority ? <PriorityBadge priority={data.priority} /> : null}
            {data.tags
              .filter((tag) => tag !== data.priority)
              .map((tag) => (
                <Badge key={tag}>{displayDomainText(tag)}</Badge>
              ))}
          </div>
        </div>
        {canEdit ? (
          <Button
            variant={data.isWatchlisted ? 'secondary' : 'primary'}
            onClick={() => watchlist.mutate()}
            disabled={watchlist.isPending}
          >
            {data.isWatchlisted ? (
              <>
                <StarOff size={16} /> 관심 해제
              </>
            ) : (
              <>
                <Star size={16} /> 관심 추가
              </>
            )}
          </Button>
        ) : null}
      </section>

      <Card className="chart-card">
        <CardHeader>
          <div>
            <span className="section-kicker">TOSS SECURITIES · MARKET DATA</span>
            <h2>{interval === '1m' ? '1분봉과 현재가' : '주가와 사건 시점'}</h2>
          </div>
          <div className="chart-controls">
            <div className="range-control" aria-label="봉 간격">
              {(['1d', '1m'] as const).map((option) => (
                <button
                  key={option}
                  aria-pressed={interval === option}
                  className={interval === option ? 'active' : ''}
                  onClick={() => setInterval(option)}
                >
                  {option === '1d' ? '일봉' : '1분봉'}
                </button>
              ))}
            </div>
            {interval === '1d' ? (
              <div className="range-control" aria-label="차트 기간">
                {rangeOptions.map((option) => (
                  <button
                    key={option}
                    aria-pressed={range === option}
                    className={range === option ? 'active' : ''}
                    onClick={() => setRange(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <div className="live-price-strip" aria-label="토스 실시간 현재가">
            <div>
              <span className={cn('live-price-status', liveStatus === 'LIVE' && 'is-live')}>
                <i />
                {liveLabels[liveStatus]}
              </span>
              <strong>{quote ? formatMoney(quote.price, quote.currency) : '—'}</strong>
            </div>
            <small>
              {quote
                ? `${formatKst(quote.providerAt)} · ${quote.source === 'TOSS_KR_INTEGRATED' ? 'KRX·NXT 통합 체결' : quote.currency === 'KRW' ? '토스증권 국내 현재가' : '토스증권 미국 현재가'}`
                : '토스증권 연결 후 체결가가 자동으로 표시됩니다.'}
            </small>
          </div>
          <div className="chart-legend">
            {interval === '1d' ? (
              <>
                <span className="legend-trade">
                  <i />T 거래일
                </span>
                <span className="legend-filing">
                  <i />F 공시일
                </span>
                <span className="legend-news">
                  <i />N 뉴스·IR
                </span>
              </>
            ) : (
              <span>최근 1분봉 · 한국 시간(KST)</span>
            )}
            <small>드래그 이동 · 핀치/휠 확대</small>
          </div>
          {timeline.isPending ? <ChartLoadingSkeleton /> : null}
          {timeline.isError ? (
            <ErrorState message={timeline.error.message} onRetry={() => void timeline.refetch()} />
          ) : null}
          {timeline.data && hasCandles ? (
            <CompanyChart
              key={`${id}-${interval}-${range}`}
              timeline={timeline.data}
              livePrice={livePrice.data ? { ...livePrice.data, status: liveStatus } : null}
            />
          ) : null}
          {timeline.isSuccess && !hasCandles ? (
            <EmptyState
              title={
                notConfigured
                  ? '토스증권 연결을 준비해 주세요'
                  : hasNoTradePrices
                    ? '표시할 거래 봉이 없습니다'
                    : timeline.data?.status === 'PENDING'
                      ? '토스 가격을 수집하고 있습니다'
                      : '표시할 가격 데이터가 없습니다'
              }
              description={
                notConfigured
                  ? '토스증권에서 API 키를 발급하고 서버 IP를 등록한 뒤 서버에 연결 정보를 설정해 주세요. 연결되면 일봉·1분봉과 현재가를 자동으로 불러옵니다.'
                  : hasNoTradePrices
                    ? '선택한 기간에는 거래 없이 공식 종가만 제공된 날짜가 있습니다. 거래 봉은 표시하지 않으며, 공식 종가는 수익률에 반영합니다. 다른 기간을 선택해 보세요.'
                    : timeline.data?.status === 'PENDING'
                      ? '수집된 가격은 자동으로 표시됩니다. 대기가 계속되면 운영 상태에서 토스 연결을 확인해 주세요.'
                      : '선택한 기간의 가격 데이터가 없습니다. 다른 기간을 선택하거나 가격을 다시 불러와 주세요.'
              }
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void timeline.refetch()}
                  disabled={timeline.isFetching}
                >
                  {timeline.isFetching ? '가격을 불러오는 중…' : '가격 다시 불러오기'}
                </Button>
              }
            />
          ) : null}
          {timeline.data?.latestCloseAt ? (
            <p className="chart-caption">
              {interval === '1m'
                ? `마지막 봉 ${formatKst(timeline.data.latestCloseAt)} · 분봉은 공식 캔들 조회로 갱신합니다.`
                : `마지막 일봉 ${formatDate(timeline.data.latestCloseAt)} · 거래일과 공시일을 별도 마커로 표시합니다.`}
            </p>
          ) : null}
          {hasCandles ? (
            <p className="chart-caption">
              현재가와 차트를 2초마다 갱신합니다. 장중 봉은 아직 확정되지 않은 값입니다.
            </p>
          ) : null}
          {timeline.data?.priceSources.length ? (
            <div className="price-source-list" aria-label="가격 데이터 출처와 이용 범위">
              {timeline.data.priceSources.map((source) => (
                <div className="price-source-notice" key={source.source}>
                  <div>
                    <strong>{source.attribution}</strong>
                    <RightsBadge status={source.rightsMode} />
                    {source.feed ? <Badge>{source.feed}</Badge> : null}
                    {source.adjustment ? <Badge>{source.adjustment}</Badge> : null}
                  </div>
                  <p>{source.limitation}</p>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <section className="returns-strip" aria-label="가격 수익률">
        <div>
          <span>최근 1일</span>
          <strong
            className={cn((eventTimeline?.returns.oneDay ?? 0) < 0 ? 'negative' : 'positive')}
          >
            {formatPercent(eventTimeline?.returns.oneDay)}
          </strong>
        </div>
        <div>
          <span>최근 1개월</span>
          <strong
            className={cn((eventTimeline?.returns.oneMonth ?? 0) < 0 ? 'negative' : 'positive')}
          >
            {formatPercent(eventTimeline?.returns.oneMonth)}
          </strong>
        </div>
        <div>
          <span>최근 이벤트 이후</span>
          <strong
            className={cn(
              (eventTimeline?.returns.sinceLatestEvent ?? 0) < 0 ? 'negative' : 'positive',
            )}
          >
            {formatPercent(eventTimeline?.returns.sinceLatestEvent)}
          </strong>
        </div>
        <div>
          <span>시장 1개월</span>
          <strong>{formatPercent(eventTimeline?.returns.benchmarkOneMonth)}</strong>
        </div>
      </section>

      {eventTimeline?.markers.length ? (
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">EVENT RETURNS</span>
              <h2>마커 기준 전·후 수익률</h2>
            </div>
          </CardHeader>
          <CardContent>
            <div className="marker-return-list">
              {eventTimeline.markers.map((marker) => (
                <Link
                  to={`/events/${marker.eventId}`}
                  className="marker-return-row"
                  key={`${marker.kind}-${marker.time}-${marker.eventId}`}
                >
                  <span className={`marker-kind marker-kind--${marker.kind.toLowerCase()}`}>
                    {marker.kind[0]}
                  </span>
                  <div>
                    <strong>{displayDomainText(marker.label)}</strong>
                    <small>
                      {formatDate(marker.time)} · {disclosureLabels[marker.detailType]}
                    </small>
                  </div>
                  <dl>
                    <div>
                      <dt>전일</dt>
                      <dd>{formatPercent(marker.returnWindows.pre1d)}</dd>
                    </div>
                    <div>
                      <dt>+1일</dt>
                      <dd>{formatPercent(marker.returnWindows.post1d)}</dd>
                    </div>
                    <div>
                      <dt>+5일</dt>
                      <dd>{formatPercent(marker.returnWindows.post5d)}</dd>
                    </div>
                    <div>
                      <dt>+20일</dt>
                      <dd>{formatPercent(marker.returnWindows.post20d)}</dd>
                    </div>
                  </dl>
                  <ArrowUpRight size={16} />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <RelatedCompanyNews companyId={data.id} />
      <section className="detail-grid">
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">RECENT</span>
              <h2>최근 확인 이벤트</h2>
            </div>
          </CardHeader>
          <CardContent className="event-list">
            {data.recentEvents.length ? (
              data.recentEvents.map((event) => <EventCompactRow key={event.id} event={event} />)
            ) : (
              <p className="muted-block">연결된 이벤트가 없습니다.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">IDENTITY</span>
              <h2>식별자와 출처</h2>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="identity-list">
              <div>
                <dt>OpenDART corp_code</dt>
                <dd className="mono">{data.corpCode ?? '—'}</dd>
              </div>
              <div>
                <dt>국내 종목코드</dt>
                <dd className="mono">{data.stockCode ?? '—'}</dd>
              </div>
              <div>
                <dt>SEC CIK</dt>
                <dd className="mono">{data.cik ?? '—'}</dd>
              </div>
              <div>
                <dt>마지막 이벤트</dt>
                <dd>{formatKst(data.lastEventAt)}</dd>
              </div>
            </dl>
            {data.thesis ? (
              <div className="company-note">
                <CalendarDays size={16} />
                <p>{data.thesis}</p>
              </div>
            ) : null}
            <div className="company-provenance">
              {data.provenance.map((source) => (
                <div key={source.id}>
                  <EvidenceBadge grade={source.grade} />
                  <RightsBadge status={source.rightsMode} />
                  <span>{source.sourceName}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>
      <ObservationDisclaimer compact />
    </div>
  );
}
