import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PublicCompany } from '@orsem/contracts';
import { useTheme } from '../theme';

export function publicStockSymbol(company: PublicCompany): string | null {
  if (
    company.region !== 'us' ||
    !['NASDAQ', 'NYSE'].includes(company.market) ||
    !/^[A-Z][A-Z0-9.-]{0,19}$/u.test(company.symbol) ||
    company.chartSymbol !== `${company.market}:${company.symbol}`
  )
    return null;
  return company.chartSymbol;
}

export function publicStockChartUrl(company: PublicCompany): string | null {
  const symbol =
    publicStockSymbol(company) ??
    (company.region === 'kr' &&
    ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(company.market) &&
    /^[A-Z0-9]{6}$/u.test(company.symbol)
      ? `KRX:${company.symbol}`
      : null);
  return symbol ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}` : null;
}

/** Embedding is performed directly by TradingView; no prices pass through our API. */
export function PublicStockWidget({ company }: { company: PublicCompany }) {
  const symbol = publicStockSymbol(company);
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const original = symbol
    ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`
    : null;
  useEffect(() => {
    const element = host.current;
    if (!symbol || !element) return;
    let disposed = false;
    setStatus('loading');
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.textContent = JSON.stringify({
      autosize: true,
      symbol,
      interval: 'D',
      timezone: 'Asia/Seoul',
      theme,
      style: '1',
      locale: 'kr',
      allow_symbol_change: false,
      hide_side_toolbar: true,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    });
    const fail = () => {
      if (!disposed) setStatus('failed');
    };
    script.onerror = fail;
    const timer = window.setTimeout(() => {
      if (!element.querySelector('iframe')) fail();
    }, 15_000);
    const observer = new MutationObserver(() => {
      const frame = element.querySelector('iframe');
      if (!frame || disposed) return;
      frame.title ||= `${company.name} TradingView 차트`;
      window.clearTimeout(timer);
      setStatus('ready');
    });
    observer.observe(element, { childList: true, subtree: true });
    queueMicrotask(() => {
      if (!disposed) element.replaceChildren(widget, script);
    });
    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(timer);
      script.onerror = null;
      element.replaceChildren();
    };
  }, [symbol, theme, company.name]);
  if (!symbol) return <p role="status">공개 차트를 제공할 수 있는 종목인지 확인되지 않았습니다.</p>;
  return (
    <section className="public-stock-widget" aria-label={`${company.name} 공개 차트`}>
      <div
        ref={host}
        className="public-stock-widget__host tradingview-widget-container"
        hidden={status === 'failed'}
      />
      {status !== 'ready' ? (
        <p role="status">
          {status === 'failed'
            ? '차트를 불러오지 못했습니다. TradingView에서 직접 확인해 주세요.'
            : 'TradingView 차트를 불러오는 중입니다.'}
        </p>
      ) : null}
      <a
        className="text-link public-stock-widget__credit"
        href={original!}
        target="_blank"
        rel="noopener noreferrer"
      >
        {company.name} 차트 · TradingView <ArrowUpRight size={15} aria-hidden="true" />
        <span className="sr-only"> 새 창에서 보기</span>
      </a>
      <p className="guest-note">
        시세는 거래소·제공자에 따라 지연될 수 있습니다. 기준 시각과 지연 표시는 TradingView 차트에서
        확인하세요. 차트 시간대는 KST입니다.
      </p>
    </section>
  );
}
