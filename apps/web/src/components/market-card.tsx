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
import type { MarketQuote, MarketHistory } from '../types';
import { MarketSparkline } from './market-sparkline';
import { Badge } from './ui';
import { MarketValue } from './market-value';
import { MarketWidget } from './market-widget';

const categoryIcons = {
  INDEX: ChartNoAxesCombined,
  FX: Coins,
  BOND: Landmark,
  METAL: Coins,
  ENERGY: Droplets,
  CRYPTO: Bitcoin,
};

function MarketCardMetadata({ item }: { item: MarketQuote }) {
  const status = marketStatusLabel(item.status);
  if (item.displayKind === 'WIDGET') {
    return status && status !== '일별 종가' ? (
      <div className="market-card__meta">
        <Badge tone={item.status === 'STALE' ? 'orange' : 'neutral'}>{status}</Badge>
      </div>
    ) : null;
  }
  if (!status && item.category !== 'CRYPTO') return null;
  return (
    <div className="market-card__meta">
      {status ? (
        <Badge tone={item.status === 'STALE' ? 'orange' : 'neutral'}>{status}</Badge>
      ) : null}
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

export function MarketCard({
  item,
  history,
  compact = false,
}: {
  item: MarketQuote;
  history?: MarketHistory;
  compact?: boolean;
}) {
  const Icon = categoryIcons[item.category];
  const emoji = marketEmoji(item.id);
  const time = marketCardTime(item);
  return (
    <article
      data-status={item.status}
      className={`market-card market-card--${item.category.toLowerCase()} ${compact ? 'market-card--compact' : ''} ${item.displayKind === 'WIDGET' ? 'market-card--widget' : ''}`}
    >
      <Link
        to={`/markets/${item.id}`}
        className="market-card__heading"
        aria-label={`${item.name} 상세 차트`}
        title={time.description}
      >
        <span className="market-card__icon" aria-hidden="true">
          {emoji ?? <Icon size={17} />}
        </span>
        <h3>{item.name}</h3>
        {time.text ? (
          <time
            className="market-card__time"
            dateTime={time.dateTime}
            title={time.description}
            aria-label={time.description}
          >
            {time.text}
          </time>
        ) : null}
        <ArrowUpRight size={15} aria-hidden="true" />
      </Link>
      {item.displayKind === 'WIDGET' && item.widgetSymbol ? (
        <MarketWidget
          symbol={item.widgetSymbol}
          name={item.name}
          sourceUrl={item.sourceUrl}
          compact={compact}
        />
      ) : (
        <div className="market-card__body">
          <MarketValue item={item} />
          <MarketSparkline history={history} name={item.name} />
        </div>
      )}
      <MarketCardMetadata item={item} />
    </article>
  );
}
