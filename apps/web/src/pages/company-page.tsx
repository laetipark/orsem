import { CompanyKeyStats, CompanyDailyPrices } from '../components/company-price-details';
import { companyPath } from '../lib/company-path';
import { CompanyInformation } from '../components/company-information';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Link,
  useLocation,
  useParams,
  useNavigate,
  useSearchParams,
  useOutletContext,
} from 'react-router-dom';
import { api } from '../lib/api';
import { hasChartCandles } from '../lib/chart-prices';
import { domesticFallbackClose, effectiveLiveStatus } from '../lib/live-price';
import { formatDate, formatKst, formatMoney, formatPercent } from '../lib/format';
import { disclosureLabels, displayDomainText } from '../lib/domain-labels';
import { CompanyNewsPanel } from '../components/company-news-panel';
import { CompanyGroupPicker } from '../components/company-group-picker';
import { CompanyNotificationToggle } from '../components/company-notification-toggle';
import { CompanyShareButton } from '../components/company-share-button';
import { MarketSelectionMembership } from '../components/market-selection';
import { recordRecentCompany } from '../lib/recent-companies';
import { watchActorKey } from '../components/watchlist-group-editors';
import type { Session } from '../types';
import { CompanyChart } from '../components/company-chart';
import { CompanyAvatar } from '../components/company-avatar';
import { RightsBadge } from '../components/domain-badges';
import { HelpPopover } from '../components/help-popover';
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
  cn,
} from '../components/ui';
import './company-page.css';

const rangeOptions = ['1M', '3M', '1Y'] as const;
const rangeLabels = { '1M': '1개월', '3M': '3개월', '1Y': '1년' } as const;
const markerLabels = { TRADE: '거래·변동', FILING: '공시일', NEWS: '뉴스·IR' } as const;
const eventReturnLabels = {
  TRADE: '최근 거래·변동 이후',
  FILING: '최근 공시 이후',
  NEWS: '최근 뉴스·IR 이후',
} as const;
const marketRefreshInterval = 2_000;

