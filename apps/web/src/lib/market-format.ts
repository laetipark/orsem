import type { MarketQuote } from '../types';

export function marketUnit(unit: string): string {
  return unit
    .replace(/\bKRW\b/gu, '₩')
    .replace(/\bUSD\b/gu, '$')
    .replace(/^원(?=\s*(?:\/|$))/u, '₩');
}

export function marketNumber(value: string | null, currency?: string | null): string {
  if (value === null || value.trim() === '' || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: currency === 'KRW' ? 2 : 3,
  }).format(Number(value));
}

export function marketAmount(value: string | null, currency?: string | null): string {
  const amount = marketNumber(value, currency);
  if (amount === '—') return amount;
  const symbol = currency === 'KRW' ? '₩' : currency === 'USD' ? '$' : '';
  if (amount.startsWith('-')) return `-${symbol}${amount.slice(1)}`;
  return `${symbol}${amount}`;
}

export function marketValueUnit(unit: string, currency?: string | null): string {
  const displayed = marketUnit(unit);
  const symbol = currency === 'KRW' ? '₩' : currency === 'USD' ? '$' : null;
  return symbol && displayed.startsWith(symbol) ? displayed.slice(symbol.length).trim() : displayed;
}

export function marketChange(
  quote: Pick<MarketQuote, 'change' | 'changePercent' | 'changeUnit'>,
): string {
  const raw = quote.changeUnit === 'bp' ? quote.change : quote.changePercent;
  if (raw === null || raw.trim() === '' || !Number.isFinite(Number(raw))) return '—';
  const value = Number(raw);
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}${quote.changeUnit === 'bp' ? ' bp' : '%'}`;
}

export function marketChangeDirection(
  quote: Pick<MarketQuote, 'change' | 'changePercent' | 'changeUnit'>,
): 'up' | 'down' | 'flat' {
  const raw = quote.changeUnit === 'bp' ? quote.change : quote.changePercent;
  const value = raw === null ? 0 : Number(raw);
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

export function historyForRange(
  points: Array<{ date: string; value: string }>,
  range: '1m' | '3m' | '1y',
  asOf: string,
) {
  const date = new Date(asOf);
  date.setUTCMonth(date.getUTCMonth() - { '1m': 1, '3m': 3, '1y': 12 }[range]);
  const start = date.toISOString().slice(0, 10);
  return points.filter((point) => point.date >= start && Number.isFinite(Number(point.value)));
}

export function availableHistoryRanges(
  points: Array<{ date: string; value: string }>,
  asOf: string,
): Array<'1m' | '3m' | '1y'> {
  if (!points.length) return [];
  const oldest = points.reduce(
    (date, point) => (point.date < date ? point.date : date),
    points[0]!.date,
  );
  const ranges: Array<'1m' | '3m' | '1y'> = ['1m'];
  for (const [range, months] of [
    ['3m', 1],
    ['1y', 3],
  ] as const) {
    const cutoff = new Date(asOf);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    if (oldest < cutoff.toISOString().slice(0, 10)) ranges.push(range);
  }
  return ranges;
}
