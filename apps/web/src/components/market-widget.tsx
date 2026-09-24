import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme';
import { TradingViewWidget, type WidgetProps } from './tradingview-widget';

const fredSourceUrl = 'https://fred.stlouisfed.org/series/SP500';

function FredSp500({ name, detail, compact, range }: WidgetProps) {
  const { theme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const graphHeight = detail ? 380 : 190;
  const activeRange = range ?? (detail ? '1m' : '3m');

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // FRED's official embed takes numeric dimensions. Match the real card width
    // rather than clipping the graph and its provider attribution on mobile.
    const resize = () => {
      const measured = element.getBoundingClientRect().width;
      if (measured > 0) setWidth(Math.max(1, Math.floor(measured) - 16));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const end = new Date();
  const start = new Date(
    end.getTime() - { '1m': 31, '3m': 93, '1y': 366 }[activeRange] * 86_400_000,
  );
  const kstDate = (value: Date) =>
    new Date(value.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    id: 'SP500',
    width: String(width),
    height: String(graphHeight),
    cosd: kstDate(start),
    coed: kstDate(end),
    bgcolor: theme === 'dark' ? '#131722' : '#ffffff',
    graph_bgcolor: theme === 'dark' ? '#131722' : '#ffffff',
    txtcolor: theme === 'dark' ? '#d1d4dc' : '#444444',
  });
  const src = `https://fred.stlouisfed.org/graph/graph-landing.php?${params}`;

  return (
    <div
      ref={container}
      className={`market-widget market-widget--fred ${detail ? 'market-widget--detail' : 'market-widget--summary'}${compact ? ' market-widget--compact' : ''}`}
    >
      <iframe
        key={src}
        src={src}
        title={`${name} FRED 일별 종가 차트`}
        width="100%"
        height={graphHeight + 80}
        loading="lazy"
        style={{ border: 0, display: 'block' }}
      />
      <a
        className="market-widget__attribution"
        href={fredSourceUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {name} · FRED · S&P Dow Jones Indices
      </a>
    </div>
  );
}

export function MarketWidget(props: WidgetProps) {
  // Keep the legacy widgetSymbol route working for cached TradingView metadata.
  // Only FRED's official embed renders the series; Orsem never reads its values.
  return props.symbol === 'FRED:SP500' ? (
    <FredSp500 {...props} />
  ) : (
    <TradingViewWidget {...props} />
  );
}
