import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ArrowUpRight, LockKeyhole, Search } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { PublicCompany, PublicNewsItem } from '@orsem/contracts';
import { MarketCard } from '../components/market-card';
import { MarketChart } from '../components/market-chart';
import { MarketValue } from '../components/market-value';
import {
  PublicStockWidget,
  publicStockSymbol,
  publicStockChartUrl,
} from '../components/public-stock-widget';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
} from '../components/ui';
import {
  publicApi,
  publicExternalUrl,
  publicMarketIds,
  publicMarketsQuery,
  type PublicRegion,
} from '../lib/public-api';
import { loginUrl } from '../lib/login-return';
import { ApiError } from '../lib/api';
import { formatDate, formatKst } from '../lib/format';
import { availableHistoryRanges, historyForRange, marketUnit } from '../lib/market-format';
import { marketHistoryLabels } from '../lib/market-display';
import { marketSourceTime } from '../lib/market-time';
import '../components/market-overview.css';
import './guest-pages.css';

const rangeLabels = { '1m': '1개월', '3m': '3개월', '1y': '1년' } as const;
const publicRegion = (value: string | null): PublicRegion =>
  value === 'kr' || value === 'us' ? value : 'all';

function GuestHeading({ title, description }: { title: string; description: string }) {
  return (
    <header className="guest-heading">
      <span className="guest-eyebrow">누구나 보는 오르셈</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}

function MemberInvitation({
  destination,
  compact = false,
}: {
  destination?: string;
  compact?: boolean;
}) {
  const location = useLocation();
  return (
    <aside
      className={`guest-member-invitation${compact ? ' is-compact' : ''}`}
      aria-label="회원 기능 안내"
    >
      <LockKeyhole size={20} aria-hidden="true" />
      <div>
        <strong>관찰을 이어가고 싶다면</strong>
        <p>로그인과 승인 후 공시·이벤트 상세, 관심 종목과 알림을 이용할 수 있습니다.</p>
      </div>
      <Link
        className="button button--secondary button--sm"
        to={loginUrl('/login', destination ?? `${location.pathname}${location.search}`)}
      >
        로그인 <ArrowRight size={15} aria-hidden="true" />
      </Link>
    </aside>
  );
}

function PublicMarketGrid() {
  const markets = useQuery(publicMarketsQuery());
  if (markets.isPending) return <LoadingState label="공개 시장 지표를 불러오는 중입니다." />;
  if (markets.isError)
    return <ErrorState message={markets.error.message} onRetry={() => void markets.refetch()} />;
  if (!markets.data.items.length)
    return (
      <EmptyState
        title="아직 공개된 시장 자료가 없습니다"
        description="공식 출처에서 확인한 관측값이 준비되면 표시합니다."
      />
    );
  return (
    <div className="guest-market-grid">
      {markets.data.items.map((item) => (
        <MarketCard key={item.id} item={item} history={markets.data.histories?.[item.id]} />
      ))}
    </div>
  );
}

function newsTitle(item: PublicNewsItem) {
  return item.rightsMode === 'OFFICIAL_PUBLIC_DATA'
    ? item.translation?.title || item.title
    : item.title;
}

function newsSummary(item: PublicNewsItem) {
  return item.rightsMode === 'OFFICIAL_PUBLIC_DATA'
    ? item.translation?.summary || item.summary
    : null;
}

function PublicNewsList({ items }: { items: PublicNewsItem[] }) {
  const visible = items.filter(
    (item) => item.rightsMode === 'OFFICIAL_PUBLIC_DATA' && publicExternalUrl(item.url),
  );
  if (!visible.length)
    return (
      <EmptyState
        title="표시할 공식 소식이 없습니다"
        description="검색 조건을 바꾸거나 나중에 다시 확인해 주세요."
      />
    );
  return (
    <ul className="guest-news-list">
      {visible.map((item) => (
        <li key={item.id}>
          <article>
            <div className="guest-news-meta">
              <span>{item.publisher}</span>
              {item.publishedAt ? (
                <time dateTime={item.publishedAt}>{formatDate(item.publishedAt)}</time>
              ) : (
                <span>발행일 미제공</span>
              )}
              {item.translation ? <Badge>자동 번역</Badge> : null}
            </div>
            <h3>
              <Link to={`/news/${encodeURIComponent(item.id)}`}>
                {newsTitle(item)}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
            </h3>
            {newsSummary(item) ? <p className="guest-news-summary">{newsSummary(item)}</p> : null}
          </article>
        </li>
      ))}
    </ul>
  );
}

function LatestPublicNews() {
  const news = useQuery({
    queryKey: ['public', 'news', 'latest'],
    queryFn: ({ signal }) => publicApi.news({ limit: 6 }, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    gcTime: 0,
  });
  return (
    <Card className="guest-news-card">
      <header className="guest-section-heading">
        <div>
          <span className="guest-eyebrow">공식 기관의 소식</span>
          <h2>새로 나온 뉴스</h2>
        </div>
        <Link className="text-link" to="/news">
          전체 보기 <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </header>
      {news.isPending ? (
        <LoadingState label="공식 소식을 불러오는 중입니다." />
      ) : news.isError ? (
        <ErrorState message={news.error.message} onRetry={() => void news.refetch()} />
      ) : (
        <PublicNewsList items={news.data.items} />
      )}
    </Card>
  );
}

function RelatedPublicNews({ companyId }: { companyId: string }) {
  const news = useQuery({
    queryKey: ['public', 'news', 'company', companyId, 6],
    queryFn: ({ signal }) => publicApi.news({ companyId, limit: 6 }, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    gcTime: 0,
  });
  return (
    <Card className="guest-news-card">
      <header className="guest-section-heading">
        <h2>관련 공식 소식</h2>
        <Link className="text-link" to={`/news?companyId=${encodeURIComponent(companyId)}`}>
          전체 보기 <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </header>
      {news.isPending ? (
        <LoadingState label="관련 공식 소식을 불러오는 중입니다." />
      ) : news.isError ? (
        <ErrorState message={news.error.message} onRetry={() => void news.refetch()} />
      ) : news.data.items.length ? (
        <PublicNewsList items={news.data.items} />
      ) : (
        <EmptyState
          title="연결된 공식 발표가 아직 없습니다"
          description="이 종목과 연결된 Fed·BLS·EIA 발표가 확인되면 표시합니다."
        />
      )}
    </Card>
  );
}

export function GuestHomePage() {
  return (
    <div className="guest-page">
      <section className="guest-hero">
        <div>
          <span className="guest-eyebrow">누구나 보는 오르셈</span>
          <h1>
            시장의 흐름,
            <br />
            지금부터 살펴보세요.
          </h1>
          <p>
            공개 시장 차트와 공식 소식을 로그인 없이 확인하세요.
            <br className="guest-desktop-break" /> 궁금한 종목은 이름이나 티커로 찾아볼 수 있습니다.
          </p>
          <div className="guest-hero__actions">
            <Link to="/companies" className="button button--primary button--md">
              종목 찾아보기 <Search size={17} aria-hidden="true" />
            </Link>
            <Link to="/news" className="text-link">
              공식 뉴스 보기 <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </div>
        <div className="guest-hero__aside">
          <span>OPEN OBSERVATORY</span>
          <strong>
            출처와 시간을
            <br />
            함께 봅니다.
          </strong>
          <p>
            미국 국채 · WTI 현물
            <br />
            Fed · BLS · EIA 공식 발표
          </p>
        </div>
      </section>
      <section aria-labelledby="guest-market-title">
        <header className="guest-section-heading">
          <div>
            <span className="guest-eyebrow">경제를 읽는 지표</span>
            <h2 id="guest-market-title">시장 한눈에 보기</h2>
          </div>
          <Link className="text-link" to="/markets">
            차트 보기 <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </header>
        <PublicMarketGrid />
        <p className="guest-note">
          공식 출처가 발표한 실제 관측값입니다. 항목마다 기준일과 갱신 주기가 다릅니다.
        </p>
      </section>
      <LatestPublicNews />
      <MemberInvitation />
    </div>
  );
}

export function GuestMarketsPage() {
  return (
    <div className="guest-page">
      <GuestHeading
        title="공개 시장 지표"
        description="미국 국채 2년·10년 수익률과 WTI 현물 가격을 공식 출처와 함께 확인합니다."
      />
      <PublicMarketGrid />
      <p className="guest-note">
        항목을 선택하면 기간별 차트와 원본 출처를 볼 수 있습니다. 발표가 지연되거나 관측값이 없으면
        마지막 확인 자료 또는 빈 상태를 표시합니다.
      </p>
      <MemberInvitation compact />
    </div>
  );
}

export function GuestMarketDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const requested = params.get('range');
  const range = requested === '3m' || requested === '1y' ? requested : '1m';
  const markets = useQuery(publicMarketsQuery());
  const item = markets.data?.items.find((quote) => quote.id === id);
  const history = useQuery({
    queryKey: ['public', 'market-history', id, '1y'],
    queryFn: ({ signal }) => publicApi.marketHistory(id, '1y', signal),
    enabled: publicMarketIds.has(id) && Boolean(item),
    staleTime: 60_000,
  });
  const available = availableHistoryRanges(
    history.data?.points ?? [],
    history.data?.asOf ?? new Date().toISOString(),
  );
  const activeRange = available.includes(range) ? range : '1m';
  const points = history.data
    ? historyForRange(history.data.points, activeRange, history.data.asOf)
    : [];
  if (!publicMarketIds.has(id))
    return (
      <div className="guest-page">
        <GuestHeading
          title="회원 시장 차트"
          description="이 지표의 상세 차트는 로그인과 승인 후 확인할 수 있습니다."
        />
        <MemberInvitation destination={`/markets/${encodeURIComponent(id)}`} compact />
        <Link className="text-link" to="/markets">
          공개 시장 지표로 돌아가기
        </Link>
      </div>
    );
  if (markets.isPending) return <LoadingState label="공개 지표를 불러오는 중입니다." />;
  if (markets.isError)
    return <ErrorState message={markets.error.message} onRetry={() => void markets.refetch()} />;
  if (!item)
    return (
      <EmptyState
        title="공개 지표를 찾을 수 없습니다"
        description="시장 메뉴에서 다른 지표를 선택해 주세요."
      />
    );
  const source = publicExternalUrl(item.sourceUrl);
  return (
    <div className="guest-page">
      <Link className="text-link" to="/markets">
        <ArrowLeft size={15} aria-hidden="true" /> 공개 시장 지표
      </Link>
      <GuestHeading title={item.name} description={item.description} />
      <Card>
        <CardContent>
          <MarketValue item={item} />
          <div className="guest-data-meta">
            <span>{marketSourceTime(item) ?? '자료 기준 확인 전'}</span>
            {item.observedAt ? (
              <time dateTime={item.observedAt}>수집 {formatKst(item.observedAt)}</time>
            ) : null}
            <span>{marketHistoryLabels[item.historyKind]}</span>
          </div>
          {item.message ? (
            <p className="guest-note" role="status">
              {item.message}
            </p>
          ) : null}
          <div className="guest-chart-toolbar">
            <span>{item.id === 'wti' ? 'WTI 현물 · EIA 발표' : '미국 국채 일별 수익률'}</span>
            <div role="group" aria-label="공개 차트 기간">
              {available.map((value) => (
                <Button
                  key={value}
                  variant={value === activeRange ? 'primary' : 'secondary'}
                  size="sm"
                  aria-pressed={value === activeRange}
                  onClick={() => setParams({ range: value })}
                >
                  {rangeLabels[value]}
                </Button>
              ))}
            </div>
          </div>
          {history.isPending ? (
            <LoadingState label="공개 지표 이력을 불러오는 중입니다." />
          ) : history.isError ? (
            <ErrorState message={history.error.message} onRetry={() => void history.refetch()} />
          ) : points.length ? (
            <MarketChart
              points={points}
              name={item.name}
              unit={marketUnit(item.unit)}
              currency={item.currency}
              rangeKey={activeRange}
            />
          ) : (
            <EmptyState
              title="표시할 이력이 없습니다"
              description={history.data?.message ?? '공식 관측값이 확인된 기간부터 표시합니다.'}
            />
          )}
          <p className="guest-note">
            실제로 제공된 날짜만 표시하며, 휴장일과 누락된 관측값을 채우지 않습니다.
            {item.id === 'wti' ? ' WTI는 여러 날짜의 현물 종가가 묶여 발표될 수 있습니다.' : ''}
          </p>
          {source ? (
            <a className="text-link" href={source} target="_blank" rel="noopener noreferrer">
              {item.attribution}
              <ArrowUpRight size={15} aria-hidden="true" />
              <span className="sr-only"> 새 창에서 보기</span>
            </a>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function SearchFilters({ kind }: { kind: 'companies' | 'news' }) {
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(params.get('q') ?? '');
  const query = params.get('q') ?? '';
  useEffect(() => setDraft(query), [query]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (draft.trim()) next.set('q', draft.trim());
      else next.delete('q');
      next.delete('cursor');
      return next;
    });
  };
  const label = kind === 'companies' ? '공개 종목 검색' : '공식 뉴스 검색';
  return (
    <form className="guest-search" role="search" aria-label={label} onSubmit={submit}>
      <label className="guest-search__input">
        <span className="sr-only">{label}</span>
        <Search size={18} aria-hidden="true" />
        <Input
          type="search"
          maxLength={120}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={kind === 'companies' ? '종목명, 종목코드 또는 티커' : '공식 발표 제목 검색'}
        />
      </label>
      <label>
        <span className="sr-only">지역</span>
        <select
          className="select"
          value={publicRegion(params.get('region'))}
          onChange={(event) =>
            setParams((current) => {
              const next = new URLSearchParams(current);
              next.set('region', event.target.value);
              next.delete('cursor');
              return next;
            })
          }
        >
          <option value="all">전체 지역</option>
          <option value="kr">국내</option>
          <option value="us">미국</option>
        </select>
      </label>
      <Button type="submit" variant="secondary">
        검색
      </Button>
    </form>
  );
}

function PageNavigation({ nextCursor }: { nextCursor: string | null }) {
  const [params, setParams] = useSearchParams();
  if (!params.get('cursor') && !nextCursor) return null;
  return (
    <nav aria-label="공개 목록 페이지" className="guest-pagination">
      {params.get('cursor') ? (
        <Button
          variant="ghost"
          onClick={() =>
            setParams((current) => {
              const next = new URLSearchParams(current);
              next.delete('cursor');
              return next;
            })
          }
        >
          처음으로
        </Button>
      ) : (
        <span />
      )}
      {nextCursor ? (
        <Button
          variant="secondary"
          onClick={() =>
            setParams((current) => {
              const next = new URLSearchParams(current);
              next.set('cursor', nextCursor);
              return next;
            })
          }
        >
          다음 <ArrowRight size={15} aria-hidden="true" />
        </Button>
      ) : null}
    </nav>
  );
}

function companyPath(company: PublicCompany) {
  return /^\/companies\/(?:[A-Z]+:)?[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/u.test(company.canonicalPath)
    ? company.canonicalPath
    : `/companies/${encodeURIComponent(company.id)}`;
}

export function GuestCompaniesPage() {
  const [params] = useSearchParams();
  const filters = {
    q: params.get('q') || undefined,
    region: publicRegion(params.get('region')),
    cursor: params.get('cursor'),
    limit: 20,
  };
  const companies = useQuery({
    queryKey: ['public', 'companies', filters],
    queryFn: ({ signal }) => publicApi.companies(filters, signal),
    staleTime: 60_000,
  });
  return (
    <div className="guest-page">
      <GuestHeading
        title="궁금한 종목 찾기"
        description="공식 출처로 확인된 종목을 검색하세요. 미국 종목은 제공 가능한 TradingView 차트를 함께 볼 수 있습니다."
      />
      <SearchFilters kind="companies" />
      {companies.isPending ? (
        <LoadingState label="공개 종목을 찾는 중입니다." />
      ) : companies.isError ? (
        <ErrorState message={companies.error.message} onRetry={() => void companies.refetch()} />
      ) : companies.data.items.length ? (
        <>
          <ul className="guest-company-list">
            {companies.data.items.map((company) => (
              <li key={company.id}>
                <Link to={companyPath(company)}>
                  <span className="guest-company-initial" aria-hidden="true">
                    {Array.from(company.symbol || company.name)
                      .slice(0, 2)
                      .join('')}
                  </span>
                  <span className="guest-company-name">
                    <strong>{company.name}</strong>
                    <small>
                      {company.market} · {company.symbol}
                    </small>
                  </span>
                  <span className="guest-company-availability">
                    {publicStockSymbol(company) ? '공개 차트' : '종목 정보'}
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
          <PageNavigation nextCursor={companies.data.nextCursor} />
        </>
      ) : (
        <EmptyState
          title="일치하는 공개 종목이 없습니다"
          description="종목명이나 티커를 확인해 주세요. 공식 출처로 확인된 종목만 검색됩니다."
        />
      )}
      <MemberInvitation compact />
    </div>
  );
}

export function GuestCompanyPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const company = useQuery({
    queryKey: ['public', 'company', id],
    queryFn: ({ signal }) => publicApi.company(id, signal),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
  useEffect(() => {
    if (!company.data) return;
    const canonical = companyPath(company.data);
    if (canonical !== location.pathname)
      void navigate(`${canonical}${location.search}`, { replace: true });
  }, [company.data, location.pathname, location.search, navigate]);
  if (company.isPending) return <LoadingState label="공개 종목 정보를 불러오는 중입니다." />;
  if (company.isError)
    return (
      <div className="guest-page">
        <ErrorState message={company.error.message} onRetry={() => void company.refetch()} />
        {company.error instanceof ApiError && company.error.statusCode === 404 ? (
          <MemberInvitation compact />
        ) : null}
      </div>
    );
  const item = company.data;
  const source = publicExternalUrl(item.sourceUrl);
  const externalChart = publicStockChartUrl(item);
  const destination = `${companyPath(item)}${location.search}`;
  return (
    <div className="guest-page">
      <Link className="text-link" to="/companies">
        <ArrowLeft size={15} aria-hidden="true" /> 종목 찾기
      </Link>
      <GuestHeading title={item.name} description={`${item.market} · ${item.symbol}`} />
      <Card>
        <CardContent>
          {publicStockSymbol(item) ? (
            <PublicStockWidget key={item.id} company={item} />
          ) : (
            <div className="guest-chart-gate">
              <LockKeyhole size={28} aria-hidden="true" />
              <h2>
                {item.region === 'kr'
                  ? '국내 종목 차트는 로그인과 승인 후 볼 수 있습니다'
                  : '현재 공개 차트를 제공하지 않는 종목입니다'}
              </h2>
              <p>회원 화면에서 종목 차트와 공시·이벤트를 함께 확인하세요.</p>
              <Link
                className="button button--primary button--md"
                to={loginUrl('/login', destination)}
              >
                로그인하고 종목 상세 보기 <ArrowRight size={16} aria-hidden="true" />
              </Link>
              {externalChart ? (
                <a
                  className="text-link"
                  href={externalChart}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  TradingView에서 차트 보기 <ArrowUpRight size={15} aria-hidden="true" />
                  <span className="sr-only"> 새 창에서 보기</span>
                </a>
              ) : null}
              {source ? (
                <a className="text-link" href={source} target="_blank" rel="noopener noreferrer">
                  공식 출처에서 종목 보기 <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
      <div className="guest-data-meta">
        {source ? (
          <a className="text-link" href={source} target="_blank" rel="noopener noreferrer">
            종목 정보의 공식 출처 <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        ) : null}
        {item.observedAt ? (
          <time dateTime={item.observedAt}>종목 정보 확인 {formatKst(item.observedAt)}</time>
        ) : (
          <span>종목 정보 확인 시각 미제공</span>
        )}
      </div>
      <RelatedPublicNews companyId={item.id} />
      <MemberInvitation destination={destination} compact />
    </div>
  );
}

export function GuestNewsPage() {
  const [params] = useSearchParams();
  const filters = {
    q: params.get('q') || undefined,
    region: publicRegion(params.get('region')),
    companyId: params.get('companyId') || undefined,
    cursor: params.get('cursor'),
    limit: 20,
  };
  const news = useQuery({
    queryKey: ['public', 'news', filters],
    queryFn: ({ signal }) => publicApi.news(filters, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    gcTime: 0,
  });
  return (
    <div className="guest-page">
      <GuestHeading
        title="공식 기관의 소식"
        description="미 연방준비제도(Fed), 노동통계국(BLS), 에너지정보청(EIA)이 발표한 소식을 확인합니다."
      />
      <SearchFilters kind="news" />
      {filters.companyId ? (
        <div className="guest-data-meta">
          <span>선택한 종목과 연결된 공식 발표만 표시합니다.</span>
          <Link className="text-link" to="/news">
            종목 필터 해제
          </Link>
        </div>
      ) : null}
      <Card className="guest-news-card">
        {news.isPending ? (
          <LoadingState label="공식 소식을 불러오는 중입니다." />
        ) : news.isError ? (
          <ErrorState message={news.error.message} onRetry={() => void news.refetch()} />
        ) : (
          <PublicNewsList items={news.data.items} />
        )}
      </Card>
      {news.data ? <PageNavigation nextCursor={news.data.nextCursor} /> : null}
      <p className="guest-note">
        공개 가능한 공식 발표의 제목과 제공된 요약을 표시합니다. 자세한 내용은 기관의 원문에서
        확인하세요.
      </p>
    </div>
  );
}

export function GuestNewsDetailPage() {
  const { id = '' } = useParams();
  const news = useQuery({
    queryKey: ['public', 'news-detail', id],
    queryFn: ({ signal }) => publicApi.newsDetail(id, signal),
    enabled: Boolean(id),
    staleTime: 60_000,
    refetchInterval: 60_000,
    gcTime: 0,
  });
  if (news.isPending) return <LoadingState label="공식 발표를 불러오는 중입니다." />;
  if (news.isError)
    return (
      <div className="guest-page">
        <ErrorState message={news.error.message} onRetry={() => void news.refetch()} />
        {news.error instanceof ApiError && news.error.statusCode === 404 ? (
          <MemberInvitation compact />
        ) : null}
      </div>
    );
  if (news.data.rightsMode !== 'OFFICIAL_PUBLIC_DATA')
    return (
      <EmptyState
        title="공개된 발표를 찾을 수 없습니다"
        description="공식 뉴스 목록에서 다른 소식을 확인해 주세요."
      />
    );
  const item = news.data;
  const original = publicExternalUrl(item.url);
  const source = publicExternalUrl(item.sourceUrl);
  return (
    <article className="guest-page guest-article">
      <Link className="text-link" to="/news">
        <ArrowLeft size={15} aria-hidden="true" /> 공식 뉴스
      </Link>
      <GuestHeading title={newsTitle(item)} description={item.publisher} />
      <div className="guest-data-meta">
        {item.publishedAt ? (
          <time dateTime={item.publishedAt}>발행 {formatKst(item.publishedAt)}</time>
        ) : (
          <span>발행 시각 미제공</span>
        )}
        <time dateTime={item.firstObservedAt}>최초 확인 {formatKst(item.firstObservedAt)}</time>
        <Badge>공식 공개 자료</Badge>
        {item.translation ? <Badge>자동 번역</Badge> : null}
      </div>
      <Card>
        <CardContent>
          <p className="guest-article__summary">
            {newsSummary(item) ||
              '이 발표는 제공된 요약이 없습니다. 기관의 원문에서 확인해 주세요.'}
          </p>
          {original ? (
            <a
              className="button button--primary button--md"
              href={original}
              target="_blank"
              rel="noopener noreferrer"
            >
              기관 원문에서 자세히 보기 <ArrowUpRight size={16} aria-hidden="true" />
              <span className="sr-only"> 새 창에서 보기</span>
            </a>
          ) : (
            <p role="status">안전한 원문 링크를 확인할 수 없습니다.</p>
          )}
        </CardContent>
      </Card>
      {source ? (
        <a className="text-link" href={source} target="_blank" rel="noopener noreferrer">
          발표 출처 확인 <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      ) : null}
    </article>
  );
}
