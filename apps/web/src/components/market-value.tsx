import {
  marketAmount,
  marketChange,
  marketChangeDirection,
  marketValueUnit,
} from '../lib/market-format';
import type { MarketQuote } from '../types';

export function MarketValue({ item }: { item: MarketQuote }) {
  const unit = marketValueUnit(item.unit, item.currency);
  return (
    <div className="market-value">
      <div className="market-value__number">
        <strong>{marketAmount(item.value, item.currency)}</strong>
        {unit ? <span>{unit}</span> : null}
      </div>
      <span className="market-value__change" data-direction={marketChangeDirection(item)}>
        {marketChange(item)} <small>{item.changeLabel}</small>
      </span>
      {item.category === 'CRYPTO' ? (
        <span className="market-value__conversion">
          ≈ {marketAmount(item.convertedValue, 'USD')} <small>원/달러 참고 환산</small>
        </span>
      ) : null}
    </div>
  );
}
