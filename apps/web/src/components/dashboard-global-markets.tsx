import { Link } from 'react-router-dom';
import { formatKst } from '../lib/format';
import { globalMarketGroups, marketStatusLabel } from '../lib/market-display';
import { marketEmoji } from '../lib/market-emoji';
import {
  marketAmount,
  marketChange,
  marketChangeDirection,
  marketNumber,
} from '../lib/market-format';
import { marketCollectionTime } from '../lib/market-time';
import type { MarketQuote } from '../types';
import './dashboard-global-markets.css';

const names: Record<string, string> = {
  gold: '금',
  silver: '은',
  wti: 'WTI',
  btc: 'BTC',
  eth: 'ETH',
};

function GlobalQuote({ item }: { item: MarketQuote }) {
  const emoji = marketEmoji(item.id);
  const value = marketNumber(item.value, item.currency);
  const change = value === '—' ? '—' : marketChange(item);
  const status = marketStatusLabel(item.status, true) ?? (value === '—' ? '자료 없음' : null);
  const unit = item.category === 'CRYPTO' ? null : item.category === 'METAL' ? '/oz t' : '/bbl';
  const unitDescription =
    item.category === 'CRYPTO' ? '원화' : item.category === 'METAL' ? 'USD/트로이온스' : 'USD/배럴';
  const time = marketCollectionTime(item);
  const converted =
    item.category === 'CRYPTO' && item.convertedValue !== null
      ? marketNumber(item.convertedValue, 'USD')
      : null;
  const description = [
    `${value} ${unitDescription}`,
    `${item.changeLabel} ${change}`,
    status,
    time.description,
    converted && converted !== '—'
      ? `참고 환산 ${converted} 달러, 환율 기준 ${formatKst(item.conversionAt)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Link
      className="dashboard-global-quote"
      data-status={item.status}
      to={`/markets/${item.id}`}
      aria-label={`${item.name} 상세 차트`}
      aria-describedby={`global-quote-${item.id}-description`}
      title={description}
    >
      <span className="dashboard-global-quote__heading">
        <strong>
          {emoji ? (
            <span className="dashboard-global-quote__emoji" aria-hidden="true">
              {emoji}
            </span>
          ) : null}
          {names[item.id] ?? item.name}
        </strong>
      </span>
      <strong className="dashboard-global-quote__value">
        <span className="dashboard-global-quote__amount">
          {marketAmount(item.value, item.currency)}
        </span>
        {unit ? <small className="dashboard-global-quote__unit">{unit}</small> : null}
      </strong>
      <span className="dashboard-global-quote__movement">
        <span data-direction={marketChangeDirection(item)}>{change}</span>
        {status ? <span className="dashboard-global-quote__status">{status}</span> : null}
      </span>
      <span className="dashboard-global-quote__detail" aria-hidden="true">
        {time.timestamp ? (
          <time dateTime={item.observedAt ?? undefined} title={time.label}>
            {time.timestamp}
          </time>
        ) : (
          <span>{time.label}</span>
        )}
        {converted && converted !== '—' ? (
          <span className="dashboard-global-quote__conversion">≈ ${converted} 참고 환산</span>
        ) : null}
      </span>
      <span className="sr-only" id={`global-quote-${item.id}-description`}>
        {description}
      </span>
    </Link>
  );
}

export function DashboardGlobalMarkets({ items }: { items: MarketQuote[] }) {
  return (
    <section className="dashboard-global-strips" aria-label="원자재와 가상자산 시세">
      {globalMarketGroups.map((strip) => (
        <section
          key={strip.key}
          className={`dashboard-global-strip dashboard-global-strip--${strip.key}`}
          aria-labelledby={`global-strip-${strip.key}`}
        >
          <h3 id={`global-strip-${strip.key}`}>{strip.label}</h3>
          <div className="dashboard-global-strip__items">
            {strip.dashboardIds.map((id) => {
              const item = items.find((entry) => entry.id === id);
              return item ? <GlobalQuote key={id} item={item} /> : null;
            })}
          </div>
        </section>
      ))}
    </section>
  );
}
