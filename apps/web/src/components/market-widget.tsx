import { TradingViewWidget, type WidgetProps } from './tradingview-widget';

export function MarketWidget(props: WidgetProps & { instrumentId?: string }) {
  return <TradingViewWidget {...props} />;
}
