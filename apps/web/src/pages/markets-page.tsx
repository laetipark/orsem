import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { MarketOverview } from '../components/market-overview';
import { MarketSelection } from '../components/market-selection';
import { MarketValue } from '../components/market-value';
import { MarketChart } from '../components/market-chart';
import { AssetNews, isNewsAsset } from '../components/asset-news';
import { RegionTabs, useRegion } from '../components/region-tabs';
import { MarketWidget } from '../components/market-widget';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/ui';
import { api } from '../lib/api';
import { formatKst } from '../lib/format';
import { availableHistoryRanges, historyForRange, marketUnit } from '../lib/market-format';
import { marketHistoryLabels } from '../lib/market-display';
import { marketOverviewQuery } from '../lib/market-query';
import { marketCollectionTime, marketSourceTime } from '../lib/market-time';

export function MarketsPage() {
  const { region } = useRegion();
  return (
    <div className="page-stack markets-page">
      <div className="page-lead">
        <p>국내·미국 지수부터 원자재와 가상자산까지, 출처와 기준 시각을 함께 확인합니다.</p>
      </div>
      <RegionTabs />
      <MarketOverview region={region} />
      <p className="market-page-note">
        지표마다 갱신 주기와 기준이 다릅니다. 항목을 선택하면 상세 차트와 출처를 볼 수 있습니다.
      </p>
      <MarketSelection region={region} />
    </div>
  );
}

export function MarketDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const requestedRange = params.get('range');
  const range = requestedRange === '3m' || requestedRange === '1y' ? requestedRange : '1m';
  const markets = useQuery(marketOverviewQuery('all'));
  const item = markets.data?.items.find((quote) => quote.id === id);
  // One shared year of daily observations supports range changes without fabricating history.
  const history = useQuery({
    queryKey: ['market-history', id, '1y'],
    queryFn: ({ signal }) => api.marketHistory(id, '1y', signal),
    enabled: Boolean(item && item.displayKind === 'NATIVE'),
    staleTime: 60_000,
  });
  const hasFredChart = item?.displayKind === 'WIDGET' && item.widgetSymbol === 'FRED:SP500';
  const availableRanges = useMemo(
    () =>
      hasFredChart
        ? (['1m', '3m', '1y'] as const)
        : item?.displayKind === 'WIDGET'
          ? []
          : availableHistoryRanges(
              history.data?.points ?? [],
              history.data?.asOf ?? new Date().toISOString(),
            ),
    [hasFredChart, item?.displayKind, history.data],
  );
  const activeRange = availableRanges.includes(range) ? range : '1m';
  const points = useMemo(
    () =>
      history.data ? historyForRange(history.data.points, activeRange, history.data.asOf) : [],
    [history.data, activeRange],
  );
  if (markets.isPending) return <LoadingState label="시장 지표를 불러오는 중입니다." />;
  if (markets.isError)
    return <ErrorState message={markets.error.message} onRetry={() => void markets.refetch()} />;
  if (!item)
    return (
      <EmptyState
        title="지표를 찾을 수 없습니다"
        description="시장 메뉴에서 지표를 다시 선택해 주세요."
      />
    );
  const kind = marketHistoryLabels[item.historyKind];
  const collectionTime = marketCollectionTime(item);
  return (
    <div className="page-stack market-detail-page">
      <Link
        className="text-link"
        to={item.region === 'global' ? '/markets' : `/markets?region=${item.region}`}
      >
        <ArrowLeft size={15} /> 시장으로 돌아가기
      </Link>
      <div className="market-detail__heading">
        <div>
          <span className="section-kicker">{item.symbol}</span>
          <h2>{item.name}</h2>
          <p>{item.description}</p>
        </div>
        <Badge>{marketUnit(item.unit)}</Badge>
      </div>
      <Card>
        <CardContent>
          {item.displayKind === 'NATIVE' ? <MarketValue item={item} /> : null}
          <div className="market-detail__times">
            <span>
              {marketSourceTime(item) ??
                (item.observedAt ? `관측 ${formatKst(item.observedAt)}` : '자료 기준 확인 전')}
            </span>
            {item.observedAt ? (
              <time dateTime={item.observedAt} title={collectionTime.description}>
                수집 {collectionTime.timestamp}
              </time>
            ) : null}
            {item.category === 'CRYPTO' ? (
              <span>환율 기준 {formatKst(item.conversionAt)} · 과거 차트는 원화 기준</span>
            ) : null}
          </div>
          {item.status === 'STALE' ||
          item.status === 'NOT_CONFIGURED' ||
          item.status === 'UNAVAILABLE' ? (
            <p className="market-detail__notice">
              {item.message ?? '현재 새 시세를 확인할 수 없어 마지막 관측값을 표시합니다.'}
            </p>
          ) : null}
          {item.displayKind === 'NATIVE' || hasFredChart ? (
            <div className="market-chart-toolbar">
              <span>
                {kind}
                {item.id === 'wti' ? ' · WTI 현물 · EIA 묶음 발표' : ''}
              </span>
              <div role="group" aria-label="차트 기간">
                {availableRanges.map((value) => (
                  <Button
                    key={value}
                    variant={value === activeRange ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={value === activeRange}
                    onClick={() =>
                      setParams((current) => {
                        const next = new URLSearchParams(current);
                        next.set('range', value);
                        return next;
                      })
                    }
                  >
                    {{ '1m': '1개월', '3m': '3개월', '1y': '1년' }[value]}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          {item.displayKind === 'WIDGET' && item.widgetSymbol ? (
            <div>
              <p className="market-page-note">{item.description}</p>
              <MarketWidget
                detail
                range={activeRange}
                symbol={item.widgetSymbol}
                name={item.name}
                sourceUrl={item.sourceUrl}
              />
            </div>
          ) : (
            <>
              {history.isPending ? <LoadingState label="지표 이력을 불러오는 중입니다." /> : null}
              {history.isError ? (
                <ErrorState
                  message={history.error.message}
                  onRetry={() => void history.refetch()}
                />
              ) : null}
              {history.data && points.length ? (
                <MarketChart
                  points={points}
                  name={item.name}
                  unit={marketUnit(item.unit)}
                  currency={item.currency}
                  rangeKey={activeRange}
                />
              ) : history.data ? (
                <EmptyState
                  title="표시할 이력이 없습니다"
                  description={
                    history.data.message ?? '수집된 데이터가 있는 기간부터 차트를 제공합니다.'
                  }
                />
              ) : null}
              {history.data && points.length ? (
                <p className="market-page-note">
                  {item.id === 'wti'
                    ? 'WTI는 날짜별 현물 종가이며 EIA가 여러 날짜를 묶어 발표합니다. 기준일과 수집 시각이 다를 수 있습니다. '
                    : ''}
                  실제 제공된 날짜만 표시합니다. 휴장일과 누락된 관측값은 채우지 않습니다.
                </p>
              ) : null}
            </>
          )}
          <div className="market-detail__source">
            <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
              {item.attribution} <ExternalLink size={13} />
            </a>
            <span>{item.description}</span>
          </div>
        </CardContent>
      </Card>
      {isNewsAsset(id) ? <AssetNews asset={id} /> : null}
    </div>
  );
}
