import type { MarketQuote } from '../types';
import { formatDate, formatKst } from './format';

const compactKst = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function shortMarketTimestamp(value: string): string {
  const parts = compactKst.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  return `${part('month')}.${part('day')} ${part('hour')}:${part('minute')} KST`;
}

export function marketSourceTime(item: MarketQuote): string | null {
  if (item.providerAt) return `자료 기준 ${formatKst(item.providerAt)}`;
  if (item.valueDate) return `자료 기준 ${formatDate(item.valueDate)}`;
  return null;
}

export function marketCollectionTime(item: MarketQuote) {
  const timestamp = item.observedAt ? formatKst(item.observedAt) : null;
  const label = timestamp ? `수집 기준 시각 ${timestamp}` : '수집 시각 확인 전';
  return {
    timestamp,
    label,
    description: [label, marketSourceTime(item), `출처 ${item.provider}`]
      .filter(Boolean)
      .join(' · '),
  };
}

function cardTimestamp(item: MarketQuote, compact: boolean): string | null {
  const native = item.displayKind === 'NATIVE';
  const value = native
    ? item.observedAt
    : (item.providerAt ?? (item.valueDate ? null : item.observedAt));
  if (!value) return !native && item.valueDate ? formatDate(item.valueDate) : null;
  const observed = !native && !item.providerAt;
  const timestamp = compact ? shortMarketTimestamp(value) : formatKst(value);
  return `${observed ? '관측 ' : ''}${timestamp}`;
}

export function marketCardTime(item: MarketQuote) {
  const native = item.displayKind === 'NATIVE';
  return {
    text: cardTimestamp(item, true),
    dateTime: native
      ? (item.observedAt ?? undefined)
      : (item.providerAt ?? item.valueDate ?? item.observedAt ?? undefined),
    description: native ? marketCollectionTime(item).description : cardTimestamp(item, false),
  };
}
