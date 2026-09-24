import { createElement, useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme';

const allowedSymbols = new Set(['SP:SPX', 'NASDAQ:IXIC', 'FRED:NDQCOM']);
const singleTickerTag = 'tv-mini-chart';
const singleTickerScript = 'https://widgets.tradingview-widget.com/w/en/tv-mini-chart.js';
const widgetLoadTimeoutMs = 15_000;
const tickerLoaders = new WeakMap<Document, { script: HTMLScriptElement; ready: Promise<void> }>();

function loadSingleTicker(): Promise<void> {
  if (window.customElements.get(singleTickerTag)) return Promise.resolve();
  const existing = tickerLoaders.get(document);
  if (existing?.script.isConnected) return existing.ready;

  const script = document.createElement('script');
  script.type = 'module';
  script.src = singleTickerScript;
  script.dataset.orsemWidget = singleTickerTag;
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failed = false) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.removeEventListener('error', onError);
      if (failed) reject(new Error('TradingView Single Ticker could not load.'));
      else resolve();
    };
    const onError = () => finish(true);
    const timer = window.setTimeout(onError, widgetLoadTimeoutMs);
    script.addEventListener('error', onError);
    // Registration is the public readiness signal. Market-data errors and the
    // official attribution remain inside TradingView's own component.
    void window.customElements.whenDefined(singleTickerTag).then(() => finish());
  });
  tickerLoaders.set(document, { script, ready });
  document.head.append(script);
  return ready;
}

export interface WidgetProps {
  symbol: string;
  name: string;
  sourceUrl: string;
  detail?: boolean;
  range?: '1m' | '3m' | '1y';
  restricted?: boolean;
  compact?: boolean;
}

function Attribution({ name, sourceUrl }: Pick<WidgetProps, 'name' | 'sourceUrl'>) {
  return (
    <a
      className="market-widget__attribution"
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      {name} by TradingView
    </a>
  );
}

function SingleTicker({ symbol, name, sourceUrl, compact }: WidgetProps) {
  const { theme } = useTheme();
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    // StrictMode's initial cleanup must not start a second script or update a
    // component that has already left the page. The module itself is shared.
    queueMicrotask(() => {
      if (cancelled) return;
      void loadSingleTicker().then(
        () => {
          if (!cancelled) setStatus('ready');
        },
        () => {
          if (!cancelled) setStatus('failed');
        },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className={`market-widget market-widget--summary${compact ? ' market-widget--compact' : ''}`}
    >
      {status !== 'failed' ? (
        <div className="tradingview-widget-container market-widget__ticker-host">
          {createElement(singleTickerTag, {
            key: symbol,
            symbol,
            theme,
            transparent: '',
            'time-frame': '3M',
            'aria-label': `${name} TradingView 시세`,
          })}
        </div>
      ) : null}
      {status !== 'ready' ? (
        <>
          <p className="market-widget__status" role="status">
            {status === 'failed'
              ? '현재 지수 위젯을 이용할 수 없습니다.'
              : '지수 시세를 불러오는 중입니다.'}
          </p>
          <Attribution name={name} sourceUrl={sourceUrl} />
        </>
      ) : null}
    </div>
  );
}

function AdvancedChart({ symbol, name, sourceUrl, range = '1m' }: WidgetProps) {
  const { theme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    setFailed(false);
    let cancelled = false;
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.type = 'text/javascript';
    script.textContent = JSON.stringify({
      autosize: true,
      symbol,
      interval: 'D',
      timezone: 'Asia/Seoul',
      theme,
      style: '3',
      locale: 'kr',
      allow_symbol_change: false,
      hide_side_toolbar: true,
      calendar: false,
      support_host: 'https://www.tradingview.com',
      ...(symbol.startsWith('FRED:')
        ? {}
        : { range: { '1m': '1M', '3m': '3M', '1y': '12M' }[range] }),
    });
    script.onerror = () => {
      if (!cancelled) setFailed(true);
    };
    queueMicrotask(() => {
      if (!cancelled) element.replaceChildren(widget, script);
    });
    const timer = window.setTimeout(() => {
      if (!cancelled && !element.querySelector('iframe')) setFailed(true);
    }, widgetLoadTimeoutMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      script.onerror = null;
      element.replaceChildren();
    };
  }, [symbol, theme, range]);

  return (
    <div className="market-widget market-widget--detail">
      <div
        className="tradingview-widget-container"
        ref={container}
        aria-label={`${name} TradingView 차트`}
      />
      {failed ? <p role="status">현재 지수 위젯을 이용할 수 없습니다.</p> : null}
      <Attribution name={name} sourceUrl={sourceUrl} />
      <p className="market-widget__note">
        위젯에 지수가 표시되지 않으면 위 출처 링크에서 확인해 주세요. 제공 지연 시간은 위젯에
        표시됩니다.
      </p>
    </div>
  );
}

export function TradingViewWidget(props: WidgetProps) {
  const { symbol, name, sourceUrl, restricted, detail } = props;
  if (restricted)
    return (
      <div className="market-widget market-widget--restricted" role="status">
        <strong>외부 위젯 표시 제한</strong>
        <p>이 지수는 TradingView에서 확인할 수 있습니다.</p>
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${name} TradingView에서 지수 보기`}
        >
          TradingView에서 지수 보기 ↗
        </a>
        <span>{name} · TradingView</span>
      </div>
    );
  if (!allowedSymbols.has(symbol))
    return (
      <div className="market-widget">
        <p role="status">현재 지수 위젯을 이용할 수 없습니다.</p>
        <Attribution name={name} sourceUrl={sourceUrl} />
      </div>
    );
  return detail ? <AdvancedChart {...props} /> : <SingleTicker {...props} />;
}
