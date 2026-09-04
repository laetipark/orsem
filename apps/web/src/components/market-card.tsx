import {
  ArrowUpRight,
  Bitcoin,
  ChartNoAxesCombined,
  Coins,
  Droplets,
  Landmark,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatKst } from '../lib/format';
import { marketStatusLabel } from '../lib/market-display';
import { marketEmoji } from '../lib/market-emoji';
import { marketCardTime, shortMarketTimestamp } from '../lib/market-time';
import type { MarketQuote } from '../types';
import { Badge } from './ui';
import { MarketValue } from './market-value';
import { TradingViewWidget } from './tradingview-widget';

const categoryIcons = {
  INDEX: ChartNoAxesCombined,
  FX: Coins,
  BOND: Landmark,
  METAL: Coins,
  ENERGY: Droplets,
  CRYPTO: Bitcoin,
};

function MarketCardMetadata({ item, compact }: { item: MarketQuote; compact: boolean }) {
  const time = marketCardTime(item);
  const status = marketStatusLabel(item.status);
  return (
    <div className="market-card__meta">
      {status ? (
        <Badge tone={item.status === 'STALE' ? 'orange' : 'neutral'}>{status}</Badge>
      ) : null}
      {time.text ? (
        <time
          dateTime={time.dateTime}
          title={time.description ?? undefined}
          aria-label={time.description ?? undefined}
        >
          {time.text}
        </time>
      ) : (
        <span title={item.displayKind === 'NATIVE' ? (time.description ?? undefined) : undefined}>
          {item.displayKind === 'WIDGET'
            ? compact
              ? 'FRED 경유'
              : 'FRED 경유 · TradingView'
            : '수집 시각 확인 전'}
        </span>
      )}
      {item.category === 'CRYPTO' ? (
        <span
          className="market-card__conversion-time"
          title={`환율 기준 ${formatKst(item.conversionAt)}`}
          aria-label={`환율 기준 ${formatKst(item.conversionAt)}`}
        >
          환율 {item.conversionAt ? shortMarketTimestamp(item.conversionAt) : '확인 전'}
        </span>
      ) : null}
    </div>
  );
}

export function MarketCard({ item, compact = false }: { item: MarketQuote; compact?: boolean }) {
  const Icon = categoryIcons[item.category];
  const emoji = marketEmoji(item.id);
  const compactWidget = compact && item.displayKind === 'WIDGET';
  const usIndex = item.region === 'us' && item.category === 'INDEX';
  return (
    <article
      data-status={item.status}
      className={`market-card market-card--${item.category.toLowerCase()} ${compact ? 'market-card--compact' : ''} ${item.displayKind === 'WIDGET' ? 'market-card--widget' : ''}`}
    >
      <Link
        to={`/markets/${item.id}`}
        className="market-card__heading"
        aria-label={`${item.name} 상세 차트`}
      >
        <span className="market-card__icon" aria-hidden="true">
          {emoji ?? <Icon size={17} />}
        </span>
        <h3>{item.name}</h3>
        {compactWidget ? (
          <Badge className="market-card__daily" title="FRED 경유 일별 종가">
            일별 종가
          </Badge>
        ) : null}
        <ArrowUpRight size={15} aria-hidden="true" />
      </Link>
      {item.displayKind === 'WIDGET' && item.widgetSymbol ? (
        <TradingViewWidget
          symbol={item.widgetSymbol}
          name={item.name}
          sourceUrl={item.sourceUrl}
          compact={compact}
        />
      ) : (
        <MarketValue item={item} />
      )}
      {!compactWidget && !usIndex ? <MarketCardMetadata item={item} compact={compact} /> : null}
    </article>
  );
}