export function CompanyPage() {
  const location = useLocation();
  const session = useOutletContext<Session | undefined>();
  const actor = watchActorKey(session?.user);
  const [pageElement, setPageElement] = useState<HTMLDivElement | null>(null);
  const [desktop, setDesktop] = useState(false);
  const recordedVisit = useRef('');
  useEffect(() => {
    if (!pageElement) return;
    const measure = () => setDesktop(pageElement.getBoundingClientRect().width >= 1144);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(pageElement);
    if (!observer) window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [pageElement]);
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem('orsem-company-sidebar-v1') !== 'closed';
    } catch {
      return true;
    }
  });
  const sideVisible = !desktop || sideOpen;
  const [chartElement, setChartElement] = useState<HTMLDivElement | null>(null);
  const [chartHeight, setChartHeight] = useState(600);
  const [chartExpanded, setChartExpanded] = useState(false);
  useEffect(() => {
    if (!chartExpanded) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChartExpanded(false);
    };
    const fullscreen = () => {
      if (!document.fullscreenElement) setChartExpanded(false);
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('fullscreenchange', fullscreen);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', escape);
      document.removeEventListener('fullscreenchange', fullscreen);
    };
  }, [chartExpanded]);
  const toggleChartExpanded = () => {
    if (chartExpanded) {
      setChartExpanded(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    } else {
      setChartExpanded(true);
      void chartElement?.requestFullscreen?.().catch(() => undefined);
    }
  };

  useEffect(() => {
    if (!chartElement || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setChartHeight(Math.max(280, Math.ceil(entry.contentRect.height)));
    });
    observer.observe(chartElement);
    return () => observer.disconnect();
  }, [chartElement]);
  const toggleSidebar = () =>
    setSideOpen((value) => {
      try {
        localStorage.setItem('orsem-company-sidebar-v1', value ? 'closed' : 'open');
      } catch {
        /* private browsing */
      }
      return !value;
    });
  const returnPath = (location.state as { watchlistReturn?: string } | null)?.watchlistReturn;
  const safeReturn = returnPath && /^\/(?:watchlist|)(?:\?|$)/.test(returnPath) ? returnPath : null;
  const { id: address = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab') ?? 'chart';
  const activeTab = ['chart', 'prices', 'information', 'events', 'news'].includes(requestedTab)
    ? requestedTab
    : 'chart';
  const [range, setRange] = useState<(typeof rangeOptions)[number]>('3M');
  const [interval, setInterval] = useState<'1d' | '1m'>('1d');
  const [clockNow, setClockNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), marketRefreshInterval);
    return () => window.clearInterval(timer);
  }, []);
  const queryClient = useQueryClient();
  const company = useQuery({
    queryKey: ['company', address],
    queryFn: ({ signal }) => api.company(address, signal),
    enabled: Boolean(address),
  });
  const id = company.data?.id ?? '';
  useEffect(() => {
    // Query refreshes and canonical URL replacements are the same visit.
    if (!actor || !company.data || !company.isSuccess) return;
    const visit = `${actor}:${company.data.id}`;
    if (recordedVisit.current === visit) return;
    recordedVisit.current = visit;
    recordRecentCompany(actor, company.data);
  }, [actor, company.data, company.isSuccess]);
  useEffect(() => {
    if (!company.data) return;
    const canonical = companyPath(company.data);
    if (location.pathname !== canonical)
      void navigate(`${canonical}${location.search}${location.hash}`, {
        replace: true,
        state: location.state,
      });
  }, [company.data, location.pathname, location.search, location.hash, location.state, navigate]);
  const timeline = useQuery({
    queryKey: ['company-timeline', id, range, interval],
    queryFn: ({ signal }) => api.companyTimeline(id, range, interval, signal),
    enabled: Boolean(id),
    refetchInterval: marketRefreshInterval,
    refetchIntervalInBackground: false,
  });
  const dailyTimeline = useQuery({
    queryKey: ['company-timeline', id, range, '1d'],
    queryFn: ({ signal }) => api.companyTimeline(id, range, '1d', signal),
    enabled: Boolean(id) && (interval === '1m' || activeTab === 'prices'),
    refetchInterval: interval === '1m' ? marketRefreshInterval : false,
    refetchIntervalInBackground: false,
  });
  const latestDailyPriceAt = (interval === '1m' ? dailyTimeline.data : timeline.data)?.prices.at(
    -1,
  )?.time;
  useEffect(() => {
    if (id && latestDailyPriceAt)
      void queryClient.invalidateQueries({ queryKey: ['company-information', id] });
  }, [id, latestDailyPriceAt, queryClient]);
  const livePrice = useQuery({
    queryKey: ['company-live-price', id],
    queryFn: ({ signal }) => api.companyLivePrice(id, signal),
    enabled: Boolean(id),
    refetchInterval: marketRefreshInterval,
    refetchIntervalInBackground: false,
    retry: false,
  });

  if (company.isPending)
    return (
      <>
        <h1 className="sr-only">종목 정보</h1>
        <CompanyPageSkeleton />
      </>
    );
  if (company.isError)
    return (
      <>
        <h1>종목 정보</h1>
        <ErrorState message={company.error.message} onRetry={() => void company.refetch()} />
      </>
    );
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
    NOT_CONFIGURED: '시세 연결 필요',
    WAITING: '시세 수신 대기',
    LIVE: '실시간',
    STALE: '최근 체결 · 수신 대기',
    UNAVAILABLE: '시세 연결 확인 필요',
  };
  const quote = livePrice.data?.quote;
  const fallbackClose = domesticFallbackClose(livePrice.data, data.market, clockNow);
  const displayPrice = fallbackClose ?? quote;
  const observedPrice = livePrice.data?.displayPrice;
  const eventTimeline = interval === '1m' ? dailyTimeline.data : timeline.data;
  const latestMarker = eventTimeline?.markers.at(-1);
  const firstDailyPriceAt = eventTimeline?.prices[0]?.time;
  const monthPeriodInsufficient = Boolean(eventTimeline && eventTimeline.prices.length < 22);
  const isEventPeriodInsufficient = (eventAt: string) =>
    !firstDailyPriceAt || eventAt < firstDailyPriceAt;
  const latestEventPeriodInsufficient = Boolean(
    latestMarker && isEventPeriodInsufficient(latestMarker.time),
  );

  const tvSymbol =
    data.isListed &&
    /^(?:KOSPI|KOSDAQ|KRX)$/u.test(data.market) &&
    /^[A-Z0-9]{6}$/u.test(data.stockCode ?? '')
      ? `KRX:${data.stockCode}`
      : data.isListed &&
          ['NASDAQ', 'NYSE', 'AMEX'].includes(data.market) &&
          /^[A-Z][A-Z0-9.-]{0,19}$/u.test(data.ticker ?? '')
        ? `${data.market}:${data.ticker}`
        : null;
  const chartTools = (
    <div className="chart-controls">
      <div className="range-control" role="group" aria-label="차트 주기">
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
        <div className="range-control" role="group" aria-label="차트 기간">
          {rangeOptions.map((option) => (
            <button
              key={option}
              aria-pressed={range === option}
              className={range === option ? 'active' : ''}
              onClick={() => setRange(option)}
            >
              {rangeLabels[option]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
  return (
    <div
      ref={setPageElement}
      className={`page-stack company-page${desktop ? '' : ' company-page--compact'}`}
    >
      <div className="company-top">
        <section className="company-heading">
          <Link
            className="company-back"
            to={safeReturn ?? '/companies'}
            aria-label={safeReturn ? '관심 종목으로 돌아가기' : '종목 목록으로 돌아가기'}
            title={safeReturn ? '관심 종목으로 돌아가기' : '종목 목록으로 돌아가기'}
          >
            <ArrowLeft size={18} />
          </Link>
          <CompanyAvatar company={data} className="company-heading__icon" />
          <div className="company-heading__main">
            <h1 title={data.nameKo}>{data.nameKo}</h1>
            <p className="company-heading__metadata">
              <span>{data.market}</span>
              {(data.stockCode ?? data.ticker) ? (
                <span className="mono">{data.stockCode ?? data.ticker}</span>
              ) : null}
            </p>
          </div>
          <div className="company-heading__actions" role="group" aria-label="종목 설정 및 공유">
            <button
              type="button"
              className="company-sidebar-toggle"
              aria-expanded={sideOpen}
              onClick={toggleSidebar}
            >
              {sideOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}공시·뉴스{' '}
              {sideOpen ? '접기' : '펼치기'}
            </button>
            <CompanyNotificationToggle companyId={data.id} />
            <CompanyGroupPicker key={data.id} companyId={data.id} />
            <CompanyShareButton key={`share-${data.id}`} company={data} />
          </div>
        </section>
        <MarketSelectionMembership companyId={data.id} />
        <section className="company-overview" aria-label="주가 요약">
          <div className="live-price-strip" aria-label="현재가">
            <div className="company-quote-main">
              <strong className="company-quote-price">
                {observedPrice
                  ? observedPrice.price === null
                    ? '—'
                    : formatMoney(observedPrice.price, observedPrice.currency)
                  : displayPrice
                    ? formatMoney(displayPrice.price, displayPrice.currency)
                    : '—'}
              </strong>
              {observedPrice ? (
                <div
                  className={cn(
                    'company-quote__change',
                    observedPrice.changePercent == null || observedPrice.changePercent === 0
                      ? ''
                      : observedPrice.changePercent < 0
                        ? 'negative'
                        : 'positive',
                  )}
                >
                  <strong>
                    {observedPrice.change == null
                      ? '—'
                      : `${observedPrice.change > 0 ? '+' : ''}${formatMoney(observedPrice.change, observedPrice.currency)}`}
                  </strong>
                  <strong>{formatPercent(observedPrice.changePercent)}</strong>
                </div>
              ) : null}
            </div>
            <div className="company-quote-meta">
              <span
                className={cn(
                  'live-price-status',
                  !fallbackClose && liveStatus === 'LIVE' && 'is-live',
                )}
              >
                <i />
                {fallbackClose ? '최근 거래일 종가' : liveLabels[liveStatus]}
              </span>
              {fallbackClose || quote ? (
                <small className="company-quote__time">
                  {fallbackClose
                    ? formatDate(fallbackClose.sessionDate)
                    : formatKst(quote!.providerAt)}
                </small>
              ) : null}
              <HelpPopover label="가격과 등락률 안내">
                <p>
                  {fallbackClose
                    ? `${formatDate(fallbackClose.sessionDate)} 종가 · 토스증권 국내 일봉`
                    : quote
                      ? `${formatKst(quote.providerAt)} · ${quote.source === 'TOSS_KR_INTEGRATED' ? 'KRX·NXT 통합 체결' : quote.currency === 'KRW' ? '토스증권 국내 현재가' : '토스증권 미국 현재가'}`
                      : '현재가를 받지 못했습니다. 시세가 연결되면 자동으로 갱신합니다.'}
                </p>
                {observedPrice ? (
                  <p>
                    {observedPrice.referenceDate
                      ? `${formatDate(observedPrice.referenceDate)} 종가 대비`
                      : '비교 종가가 없어 전일 대비를 표시하지 않습니다.'}
                  </p>
                ) : null}
                <p>
                  기간별 등락률은 일봉 종가 기준입니다. 1개월은 21거래일로 계산하며, 조회 기간이
                  부족하면 —로 표시합니다.
                </p>
              </HelpPopover>
            </div>
          </div>
          <section className="returns-strip" aria-label="기간별 등락률, 일봉 종가 기준">
            <div>
              <span>1일</span>
              <strong
                className={cn((eventTimeline?.returns.oneDay ?? 0) < 0 ? 'negative' : 'positive')}
              >
                {formatPercent(eventTimeline?.returns.oneDay)}
              </strong>
            </div>
            <div>
              <span>1개월</span>
              {monthPeriodInsufficient ? (
                <strong className="return-unavailable" aria-label="조회 기간 부족">
                  —
                </strong>
              ) : (
                <strong
                  className={cn(
                    (eventTimeline?.returns.oneMonth ?? 0) < 0 ? 'negative' : 'positive',
                  )}
                >
                  {formatPercent(eventTimeline?.returns.oneMonth)}
                </strong>
              )}
            </div>
            <div>
              <span>
                {latestMarker ? eventReturnLabels[latestMarker.kind] : '최근 이벤트 이후'}
              </span>
              {latestEventPeriodInsufficient ? (
                <strong className="return-unavailable" aria-label="조회 기간 부족">
                  —
                </strong>
              ) : (
                <strong
                  className={cn(
                    (eventTimeline?.returns.sinceLatestEvent ?? 0) < 0 ? 'negative' : 'positive',
                  )}
                >
                  {formatPercent(eventTimeline?.returns.sinceLatestEvent)}
                </strong>
              )}
            </div>
          </section>
          <CompanyKeyStats companyId={data.id} />
        </section>
      </div>
      <nav className="company-section-nav" aria-label="종목 메뉴">
        {(
          [
            ['chart', '차트'],
            ['prices', '일별 시세'],
            ['information', '기업정보·재무'],
            ['events', '이벤트'],
            ['news', '뉴스·공시'],
          ] as const
        ).map(([tab, label]) => (
          <button
            type="button"
            key={tab}
            aria-pressed={activeTab === tab}
            onClick={() =>
              setSearchParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  if (tab === 'chart') next.delete('tab');
                  else next.set('tab', tab);
                  return next;
                },
                { replace: true },
              )
            }
          >
            {label}
          </button>
        ))}
      </nav>
      <section
        className={`company-workspace company-workspace--${activeTab} ${sideVisible ? 'has-sidebar' : ''}`}
        aria-label="차트와 종목 소식"
        style={{ '--company-chart-height': `${chartHeight}px` } as CSSProperties}
      >
        <div
          className={`company-chart-section ${chartExpanded ? 'is-expanded' : ''}`}
          hidden={activeTab !== 'chart'}
          ref={setChartElement}
        >
          <Card className="chart-card">
            {!hasCandles ? (
              <CardHeader>
                <div>
                  <span className="section-kicker">PRICE CHART</span>
                  <h2>주가 차트</h2>
                </div>
                {chartTools}
              </CardHeader>
            ) : null}
            <CardContent>
              {timeline.isPending ? <ChartLoadingSkeleton /> : null}
              {timeline.isError ? (
                <ErrorState
                  message={timeline.error.message}
                  onRetry={() => void timeline.refetch()}
                />
              ) : null}
              {timeline.data && hasCandles ? (
                <CompanyChart
                  key={`${id}-${interval}-${range}`}
                  timeline={timeline.data}
                  expanded={chartExpanded}
                  onExpand={toggleChartExpanded}
                  toolbar={chartTools}
                  livePrice={
                    livePrice.data && !fallbackClose
                      ? { ...livePrice.data, status: liveStatus }
                      : null
                  }
                />
              ) : null}
              {timeline.isSuccess && !hasCandles ? (
                <EmptyState
                  title={
                    notConfigured
                      ? '시세 연결이 필요합니다'
                      : hasNoTradePrices
                        ? '표시할 거래 봉이 없습니다'
                        : timeline.data?.status === 'PENDING'
                          ? '토스 가격을 수집하고 있습니다'
                          : '표시할 가격 데이터가 없습니다'
                  }
                  description={hasNoTradePrices ? '거래가 있는 기간을 선택해 주세요.' : undefined}
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void timeline.refetch()}
                      disabled={timeline.isFetching}
                    >
                      {timeline.isFetching ? '가격을 불러오는 중…' : '다시 불러오기'}
                    </Button>
                  }
                />
              ) : null}
              {tvSymbol ? (
                <a
                  className="company-tradingview-link"
                  href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  TradingView에서 보기 <ArrowUpRight size={13} />
                </a>
              ) : null}
              {timeline.data?.latestCloseAt ? (
                <p className="chart-caption">
                  {interval === '1m'
                    ? `마지막 봉 ${formatKst(timeline.data.latestCloseAt)}`
                    : `마지막 일봉 ${formatDate(timeline.data.latestCloseAt)}`}
                </p>
              ) : null}
              {timeline.data?.priceSources.length ? (
                <div className="price-source-list" aria-label="가격 데이터 출처와 이용 범위">
                  {timeline.data.priceSources.map((source) => (
                    <div className="price-source-notice" key={source.source}>
                      <div>
                        <strong>{source.attribution}</strong>
                        <HelpPopover label={`${source.attribution} 데이터 안내`}>
                          <p>{source.limitation}</p>
                          <div className="company-source-details">
                            <RightsBadge status={source.rightsMode} />
                            {source.feed ? <Badge>{source.feed}</Badge> : null}
                            {source.adjustment ? <Badge>{source.adjustment}</Badge> : null}
                          </div>
                        </HelpPopover>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {activeTab === 'prices' ? (
          <CompanyDailyPrices
            timeline={eventTimeline}
            loading={timeline.isPending || dailyTimeline.isFetching}
          />
        ) : null}
        {sideVisible || activeTab === 'news' ? (
          <CompanyNewsPanel
            key={data.id}
            companyId={data.id}
            companyName={data.nameKo || data.nameEn || data.ticker || data.stockCode || ''}
          />
        ) : null}

        {activeTab === 'events' && !eventTimeline?.markers.length ? (
          <EmptyState
            title="표시할 이벤트가 없습니다"
            description="확인된 공시와 뉴스가 연결되면 가격 흐름과 함께 표시합니다."
          />
        ) : null}
        {eventTimeline?.markers.length ? (
          <Card className="company-event-returns" hidden={activeTab !== 'events'}>
            <CardHeader>
              <div>
                <span className="section-kicker">EVENT RETURNS</span>
                <h2>주요 이벤트 전후 등락률</h2>
              </div>
              <HelpPopover label="이벤트 등락률 계산 안내">
                <p>
                  이벤트 당일 또는 이후 첫 일봉의 종가를 기준으로 합니다. 전일 대비는 직전 거래일과
                  비교하고, 이후 등락률은 거래일 단위로 계산합니다.
                </p>
              </HelpPopover>
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
                      {markerLabels[marker.kind]}
                    </span>
                    <div>
                      <strong>{displayDomainText(marker.label)}</strong>
                      <small>
                        {formatDate(marker.time)} · {disclosureLabels[marker.detailType]}
                      </small>
                    </div>
                    {isEventPeriodInsufficient(marker.time) ? (
                      <p className="marker-return-unavailable">조회 기간 부족</p>
                    ) : (
                      <dl>
                        <div>
                          <dt>전일 대비</dt>
                          <dd>{formatPercent(marker.returnWindows.pre1d)}</dd>
                        </div>
                        <div>
                          <dt>1거래일 후</dt>
                          <dd>{formatPercent(marker.returnWindows.post1d)}</dd>
                        </div>
                        <div>
                          <dt>5거래일 후</dt>
                          <dd>{formatPercent(marker.returnWindows.post5d)}</dd>
                        </div>
                        <div>
                          <dt>20거래일 후</dt>
                          <dd>{formatPercent(marker.returnWindows.post20d)}</dd>
                        </div>
                      </dl>
                    )}
                    <ArrowUpRight size={16} />
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}

        <section className="company-information" hidden={activeTab !== 'information'}>
          <Card>
            <CardHeader>
              <div>
                <span className="section-kicker">IDENTITY</span>
                <h2>기업 정보</h2>
              </div>
            </CardHeader>
            <CardContent>
              <div className="company-identity-name">
                <strong>{data.nameKo}</strong>
                {data.nameEn ? <span>{data.nameEn}</span> : null}
                {data.sector && data.sector !== '미분류' ? <span>{data.sector}</span> : null}
              </div>
              <CompanyInformation companyId={data.id} />
              <dl className="identity-list">
                <div>
                  <dt>DART 기업 고유번호</dt>
                  <dd className="mono">{data.corpCode ?? '—'}</dd>
                </div>
                <div>
                  <dt>국내 종목코드</dt>
                  <dd className="mono">{data.stockCode ?? '—'}</dd>
                </div>
                <div>
                  <dt>미국 SEC 등록번호 (CIK)</dt>
                  <dd className="mono">{data.cik ?? '—'}</dd>
                </div>
                <div>
                  <dt>최근 공시·뉴스</dt>
                  <dd>{formatKst(data.lastEventAt)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </section>
      </section>
    </div>
  );
}
