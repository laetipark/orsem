import { ArrowUpRight, CalendarDays, ChartNoAxesCombined } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { companyPath } from '../lib/company-path';
import { formatDate, formatKst, formatMoney } from '../lib/format';
import { CompanyAvatar } from './company-avatar';
import { Card, CardHeader, EmptyState, ErrorState, LoadingState } from './ui';
import './market-selection.css';

type Selection = Awaited<ReturnType<typeof api.marketSelection>>;
type Region = Selection['regions'][number];

function useMarketSelection() {
  return useQuery({
    queryKey: ['market-selection'],
    queryFn: ({ signal }) => api.marketSelection(signal),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

function sourceLink(value: string | null) {
  try {
    const url = new URL(value ?? '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function marketCapLabel(value: string, currency: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(number);
}

function selectionState(region: Region | undefined) {
  if (!region?.items.length) return '목록 준비 중';
  return region.status === 'AVAILABLE' ? '월간 목록' : '이전 목록 유지';
}

function MarketRegion({ region, code }: { region?: Region; code: 'kr' | 'us' }) {
  const label = code === 'kr' ? '국내' : '미국';
  const currency = region?.currency ?? (code === 'kr' ? 'KRW' : 'USD');
  const source = sourceLink(region?.sourceUrl ?? null);
  const items = (region?.items ?? [])
    .filter((item) => item.rank >= 1 && item.rank <= 20)
    .sort((a, b) => a.rank - b.rank);
  return (
    <section
      className="market-leaders__region"
      id={`market-leaders-${code}`}
      aria-labelledby={`market-leaders-${code}-title`}
    >
      <header className="market-leaders__region-header">
        <h3 id={`market-leaders-${code}-title`}>{label} 상위 20종목</h3>
        <span className="market-leaders__status" data-status={region?.status ?? 'PENDING'}>
          {selectionState(region)}
        </span>
      </header>
      <div className="market-leaders__basis">
        <dl>
          <div>
            <dt>자료 기준</dt>
            <dd>
              {region?.basisDate ? (
                <time dateTime={region.basisDate}>{formatDate(region.basisDate)}</time>
              ) : (
                '확인 대기'
              )}
            </dd>
          </div>
          {region?.selectionMonth ? (
            <div>
              <dt>선정 월</dt>
              <dd>{region.selectionMonth.replace('-', '. ')}</dd>
            </div>
          ) : null}
          {region?.observedAt ? (
            <div>
              <dt>갱신 시각</dt>
              <dd>
                <time dateTime={region.observedAt}>{formatKst(region.observedAt)}</time>
              </dd>
            </div>
          ) : null}
          {region?.nextRefreshAt ? (
            <div>
              <dt>다음 갱신</dt>
              <dd>
                <time dateTime={region.nextRefreshAt}>{formatKst(region.nextRefreshAt)}</time>
              </dd>
            </div>
          ) : null}
        </dl>
        {region?.reason ? <p className="market-leaders__notice">{region.reason}</p> : null}
        {region?.providerScope ? (
          <p className="market-leaders__note">{region.providerScope}</p>
        ) : null}
        {region?.updateNote ? <p className="market-leaders__note">{region.updateNote}</p> : null}
        {source ? (
          <a
            className="market-leaders__source"
            href={source}
            target="_blank"
            rel="noopener noreferrer"
          >
            {region?.sourceName || '원본 출처'}
            <ArrowUpRight size={13} aria-hidden="true" />
            <span className="sr-only"> 새 창에서 보기</span>
          </a>
        ) : (
          <span className="market-leaders__note">원본 출처 확인 대기</span>
        )}
      </div>
      {items.length ? (
        <>
          <div className="market-leaders__columns" aria-hidden="true">
            <span>순위 · 종목</span>
            <span>시가총액 · {currency}</span>
          </div>
          <ol className="market-leaders__list" aria-label={`${label} 시가총액 순위`}>
            {items.map((item) => (
              <li key={item.id} value={item.rank}>
                <Link className="market-leaders__row" to={companyPath(item)}>
                  <span className="market-leaders__rank" aria-label={`${item.rank}위`}>
                    {item.rank}
                  </span>
                  <CompanyAvatar
                    company={{
                      nameKo: item.nameKo,
                      stockCode: item.stockCode ?? null,
                      ticker: item.ticker ?? null,
                      market: item.market ?? (code === 'kr' ? 'KRX' : 'NASDAQ'),
                    }}
                  />
                  <span className="market-leaders__company">
                    <strong>{item.nameKo}</strong>
                    <small>
                      {[item.market, item.stockCode ?? item.ticker].filter(Boolean).join(' · ')}
                    </small>
                  </span>
                  <span
                    className="market-leaders__cap"
                    title={formatMoney(item.marketCap, currency)}
                  >
                    {marketCapLabel(item.marketCap, currency)}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          {items.length < 20 ? (
            <p className="market-leaders__partial">현재 확인된 {items.length}종목을 표시합니다.</p>
          ) : null}
        </>
      ) : (
        <EmptyState
          title={`${label} 선정 목록을 기다리고 있습니다`}
          description="검증된 월간 목록이 준비되면 표시합니다."
        />
      )}
    </section>
  );
}

export function MarketSelection() {
  const query = useMarketSelection();
  return (
    <Card className="market-leaders" aria-labelledby="market-leaders-title">
      <CardHeader>
        <div>
          <h2 id="market-leaders-title">
            <ChartNoAxesCombined size={19} aria-hidden="true" />
            시가총액 상위 20종목
          </h2>
          <p className="market-leaders__description">국내와 미국에서 각각 20종목을 선정합니다.</p>
        </div>
        <span className="market-leaders__cadence">
          <CalendarDays size={14} aria-hidden="true" />
          매월 1회 갱신
        </span>
      </CardHeader>
      {query.isPending ? <LoadingState label="월간 시가총액 순위를 불러오는 중입니다." /> : null}
      {query.isError ? (
        <ErrorState
          message={
            query.data
              ? '새 목록을 확인하지 못해 마지막 조회 결과를 표시합니다.'
              : '시가총액 선정 목록을 불러오지 못했습니다.'
          }
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data ? (
        <div className="market-leaders__regions">
          {(['kr', 'us'] as const).map((code) => (
            <MarketRegion
              key={code}
              code={code}
              region={query.data.regions.find((region) => region.region === code)}
            />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export function MarketSelectionMembership({ companyId }: { companyId: string }) {
  const query = useMarketSelection();
  const selected = query.data?.regions
    .flatMap((region) =>
      region.items
        .filter((item) => item.id === companyId && item.rank <= 20 && item.rank >= 1)
        .map((item) => ({ region, item })),
    )
    .find(({ region }) => region.region === 'kr' || region.region === 'us');
  if (!selected) return null;
  const { region, item } = selected;
  const label = region.region === 'kr' ? '국내' : '미국';
  return (
    <Link
      className="market-leaders__membership"
      to={`/watchlist#market-leaders-${region.region}`}
      title={`시가총액 상위 20종목 · ${region.basisDate ? formatDate(region.basisDate) + ' 자료' : '자료 기준일 미제공'} · 매월 1회 갱신`}
    >
      <ChartNoAxesCombined size={13} aria-hidden="true" />
      {label} 시총 {item.rank}위{region.status !== 'AVAILABLE' ? <small>이전 목록</small> : null}
    </Link>
  );
}
